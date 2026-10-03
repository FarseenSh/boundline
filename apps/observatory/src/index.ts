import { Hono } from "hono";
import { readAaveReserves } from "./aave.js";
import { liveCalendar } from "./calendar-impl.js";
import { appendSnapshot } from "./d1.js";
import type { Env } from "./env.js";
import { renderPage } from "./html.js";
import { discoverB20Markets, readMarkets } from "./morpho.js";
import { createViemReader } from "./reader.js";
import { buildSnapshot, type Snapshot } from "./snapshot.js";

const KV_LATEST = "latest";
const KV_MORPHO = "morpho-markets";
const KV_AAVE = "aave-reserves";

async function takeSnapshot(env: Env, persist: boolean): Promise<Snapshot> {
  const reads = await createViemReader(env.BASE_RPC_URL).read();
  const snapshot = buildSnapshot(reads, liveCalendar, Math.floor(Date.now() / 1000));
  await env.SNAPSHOTS.put(KV_LATEST, JSON.stringify(snapshot));
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

async function cachedJson<T>(env: Env, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = await env.SNAPSHOTS.get<T>(key, "json");
  if (hit) return hit;
  const value = await load();
  await env.SNAPSHOTS.put(key, JSON.stringify(value), { expirationTtl: ttl });
  return value;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => c.html(renderPage(await latest(c.env))));
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
  return c.json({ takenAt: s.takenAt, ...s.session });
});

app.get("/v1/venues/morpho/markets", async (c) => {
  const rows = await cachedJson(c.env, KV_MORPHO, 300, async () => readMarkets(c.env.BASE_RPC_URL, await discoverB20Markets()));
  return c.json({ chainId: 8453, count: rows.length, markets: rows });
});

app.get("/v1/venues/aave/positions", async (c) => {
  const reserves = await cachedJson(c.env, KV_AAVE, 300, () => readAaveReserves(c.env.BASE_RPC_URL));
  // TODO(M5 indexer): scan Borrow events on the spoke, then getUserAccountData per borrower.
  return c.json({ chainId: 8453, spoke: "MAG7", reserves, borrowers: { status: "not_indexed_yet" } });
});

app.get("/v1/events", (c) => c.json({ error: "not implemented", plan: "M5 indexer: Morpho, Aave, B20, OracleRegistry and Chainlink events with hash-chained roots" }, 501));

app.get("/v1/positions/:addr/shadow", (c) =>
  // Planned shape: { address, venue, market, collateral, debt, venueHealthFactor, shadowHealthFactor (at the 1h DEX TWAP),
  //                  session, decision: ALLOW | HOLD_SESSION | HOLD_FEED | HOLD_ISSUER | GRACE | RECOVER, reasons: [] }
  c.json({ error: "not implemented", address: c.req.param("addr"), plan: "shadow health at the 24/7 DEX price (M1/M6)" }, 501),
);

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(takeSnapshot(env, true));
  },
} satisfies ExportedHandler<Env>;
