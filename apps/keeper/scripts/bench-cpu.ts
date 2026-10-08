// CPU cost of one cron tick, measured with process.cpuUsage around the Worker's own `scheduled` handler, network
// replaced by recorded answers. The Workers Free plan allows 10 ms of CPU per invocation; a cold isolate compiles
// every function on the path the first time, so the first tick in a fresh process is the number that matters.
//
//   1. record (live network, once):  pnpm --filter @boundline/keeper exec tsx scripts/bench-cpu.ts record /tmp/keeper-rpc.json
//   2. measure (fresh process each):  pnpm --filter @boundline/keeper exec tsx scripts/bench-cpu.ts measure /tmp/keeper-rpc.json [idle|sign|vault]
//      worst case:                    NODE_OPTIONS=--jitless pnpm --filter @boundline/keeper exec tsx scripts/bench-cpu.ts measure …
//
// `idle` replays the live answers (nothing to do). `sign` rewrites the Protector's sizing so the second target is
// IN_BAND with a partial: the protection job signs and arms a validity transaction (the sequencer is faked). `vault`
// runs the vault job against a line whose shadow LTV is past grace, so it signs instead.
import { readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

type Json = unknown;
interface Rec {
  method: string;
  params: Json;
  result?: Json;
  error?: Json;
}

const [mode, file, scenario = "idle"] = process.argv.slice(2);
if (!mode || !file) {
  console.error("usage: bench-cpu.ts record|measure <fixtures.json> [idle|sign|vault]");
  process.exit(2);
}

const keyOf = (method: string, params: Json): string => `${method} ${JSON.stringify(params)}`;
const realFetch = globalThis.fetch;

// The Worker's vars, as in wrangler.jsonc (public RPCs; no keyed RPC in the bench).
const VARS = {
  BASE_RPC_URL: "https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org",
  BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org,https://base-sepolia-rpc.publicnode.com,https://base-sepolia.drpc.org",
  PROTECTOR: "0x5c546946c909718040dd686f63df6cb5e4df442c",
  PROTECT_TARGETS:
    "0xdcae709341aab652144e8afcb47479fe49e133a1:0xB789aD318945B37566E2549F65526Cc269a482Fc:0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a:5,0xdcae709341aab652144e8afcb47479fe49e133a1:0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E:0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a:5",
  BASE_SEPOLIA_SEQUENCER_URL: "https://sepolia-sequencer.base.org",
  MIRROR_HOLD_FEED: "",
  MIRROR_HOLD_REGISTRY: "",
  DESK_PROTECTION_VAULT: "0x87f600279F021ca859b9903DE884d3A7A169f38c",
  CREDIT_DESK: "0x39aBaDc0aAa12D1F7e259b89536Aa1848997399a",
  VAULT_TARGETS: process.env.BENCH_VAULT_TARGETS ?? "1:5200:4500:0x7a53b459be6e5e9a12324cc3417bb027daf73f65:0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a:5",
};

function memoryKv(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  } as unknown as KVNamespace;
}

async function runScheduled(env: Record<string, unknown>): Promise<void> {
  const mod = (await import("../src/index.js")) as { default: { scheduled: (c: unknown, e: unknown, x: unknown) => Promise<void> } };
  const pending: Promise<unknown>[] = [];
  await mod.default.scheduled({ cron: "* * * * *", scheduledTime: Date.now() }, env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined });
  await Promise.all(pending);
}

if (mode === "record") {
  const recs: Rec[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await realFetch(input, init);
    const text = await res.clone().text();
    try {
      const req = JSON.parse(String(init?.body ?? "null")) as Json;
      const out = JSON.parse(text) as Json;
      const reqs = Array.isArray(req) ? req : [req];
      const outs = Array.isArray(out) ? out : [out];
      for (const r of reqs as { id: number; method: string; params: Json }[]) {
        const o = (outs as { id: number; result?: Json; error?: Json }[]).find((x) => x.id === r.id);
        if (o) recs.push({ method: r.method, params: r.params, result: o.result, error: o.error });
      }
    } catch {
      /* not JSON-RPC */
    }
    return res;
  }) as typeof fetch;
  const env = { ...VARS, KEEPER_KEY: generatePrivateKey(), PROTECT_KEY: generatePrivateKey(), KEEPER_STATE: memoryKv() };
  await runScheduled(env);
  // The signing path's extra reads, recorded once so `sign`/`vault` replay them too.
  const sep = "https://sepolia.base.org";
  for (const [method, params] of [
    ["eth_getStorageAt", ["0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a", "0x5", "latest"]],
    ["eth_gasPrice", []],
    ["eth_blockNumber", []],
  ] as [string, Json[]][]) {
    const res = await realFetch(sep, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const o = (await res.json()) as { result?: Json; error?: Json };
    recs.push({ method, params, result: o.result, error: o.error });
  }
  writeFileSync(file, JSON.stringify(recs, null, 1));
  console.log(`recorded ${recs.length} JSON-RPC answers into ${file}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------- measure

const recs = JSON.parse(readFileSync(file, "utf8")) as Rec[];
const answers = new Map<string, Rec>();
for (const r of recs) answers.set(keyOf(r.method, r.params), r);
const byMethod = new Map<string, Rec>();
for (const r of recs) if (!byMethod.has(r.method)) byMethod.set(r.method, r);

// Sizing word lists for the `sign` scenario: target 2 IN_BAND with a partial.
const W = (x: bigint | number) => BigInt(x).toString(16).padStart(64, "0");
function sizingWords(standing: number, partial: boolean): string {
  const f = [standing, 940611, 1805321834834n, 1805453, 3.3e36, 3.3e36, 1, 0.59e18, 0.59e18, 1.01e18, 1e18, 0.58e18, partial ? 10_000 : 0, 0, partial ? 33_000 : 0, 0, 0, 0];
  return f.map((x) => W(BigInt(Math.round(Number(x))))).join("");
}
function aggregate3Return(payloads: string[]): string {
  // (bool success, bytes returnData)[]
  const elems = payloads.map((p) => W(1) + W(0x40) + W(p.length / 2) + p.padEnd(Math.ceil(p.length / 64) * 64, "0"));
  let off = payloads.length * 32;
  const offs: string[] = [];
  for (const e of elems) {
    offs.push(W(off));
    off += e.length / 2;
  }
  return `0x${W(0x20)}${W(payloads.length)}${offs.join("")}${elems.join("")}`;
}

const PROTECT_KEY = generatePrivateKey();
const protectSigner = privateKeyToAccount(PROTECT_KEY).address;
function vaultInGrace(): string {
  const line = [W(0x626f756e646c696e65n), W(0xb789ad318945b37566e2549f65526cc269a482fcn), W(0x4a03n), W(0xb2000000000000000000000e063e65377ca34141n), W(2), W(1), W(0), W(1791400000), W(3_300_000)].join("");
  const quote = [W(0), W(5), W(0), W(2_000_000), W(0), W(3_300_000), W(0), W(0), W(0.5e18), W(0)].join("");
  const ladder = [W(400_000), W(0), W(1_000_000), W((1n << 128n) - 1n - 1_400_000n)].join("");
  return aggregate3Return([W(BigInt(protectSigner)), W(0), line, quote, W(3.0e36), ladder]);
}

function answer(method: string, params: Json): Rec | undefined {
  if (method === "base_sendRawTransactionValidity") return { method, params, result: `0x${"ab".repeat(32)}` };
  if (scenario === "vault" && method === "eth_call") {
    const data = String((params as [{ data: string }])[0]?.data ?? "");
    if (data.startsWith("0x82ad56cb") && data.includes("3c7d9255")) return { method, params, result: vaultInGrace() };
  }
  if (scenario === "sign" && method === "eth_call") {
    const data = String((params as [{ data: string }])[0]?.data ?? "");
    if (data.startsWith("0x82ad56cb") && data.includes("94eb1b61")) return { method, params, result: aggregate3Return([sizingWords(2, false), sizingWords(3, true)]) };
  }
  if (method === "eth_getTransactionCount") return { method, params, result: "0x5" };
  return answers.get(keyOf(method, params)) ?? byMethod.get(method);
}

globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const req = JSON.parse(String(init?.body ?? "null")) as { id: number; method: string; params: Json } | { id: number; method: string; params: Json }[];
  const one = (r: { id: number; method: string; params: Json }) => {
    const a = answer(r.method, r.params);
    if (!a) return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: `bench: no recorded answer for ${r.method}` } };
    return a.error !== undefined ? { jsonrpc: "2.0", id: r.id, error: a.error } : { jsonrpc: "2.0", id: r.id, result: a.result };
  };
  const body = Array.isArray(req) ? req.map(one) : one(req);
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const env = {
  ...VARS,
  ...(scenario === "vault" ? {} : { VAULT_TARGETS: "" }),
  KEEPER_KEY: generatePrivateKey(),
  PROTECT_KEY,
  KEEPER_STATE: memoryKv(),
};
const silent = console.log;
const lines: string[] = [];
console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));

const t0 = process.cpuUsage();
const imported = await import("../src/index.js");
void imported;
await (await import("../src/warm.js")).warmed;
// Warm the harness's own fake fetch (Node's Response and JSON body are JavaScript, unlike workerd's native ones), so
// tick #1 measures the keeper's code, not the bench's.
for (const body of [{ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, [{ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }]]) {
  await (await fetch("http://bench.invalid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) })).json();
}
const tImport = process.cpuUsage(t0);
if (process.env.BENCH_STEPS) {
  // Tick #1 broken into its steps (the order runCron uses).
  const m = (await import("../src/index.js")) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>> & { vaultConfig: (e: unknown) => unknown };
  const { readHold } = await import("../src/env.js");
  const step = async (label: string, fn: () => Promise<unknown>) => {
    const s0 = process.cpuUsage();
    const out = await fn();
    const d0 = process.cpuUsage(s0);
    silent(`  step ${label.padEnd(14)} ${((d0.user + d0.system) / 1000).toFixed(2)} ms`);
    return out;
  };
  const cfg = m.vaultConfig(env);
  const protect = (await step("protectTick", () => m.protectTick!(env))) as { targets: { decision: { action: string } | null }[] } | null;
  const hold = await step("readHold", () => readHold(env as never));
  const vault = await step("vaultTick", () => m.vaultTick!(env, cfg, protect?.targets.some((t) => t.decision?.action !== "none") ?? false));
  const state = (await import("../src/events.js")).parseState(null);
  await step("eventsTick", () => m.eventsTick!(env, state, protect, vault, cfg));
  await step("mirror tick", () => m.tick!(env, hold));
}
const results: number[] = [];
for (let i = 0; i < 4; i += 1) {
  const s = process.cpuUsage();
  await runScheduled(env);
  const d = process.cpuUsage(s);
  results.push((d.user + d.system) / 1000);
}
console.log = silent;
console.log(`scenario=${scenario} jitless=${process.execArgv.includes("--jitless") || (process.env.NODE_OPTIONS ?? "").includes("--jitless")}`);
console.log(`module evaluation (startup, not billed per tick): ${((tImport.user + tImport.system) / 1000).toFixed(2)} ms`);
results.forEach((ms, i) => console.log(`tick #${i + 1}${i === 0 ? " (cold)" : ""}: cpu ${ms.toFixed(2)} ms`));
for (const l of lines.slice(0, 3)) console.log(`  log: ${l.slice(0, 240)}`);
