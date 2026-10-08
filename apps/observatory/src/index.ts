import { B20_TOKENS } from "@boundline/chain";
import { Hono } from "hono";
import { PatternRouter } from "hono/router/pattern-router";
import type { Address } from "viem";
import { readAaveReserves } from "./aave.js";
import { AAVE_CHAIN_ID, AAVE_SPOKE, KV_AAVE_META, cachedAaveMeta, parseIndexerBorrowers, type AaveMeta } from "./aave-positions.js";
import { readAssurance } from "./assurance.js";
import { liveCalendar } from "./calendar-impl.js";
import type { CalendarPort } from "./calendar-port.js";
import { findLivenessTransitions } from "./capture.js";
import { appendSnapshot } from "./d1.js";
import { logsRpcUrl, rpcUrl, type Env } from "./env.js";
import { GAPS_REFRESH_MINUTES, GAPS_TTL_SECONDS, KV_GAPS, ROUNDS_PER_SYMBOL, buildGapsPanel, type GapsPanel, type IndexerRoundsBody } from "./gaps.js";
import { KV_SEIZE, SEIZE_TTL_SECONDS, isSeizeWatchBody, seizeDue, type SeizeWatchBody } from "./seize.js";
import { renderPage } from "./html.js";
import { runAavePositions, runCapture, runPositions } from "./jobs.js";
import { KV_LATEST, storeLatest } from "./kv-latest.js";
import { discoverB20Markets, readMarkets, type MarketRow } from "./morpho.js";
import { CHAIN_ID } from "./positions.js";
import { createRpcReader, rpcUrlsOf, type ChainReader } from "./reader.js";
import { ethCaller, logsGetter } from "./rpc.js";
import { buildSnapshot, type Snapshot } from "./snapshot.js";
import { d1Stores, type Stores } from "./stores.js";

// Minutes between position scans. A second cron trigger (every fifth minute) never fired on this account (6 Oct 2026,
// like the indexer's own cron before it), so the positions job rides on every fifth minute of the one cron that does fire.
export const POSITIONS_EVERY_MINUTES = 5;

/** True on the ticks that also run the positions jobs (Morpho, then Aave): wall-clock minutes divisible by five. */
export function positionsDue(epochSeconds: number): boolean {
  return Math.floor(epochSeconds / 60) % POSITIONS_EVERY_MINUTES === 0;
}

/** True on the ticks that read an Aave V4 batch: minute 1 of every five, so its CPU never stacks on the Morpho scan's tick (measured 36 ms together on 7 Oct 2026). */
export function aaveDue(epochSeconds: number): boolean {
  return Math.floor(epochSeconds / 60) % POSITIONS_EVERY_MINUTES === 1;
}

/** True on the ticks that rebuild the weekend-gap panel: minute 2 of every ten, never sharing a tick with the positions jobs. */
export function gapsDue(epochSeconds: number): boolean {
  return Math.floor(epochSeconds / 60) % GAPS_REFRESH_MINUTES === 2;
}

const KV_MORPHO = "morpho-markets";
const KV_AAVE = "aave-reserves";
/** Venue reads are cached in KV on request; 15 minutes keeps a crawler from spending the free tier's 1,000 KV writes a day. */
const VENUE_CACHE_SECONDS = 900;
/** The ten priced B20 feeds the gap panel asks the indexer about. */
const GAP_SYMBOLS = B20_TOKENS.map((t) => t.symbol);

/** The indexer behind its service binding (Worker-to-Worker fetches over workers.dev are refused, error 1042). */
export interface IndexerClient {
  json<T>(path: string): Promise<T>;
}

export function indexerClient(env: Env): IndexerClient | null {
  const binding = env.INDEXER;
  if (!binding) return null;
  return {
    async json<T>(path: string): Promise<T> {
      const res = await binding.fetch(`https://indexer${path}`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`indexer answered ${res.status} for ${path}`);
      return (await res.json()) as T;
    },
  };
}

export interface AppDeps {
  stores(env: Env): Stores;
  calendar: CalendarPort;
  reader(env: Env): ChainReader;
  fetchImpl: typeof fetch;
  /** The B20 Morpho markets, cached in KV; overridable so tests never call the API. */
  markets(env: Env): Promise<MarketRow[]>;
  /** The indexer, or null when the binding is absent (tests pass a fake). */
  indexer(env: Env): IndexerClient | null;
  /** Aave reserve metadata (decimals, collateral factors, oracle), cached in KV for an hour. */
  aaveMeta(env: Env, now: number): Promise<AaveMeta>;
}

async function cachedJson<T>(env: Env, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = await env.SNAPSHOTS.get<T>(key, "json");
  if (hit) return hit;
  const value = await load();
  await env.SNAPSHOTS.put(key, JSON.stringify(value), { expirationTtl: ttl });
  return value;
}

const liveDeps: AppDeps = {
  stores: (env) => d1Stores(env.DB),
  calendar: liveCalendar,
  reader: (env) => createRpcReader(rpcUrl(env)),
  fetchImpl: (input, init) => fetch(input, init),
  markets: (env) => cachedJson(env, KV_MORPHO, VENUE_CACHE_SECONDS, async () => readMarkets(rpcUrl(env), await discoverB20Markets())),
  indexer: indexerClient,
  aaveMeta: (env, now) => cachedAaveMeta(env.SNAPSHOTS, ethCaller(rpcUrlsOf(rpcUrl(env))), now),
};

export function createApp(overrides: Partial<AppDeps> = {}) {
  const deps: AppDeps = { ...liveDeps, ...overrides };

  async function takeSnapshot(env: Env, persist: boolean): Promise<Snapshot> {
    const reads = await deps.reader(env).read();
    const snapshot = buildSnapshot(reads, deps.calendar, Math.floor(Date.now() / 1000));
    const stored = await storeLatest(env.SNAPSHOTS, snapshot);
    console.log(`snapshot block=${snapshot.block} session=${snapshot.session.state} kv=${stored.reason}`);
    if (persist) {
      try {
        await appendSnapshot(env.DB, snapshot);
      } catch (err) {
        console.error("d1 append failed", err instanceof Error ? err.message : err);
      }
    }
    return snapshot;
  }

  async function latest(env: Env): Promise<Snapshot> {
    const cached = await env.SNAPSHOTS.get<Snapshot>(KV_LATEST, "json");
    return cached ?? takeSnapshot(env, false);
  }

  /** The reopen capture rides on the same tick as the snapshot; it may never break it. */
  async function afterSnapshot(env: Env, snapshot: Snapshot): Promise<void> {
    try {
      const c = await runCapture(deps.stores(env).capture, deps.calendar, snapshot);
      if (c.status !== "idle") console.log(`capture ${c.status} transition=${c.transitionAt} phase=${c.phase} ticks=${c.ticks}`);
    } catch (err) {
      console.error("capture job failed", err instanceof Error ? err.message : err);
    }
  }

  /** The real-position scan and refresh, every fifth minute. Raw JSON-RPC reads keep it to about a millisecond of CPU. */
  async function refreshPositions(env: Env, snapshot: Snapshot): Promise<void> {
    try {
      const markets = await deps.markets(env);
      const rpc = { call: ethCaller(rpcUrlsOf(rpcUrl(env))), getLogs: logsGetter(rpcUrlsOf(logsRpcUrl(env))) };
      const r = await runPositions({ store: deps.stores(env).positions, rpc, markets, fetchImpl: deps.fetchImpl, snapshot });
      console.log(`positions scanned=${r.scanned ? `${r.scanned.from}-${r.scanned.to}` : "none"} seeded=${r.seeded} new=${r.newBorrowers} refreshed=${r.refreshed ?? "skip"} errors=${r.errors.length}`);
    } catch (err) {
      console.error("positions job failed", err instanceof Error ? err.message : err);
    }
  }

  /** Aave V4 MAG7 positions: a rotating batch of the indexer's borrowers, read in one aggregate3 call, every fifth minute. */
  async function refreshAave(env: Env, snapshot: Snapshot): Promise<void> {
    try {
      const indexer = deps.indexer(env);
      const r = await runAavePositions({
        store: deps.stores(env).aave,
        call: ethCaller(rpcUrlsOf(rpcUrl(env))),
        meta: () => deps.aaveMeta(env, snapshot.takenAt),
        borrowers: async () => (indexer ? parseIndexerBorrowers(await indexer.json("/v1/venues/aave/borrowers?limit=500"), snapshot.takenAt) : []),
        snapshot,
      });
      console.log(`aave known=${r.known} new=${r.newBorrowers} scanned=${r.scanned} refreshed=${r.refreshed} cases=${r.protectionCases} next=${r.nextOffset} errors=${r.errors.length}`);
    } catch (err) {
      console.error("aave job failed", err instanceof Error ? err.message : err);
    }
  }

  /** The weekend-gap panel: the indexer's round history for every priced feed, classified against the calendar, cached in KV. */
  async function computeGaps(env: Env, now: number): Promise<GapsPanel> {
    const indexer = deps.indexer(env);
    const rounds = new Map<string, IndexerRoundsBody | Error>();
    if (indexer) {
      const settled = await Promise.allSettled(GAP_SYMBOLS.map((s) => indexer.json<IndexerRoundsBody>(`/v1/feeds/${s}/rounds?limit=${ROUNDS_PER_SYMBOL}`)));
      settled.forEach((r, i) => rounds.set(GAP_SYMBOLS[i] as string, r.status === "fulfilled" ? r.value : r.reason instanceof Error ? r.reason : new Error(String(r.reason))));
    }
    const captureRuns = await deps.stores(env).capture.listRuns(MAX_CAPTURE_RUNS_FOR_GAPS).catch(() => []);
    const panel = buildGapsPanel({ now, calendar: deps.calendar, rounds, captureRuns });
    await env.SNAPSHOTS.put(KV_GAPS, JSON.stringify(panel), { expirationTtl: GAPS_TTL_SECONDS });
    return panel;
  }

  async function refreshGaps(env: Env, now: number): Promise<void> {
    try {
      const p = await computeGaps(env, now);
      console.log(`gaps weekends=${p.weekends.length} indexerSymbols=${p.indexer.symbols} through=${p.indexer.through ?? "none"} errors=${p.indexer.errors.length}`);
    } catch (err) {
      console.error("gaps job failed", err instanceof Error ? err.message : err);
    }
  }

  async function gapsPanel(env: Env, now: number): Promise<GapsPanel> {
    const hit = await env.SNAPSHOTS.get<GapsPanel>(KV_GAPS, "json");
    return hit ?? computeGaps(env, now);
  }

  /** The seize watch from the indexer, cached in KV (minute 3 of every 30). */
  async function computeSeize(env: Env): Promise<SeizeWatchBody | null> {
    const indexer = deps.indexer(env);
    if (!indexer) return null;
    const body = await indexer.json<unknown>("/v1/seize-watch");
    if (!isSeizeWatchBody(body)) throw new Error("indexer seize-watch answer has an unexpected shape");
    await env.SNAPSHOTS.put(KV_SEIZE, JSON.stringify(body), { expirationTtl: SEIZE_TTL_SECONDS });
    return body;
  }

  async function refreshSeize(env: Env): Promise<void> {
    try {
      const w = await computeSeize(env);
      if (w) console.log(`seize holders=${w.summary.seizeRoleHolders} policies=${w.summary.exemptionPolicies.join("/")} venuesNotExempt=${w.summary.venuesNotExempt.length} liveBlock=${w.live.block ?? "none"}`);
    } catch (err) {
      console.error("seize job failed", err instanceof Error ? err.message : err);
    }
  }

  async function seizeWatch(env: Env): Promise<SeizeWatchBody | null> {
    const hit = await env.SNAPSHOTS.get<SeizeWatchBody>(KV_SEIZE, "json");
    return hit ?? computeSeize(env);
  }

  // PatternRouter, not Hono's default SmartRouter: the default compiles a regular expression over every route on the
  // first request of a cold isolate (24-26 ms CPU measured in apps/api, 8 Oct 2026); PatternRouter's first match costs
  // 0.2-0.3 ms, which the Free plan's 10 ms CPU per invocation can afford.
  const app = new Hono<{ Bindings: Env }>({ router: new PatternRouter() });

  app.get("/", async (c) => {
    const s = await latest(c.env);
    const stores = deps.stores(c.env);
    const quiet = <T>(label: string, p: Promise<T>): Promise<T | null> =>
      p.catch((err: unknown) => {
        console.error(`${label} failed`, err instanceof Error ? err.message : err);
        return null;
      });
    const [capture, positions, aave, gaps, assurance, seize] = await Promise.all([
      quiet("latestRun", stores.capture.latestRun()),
      quiet("latestPositions", stores.positions.latestPositions(CHAIN_ID)),
      quiet("latestAave", stores.aave.latestPositions(AAVE_CHAIN_ID)),
      quiet("gaps", gapsPanel(c.env, s.takenAt)),
      quiet("assurance", readAssurance(c.env.SNAPSHOTS)),
      quiet("seize", seizeWatch(c.env)),
    ]);
    const { next } = findLivenessTransitions(deps.calendar, s.takenAt);
    return c.html(renderPage(s, { capture, nextTransition: next, positions, aave, gaps, assurance, seize }));
  });
  app.get("/health", (c) => c.json({ ok: true, service: "boundline-observatory" }));

  app.get("/v1/tokens", async (c) => {
    const s = await latest(c.env);
    return c.json({ takenAt: s.takenAt, block: s.block, session: s.session.state, tokens: s.tokens });
  });

  app.get("/v1/feeds", async (c) => {
    const s = await latest(c.env);
    return c.json({
      takenAt: s.takenAt,
      block: s.block,
      feeds: s.tokens.map((t) => ({
        symbol: t.symbol,
        feed: t.feed,
        price: t.feedPrice,
        answer: t.feedAnswer,
        roundId: t.feedRoundId,
        updatedAt: t.feedUpdatedAt,
        ageSeconds: t.feedAgeSeconds,
        frozen: t.feedFrozen,
        registryMultiplier: t.registryMultiplier,
        registryPaused: t.registryPaused,
      })),
    });
  });

  app.get("/v1/sessions", async (c) => {
    const s = await latest(c.env);
    const { next } = findLivenessTransitions(deps.calendar, s.takenAt);
    return c.json({ takenAt: s.takenAt, ...s.session, nextFeedTransition: next });
  });

  app.get("/v1/captures", async (c) => {
    const [runs, s] = await Promise.all([deps.stores(c.env).capture.listRuns(20), latest(c.env)]);
    const { next } = findLivenessTransitions(deps.calendar, s.takenAt);
    return c.json({ asOf: s.takenAt, nextFeedTransition: next, runs });
  });

  app.get("/v1/captures/:transitionAt", async (c) => {
    const at = Number(c.req.param("transitionAt"));
    if (!Number.isInteger(at)) return c.json({ error: "transitionAt must be unix seconds" }, 400);
    const store = deps.stores(c.env).capture;
    const run = await store.getRun(at);
    if (!run) return c.json({ error: "no capture run for that transition" }, 404);
    return c.json({ run, rows: await store.rowsFor(at) });
  });

  app.get("/v1/positions", async (c) => {
    const rows = await deps.stores(c.env).positions.latestPositions(CHAIN_ID);
    return c.json({ chainId: CHAIN_ID, count: rows.length, protectionCases: rows.filter((p) => p.protectionCase).length, positions: rows });
  });

  app.get("/v1/positions/:addr/shadow", async (c) => {
    const addr = c.req.param("addr");
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return c.json({ error: "address must be 0x + 40 hex" }, 400);
    const stores = deps.stores(c.env);
    const [rows, aaveRows] = await Promise.all([stores.positions.positionsForAddress(addr as Address), stores.aave.positionsForAddress(addr as Address)]);
    const latestPerMarket = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!latestPerMarket.has(r.marketId)) latestPerMarket.set(r.marketId, r);
    const morpho = [...latestPerMarket.values()].map((p) => ({ venue: "morpho" as const, ...p }));
    const aave = aaveRows.length > 0 ? [aaveRows[0] as (typeof aaveRows)[number]] : [];
    const positions = [...morpho, ...aave];
    const decision = positions.some((p) => p.protectionCase) ? "PROTECT" : positions.length === 0 ? "UNKNOWN" : "ALLOW";
    return c.json({ address: addr, chainId: CHAIN_ID, positions, history: rows.length + aaveRows.length, decision });
  });

  app.get("/v1/venues/morpho/markets", async (c) => {
    const rows = await deps.markets(c.env);
    return c.json({ chainId: 8453, count: rows.length, markets: rows });
  });

  app.get("/v1/venues/aave/positions", async (c) => {
    const stores = deps.stores(c.env);
    const [rows, known, meta] = await Promise.all([
      stores.aave.latestPositions(AAVE_CHAIN_ID),
      stores.aave.borrowers(AAVE_CHAIN_ID).catch(() => []),
      c.env.SNAPSHOTS.get<AaveMeta>(KV_AAVE_META, "json").catch(() => null),
    ]);
    return c.json({
      chainId: AAVE_CHAIN_ID,
      spoke: AAVE_SPOKE,
      takenAt: rows.reduce((m, p) => Math.max(m, p.takenAt), 0) || null,
      count: rows.length,
      protectionCases: rows.filter((p) => p.protectionCase).length,
      borrowersKnown: known.length,
      reserves: meta?.reserves.map((r) => ({ reserveId: r.reserveId, symbol: r.symbol, underlying: r.underlying, decimals: r.decimals, collateralFactor: r.collateralFactorBps / 10_000, paused: r.paused, frozen: r.frozen, borrowable: r.borrowable })) ?? null,
      note: "borrowers come from the indexer's Borrow-event scan of the MAG7 spoke (positions opened before its cutoff block appear once they borrow again); health is the spoke's formula at its oracle's prices and at the 1h Aerodrome TWAP where a pool exists; refreshed in rotating batches every five minutes",
      positions: rows,
    });
  });

  app.get("/v1/venues/aave/reserves", async (c) => {
    const reserves = await cachedJson(c.env, KV_AAVE, VENUE_CACHE_SECONDS, () => readAaveReserves(rpcUrl(c.env)));
    return c.json({ chainId: 8453, spoke: AAVE_SPOKE, reserves });
  });

  app.get("/v1/gaps", async (c) => {
    const s = await latest(c.env);
    return c.json(await gapsPanel(c.env, s.takenAt));
  });

  /** Seize watch (plan M9), as the indexer computes it; cached here for 30 minutes. */
  app.get("/v1/seize-watch", async (c) => {
    const w = await seizeWatch(c.env).catch((err: unknown) => {
      console.error("seize-watch failed", err instanceof Error ? err.message : err);
      return null;
    });
    return w ? c.json(w) : c.json({ error: "seize watch not available yet" }, 503);
  });

  app.get("/v1/assurance", async (c) => {
    const a = await readAssurance(c.env.SNAPSHOTS);
    if (a.status === "ok") return c.json(a.run);
    return c.json(a.status === "no run yet" ? { status: "no run yet" } : { status: "malformed", detail: a.detail });
  });

  app.get("/v1/events", (c) => c.json({ error: "not implemented", plan: "M5 indexer: Morpho, Aave, B20, OracleRegistry and Chainlink events with hash-chained roots" }, 501));

  /** One cron a minute: the snapshot, the reopen capture and the indexer kick; on every fifth minute the Morpho positions, a minute later the Aave batch, on minute 2 of every ten the gap panel, on minute 3 of every thirty the seize watch. */
  async function scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const snapshot = await takeSnapshot(env, true);
        await afterSnapshot(env, snapshot);
        if (positionsDue(snapshot.takenAt)) await refreshPositions(env, snapshot);
        if (aaveDue(snapshot.takenAt)) await refreshAave(env, snapshot);
        if (gapsDue(snapshot.takenAt)) await refreshGaps(env, snapshot.takenAt);
        if (seizeDue(snapshot.takenAt)) await refreshSeize(env);
      })(),
    );
    ctx.waitUntil(kickIndexer(env));
  }

  return { app, scheduled, takeSnapshot, afterSnapshot, refreshPositions, refreshAave, refreshGaps, computeGaps, refreshSeize, computeSeize };
}

/** Capture runs folded into the gap panel (one per reopen). */
const MAX_CAPTURE_RUNS_FOR_GAPS = 12;

/** Fallback trigger for the indexer: its own cron has not fired on this account, so this cron calls its
 *  POST /__tick through the service binding with the shared token. Never throws; the tick is idempotent. */
export async function kickIndexer(env: Env): Promise<void> {
  if (!env.INDEXER || !env.INDEXER_TICK_TOKEN) return;
  try {
    const res = await env.INDEXER.fetch("https://indexer/__tick", {
      method: "POST",
      headers: { authorization: `Bearer ${env.INDEXER_TICK_TOKEN}` },
      signal: AbortSignal.timeout(25_000),
    });
    console.log(`indexer tick via binding: ${res.status}`);
  } catch (err) {
    console.warn(`indexer tick via binding failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const live = createApp();

export default {
  fetch: live.app.fetch,
  scheduled: live.scheduled,
} satisfies ExportedHandler<Env>;
