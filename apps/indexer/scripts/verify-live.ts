// Real-data check of the 8 Oct 2026 lean decoder and byte-level roots against what the deployed indexer stored with the
// previous (viem) code: for a sample of stored events of every source, re-fetch the raw logs and decode them again; for
// stored daily roots, recompute them from the stored rows.
//   pnpm --filter @boundline/indexer exec tsx scripts/verify-live.ts [perSource=25]
import { readFileSync } from "node:fs";
import { canonicalJson } from "../src/canonical.js";
import { decodeLog, type RawLog } from "../src/decode.js";
import { activeSources } from "../src/index.js";
import { ZERO_ROOT, chainRoot, dayEnd, dayStart } from "../src/roots.js";
import { rawRpc, splitUrls } from "../src/rpc.js";
import type { Env } from "../src/env.js";

const LIVE = "https://boundline-indexer.papermind-ai.workers.dev";
const VARS = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n"),
).vars as Record<string, string>;
const env = VARS as unknown as Env;
const perSource = Number(process.argv[2] ?? 25);

interface LiveEvent {
  chainId: number;
  blockNumber: number;
  blockTime: number;
  txHash: `0x${string}`;
  logIndex: number;
  address: `0x${string}`;
  topic0: `0x${string}`;
  name: string;
  args: unknown;
}

async function json<T>(path: string): Promise<T> {
  const res = await fetch(`${LIVE}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

let checked = 0;
let mismatches = 0;
for (const source of activeSources(env)) {
  const body = await json<{ events: LiveEvent[] }>(`/v1/events?chainId=${source.chainId}&source=${source.id}&limit=${perSource}`);
  const rpc = rawRpc(splitUrls(source.chainId === 84532 ? VARS.BASE_SEPOLIA_RPC_URL! : VARS.BASE_RPC_URL!));
  let ok = 0;
  for (const e of body.events) {
    const hex = `0x${e.blockNumber.toString(16)}`;
    const logs = await rpc.call<RawLog[]>("eth_getLogs", [{ address: [e.address], fromBlock: hex, toBlock: hex }]);
    const raw = logs.find((l) => l.transactionHash.toLowerCase() === e.txHash && Number.parseInt(String(l.logIndex), 16) === e.logIndex);
    if (!raw) {
      console.log(`  ${source.id}: log ${e.txHash}#${e.logIndex} not returned by the RPC`);
      mismatches += 1;
      continue;
    }
    const row = decodeLog(source.abi, raw, e.chainId, e.blockTime);
    const stored = canonicalJson(e.args);
    checked += 1;
    if (row.name !== e.name || row.argsJson !== stored) {
      mismatches += 1;
      console.log(`  MISMATCH ${source.id} ${e.txHash}#${e.logIndex}: stored ${e.name} ${stored.slice(0, 160)} | lean ${row.name} ${row.argsJson.slice(0, 160)}`);
    } else ok += 1;
  }
  console.log(`${source.id.padEnd(28)} ${ok}/${body.events.length} re-decoded identically`);
}

// daily roots: recompute the latest stored day of each chain from its stored rows (the API pages newest first)
for (const chainId of [84532, 8453]) {
  const r = await json<{ roots: { day: string; root: string; prevRoot: string; eventCount: number }[] }>(`/v1/roots?chainId=${chainId}`);
  for (const root of r.roots.slice(0, 2)) {
    const events: LiveEvent[] = [];
    let before: string | null = null;
    for (;;) {
      const page: { events: LiveEvent[]; next: string | null } = await json(`/v1/events?chainId=${chainId}&limit=500&since=${dayStart(root.day)}${before ? `&before=${before}` : ""}`);
      events.push(...page.events.filter((e) => e.blockTime < dayEnd(root.day)));
      if (!page.next || page.events.length === 0 || page.events[page.events.length - 1]!.blockTime < dayStart(root.day)) break;
      before = page.next;
    }
    const mine = events.filter((e) => e.blockTime >= dayStart(root.day) && e.blockTime < dayEnd(root.day));
    const recomputed = chainRoot((root.prevRoot || ZERO_ROOT) as `0x${string}`, mine.map((e) => ({ ...e, argsJson: canonicalJson(e.args) })));
    const same = recomputed === root.root && mine.length === root.eventCount;
    if (!same) mismatches += 1;
    console.log(`root ${chainId} ${root.day}: stored ${root.root.slice(0, 18)}… (${root.eventCount} events) recomputed ${recomputed.slice(0, 18)}… (${mine.length}) ${same ? "IDENTICAL" : "DIFFERENT"}`);
  }
}
console.log(`checked ${checked} stored events, ${mismatches} mismatches`);
process.exit(mismatches === 0 ? 0 : 1);
