// CPU cost of the API's new hot paths (8 Oct 2026), measured with process.cpuUsage the way
// apps/observatory/scripts/bench-cpu.ts does. Run normally and with NODE_OPTIONS=--jitless to bracket what a cold
// Workers isolate pays (the Free plan allows 10 ms of CPU per invocation):
//   pnpm --filter @boundline/api exec tsx scripts/bench-cpu.ts
//   NODE_OPTIONS=--jitless pnpm --filter @boundline/api exec tsx scripts/bench-cpu.ts
// Network is faked (fixed RPC answers), so the numbers are the Worker's own work: routing, ABI words, hashing, JSON,
// HMAC, store calls.
// Measured 8 Oct 2026 (Node 26, JIT / --jitless): POST /v1/route first request 8.1 / 6.9 ms, then 1.8–3.0 / 5.3–5.5 ms;
// a keeper event logged and one signed delivery sent 3.3 / 1.2 ms cold, 1.0 / 0.3 ms warm. Before the switch to Hono's
// PatternRouter (src/app.ts) the first request of any route also paid the default SmartRouter's regex build, 24–26 ms.
// The cron: the first version (two sources a tick, a 50-event backfill, deliveries sent in the poll) cost 14.25 ms on a
// cold tick with real SQL (node:sqlite) and never wrote a cursor live, consistent with the 10 ms cap scheduled
// invocations get; the bounded tick (one source, at most 4 new events, the cursor primed on the first poll, at most 2
// deliveries from the retry pass, the app built only for an echo delivery) costs 9.3 / 5.4 ms in the worst cold case
// (4 new events and 2 echo deliveries, real SQL) and 1.5–2.2 ms warm.
import { createApp } from "../src/app.js";
import { sha256Hex } from "../src/auth.js";
import { createMemoryStore } from "../src/db.js";
import type { MarketConfig } from "../src/policy.js";
import { createMemoryWebhookStore, ingest, pollSource, retryDue, type IndexerGet } from "../src/webhooks.js";
import { makeWebhookRuntime } from "../src/app.js";

const W = (x: bigint | number) => BigInt(x).toString(16).padStart(64, "0");
const A = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const DESK = "0x39aBaDc0aAa12D1F7e259b89536Aa1848997399a";
const GATE = "0x92f59437d4ef5CDcEAe2CcDE89B03A7B4B1Ae427";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const IRM = "0x46415998764C29aB2a25CbeA6254146D50D22687";
const AAPLT = "0xB2000000000000000000000E063E65377cA34141";
const MARKET = "0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047";
const PARTNER = "0x626f756e646c696e652d61707000000000000000000000000000000000000000";

/** The aggregate3 answer for [blockNumber, market, idToMarketParams, check, tickerPolicy, partner], built once. */
function aggregateAnswer(): string {
  const results = [
    W(47_836_573n),
    [10_000_220n, 10_000_220_000_000n, 3_405_541n, 3_405_541_000_000n, 1_791_441_000n, 0n].map(W).join(""),
    `${A("0x036CbD53842c5426634e7929541eC2318f3dCF7e")}${A(AAPLT)}${A("0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854")}${A(IRM)}${W(625n * 10n ** 15n)}`,
    [0n, 4n, 33_568_300_000n, 1_791_401_927n, 10n ** 18n, 0n, 0n].map(W).join(""),
    [1n, 5n * 10n ** 17n, 1_000_000n, 100_000_000n, 500_000_000n, 3_000_000n].map(W).join(""),
    `${A(DESK)}${W(0)}${W(0)}${W(1)}${W(1)}${W(1_000_000_000n)}${W(3_000_000n)}`,
  ];
  const elems = results.map((d) => W(1) + W(0x40) + W(d.length / 2) + d);
  let offset = results.length * 32;
  const offsets: string[] = [];
  for (const e of elems) {
    offsets.push(W(offset));
    offset += e.length / 2;
  }
  return `0x${W(0x20)}${W(results.length)}${offsets.join("")}${elems.join("")}`;
}
const AGG = aggregateAnswer();
const RATE = `0x${W(1_268_391_679n)}`;
const rpc = (async (_u: unknown, init?: RequestInit) => {
  const req = JSON.parse(String(init?.body)) as { id: number; params: [{ to: string }] };
  const result = req.params[0].to.toLowerCase() === IRM.toLowerCase() ? RATE : AGG;
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

async function cpu<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const s = process.cpuUsage();
  const t0 = performance.now();
  const out = await fn();
  const d = process.cpuUsage(s);
  console.log(`${label.padEnd(58)} cpu ${((d.user + d.system) / 1000).toFixed(2)} ms  wall ${(performance.now() - t0).toFixed(2)} ms`);
  return out;
}

const KEY = "bl_bench";
const store = createMemoryStore();
store.partners.push({ partnerId: PARTNER, name: "bench", apiKeyHash: await sha256Hex(KEY), policyVersion: 1, createdAt: 0 });
const markets: MarketConfig[] = [{ symbol: "AAPLt", collateral: AAPLT, marketId: MARKET, preLiquidation: "0xdcae709341aab652144e8afcb47479fe49e133a1", protector: "0x5c546946c909718040dd686f63df6cb5e4df442c" }];
const webhookStore = createMemoryWebhookStore();
const pending: Promise<unknown>[] = [];
let n = 0;
const deps = {
  store,
  desk: null,
  chainId: 84532,
  now: () => Math.floor(Date.now() / 1000),
  uuid: () => `u${++n}`,
  markets,
  route: { sepolia: { rpcs: ["https://rpc"], fetchImpl: rpc, desk: DESK as `0x${string}`, gate: GATE as `0x${string}`, morpho: MORPHO as `0x${string}`, markets, vault: null }, mainnet: null },
  routeSigner: null,
  webhookStore,
  selfHosts: ["api.bench"],
  defer: (p: Promise<unknown>) => pending.push(p),
  deliveryFetch: (async () => new Response("ok")) as unknown as typeof fetch,
};
const app = createApp(deps);
const body = JSON.stringify({ chainId: 84532, borrower: "0xB789aD318945B37566E2549F65526Cc269a482Fc", collateral: [{ symbol: "AAPLt", amount: "0.02" }], amountUsdc: "3.00" });
const routeReq = () => app.request("/v1/route", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body });

// Node builds its web Request/Response/stream machinery lazily (workerd has it natively): pay that outside the
// measurement, without touching any API code, so "#1 (cold)" is the app's own first-request cost.
await new Response(JSON.stringify({ warm: true })).json();
await new Request("https://warm.example", { method: "POST", body: "{}" }).text();
await crypto.subtle.digest("SHA-256", new TextEncoder().encode("warm"));

console.log("--- POST /v1/route end to end (Hono, auth, one multicall + one IRM call faked, router, hashes, store)");
for (const label of ["#1 (cold)", "#2", "#3"]) {
  const res = await cpu(`POST /v1/route ${label}`, routeReq);
  if (res.status !== 200) throw new Error(`route answered ${res.status}: ${await res.text()}`);
}

console.log("--- webhooks");
await webhookStore.createWebhook({ id: "wh_1", partnerId: PARTNER, url: "https://partner.example/hook", events: ["*"], description: "", secret: "whsec_bench", active: true, createdAt: 0 });
// line 1 belongs to the partner, so the cron's events are attributed and their deliveries queued
await store.rememberLine({ lineId: "1", partnerId: PARTNER, user: "0xB789aD318945B37566E2549F65526Cc269a482Fc", marketId: MARKET, firstSeen: 0 });
const rt = makeWebhookRuntime(deps as never, async (r) => app.fetch(r), (p) => pending.push(p))!;
await cpu("ingest one keeper event + one signed delivery #1 (cold)", async () => {
  await ingest(rt, { type: "grace", chainId: 84532, at: deps.now(), source: "keeper", partnerId: PARTNER, data: { shadowLtvBps: 5340 }, dedupeKey: "b1" });
  await Promise.all(pending.splice(0));
});
await cpu("ingest one keeper event + one signed delivery #2", async () => {
  await ingest(rt, { type: "grace", chainId: 84532, at: deps.now(), source: "keeper", partnerId: PARTNER, data: { shadowLtvBps: 5350 }, dedupeKey: "b2" });
  await Promise.all(pending.splice(0));
});
const events = Array.from({ length: 20 }, (_, i) => ({ chainId: 84532, blockNumber: 47_836_000 + i, blockTime: deps.now() - 60, txHash: `0x${W(i)}`, logIndex: 1, address: DESK, name: "Decision", args: { action: `0x${Buffer.from(i % 2 ? "HOLD" : "RELEASE").toString("hex").padEnd(64, "0")}`, amount: "0", decisionHash: `0x${W(i + 1)}`, lineId: "1", price8: "0" } })).reverse();
const indexerGet: IndexerGet = async (path) => ({ ok: true, data: { events: /[?&]limit=1(&|$)/.test(path) ? events.slice(-1) : events, next: null } });
await cpu("cron: first poll of a source (primes the cursor only)", () => pollSource(rt, "credit-desk", 84532, indexerGet));
await cpu("cron: a tick with 4 new events (deliveries queued)", () => pollSource(rt, "credit-desk", 84532, indexerGet));
await cpu("cron: retry pass sending 2 due deliveries", async () => {
  await retryDue(rt, 2);
  await Promise.all(pending.splice(0));
});
await cpu("cron: a tick with nothing new (all duplicates)", () => pollSource(rt, "credit-desk", 84532, async () => ({ ok: true, data: { events: [], next: null } })));
