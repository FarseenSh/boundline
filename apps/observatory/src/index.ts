import { Hono } from "hono";
import type { Address } from "viem";
import { readAaveReserves } from "./aave.js";
import { liveCalendar } from "./calendar-impl.js";
import type { CalendarPort } from "./calendar-port.js";
import { findLivenessTransitions } from "./capture.js";
import { appendSnapshot } from "./d1.js";
import { rpcUrl, type Env } from "./env.js";
import { renderPage } from "./html.js";
import { runCapture, runPositions } from "./jobs.js";
import { KV_LATEST, storeLatest } from "./kv-latest.js";
import { discoverB20Markets, readMarkets, type MarketRow } from "./morpho.js";
import { CHAIN_ID, makeClient } from "./positions.js";
import { createViemReader, type ChainReader } from "./reader.js";
import { buildSnapshot, type Snapshot } from "./snapshot.js";
import { d1Stores, type Stores } from "./stores.js";

const KV_MORPHO = "morpho-markets";
const KV_AAVE = "aave-reserves";
/** Venue reads are cached in KV on request; 15 minutes keeps a crawler from spending the free tier's 1,000 KV writes a day. */
const VENUE_CACHE_SECONDS = 900;

export interface AppDeps {
  stores(env: Env): Stores;
  calendar: CalendarPort;
  reader(env: Env): ChainReader;
  fetchImpl: typeof fetch;
  /** The B20 Morpho markets, cached in KV; overridable so tests never call the API. */
  markets(env: Env): Promise<MarketRow[]>;
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
  reader: (env) => createViemReader(rpcUrl(env)),
  fetchImpl: (input, init) => fetch(input, init),
  markets: (env) => cachedJson(env, KV_MORPHO, VENUE_CACHE_SECONDS, async () => readMarkets(rpcUrl(env), await discoverB20Markets())),
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

  /** The reopen capture and the position refresh ride on the same tick as the snapshot; neither may break it. */
  async function afterSnapshot(env: Env, snapshot: Snapshot): Promise<void> {
    const stores = deps.stores(env);
    try {
      const c = await runCapture(stores.capture, deps.calendar, snapshot);
      if (c.status !== "idle") console.log(`capture ${c.status} transition=${c.transitionAt} phase=${c.phase} ticks=${c.ticks}`);
    } catch (err) {
      console.error("capture job failed", err instanceof Error ? err.message : err);
    }
    try {
      const markets = await deps.markets(env);
      const r = await runPositions({ store: stores.positions, client: makeClient(rpcUrl(env)), markets, fetchImpl: deps.fetchImpl, snapshot });
      console.log(`positions scanned=${r.scanned ? `${r.scanned.from}-${r.scanned.to}` : "none"} seeded=${r.seeded} new=${r.newBorrowers} refreshed=${r.refreshed ?? "skip"} errors=${r.errors.length}`);
    } catch (err) {
      console.error("positions job failed", err instanceof Error ? err.message : err);
    }
  }

  const app = new Hono<{ Bindings: Env }>();

  app.get("/", async (c) => {
    const s = await latest(c.env);
    const stores = deps.stores(c.env);
    const [capture, positions] = await Promise.all([
      stores.capture.latestRun().catch((err: unknown) => {
        console.error("latestRun failed", err instanceof Error ? err.message : err);
        return null;
      }),
      stores.positions.latestPositions(CHAIN_ID).catch((err: unknown) => {
        console.error("latestPositions failed", err instanceof Error ? err.message : err);
        return null;
      }),
    ]);
    const { next } = findLivenessTransitions(deps.calendar, s.takenAt);
    return c.html(renderPage(s, { capture, nextTransition: next, positions }));
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
    const runs = await deps.stores(c.env).capture.listRuns(20);
    const { next } = findLivenessTransitions(deps.calendar, Math.floor(Date.now() / 1000));
    return c.json({ nextFeedTransition: next, runs });
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
    const rows = await deps.stores(c.env).positions.positionsForAddress(addr as Address);
    const latestPerMarket = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!latestPerMarket.has(r.marketId)) latestPerMarket.set(r.marketId, r);
    const latestRows = [...latestPerMarket.values()];
    return c.json({ address: addr, chainId: CHAIN_ID, positions: latestRows, history: rows.length, decision: latestRows.some((p) => p.protectionCase) ? "PROTECT" : latestRows.length === 0 ? "UNKNOWN" : "ALLOW" });
  });

  app.get("/v1/venues/morpho/markets", async (c) => {
    const rows = await deps.markets(c.env);
    return c.json({ chainId: 8453, count: rows.length, markets: rows });
  });

  app.get("/v1/venues/aave/positions", async (c) => {
    const reserves = await cachedJson(c.env, KV_AAVE, VENUE_CACHE_SECONDS, () => readAaveReserves(rpcUrl(c.env)));
    return c.json({ chainId: 8453, spoke: "MAG7", reserves, borrowers: { status: "not_indexed_yet", note: "Morpho borrowers are under /v1/positions; the Aave spoke scan is not built yet" } });
  });

  app.get("/v1/events", (c) => c.json({ error: "not implemented", plan: "M5 indexer: Morpho, Aave, B20, OracleRegistry and Chainlink events with hash-chained roots" }, 501));

  async function scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const snapshot = await takeSnapshot(env, true);
        await afterSnapshot(env, snapshot);
      })(),
    );
  }

  return { app, scheduled, takeSnapshot, afterSnapshot };
}

const live = createApp();

export default {
  fetch: live.app.fetch,
  scheduled: live.scheduled,
} satisfies ExportedHandler<Env>;
