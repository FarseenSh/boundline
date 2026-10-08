// Module-scope warm-up: run every cron path once against an in-memory fake, during module evaluation.
//
// Why: on a cold isolate each function is compiled the first time it runs. Measured 8 Oct 2026 in Node
// (scripts/bench-cpu.ts): the first tick of a fresh process cost 26–36 ms of CPU, every later one 0.7–4 ms; the
// Workers Free plan allows 10 ms per invocation, while module evaluation has its own startup budget. So the startup
// pays the compilation: the raw RPC client, Multicall3 encode/decode, the Protector and vault sizing and decisions, a
// transaction signature, the validity predicates, the mirror's plan and send path, the event transitions and the JSON
// of every report. No I/O happens here (the fake fetch answers from memory, timeoutMs 0 creates no timer) and nothing
// it does is visible: its accounts, clients and state are throwaway, and any failure is swallowed.
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createViemMirrorChain } from "./chain.js";
import { PAIRS } from "./config.js";
import { mergeHold, parseKvHold } from "./env.js";
import { decodeExecutions, executionReads, parseState, transitions } from "./events.js";
import { parseTargets } from "./protect.js";
import { runProtect, sepoliaRpcOver, validitySubmitter } from "./protect-job.js";
import { rpcClient, type FetchLike } from "./rpc.js";
import { runTick } from "./tick.js";
import { parseVaultTargets, pct, usdc } from "./vault.js";
import { runVault, simulateBatch } from "./vault-job.js";
import { decodeRevert } from "./reverts.js";

const W = (x: bigint | number): string => BigInt(x).toString(16).padStart(64, "0");
const HOLE = `0x${"ab".repeat(32)}`;

function aggregate3Return(payloads: string[]): string {
  const elems = payloads.map((p) => W(1) + W(0x40) + W(p.length / 2) + p.padEnd(Math.ceil(p.length / 64) * 64, "0"));
  let off = payloads.length * 32;
  const offs: string[] = [];
  for (const e of elems) {
    offs.push(W(off));
    off += e.length / 2;
  }
  return `0x${W(0x20)}${W(payloads.length)}${offs.join("")}${elems.join("")}`;
}

const SIGNER_KEY: Hex = "0x0000000000000000000000000000000000000000000000000000000000000002"; // not a secret
const signer = privateKeyToAccount(SIGNER_KEY);
const signerWord = W(BigInt(signer.address));

// Protector sizing: target 1 below the band, target 2 in the band with a partial (so the arm path signs).
const sizing = (standing: number, partial: boolean): string =>
  [standing, 940611, 1805321834834n, 1805453, 3.3e36, 3.3e36, 1, 0.59e18, 0.59e18, 1.01e18, 1e18, 0.58e18, partial ? 10_000 : 0, 0, partial ? 33_000 : 0, 0, 0, 0]
    .map((x) => W(BigInt(Math.round(Number(x)))))
    .join("");
// Vault: keeper = the warm signer, not paused; one line in grace with a funded ladder (so the vault job signs).
const line = [W(0x626f756e646c696e65n), W(0xb789ad318945b37566e2549f65526cc269a482fcn), W(0x4a03n), W(0xb2000000000000000000000e063e65377ca34141n), W(2), W(1), W(0), W(1791400000), W(3_300_000)].join("");
const quote = [W(0), W(5), W(0), W(2_000_000), W(0), W(3_300_000), W(0), W(0), W(0.5e18), W(0)].join("");
const ladder = [W(400_000), W(0), W(1_000_000), W((1n << 128n) - 1n - 1_400_000n)].join("");
const mirrorRound = (updatedAt: number): string => [W(36893488147419103532n), W(33568300000), W(updatedAt - 15), W(updatedAt), W(36893488147419103532n)].join("");
const params = [W(10n ** 18n), W(0)].join("");

function answer(url: string, method: string, p: unknown[]): unknown {
  switch (method) {
    case "eth_blockNumber":
      return "0x2d9f108";
    case "eth_getTransactionCount":
      return "0x5";
    case "eth_gasPrice":
      return "0x4c4b40";
    case "eth_getStorageAt":
      return `0x${W(1791401927)}`;
    case "eth_sendRawTransaction":
    case "base_sendRawTransactionValidity":
      return HOLE;
    case "eth_getLogs":
      return [];
    case "eth_call": {
      // A pre-flight simulation (eth_call from the signer) succeeds here, so the arm path behind it is warmed too.
      if ((p[0] as { from?: string })?.from) return "0x";
      const data = String((p[0] as { data?: string })?.data ?? "");
      if (data.includes("94eb1b61")) return aggregate3Return([sizing(2, false), sizing(3, true)]);
      if (data.includes("3c7d9255")) return aggregate3Return([signerWord, W(0), line, quote, W(3.0e36), ladder]);
      // The mirror's read: Sepolia one round behind mainnet, so the plan sends a setRoundData.
      const at = url.includes("sepolia") ? 1791400000 : 1791401927;
      return aggregate3Return(PAIRS.flatMap(() => [mirrorRound(at), params]));
    }
    default:
      return null;
  }
}

const fakeFetch: FetchLike = async (url, init) => {
  const req = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
  const one = (r: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: "2.0", id: r.id, result: answer(url, r.method, r.params) });
  const text = JSON.stringify(Array.isArray(req) ? req.map(one) : one(req));
  return { ok: true, status: 200, json: async () => JSON.parse(text) } as unknown as Response;
};

const replacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);

export interface WarmUpSummary {
  protectArmed: boolean;
  vaultArmed: boolean;
  mirrorSent: number;
  events: string[];
}

/** One pass over every cron path against the fakes; the summary lets the tests prove the paths ran. */
export async function runWarmUp(): Promise<WarmUpSummary> {
  const sepolia = rpcClient(["warm://sepolia"], fakeFetch, 0);
  const mainnet = rpcClient(["warm://mainnet"], fakeFetch, 0);
  const rpc = sepoliaRpcOver(sepolia, validitySubmitter("warm://sequencer", fakeFetch, 0));
  const targets = parseTargets(
    "0xdcae709341aab652144e8afcb47479fe49e133a1:0xB789aD318945B37566E2549F65526Cc269a482Fc:0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a:5,0xdcae709341aab652144e8afcb47479fe49e133a1:0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E:0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a:5",
  );
  const protect = await runProtect({ rpc, protector: "0x5c546946c909718040dd686f63df6cb5e4df442c", targets, account: signer, chainId: 84532, sleep: async () => undefined });
  const vaultTargets = parseVaultTargets("4:5200:4500:0x7a53b459be6e5e9a12324cc3417bb027daf73f65:0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a:5");
  const vault = await runVault({ rpc, vault: "0x87f600279F021ca859b9903DE884d3A7A169f38c", desk: "0x39aBaDc0aAa12D1F7e259b89536Aa1848997399a", targets: vaultTargets, account: signer, chainId: 84532, sleep: async () => undefined });
  const chain = createViemMirrorChain({ mainnetRpc: "warm://mainnet", sepoliaRpc: "warm://sepolia", keeperKey: SIGNER_KEY }, { mainnet, sepolia });
  const mirror = await runTick(chain, PAIRS, { hold: mergeHold({ feed: new Set(), registry: new Set() }, parseKvHold('{"feed":[],"registry":["NVDAt"]}')) });
  const state = parseState('{"v":1,"grace":{},"armed":{"line:4":{"kind":"vault-repay","head":47836000,"nonce":5,"at":1,"lineId":"4"}}}');
  const reads = executionReads(state, "0x87f600279F021ca859b9903DE884d3A7A169f38c" as Address, "0x5c546946c909718040dd686f63df6cb5e4df442c" as Address);
  const log = { transactionHash: HOLE, blockNumber: "0x2d9f109", topics: [], data: `0x${W(500_000)}${W(400_000)}${W(0)}${W(100_000)}${W(3_300_000)}${W(2_800_000)}${HOLE.slice(2)}` };
  const executions = decodeExecutions(reads, [{ ok: true, result: [log] }], state);
  const t = transitions(state, { chainId: 84532, now: 1791443000, vault, protect, executions, head: 47836560 });
  // The revert path of the pre-flight: a batch error with data, decoded by selector.
  const unpaid = `0x0ff42e2c${W(BigInt(signer.address))}${W(1_805_453)}${W(1_805_321)}`;
  const reverted = await simulateBatch({ batch: async () => [{ ok: false, error: "rpc 3 execution reverted", data: unpaid }, { ok: true, result: "0x" }] }, signer.address, "0x87f600279F021ca859b9903DE884d3A7A169f38c", "0x1bb980bb");
  if (reverted.verdict !== "revert" || decodeRevert(unpaid) !== "Unpaid(address,uint256,uint256)") throw new Error("warm-up: revert decoding broken");
  JSON.stringify({ protect, vault, mirror, t, pct: pct(5_800n * 10n ** 14n), usdc: usdc(1_805_453n) }, replacer);
  return {
    protectArmed: protect.armed !== null,
    vaultArmed: vault.armed !== null,
    mirrorSent: mirror.sent,
    events: t.events.map((e) => `${e.type}:${String(e.data.phase ?? e.data.standing ?? "")}`),
  };
}

/** How the module-scope pass went, for /v1/config (a failure here never breaks the Worker; it only costs CPU later). */
export const warmUp: { done: boolean; ok: boolean; summary?: WarmUpSummary; error?: string } = { done: false, ok: false };

/** Resolves once the warm-up has run (or failed: it must never break the module); exported for the bench and the tests. */
export const warmed: Promise<void> = runWarmUp().then(
  (summary) => {
    warmUp.done = true;
    warmUp.ok = summary.protectArmed && summary.vaultArmed && summary.mirrorSent === 1;
    warmUp.summary = summary;
  },
  (err: unknown) => {
    warmUp.done = true;
    warmUp.error = err instanceof Error ? err.message : String(err);
  },
);
