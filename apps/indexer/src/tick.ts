import type { ChainId } from "@boundline/chain";
import { computeDailyRoots } from "./daily.js";
import { ingestSource, type IngestResult, type LogClient, type TickBudget } from "./ingest.js";
import { reconcileMarket, type ChainReader, type MarketToReconcile } from "./reconcile.js";
import type { Source } from "./sources.js";
import type { Store } from "./store.js";

/** Blocks per `eth_getLogs` call, per chain. Base's public RPCs cap the range at 500 (`eth_getLogs is limited to a 500 range`
 *  from mainnet.base.org on 6 Oct 2026); the keyed RPC accepts the same window, so 500 is the universal size. */
export const RANGE_BLOCKS = 500;
export const RANGE_BLOCKS_BY_CHAIN: Readonly<Record<number, number>> = { 8453: 500, 84532: 500 };
export function rangeBlocksFor(chainId: number): number {
  return RANGE_BLOCKS_BY_CHAIN[chainId] ?? RANGE_BLOCKS;
}
export const RECONCILE_EVERY_SECONDS = 600;
/** Daily roots are recomputed when a tick stored events, and at least this often otherwise. */
export const ROOTS_EVERY_SECONDS = 600;
/** Leave the 30 s cron budget room for the root and reconciliation steps. */
export const INGEST_BUDGET_MS = 18_000;
const RECONCILE_CURSOR = "reconcile";
const ROOTS_CURSOR = "roots";
const TICK_CURSOR = "tick";
/** A tick that started less than this long after the previous one is skipped: the Worker's own cron and the
 *  Observatory's `/__tick` kick both fire every minute, and two ticks at once would scan the same ranges twice. */
export const TICK_MIN_GAP_SECONDS = 40;

export interface TickDeps {
  store: Store;
  clientFor: (chainId: ChainId) => LogClient;
  readerFor: (chainId: ChainId) => ChainReader;
  now: () => number;
  log?: (line: string) => void;
}

export interface TickConfig {
  sources: Source[];
  markets: MarketToReconcile[];
  /** Ranges one source may scan in this tick. */
  maxRanges: number;
  /** Ranges all sources together may scan in this tick (default: unlimited). */
  maxRangesTotal?: number;
  /** Logs decoded in this tick before no further range starts (default: unlimited). */
  maxLogs?: number;
}

export interface TickSummary {
  /** True when this tick ran; false when it was skipped because another tick started under TICK_MIN_GAP_SECONDS ago. */
  ran: boolean;
  /** The order the sources were visited in (rotates every minute so no source starves the others). */
  order: string[];
  ingest: IngestResult[];
  roots: { chainId: number; day: string; root: string; eventCount: number }[];
  rootsChecked: number[];
  reconciled: { chainId: number; marketId: string; blockNumber: number; pass: number; fail: number; skip: number; usedLatest: boolean }[];
  budget: { rangesLeft: number; logsLeft: number } | null;
  errors: string[];
}

/** Sources rotated by the minute: the one that goes first changes every tick. Pure; exported for tests. */
export function rotateSources<T>(sources: readonly T[], nowSeconds: number): T[] {
  if (sources.length === 0) return [];
  const offset = Math.floor(nowSeconds / 60) % sources.length;
  return [...sources.slice(offset), ...sources.slice(0, offset)];
}

/** One cron tick: ingest every source inside the budget, close complete days, reconcile when due. */
export async function runTick(deps: TickDeps, config: TickConfig): Promise<TickSummary> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const summary: TickSummary = { ran: true, order: [], ingest: [], roots: [], rootsChecked: [], reconciled: [], budget: null, errors: [] };
  const lastTick = await deps.store.getCursor(0, TICK_CURSOR);
  if (lastTick && deps.now() - lastTick.updatedAt < TICK_MIN_GAP_SECONDS && deps.now() >= lastTick.updatedAt) {
    summary.ran = false;
    log(`tick skipped: previous tick started ${deps.now() - lastTick.updatedAt}s ago`);
    return summary;
  }
  await deps.store.setCursor({ chainId: 0, source: TICK_CURSOR, lastBlock: 0, lastBlockTime: 0, updatedAt: deps.now() });
  const deadlineMs = Date.now() + INGEST_BUDGET_MS;
  const clients = new Map<ChainId, LogClient>();
  const clientFor = (chainId: ChainId): LogClient => {
    const hit = clients.get(chainId);
    if (hit) return hit;
    const c = deps.clientFor(chainId);
    clients.set(chainId, c);
    return c;
  };
  const budget: TickBudget | undefined =
    config.maxRangesTotal !== undefined || config.maxLogs !== undefined
      ? { ranges: config.maxRangesTotal ?? Number.MAX_SAFE_INTEGER, logs: config.maxLogs ?? Number.MAX_SAFE_INTEGER }
      : undefined;
  const chains = new Set<ChainId>();
  const inserted = new Map<number, number>();
  const newMarketEvents = new Map<number, boolean>();
  const ordered = rotateSources(config.sources, deps.now());
  summary.order = ordered.map((s) => s.id);
  for (const source of ordered) {
    chains.add(source.chainId);
    if (budget && (budget.ranges <= 0 || budget.logs <= 0)) {
      summary.ingest.push({ source: source.id, chainId: source.chainId, head: 0, cursorBefore: -1, cursorAfter: -1, ranges: 0, logs: 0, inserted: 0, names: {}, budgetExhausted: true });
      continue;
    }
    const r = await ingestSource(deps.store, clientFor(source.chainId), source, {
      range: rangeBlocksFor(source.chainId),
      maxRanges: config.maxRanges,
      deadlineMs,
      now: deps.now,
      ...(budget ? { budget } : {}),
    });
    summary.ingest.push(r);
    if (r.error) summary.errors.push(`${r.source}: ${r.error}`);
    inserted.set(source.chainId, (inserted.get(source.chainId) ?? 0) + r.inserted);
    if (r.inserted > 0 && source.id.startsWith("morpho-market")) newMarketEvents.set(source.chainId, true);
    log(
      `ingest ${r.source} head=${r.head} cursor=${r.cursorBefore}->${r.cursorAfter} ranges=${r.ranges} logs=${r.logs} inserted=${r.inserted}${r.budgetExhausted ? " budget=exhausted" : ""}${r.error ? ` error=${r.error}` : ""}`,
    );
  }
  if (budget) summary.budget = { rangesLeft: budget.ranges, logsLeft: budget.logs };

  for (const chainId of chains) {
    try {
      const last = await deps.store.getCursor(chainId, ROOTS_CURSOR);
      const due = !last || deps.now() - last.updatedAt >= ROOTS_EVERY_SECONDS;
      if (!due && (inserted.get(chainId) ?? 0) === 0) continue;
      summary.rootsChecked.push(chainId);
      for (const row of await computeDailyRoots(deps.store, chainId, deps.now())) {
        summary.roots.push({ chainId, day: row.day, root: row.root, eventCount: row.eventCount });
        log(`root ${chainId} ${row.day} events=${row.eventCount} root=${row.root}`);
      }
      await deps.store.setCursor({ chainId, source: ROOTS_CURSOR, lastBlock: 0, lastBlockTime: 0, updatedAt: deps.now() });
    } catch (err) {
      summary.errors.push(`roots ${chainId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const market of config.markets) {
    try {
      const last = await deps.store.getCursor(market.chainId, RECONCILE_CURSOR);
      const due = !last || deps.now() - last.updatedAt >= RECONCILE_EVERY_SECONDS;
      if (!due && !newMarketEvents.get(market.chainId)) continue;
      const outcome = await reconcileMarket(deps.store, deps.readerFor(market.chainId as ChainId), market, deps.now());
      const count = (s: string) => outcome.rows.filter((r) => r.status === s).length;
      summary.reconciled.push({
        chainId: market.chainId,
        marketId: market.marketId,
        blockNumber: outcome.blockNumber,
        pass: count("PASS"),
        fail: count("FAIL"),
        skip: count("SKIP"),
        usedLatest: outcome.usedLatest,
      });
      await deps.store.setCursor({ chainId: market.chainId, source: RECONCILE_CURSOR, lastBlock: outcome.blockNumber, lastBlockTime: 0, updatedAt: deps.now() });
      log(`reconcile ${market.marketId} block=${outcome.blockNumber} pass=${count("PASS")} fail=${count("FAIL")} skip=${count("SKIP")}`);
    } catch (err) {
      summary.errors.push(`reconcile ${market.marketId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return summary;
}
