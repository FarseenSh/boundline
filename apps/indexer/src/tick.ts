import type { ChainId } from "@boundline/chain";
import { advanceRoots } from "./daily.js";
import { scanSource, type IngestResult, type LogClient, type TickBudget } from "./ingest.js";
import { reconcileMarket, type ChainReader, type MarketToReconcile } from "./reconcile.js";
import type { Source } from "./sources.js";
import { TICK_CURSOR, TICK_DONE_CURSOR, type CursorRow, type EventGroup, type Store } from "./store.js";

export { TICK_CURSOR, TICK_DONE_CURSOR } from "./store.js";

/** Blocks per `eth_getLogs` call, per chain. Base's public RPCs cap the range at 500 (`eth_getLogs is limited to a 500 range`
 *  from mainnet.base.org on 6 Oct 2026); the keyed RPC accepts the same window, so 500 is the universal size. */
export const RANGE_BLOCKS = 500;
export const RANGE_BLOCKS_BY_CHAIN: Readonly<Record<number, number>> = { 8453: 500, 84532: 500 };
export function rangeBlocksFor(chainId: number): number {
  return RANGE_BLOCKS_BY_CHAIN[chainId] ?? RANGE_BLOCKS;
}
/** The market reconciliation runs this often, and also right after its market got new events. */
export const RECONCILE_EVERY_SECONDS = 600;
/** Complete days are rooted this often (a day closes once every cursor of its chain passed its midnight). */
export const ROOTS_EVERY_SECONDS = 600;
/** No new source starts scanning after this much wall time; the commit and maintenance follow. */
export const INGEST_BUDGET_MS = 18_000;
const RECONCILE_CURSOR = "reconcile";
const ROOTS_CURSOR = "roots";
/** A tick is skipped when another one finished less than this long ago: the Worker's own cron and the Observatory's
 *  `/__tick` kick both fire every minute, and two ticks at once would scan the same ranges twice. */
export const TICK_MIN_GAP_SECONDS = 40;
/** The lease a tick claims atomically when it starts (store.claimTick). A tick killed by the CPU limit holds it this
 *  long at most; before 8 Oct a killed tick's start marker made the Observatory's kick skip for 40 s, i.e. always, and
 *  the cron and the kick could also both run because each read the marker before the other wrote it. */
export const TICK_LEASE_SECONDS = 20;
/** Stored events hashed per tick for the daily roots (each costs ~0.2 ms of CPU warm and ~1 ms on a cold isolate: a tick
 *  that hashed 16 cost 30 ms live on 8 Oct 2026, one that hashed none ~10 ms; see migrations/0003). While
 *  hashes are pending the root step runs every tick; a day is rooted (one keccak over its hashes) once all are in. */
export const ROOT_HASHES_PER_TICK = 8;
/** A source near the head waits until it is this many blocks behind before it scans again (Base: 2 s blocks): every
 *  eth_getLogs costs CPU on a Free-plan invocation, and a sliver of 30 blocks a minute is the most expensive way to
 *  stay current. Sepolia carries the desk and protection events the API and webhooks read (90 s); mainnet is analytics
 *  (5 min). A source further behind than this scans every tick. */
export const MIN_LAG_BLOCKS: Readonly<Record<number, number>> = { 84532: 45, 8453: 150 };
export function minLagFor(chainId: number): number {
  return MIN_LAG_BLOCKS[chainId] ?? 0;
}

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
  /** Logs decoded in this tick before no further source starts (default: unlimited). */
  maxLogs?: number;
  /** Stored events hashed per tick for the daily roots (default ROOT_HASHES_PER_TICK). */
  rootHashesPerTick?: number;
}

export interface TickSummary {
  /** True when this tick ran; false when another tick finished under TICK_MIN_GAP_SECONDS ago or still holds the lease. */
  ran: boolean;
  /** The order the sources were visited in (rotates every minute so no source starves the others). */
  order: string[];
  ingest: IngestResult[];
  roots: { chainId: number; day: string; root: string; eventCount: number }[];
  rootsChecked: number[];
  reconciled: { chainId: number; marketId: string; blockNumber: number; pass: number; fail: number; skip: number; usedLatest: boolean }[];
  budget: { rangesLeft: number; logsLeft: number } | null;
  /** D1 round trips this tick made (each costs CPU on Workers; the Free plan allows 10 ms an invocation). */
  storeCalls: number;
  errors: string[];
}

/** Sources rotated by the minute: the one that goes first changes every tick. Pure; exported for tests. */
export function rotateSources<T>(sources: readonly T[], nowSeconds: number): T[] {
  if (sources.length === 0) return [];
  const offset = Math.floor(nowSeconds / 60) % sources.length;
  return [...sources.slice(offset), ...sources.slice(0, offset)];
}

/**
 * One cron tick, built to make few D1 round trips: one read of every cursor, one atomic lease claim, the sources scanned
 * in rotation (each source's ranges in parallel), one batch that writes every source's events and cursors, the daily
 * roots and the market reconciliation only when due, and the completion marker.
 */
export async function runTick(deps: TickDeps, config: TickConfig): Promise<TickSummary> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const summary: TickSummary = { ran: true, order: [], ingest: [], roots: [], rootsChecked: [], reconciled: [], budget: null, storeCalls: 0, errors: [] };
  const startedAt = deps.now();
  const cursorRows = await deps.store.listCursors();
  summary.storeCalls += 1;
  const cursorOf = (chainId: number, source: string) => cursorRows.find((c) => c.chainId === chainId && c.source === source) ?? null;
  const done = cursorOf(0, TICK_DONE_CURSOR);
  if (done && startedAt - done.updatedAt >= 0 && startedAt - done.updatedAt < TICK_MIN_GAP_SECONDS) {
    summary.ran = false;
    log(`tick skipped: previous tick finished ${startedAt - done.updatedAt}s ago`);
    return summary;
  }
  const claimed = await deps.store.claimTick(startedAt, TICK_LEASE_SECONDS);
  summary.storeCalls += 1;
  if (!claimed) {
    summary.ran = false;
    log("tick skipped: another tick holds the lease");
    return summary;
  }

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
  const ordered = rotateSources(config.sources, startedAt);
  summary.order = ordered.map((s) => s.id);
  const groups: EventGroup[] = [];
  const writes: CursorRow[] = [];
  const newMarketEvents = new Set<number>();
  for (const source of ordered) {
    const before = cursorOf(source.chainId, source.id)?.lastBlock ?? source.startBlock - 1;
    const lag = minLagFor(source.chainId);
    if (lag > 0) {
      const head = await clientFor(source.chainId)
        .getBlockNumber()
        .catch(() => null);
      if (head !== null && head - before < lag) continue;
    }
    const { result, rows, cursor } = await scanSource(clientFor(source.chainId), source, before, {
      range: rangeBlocksFor(source.chainId),
      maxRanges: config.maxRanges,
      deadlineMs,
      now: deps.now,
      ...(budget ? { budget } : {}),
    });
    summary.ingest.push(result);
    if (result.error) summary.errors.push(`${result.source}: ${result.error}`);
    if (rows.length > 0) groups.push({ key: source.id, events: rows });
    if (cursor) writes.push(cursor);
    if (rows.length > 0 && source.id.startsWith("morpho-market")) newMarketEvents.add(source.chainId);
  }
  if (budget) summary.budget = { rangesLeft: budget.ranges, logsLeft: budget.logs };

  // Maintenance due this tick? When it is not (most ticks), the completion marker rides in the ingest commit.
  const chains = [...new Set(config.sources.map((s) => s.chainId))];
  // the roots cursor's lastBlock is 1 while hashes or days are pending (the step then runs every tick)
  const rootsDue = chains.filter((chainId) => {
    const last = cursorOf(chainId, ROOTS_CURSOR);
    return !last || last.lastBlock === 1 || startedAt - last.updatedAt >= ROOTS_EVERY_SECONDS;
  });
  const marketsDue = config.markets.filter((m) => {
    const last = cursorOf(m.chainId, RECONCILE_CURSOR);
    return !last || startedAt - last.updatedAt >= RECONCILE_EVERY_SECONDS || newMarketEvents.has(m.chainId);
  });
  const doneMarker = (): CursorRow => ({ chainId: 0, source: TICK_DONE_CURSOR, lastBlock: startedAt, lastBlockTime: 0, updatedAt: deps.now() });
  const maintenanceDue = rootsDue.length > 0 || marketsDue.length > 0;
  if (groups.length > 0 || writes.length > 0 || !maintenanceDue) {
    try {
      const added = await deps.store.commit(groups, maintenanceDue ? writes : [...writes, doneMarker()]);
      summary.storeCalls += 1;
      for (const r of summary.ingest) r.inserted = added[r.source] ?? 0;
    } catch (err) {
      summary.errors.push(`commit: ${err instanceof Error ? err.message : String(err)}`);
      for (const r of summary.ingest) r.cursorAfter = r.cursorBefore;
    }
  }
  for (const r of summary.ingest) {
    if (r.ranges === 0 && !r.error && !r.budgetExhausted) continue;
    log(
      `ingest ${r.source} head=${r.head} cursor=${r.cursorBefore}->${r.cursorAfter} ranges=${r.ranges} logs=${r.logs} inserted=${r.inserted}${r.budgetExhausted ? " budget=exhausted" : ""}${r.error ? ` error=${r.error}` : ""}`,
    );
  }

  // Maintenance, only when due: each step costs a few D1 round trips.
  const maintenance: CursorRow[] = [];
  for (const chainId of rootsDue) {
    try {
      summary.rootsChecked.push(chainId);
      // the cursors as they stand after this tick's commit; a configured source that has never scanned counts as time 0,
      // so a newly added source holds back day closure until it has scanned (else a day could be rooted without its events)
      const view = [...cursorRows.filter((c) => !writes.some((w) => w.chainId === c.chainId && w.source === c.source)), ...writes];
      for (const s of config.sources) {
        if (s.chainId === chainId && !view.some((c) => c.chainId === chainId && c.source === s.id)) {
          view.push({ chainId, source: s.id, lastBlock: s.startBlock - 1, lastBlockTime: 0, updatedAt: 0 });
        }
      }
      const progress = await advanceRoots(deps.store, chainId, deps.now(), view, config.rootHashesPerTick ?? ROOT_HASHES_PER_TICK);
      for (const row of progress.made) {
        summary.roots.push({ chainId, day: row.day, root: row.root, eventCount: row.eventCount });
        log(`root ${chainId} ${row.day} events=${row.eventCount} root=${row.root}`);
      }
      if (progress.hashed > 0) log(`hashed ${chainId} ${progress.hashed} events${progress.pending ? " (more pending)" : ""}`);
      summary.storeCalls += 2 + (progress.hashed > 0 ? 1 : 0) + progress.made.length * 2;
      maintenance.push({ chainId, source: ROOTS_CURSOR, lastBlock: progress.pending ? 1 : 0, lastBlockTime: 0, updatedAt: deps.now() });
    } catch (err) {
      summary.errors.push(`roots ${chainId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const market of marketsDue) {
    try {
      const outcome = await reconcileMarket(deps.store, deps.readerFor(market.chainId as ChainId), market, deps.now());
      summary.storeCalls += 2;
      const count = (s: string) => outcome.rows.filter((r) => r.status === s).length;
      summary.reconciled.push({ chainId: market.chainId, marketId: market.marketId, blockNumber: outcome.blockNumber, pass: count("PASS"), fail: count("FAIL"), skip: count("SKIP"), usedLatest: outcome.usedLatest });
      maintenance.push({ chainId: market.chainId, source: RECONCILE_CURSOR, lastBlock: outcome.blockNumber, lastBlockTime: 0, updatedAt: deps.now() });
      log(`reconcile ${market.marketId} block=${outcome.blockNumber} pass=${count("PASS")} fail=${count("FAIL")} skip=${count("SKIP")}`);
    } catch (err) {
      summary.errors.push(`reconcile ${market.marketId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (maintenanceDue) {
    // the maintenance cursors and the completion marker in one round trip
    await deps.store.commit([], [...maintenance, doneMarker()]);
    summary.storeCalls += 1;
  }
  log(`tick done: ${summary.ingest.reduce((n, r) => n + r.ranges, 0)} ranges, ${summary.ingest.reduce((n, r) => n + r.logs, 0)} logs, ${summary.storeCalls} store calls${summary.errors.length ? `, ${summary.errors.length} errors` : ""}`);
  return summary;
}
