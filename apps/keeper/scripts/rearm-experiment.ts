// The validity re-arm experiment (8 Oct 2026): when a validity transaction's predicate is already true at the moment
// it is re-armed, is it included sooner if each re-arm carries a NEW hash (same nonce, higher tip) than if the same
// signed bytes are re-submitted? On 6 Oct seven accepted re-submissions of identical bytes with a true predicate were
// not included before the eighth was (docs/evidence/validity-transactions-sepolia.md).
//
// Laptop only, with the validity demo key (never the keeper Worker's keys). Each trial:
//   phase 1  sign a 0-value self-transfer at nonce N and arm it with a FALSE predicate (storage(calendar, 0) != owner)
//            and a 30-block bound; it cannot land, and expires.
//   phase 2  after the bound has passed, re-arm with a TRUE predicate (storage(calendar, 0) == owner):
//            strategy "same": the identical signed bytes, re-submitted every 30 blocks until included;
//            strategy "new":  re-signed at the same nonce with the tip raised 20% per re-arm (a new hash each time).
//   control  a fresh transaction (never submitted before) armed once with the TRUE predicate.
// Latency is counted in blocks from the first true-predicate submission to the receipt's block.
//
//   set -a; . ~/.boundline/base-sepolia.env; set +a
//   pnpm --filter @boundline/keeper exec tsx scripts/rearm-experiment.ts <out.json> [trialsPerArm=5] [controls=3]
import { writeFileSync } from "node:fs";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const [out, trialsArg, controlsArg] = process.argv.slice(2);
if (!out) {
  console.error("usage: rearm-experiment.ts <out.json> [trialsPerArm] [controls]");
  process.exit(2);
}
const TRIALS = Number(trialsArg ?? 5);
const CONTROLS = Number(controlsArg ?? 3);
const key = process.env.BOUNDLINE_TESTNET_VALIDITY_KEY as Hex | undefined;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("BOUNDLINE_TESTNET_VALIDITY_KEY missing");
const alchemy = process.env.BOUNDLINE_ALCHEMY_API_KEY;
const READ = process.env.REARM_READ_RPC ?? (alchemy ? `https://base-sepolia.g.alchemy.com/v2/${alchemy}` : "https://sepolia.base.org");
const SEQUENCER = "https://sepolia-sequencer.base.org";
const CHAIN_ID = 84532;
const CALENDAR = "0x70575eb938645A9D3E18Dda035f5A6a7713696B8"; // MarketCalendar on Base Sepolia; slot 0 = owner (never changes here)
const WINDOW = 30n;
const MAX_REARMS = 5;

const account = privateKeyToAccount(key);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
      const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
      // A rate limit (HTTP 429 or a JSON-RPC 429 / -32005) is retried like a network error; any other RPC error is an answer.
      if (body.error && (body.error.code === 429 || body.error.code === -32005 || /rate|capacity|too many/i.test(body.error.message))) throw new Error(`rate limited: ${body.error.message}`);
      if (body.error) throw Object.assign(new Error(`${body.error.code} ${body.error.message}`), { rpc: true });
      return body.result as T;
    } catch (err) {
      if ((err as { rpc?: boolean }).rpc || attempt >= 6) throw err;
      await sleep(1_500 * (attempt + 1));
    }
  }
}
const head = async () => BigInt(await rpc<Hex>(READ, "eth_blockNumber", []));
const hex = (n: bigint) => `0x${n.toString(16)}`;

const slot0 = await rpc<Hex>(READ, "eth_getStorageAt", [CALENDAR, "0x0", "latest"]);
const predicate = (op: "=" | "!=", bound: bigint) => [
  { type: "storage", params: { address: CALENDAR, slot: "0x0", op, value: slot0 } },
  { type: "block_number", params: { op: "<=", value: hex(bound) } },
];

async function submit(raw: Hex, op: "=" | "!=", h: bigint): Promise<{ ok: boolean; answer: string; bound: number; head: number; at: number }> {
  const bound = h + WINDOW;
  const at = Math.floor(Date.now() / 1000);
  try {
    const hash = await rpc<Hex>(SEQUENCER, "base_sendRawTransactionValidity", [raw, { validity: predicate(op, bound) }]);
    return { ok: true, answer: hash, bound: Number(bound), head: Number(h), at };
  } catch (err) {
    return { ok: false, answer: err instanceof Error ? err.message : String(err), bound: Number(bound), head: Number(h), at };
  }
}

const gasPrice = BigInt(await rpc<Hex>(READ, "eth_gasPrice", []));
const BASE_TIP = 1_000_000n; // 0.001 gwei
const maxFee = (tip: bigint) => (gasPrice * 3n > 20_000_000n ? gasPrice * 3n : 20_000_000n) + tip;
const RUN = Date.now().toString(16);
const { keccak256, toHex } = await import("viem");
/** Every trial (and every "new" re-arm) carries its own payload, so no two trials can ever share a hash. */
async function sign(nonce: number, tip: bigint, tag: string): Promise<{ raw: Hex; hash: Hex }> {
  const data = keccak256(toHex(`boundline/rearm/${RUN}/${tag}`));
  const raw = await account.signTransaction({ chainId: CHAIN_ID, type: "eip1559", nonce, to: account.address, value: 0n, gas: 30_000n, maxFeePerGas: maxFee(tip), maxPriorityFeePerGas: tip, data });
  return { raw, hash: keccak256(raw) };
}
/** Tips only rise at a nonce: a transaction still parked at the sequencer can never make a later trial "underpriced". */
const maxTipAt = new Map<number, bigint>();
function startTip(nonce: number): bigint {
  const prev = maxTipAt.get(nonce);
  return prev === undefined ? BASE_TIP : (prev * 125n) / 100n + 1n;
}
function noteTip(nonce: number, tip: bigint): void {
  const prev = maxTipAt.get(nonce) ?? 0n;
  if (tip > prev) maxTipAt.set(nonce, tip);
}

interface Receipt {
  blockNumber: Hex;
  status: Hex;
  gasUsed: Hex;
  effectiveGasPrice: Hex;
  transactionHash: Hex;
}
async function receiptOf(hashes: Hex[]): Promise<Receipt | null> {
  for (const h of hashes) {
    const r = await rpc<Receipt | null>(READ, "eth_getTransactionReceipt", [h]);
    if (r) return r;
  }
  return null;
}
async function nonceNow(): Promise<{ latest: number; pending: number }> {
  const [l, p] = await Promise.all([rpc<Hex>(READ, "eth_getTransactionCount", [account.address, "latest"]), rpc<Hex>(READ, "eth_getTransactionCount", [account.address, "pending"])]);
  return { latest: Number(BigInt(l)), pending: Number(BigInt(p)) };
}

type Strategy = "same" | "new" | "control";
interface Trial {
  strategy: Strategy;
  nonce: number;
  phase1: { hash: Hex; submission: Awaited<ReturnType<typeof submit>> } | null;
  rearms: { hash: Hex; tipWei: string; submission: Awaited<ReturnType<typeof submit>> }[];
  included: { hash: Hex; block: number; status: string; gasUsed: number; effectiveGasPriceWei: string; latencyBlocks: number; latencySeconds: number; rearmIndex: number } | null;
  note?: string;
}

async function waitForBlock(target: bigint): Promise<bigint> {
  for (;;) {
    const h = await head();
    if (h >= target) return h;
    await sleep(1_000);
  }
}

let trialNo = 0;
async function runTrial(strategy: Strategy): Promise<Trial> {
  // RPC nodes lag each other by a few seconds: wait for latest == pending rather than trusting one read.
  let { latest, pending } = await nonceNow();
  for (let i = 0; i < 30 && pending !== latest; i += 1) {
    await sleep(2_000);
    ({ latest, pending } = await nonceNow());
  }
  if (pending !== latest) throw new Error(`a transaction is pending (latest ${latest}, pending ${pending}); stop`);
  const nonce = latest;
  const id = trialNo++;
  const trial: Trial = { strategy, nonce, phase1: null, rearms: [], included: null };
  let tip = startTip(nonce);
  let signed = await sign(nonce, tip, `t${id}`);
  noteTip(nonce, tip);
  if (strategy !== "control") {
    // phase 1: armed with a false predicate; cannot land; expires at its bound
    const h1 = await head();
    trial.phase1 = { hash: signed.hash, submission: await submit(signed.raw, "!=", h1) };
    console.log(`[${strategy} n${nonce}] phase 1 armed false: ${trial.phase1.submission.ok ? "accepted" : trial.phase1.submission.answer}; bound ${trial.phase1.submission.bound}`);
    await waitForBlock(BigInt(trial.phase1.submission.bound) + 2n);
    const stray = await receiptOf([signed.hash]);
    if (stray) trial.note = `phase-1 transaction was included at block ${Number(BigInt(stray.blockNumber))} with a false predicate`;
  }
  // phase 2: true predicate, re-armed until included
  const hashes: Hex[] = [];
  for (let i = 0; i < MAX_REARMS; i += 1) {
    if (strategy === "new") {
      // every re-arm, the first one included, is a new hash: same nonce, tip raised 20%
      tip = (tip * 12n) / 10n + 1n;
      signed = await sign(nonce, tip, `t${id}r${i}`);
      noteTip(nonce, tip);
    }
    const h = await head();
    const sub = await submit(signed.raw, "=", h);
    hashes.push(signed.hash);
    trial.rearms.push({ hash: signed.hash, tipWei: tip.toString(), submission: sub });
    console.log(`[${strategy} n${nonce}] re-arm ${i} (tip ${tip}): ${sub.ok ? "accepted" : sub.answer} at head ${sub.head}, bound ${sub.bound}`);
    // watch until the bound passes
    for (;;) {
      const r = await receiptOf([...new Set(hashes)]);
      if (r) {
        const block = Number(BigInt(r.blockNumber));
        const first = trial.rearms[0]!.submission;
        trial.included = {
          hash: r.transactionHash,
          block,
          status: r.status,
          gasUsed: Number(BigInt(r.gasUsed)),
          effectiveGasPriceWei: BigInt(r.effectiveGasPrice).toString(),
          latencyBlocks: block - first.head,
          latencySeconds: Math.floor(Date.now() / 1000) - first.at,
          rearmIndex: trial.rearms.findIndex((x) => x.hash === r.transactionHash),
        };
        console.log(`[${strategy} n${nonce}] included in block ${block} (${trial.included.latencyBlocks} blocks after the first true-predicate submission), hash ${r.transactionHash}`);
        // let every node see the consumed nonce before the next trial reads it
        for (let k = 0; k < 30 && (await nonceNow()).latest <= nonce; k += 1) await sleep(2_000);
        return trial;
      }
      const now = await head();
      if (now > BigInt(sub.bound) + 1n) break;
      await sleep(1_000);
    }
    const n = await nonceNow();
    if (n.latest > nonce) {
      trial.note = `nonce ${nonce} consumed by a transaction this script did not see`;
      return trial;
    }
  }
  trial.note = `not included after ${MAX_REARMS} re-arms`;
  return trial;
}

const results: Trial[] = [];
const order: Strategy[] = [];
if (process.env.REARM_ORDER) {
  for (const o of process.env.REARM_ORDER.split(",")) if (o === "same" || o === "new" || o === "control") order.push(o);
} else {
  for (let i = 0; i < TRIALS; i += 1) order.push("control", i % 2 === 0 ? "new" : "same", i % 2 === 0 ? "same" : "new");
  while (order.filter((o) => o === "control").length > CONTROLS) order.splice(order.lastIndexOf("control"), 1);
}
// Run 1 (stopped): reconstruct its same-bytes transaction for the record and confirm it never landed.
const run1 = await account.signTransaction({ chainId: CHAIN_ID, type: "eip1559", nonce: 3, to: account.address, value: 0n, gas: 21_000n, maxFeePerGas: 21_000_000n, maxPriorityFeePerGas: BASE_TIP, data: "0x" });
const run1Hash = keccak256(run1);
const run1Receipt = await rpc<Receipt | null>(READ, "eth_getTransactionReceipt", [run1Hash]);
console.log(`run 1 same-bytes transaction ${run1Hash}: ${run1Receipt ? `included in block ${Number(BigInt(run1Receipt.blockNumber))}` : "never included"}`);
// Whatever this key last armed at its current nonce was at least the base tip: start above it.
maxTipAt.set((await nonceNow()).latest, BASE_TIP);
console.log(`account ${account.address}, gas price ${gasPrice}, slot0 ${slot0}, order ${order.join(",")}`);
const startBalance = BigInt(await rpc<Hex>(READ, "eth_getBalance", [account.address, "latest"]));
for (const s of order) {
  try {
    results.push(await runTrial(s));
  } catch (err) {
    console.error(`trial ${s} failed:`, err instanceof Error ? err.message : err);
    results.push({ strategy: s, nonce: -1, phase1: null, rearms: [], included: null, note: `error: ${err instanceof Error ? err.message : String(err)}` });
    writeFileSync(out, JSON.stringify({ account: account.address, calendarSlot0: slot0, gasPriceWei: gasPrice.toString(), results }, null, 1));
    break;
  }
  writeFileSync(out, JSON.stringify({ account: account.address, calendarSlot0: slot0, gasPriceWei: gasPrice.toString(), results }, null, 1));
}
const endBalance = await rpc<Hex>(READ, "eth_getBalance", [account.address, "latest"]).then(BigInt, () => startBalance);
writeFileSync(out, JSON.stringify({ account: account.address, calendarSlot0: slot0, gasPriceWei: gasPrice.toString(), costWei: (startBalance - endBalance).toString(), run1: { hash: run1Hash, included: run1Receipt !== null }, results }, null, 1));
const summary = (s: Strategy) => results.filter((r) => r.strategy === s).map((r) => (r.included ? `${r.included.latencyBlocks}b/rearm${r.included.rearmIndex}` : "none"));
console.log(`same: ${summary("same").join(" ")} | new: ${summary("new").join(" ")} | control: ${summary("control").join(" ")} | cost ${Number(startBalance - endBalance) / 1e18} ETH`);
