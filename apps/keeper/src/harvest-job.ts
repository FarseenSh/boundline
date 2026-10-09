// The harvest job: the self-repaying leg without an operator. Each tick it reads the DividendHarvester's own
// `preview(user, marketId)` for every enrolled target (one JSON-RPC batch: head, one Multicall3 read, the signer's
// nonces and the gas price) and, when a target is READY (a dividend to sweep into the loan) or needs a re-base (the
// multiplier fell, rose by a split-sized step, or the borrower keeps dividends as shares), sends `harvest(user,
// marketId, deadline)` as a plain transaction. The contract itself refuses outside an OPEN session, so no validity
// predicate is needed; the job only ever acts in session. Signs with the protection signer (PROTECT_KEY), third in
// line after the Protector and the vault, at most one signature per tick and never while one is in flight. Every
// action is simulated from the signer first (latest and pending); a revert is never signed. Never throws.
import type { Address, Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { rearmFees } from "./protect.js";
import { MULTICALL3, decodeAggregate3, describeRevert, hexToBigInt, strip, word, addressWord, encodeAggregate3, type Call3 } from "./raw.js";
import type { RpcCall, RpcOutcome } from "./rpc.js";
import { simulateBatch } from "./vault-job.js";

export const HARVEST_SELECTOR = {
  keeper: "0xaced1661",
  preview: "0x4d86e257",
  harvest: "0x41ee7a93",
} as const satisfies Record<string, Hex>;

/** The live harvest took 535,346 gas (9 Oct 2026) and a re-base 167,821; the limit covers both with room. */
export const HARVEST_GAS_LIMIT = 900_000n;
/** How long a signed harvest stays valid on chain (the contract's `deadline`). */
export const HARVEST_DEADLINE_SECONDS = 600;

export const STANDINGS = ["NOT_ENROLLED", "GATE_CLOSED", "NO_CHANGE", "STEP_DOWN", "STEP_TOO_LARGE", "HEADROOM", "NO_DEBT", "TOO_SMALL", "NOT_AUTHORIZED", "READY"] as const;
export type Standing = (typeof STANDINGS)[number];
/** Standings where `harvest` re-bases the base multiplier and sells nothing. */
const REBASE: ReadonlySet<Standing> = new Set(["STEP_DOWN", "STEP_TOO_LARGE", "HEADROOM", "NO_DEBT"]);

export interface HarvestTarget {
  user: Address;
  marketId: Hex;
}

export interface HarvestPreview {
  standing: Standing;
  baseMultiplier: bigint;
  multiplier: bigint;
  collateral: bigint;
  debt: bigint;
  price8: bigint;
  dividendRaw: bigint;
  dividendValue: bigint;
  repayAssets: bigint;
  fullRepay: boolean;
}

export type HarvestDecision =
  | { action: "harvest"; repayAssets: bigint; dividendRaw: bigint }
  | { action: "rebase"; from: bigint; to: bigint }
  | { action: "none"; reason: string; error?: string };

/** `HARVEST_TARGETS`: comma-separated `<user>:<marketId>`. Empty or unset means no targets. */
export function parseHarvestTargets(raw: string | undefined): HarvestTarget[] {
  if (!raw || raw.trim() === "") return [];
  return raw.split(",").map((part, i) => {
    const [user, marketId, ...rest] = part.trim().split(":");
    if (rest.length || !user || !/^0x[0-9a-fA-F]{40}$/.test(user) || !marketId || !/^0x[0-9a-fA-F]{64}$/.test(marketId)) {
      throw new Error(`HARVEST_TARGETS entry ${i + 1}: expected <user>:<marketId>`);
    }
    return { user: user as Address, marketId: marketId.toLowerCase() as Hex };
  });
}

export function encodePreview(t: HarvestTarget): Hex {
  return `${HARVEST_SELECTOR.preview}${addressWord(t.user)}${strip(t.marketId).padStart(64, "0")}` as Hex;
}

export function encodeHarvest(t: HarvestTarget, deadline: bigint): Hex {
  return `${HARVEST_SELECTOR.harvest}${addressWord(t.user)}${strip(t.marketId).padStart(64, "0")}${word(deadline)}` as Hex;
}

/** `preview` returns a static 10-word tuple: standing, m0, m1, collateral, debt, price8, dividendRaw, dividendValue, repayAssets, fullRepay. */
export function decodePreview(data: Hex): HarvestPreview {
  const d = strip(data);
  if (d.length < 640) throw new Error(`preview: ${d.length / 2} bytes, expected 320`);
  const w = (i: number) => BigInt(`0x${d.slice(i * 64, (i + 1) * 64)}`);
  const s = Number(w(0));
  const standing = STANDINGS[s];
  if (!standing) throw new Error(`preview: unknown standing ${s}`);
  return { standing, baseMultiplier: w(1), multiplier: w(2), collateral: w(3), debt: w(4), price8: w(5), dividendRaw: w(6), dividendValue: w(7), repayAssets: w(8), fullRepay: w(9) !== 0n };
}

export function decideHarvest(p: HarvestPreview): HarvestDecision {
  if (p.standing === "READY") return { action: "harvest", repayAssets: p.repayAssets, dividendRaw: p.dividendRaw };
  if (REBASE.has(p.standing)) return { action: "rebase", from: p.baseMultiplier, to: p.multiplier };
  return { action: "none", reason: p.standing };
}

export interface HarvestRpc {
  batch(calls: readonly RpcCall[]): Promise<RpcOutcome[]>;
  call<T = unknown>(method: string, params: readonly unknown[]): Promise<T>;
}

export interface HarvestTargetReport {
  user: Address;
  marketId: Hex;
  preview: HarvestPreview | null;
  decision: HarvestDecision | null;
  simulation?: { latest: string; pending: string | null };
  error?: string;
}

export interface HarvestSent {
  user: Address;
  marketId: Hex;
  action: "harvest" | "rebase";
  hash: Hex;
  nonce: number;
  head: number;
  deadline: number;
}

export interface HarvestReport {
  at: number;
  ms: number;
  harvester: Address;
  keeper: Address | null;
  signer: Address | null;
  keeperIsSigner: boolean | null;
  head: number | null;
  targets: HarvestTargetReport[];
  sent: HarvestSent | null;
  skipped: "no-targets" | "read-failed" | "nothing-to-do" | "no-key" | "not-keeper" | "would-revert" | "simulation-unavailable" | "signer-busy" | "in-flight" | null;
  errors: string[];
}

export interface HarvestDeps {
  rpc: HarvestRpc;
  harvester: Address;
  targets: readonly HarvestTarget[];
  account: PrivateKeyAccount | null;
  chainId: number;
  /** True when the Protector or the vault wanted the shared signer in this tick. */
  signerBusy?: boolean;
  /** Live view only: decide and simulate, never sign. */
  dryRun?: boolean;
  now?: () => number;
}

function outcomeHex(o: RpcOutcome | undefined, what: string): Hex {
  if (!o) throw new Error(`${what}: missing`);
  if (!o.ok) throw new Error(`${what}: ${o.error}`);
  return o.result as Hex;
}

export async function runHarvest(deps: HarvestDeps): Promise<HarvestReport> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const signer = deps.account?.address ?? null;
  const report: HarvestReport = { at: Math.floor(started / 1000), ms: 0, harvester: deps.harvester, keeper: null, signer, keeperIsSigner: null, head: null, targets: [], sent: null, skipped: null, errors: [] };
  const finish = (): HarvestReport => {
    report.ms = now() - started;
    return report;
  };
  if (deps.targets.length === 0) {
    report.skipped = "no-targets";
    return finish();
  }

  // ---- one batch: head, the multicall (keeper, every preview), the signer's nonces and the gas price
  const calls: Call3[] = [{ target: deps.harvester, allowFailure: true, callData: HARVEST_SELECTOR.keeper }];
  for (const t of deps.targets) calls.push({ target: deps.harvester, allowFailure: true, callData: encodePreview(t) });
  const batch: RpcCall[] = [
    { method: "eth_blockNumber", params: [] },
    { method: "eth_call", params: [{ to: MULTICALL3, data: encodeAggregate3(calls) }, "latest"] },
  ];
  if (signer) {
    batch.push({ method: "eth_getTransactionCount", params: [signer, "latest"] });
    batch.push({ method: "eth_getTransactionCount", params: [signer, "pending"] });
    batch.push({ method: "eth_gasPrice", params: [] });
  }
  let out: RpcOutcome[];
  let head: bigint;
  let results: ReturnType<typeof decodeAggregate3>;
  try {
    out = await deps.rpc.batch(batch);
    head = hexToBigInt(outcomeHex(out[0], "eth_blockNumber"));
    results = decodeAggregate3(outcomeHex(out[1], "eth_call"));
  } catch (err) {
    report.skipped = "read-failed";
    report.errors.push(`read failed: ${err instanceof Error ? err.message : String(err)}`);
    return finish();
  }
  report.head = Number(head);
  const k = results[0];
  report.keeper = k?.success && strip(k.returnData).length >= 64 ? (`0x${strip(k.returnData).slice(24, 64)}` as Address) : null;
  report.keeperIsSigner = signer && report.keeper ? report.keeper.toLowerCase() === signer.toLowerCase() : signer ? false : null;

  // ---- per target: decode and decide; a harvest (a dividend to repay) before a re-base
  const candidates: { target: HarvestTarget; row: HarvestTargetReport; action: "harvest" | "rebase" }[] = [];
  deps.targets.forEach((t, i) => {
    const row: HarvestTargetReport = { user: t.user, marketId: t.marketId, preview: null, decision: null };
    try {
      const r = results[1 + i];
      if (!r?.success) throw new Error(`preview: ${r ? describeRevert(r.returnData) : "no result"}`);
      row.preview = decodePreview(r.returnData);
      row.decision = decideHarvest(row.preview);
      if (row.decision.action !== "none") candidates.push({ target: t, row, action: row.decision.action });
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    }
    report.targets.push(row);
  });
  if (candidates.length === 0) {
    report.skipped = "nothing-to-do";
    return finish();
  }
  if (!deps.account || !signer) {
    report.skipped = "no-key";
    return finish();
  }
  if (report.keeperIsSigner !== true) {
    // Until the harvester's owner points its keeper at this signer, the job watches and never signs.
    report.skipped = "not-keeper";
    return finish();
  }
  candidates.sort((a, b) => (a.action === b.action ? 0 : a.action === "harvest" ? -1 : 1));

  const deadline = BigInt(Math.floor(now() / 1000) + HARVEST_DEADLINE_SECONDS);
  let chosen: (typeof candidates)[number] | null = null;
  let firstFailure: "would-revert" | "simulation-unavailable" | null = null;
  for (const c of candidates) {
    const sim = await simulateBatch(deps.rpc, signer, deps.harvester, encodeHarvest(c.target, deadline));
    c.row.simulation = sim.simulation;
    if (sim.verdict !== "ok") {
      const reason = sim.verdict === "revert" ? "would-revert" : "simulation-unavailable";
      c.row.decision = { action: "none", reason, ...(sim.error ? { error: sim.error } : {}) };
      firstFailure ??= reason;
      continue;
    }
    chosen = c;
    break;
  }
  if (!chosen) {
    report.skipped = firstFailure ?? "nothing-to-do";
    return finish();
  }
  if (deps.signerBusy) {
    report.skipped = "signer-busy";
    return finish();
  }
  let latest: bigint;
  let pending: bigint;
  let gasPrice: bigint;
  try {
    latest = hexToBigInt(outcomeHex(out[2], "nonce latest"));
    pending = hexToBigInt(outcomeHex(out[3], "nonce pending"));
    gasPrice = hexToBigInt(outcomeHex(out[4], "eth_gasPrice"));
  } catch (err) {
    report.skipped = "read-failed";
    report.errors.push(err instanceof Error ? err.message : String(err));
    return finish();
  }
  if (pending > latest) {
    report.skipped = "in-flight";
    return finish();
  }
  if (deps.dryRun) return finish();

  try {
    const fees = rearmFees(gasPrice, null, head);
    const raw = await deps.account.signTransaction({
      chainId: deps.chainId,
      type: "eip1559",
      nonce: Number(pending),
      to: deps.harvester,
      data: encodeHarvest(chosen.target, deadline),
      value: 0n,
      gas: HARVEST_GAS_LIMIT,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    const hash = await deps.rpc.call<Hex>("eth_sendRawTransaction", [raw]);
    report.sent = { user: chosen.target.user, marketId: chosen.target.marketId, action: chosen.action, hash, nonce: Number(pending), head: Number(head), deadline: Number(deadline) };
  } catch (err) {
    report.errors.push(`send failed: ${err instanceof Error ? ((err as Error & { shortMessage?: string }).shortMessage ?? err.message) : String(err)}`);
  }
  return finish();
}
