// CPU cost of one indexer tick, measured with process.cpuUsage over a recorded tick (network excluded).
//
//   record: pnpm --filter @boundline/indexer exec tsx scripts/bench-tick.ts record <fixture.json>
//           runs one tick from the LIVE cursors (read from the deployed indexer) against the RPC lists of
//           wrangler.jsonc and records every JSON-RPC answer, plus the live cursors, roots and the Sepolia market
//           events the reconciliation replays.
//   bench:  pnpm --filter @boundline/indexer exec tsx scripts/bench-tick.ts bench <fixture.json>
//           replays the recording through a fake fetch and reports the tick's CPU, cold and warm. Run it also with
//           NODE_OPTIONS=--jitless to bracket what a fresh Workers isolate pays (the Free plan allows 10 ms).
//
// The tick runs exactly as src/index.ts runs it (same deps, same budget vars), over an in-memory store seeded with
// the live state, so the numbers are the Worker's minus D1's bindings (I/O, not CPU).
import { readFileSync, writeFileSync } from "node:fs";
import { activeSources, tickDeps } from "../src/index.js";
import { MemoryStore } from "../src/store-memory.js";
import { SEPOLIA, SEPOLIA_STACK } from "../src/sources.js";
import { runTick, type TickSummary } from "../src/tick.js";
import type { Env } from "../src/env.js";
import type { EventRow } from "../src/decode.js";
import type { CursorRow, DailyRootRow } from "../src/store.js";

const LIVE = "https://boundline-indexer.papermind-ai.workers.dev";
const VARS = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n"),
).vars as Record<string, string>;
const env = { ...VARS, DB: undefined as unknown as D1Database } as unknown as Env;

interface Fixture {
  recordedAt: number;
  cursors: CursorRow[];
  roots: DailyRootRow[];
  sepoliaMarketEvents: EventRow[];
  /** key = method + JSON(params) → the answers in the order they were given, ids replaced by __ID__ */
  rpc: Record<string, string[]>;
}

function keyOf(body: string): { key: string; id: string } {
  const b = JSON.parse(body) as { id: number | string; method: string; params: unknown };
  return { key: `${b.method} ${JSON.stringify(b.params)}`, id: String(b.id) };
}

async function seededStore(fx: Pick<Fixture, "cursors" | "roots" | "sepoliaMarketEvents">): Promise<MemoryStore> {
  const store = new MemoryStore();
  for (const c of fx.cursors) await store.setCursor(c);
  for (const r of fx.roots) await store.putRoot(r);
  await store.insertEvents(fx.sepoliaMarketEvents);
  return store;
}

function cpuMs(start: NodeJS.CpuUsage): number {
  const d = process.cpuUsage(start);
  return (d.user + d.system) / 1000;
}

async function record(path: string): Promise<void> {
  const cursors = ((await (await fetch(`${LIVE}/v1/cursors`)).json()) as { cursors: CursorRow[] }).cursors
    // the tick marker would make the recorded tick skip itself
    .filter((c) => c.source !== "tick" && c.source !== "tick-done");
  const roots: DailyRootRow[] = [];
  for (const chainId of [8453, 84532]) {
    const r = (await (await fetch(`${LIVE}/v1/roots?chainId=${chainId}`)).json()) as { roots: DailyRootRow[] };
    roots.push(...r.roots.slice(0, 1));
  }
  const ev = (await (await fetch(`${LIVE}/v1/events?chainId=${SEPOLIA}&source=morpho-market-aaplt&limit=500`)).json()) as {
    events: { chainId: number; blockNumber: number; blockTime: number; txHash: `0x${string}`; logIndex: number; address: `0x${string}`; topic0: `0x${string}`; name: string; args: unknown }[];
  };
  const { canonicalJson } = await import("../src/canonical.js");
  const sepoliaMarketEvents: EventRow[] = ev.events.map((e) => ({ ...e, argsJson: canonicalJson(e.args) }));
  const rpc: Record<string, string[]> = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await realFetch(input, init);
    if (typeof init?.body === "string" && init.body.includes('"jsonrpc"')) {
      const text = await res.clone().text();
      const { key } = keyOf(init.body);
      (rpc[key] ??= []).push(text.replace(/"id":\s*("[^"]*"|\d+)/, '"id":__ID__'));
    }
    return res;
  }) as typeof fetch;
  const recordedAt = rotationNow(Math.floor(Date.now() / 1000));
  const store = await seededStore({ cursors, roots, sepoliaMarketEvents });
  const summary = await runTick(tickDeps(env, store, () => recordedAt), tickConfig());
  globalThis.fetch = realFetch;
  printSummary(summary);
  writeFileSync(path, JSON.stringify({ recordedAt, cursors, roots, sepoliaMarketEvents, rpc } satisfies Fixture));
  console.log(`recorded ${Object.keys(rpc).length} RPC answers, ${sepoliaMarketEvents.length} market events → ${path}`);
}

/** BENCH_FIRST=<source id> picks a `now` in the current hour whose minute puts that source first in the rotation. */
function rotationNow(now: number): number {
  const first = process.env.BENCH_FIRST;
  if (!first) return now;
  const ids = activeSources(env).map((s) => s.id);
  const idx = ids.indexOf(first);
  if (idx < 0) throw new Error(`BENCH_FIRST: unknown source ${first} (have ${ids.join(", ")})`);
  const minute = Math.floor(now / 60);
  const shift = (((idx - (minute % ids.length)) % ids.length) + ids.length) % ids.length;
  return (minute + shift) * 60 + 30;
}

function tickConfig() {
  // same as src/index.ts
  return {
    sources: activeSources(env),
    markets: [{ chainId: SEPOLIA, morpho: SEPOLIA_STACK.morpho, marketId: SEPOLIA_STACK.market.id }],
    maxRanges: Number(VARS.MAX_RANGES_PER_TICK),
    maxRangesTotal: Number(VARS.MAX_RANGES_TOTAL_PER_TICK),
    maxLogs: Number(VARS.MAX_LOGS_PER_TICK),
  };
}

function printSummary(s: TickSummary): void {
  for (const r of s.ingest) {
    console.log(`  ${r.source.padEnd(28)} ${r.cursorBefore}->${r.cursorAfter} ranges=${r.ranges} logs=${r.logs}${r.budgetExhausted ? " (budget)" : ""}${r.error ? ` ERROR ${r.error}` : ""}`);
  }
  if (s.reconciled.length) console.log(`  reconciled ${JSON.stringify(s.reconciled)}`);
  if (s.roots.length) console.log(`  roots ${s.roots.map((r) => `${r.chainId}:${r.day}:${r.eventCount}`).join(" ")}`);
  if (s.errors.length) console.log(`  errors ${s.errors.join(" | ")}`);
}

async function bench(path: string): Promise<void> {
  const fx = JSON.parse(readFileSync(path, "utf8")) as Fixture;
  let misses = 0;
  let served = new Map<string, number>();
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { key, id } = keyOf(String(init?.body ?? "{}"));
    const answers = fx.rpc[key];
    const n = served.get(key) ?? 0;
    served.set(key, n + 1);
    const text = answers?.[Math.min(n, answers.length - 1)];
    if (text === undefined) {
      misses += 1;
      return new Response(`{"jsonrpc":"2.0","id":${id},"error":{"code":-32000,"message":"not recorded"}}`, { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(text.replace("__ID__", id), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  // Node's own first use of Response/undici, AbortSignal.timeout and the in-memory store costs several ms that a Workers
  // isolate does not pay (fetch and Response are native there, the store is D1): warm those, never our tick code.
  if (process.env.BENCH_PREWARM !== "0") {
    const res = new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', { status: 200, headers: { "content-type": "application/json" } });
    JSON.parse(await res.text());
    AbortSignal.timeout(1);
    const warm = new MemoryStore();
    await warm.setCursor({ chainId: 1, source: "x", lastBlock: 1, lastBlockTime: 1, updatedAt: 1 });
    await warm.getCursor(1, "x");
    await warm.listCursors();
    await warm.insertEvents([]);
    await warm.queryEvents({ chainId: 1, limit: 1 });
    await warm.eventsOfAddress(1, "0x00");
    await warm.insertReconciliations([]);
  }
  for (let i = 0; i < 4; i += 1) {
    served = new Map();
    const store = await seededStore(fx);
    const profile = i === 0 && process.env.BENCH_PROFILE ? await startProfile() : null;
    const s0 = process.cpuUsage();
    const t0 = performance.now();
    const summary = await runTick(tickDeps(env, store, () => fx.recordedAt), tickConfig());
    const cpu = cpuMs(s0);
    if (profile) await profile(process.env.BENCH_PROFILE!);
    const logs = summary.ingest.reduce((n, r) => n + r.logs, 0);
    const ranges = summary.ingest.reduce((n, r) => n + r.ranges, 0);
    console.log(`tick #${i + 1}${i === 0 ? " (cold)" : ""}: cpu ${cpu.toFixed(2)} ms, wall ${(performance.now() - t0).toFixed(1)} ms, ranges ${ranges}, logs ${logs}, reconciled ${summary.reconciled.length}, roots ${summary.roots.length}, misses ${misses}`);
    if (i === 0) printSummary(summary);
  }
}

/** BENCH_PROFILE=<file.cpuprofile>: a sampling profile of the cold tick only (inspector, 100 µs interval). */
async function startProfile(): Promise<(path: string) => Promise<void>> {
  const { Session } = await import("node:inspector/promises");
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 100 });
  await session.post("Profiler.start");
  return async (path: string) => {
    const { profile } = (await session.post("Profiler.stop")) as { profile: unknown };
    writeFileSync(path, JSON.stringify(profile));
    session.disconnect();
  };
}

const [mode, file] = process.argv.slice(2);
if (!file || (mode !== "record" && mode !== "bench")) {
  console.error("usage: tsx scripts/bench-tick.ts record|bench <fixture.json>");
  process.exit(2);
}
await (mode === "record" ? record(file) : bench(file));
