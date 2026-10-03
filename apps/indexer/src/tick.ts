import type { ChainId } from "@boundline/chain";
import { computeDailyRoots } from "./daily.js";
import { ingestSource, type IngestResult, type LogClient } from "./ingest.js";
import { reconcileMarket, type ChainReader, type MarketToReconcile } from "./reconcile.js";
import type { Source } from "./sources.js";
import type { Store } from "./store.js";

export const RANGE_BLOCKS = 2_000;
export const RECONCILE_EVERY_SECONDS = 600;
/** Leave the 30 s cron budget room for the root and reconciliation steps. */
export const INGEST_BUDGET_MS = 18_000;
const RECONCILE_CURSOR = "reconcile";

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
  maxRanges: number;
}

export interface TickSummary {
  ingest: IngestResult[];
  roots: { chainId: number; day: string; root: string; eventCount: number }[];
  reconciled: { chainId: number; marketId: string; blockNumber: number; pass: number; fail: number; skip: number; usedLatest: boolean }[];
  errors: string[];
}

/** One cron tick: ingest every source, close complete days, reconcile when market events arrived or ten minutes passed. */
export async function runTick(deps: TickDeps, config: TickConfig): Promise<TickSummary> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const summary: TickSummary = { ingest: [], roots: [], reconciled: [], errors: [] };
  const deadlineMs = Date.now() + INGEST_BUDGET_MS;
  const clients = new Map<ChainId, LogClient>();
  const clientFor = (chainId: ChainId): LogClient => {
    const hit = clients.get(chainId);
    if (hit) return hit;
    const c = deps.clientFor(chainId);
    clients.set(chainId, c);
    return c;
  };
  const chains = new Set<ChainId>();
  const newMarketEvents = new Map<number, boolean>();
  for (const source of config.sources) {
    chains.add(source.chainId);
    const r = await ingestSource(deps.store, clientFor(source.chainId), source, { range: RANGE_BLOCKS, maxRanges: config.maxRanges, deadlineMs, now: deps.now });
    summary.ingest.push(r);
    if (r.error) summary.errors.push(`${r.source}: ${r.error}`);
    if (r.inserted > 0 && source.id.startsWith("morpho-market")) newMarketEvents.set(source.chainId, true);
    log(`ingest ${r.source} head=${r.head} cursor=${r.cursorBefore}->${r.cursorAfter} ranges=${r.ranges} logs=${r.logs} inserted=${r.inserted}${r.error ? ` error=${r.error}` : ""}`);
  }
  for (const chainId of chains) {
    try {
      for (const row of await computeDailyRoots(deps.store, chainId, deps.now())) {
        summary.roots.push({ chainId, day: row.day, root: row.root, eventCount: row.eventCount });
        log(`root ${chainId} ${row.day} events=${row.eventCount} root=${row.root}`);
      }
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
