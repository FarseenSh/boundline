// CPU cost of the cron's hot paths, measured with process.cpuUsage. Run normally and with NODE_OPTIONS=--jitless
// to bracket what a cold Workers isolate (10 ms CPU on the Free plan) pays.
//   pnpm --filter @boundline/observatory exec tsx scripts/bench-cpu.ts
//   NODE_OPTIONS=--jitless pnpm --filter @boundline/observatory exec tsx scripts/bench-cpu.ts
// Numbers from 6 Oct 2026 (JIT): before the hand-rolled reader a read cost 88.5 ms cold / 17.3 ms warm and the first
// buildSnapshot 10 ms (Intl); after it decode+shape costs ~0.6 ms cold / ~0.1 ms warm and buildSnapshot ~0.4 ms cold.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { liveCalendar } from "../src/calendar-impl.js";
import { findLivenessTransitions, nextLivenessTransition } from "../src/capture.js";
import { decodeAggregate3 } from "../src/encoding.js";
import { fingerprint } from "../src/kv-latest.js";
import { DEFAULT_PLAN, createRpcReader, shapeReads } from "../src/reader.js";
import { buildSnapshot } from "../src/snapshot.js";
import { AGGREGATE3_FIXTURE as fixture } from "../test/fixtures/aggregate3-mainnet.js";

function cpu<T>(label: string, fn: () => T): T {
  const s = process.cpuUsage();
  const t0 = performance.now();
  const out = fn();
  const d = process.cpuUsage(s);
  console.log(`${label.padEnd(50)} cpu ${((d.user + d.system) / 1000).toFixed(2)} ms  wall ${(performance.now() - t0).toFixed(2)} ms`);
  return out;
}
async function cpuAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const s = process.cpuUsage();
  const t0 = performance.now();
  const out = await fn();
  const d = process.cpuUsage(s);
  console.log(`${label.padEnd(50)} cpu ${((d.user + d.system) / 1000).toFixed(2)} ms  wall ${(performance.now() - t0).toFixed(2)} ms`);
  return out;
}

const now = Math.floor(Date.now() / 1000);

console.log("--- keeper-style costs (for reference: viem key derivation triggers noble's base-point precompute)");
const key = generatePrivateKey();
cpu("privateKeyToAccount #1 (cold)", () => privateKeyToAccount(key));
cpu("privateKeyToAccount #2", () => privateKeyToAccount(key));

console.log("--- observatory tick, offline parts");
const results1 = cpu("decodeAggregate3(fixture) #1 (cold)", () => decodeAggregate3(fixture.result));
cpu("decodeAggregate3(fixture) #2", () => decodeAggregate3(fixture.result));
const reads1 = cpu("shapeReads #1 (cold)", () => shapeReads(DEFAULT_PLAN, results1));
cpu("shapeReads #2", () => shapeReads(DEFAULT_PLAN, results1));
const snap = cpu("buildSnapshot #1 (cold, arithmetic calendar)", () => buildSnapshot(reads1, liveCalendar, now));
cpu("buildSnapshot #2", () => buildSnapshot(reads1, liveCalendar, now));
cpu("fingerprint", () => fingerprint(snap));
cpu("JSON.stringify(snapshot)", () => JSON.stringify(snap));
cpu("nextLivenessTransition #1 (cold walk)", () => nextLivenessTransition(liveCalendar, now));
cpu("findLivenessTransitions #2 (cached next)", () => findLivenessTransitions(liveCalendar, now + 60));
cpu("findLivenessTransitions @Sun 19:45 ET (new calendar walk)", () => findLivenessTransitions({ ...liveCalendar }, 1791158400 - 900));

console.log("--- observatory tick, live read (network included in wall time)");
const rpc = process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com";
const reader = createRpcReader(rpc);
await cpuAsync("reader.read() #1 (cold; includes network)", () => reader.read());
await cpuAsync("reader.read() #2 (includes network)", () => reader.read());
