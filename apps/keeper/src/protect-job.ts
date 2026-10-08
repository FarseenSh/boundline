// The protection job's network side: read every target's sizing in one multicall, read the feed slot, decide, and
// arm the chosen action as a validity transaction signed by PROTECT_KEY (a key of its own: a transaction that
// waits for a state change must not block the mirror key's nonce). Never throws; one JSON line per run.
import type { Address, Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  decideProtection,
  decodeSizing,
  encodeProtect,
  encodeSizing,
  hexToBigInt,
  isAlreadyKnown,
  isUnderpriced,
  predicatesFor,
  protectFingerprint,
  rearmFees,
  type BackoffEntry,
  type Predicate,
  type ProtectionDecision,
  type ProtectTarget,
  type Sizing,
} from "./protect.js";
import { MULTICALL3, decodeAggregate3, encodeAggregate3, describeRevert } from "./raw.js";
import { decodeRevert, revertDataOf } from "./reverts.js";
import { RpcCallError, rpcFor, type FetchLike, type RpcCall, type RpcClient, type RpcOutcome } from "./rpc.js";

export const PROTECT_GAS_LIMIT = 900_000n;
/** The signed action is valid for this long; the predicate window is far shorter. */
export const PROTECT_DEADLINE_SECONDS = 15 * 60;
/** Second arming attempt inside the same tick, so a 60 s window is covered when the first answer is "already known". */
export const REARM_AFTER_MS = 35_000;

export interface ProtectRpc {
  /** Read RPC (fallback list). */
  read(method: string, params: unknown[]): Promise<unknown>;
  /** The sequencer endpoint for base_sendRawTransactionValidity. */
  submitValidity(raw: Hex, validity: Predicate[]): Promise<Hex>;
}

export interface Simulation {
  /** eth_call of the exact action from the signer at `latest`: "ok" or the decoded revert. Mandatory before a signature. */
  latest: string;
  /** The same at `pending` (advisory: a revert blocks, an unavailable answer does not). */
  pending: string | null;
}

export interface TargetReport {
  preLiq: Address;
  borrower: Address;
  sizing: Sizing | null;
  error?: string;
  decision: ProtectionDecision | null;
  /** Present when the action was simulated this run. */
  simulation?: Simulation;
  /** What decides the action (protectFingerprint), present when there was an action to consider. */
  fingerprint?: string;
}

export interface ProtectReport {
  at: number;
  ms: number;
  /** The Sepolia head read this run (null when the read failed). */
  head: number | null;
  signer: Address | null;
  targets: TargetReport[];
  armed: { preLiq: Address; borrower: Address; action: string; hash: Hex; nonce: number; bound: number; attempts: number; alreadyKnown: boolean; feeStep: number; maxFeePerGas: string; maxPriorityFeePerGas: string } | null;
  skipped: "no-targets" | "no-key" | "nothing-to-do" | "read-failed" | "would-revert" | "backoff" | "simulation-unavailable" | "dry-run" | null;
  errors: string[];
}

export interface ProtectDeps {
  rpc: ProtectRpc;
  protector: Address;
  targets: ProtectTarget[];
  account: PrivateKeyAccount | null;
  chainId: number;
  /** The head at which this borrower's current arming episode began (KV state), for the re-arm fee schedule. */
  episodeHead?: (borrower: Address) => bigint | null;
  /** A standing backoff for this borrower after a simulated revert (KV state). */
  backoff?: (borrower: Address) => BackoffEntry | null;
  /** Decide and simulate with the signer's address, never sign (the live view). */
  dryRun?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rearmAfterMs?: number;
}

export async function runProtect(deps: ProtectDeps): Promise<ProtectReport> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const report: ProtectReport = { at: Math.floor(started / 1000), ms: 0, head: null, signer: deps.account?.address ?? null, targets: [], armed: null, skipped: null, errors: [] };
  const finish = (): ProtectReport => {
    report.ms = now() - started;
    return report;
  };
  if (deps.targets.length === 0) {
    report.skipped = "no-targets";
    return finish();
  }

  let head: bigint;
  let sizings: ReturnType<typeof decodeAggregate3>;
  try {
    const calls = deps.targets.map((t) => ({ target: deps.protector, allowFailure: true, callData: encodeSizing(t.preLiq, t.borrower, 0n) }));
    const [headHex, raw] = await Promise.all([
      deps.rpc.read("eth_blockNumber", []) as Promise<Hex>,
      deps.rpc.read("eth_call", [{ to: MULTICALL3, data: encodeAggregate3(calls) }, "latest"]) as Promise<Hex>,
    ]);
    head = hexToBigInt(headHex);
    report.head = Number(head);
    sizings = decodeAggregate3(raw);
  } catch (err) {
    report.skipped = "read-failed";
    report.errors.push(`read failed: ${err instanceof Error ? err.message : String(err)}`);
    return finish();
  }

  const candidates: { target: ProtectTarget; row: TargetReport; decision: Extract<ProtectionDecision, { action: "partial" | "close" }> }[] = [];
  deps.targets.forEach((t, i) => {
    const r = sizings[i];
    const row: TargetReport = { preLiq: t.preLiq, borrower: t.borrower, sizing: null, decision: null };
    try {
      if (!r) throw new Error("no result");
      if (!r.success) throw new Error(describeRevert(r.returnData));
      row.sizing = decodeSizing(r.returnData);
      const d = decideProtection(row.sizing);
      row.decision = d;
      if (d.action !== "none") {
        row.fingerprint = protectFingerprint(row.sizing, d.action);
        candidates.push({ target: t, row, decision: d });
      }
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    }
    report.targets.push(row);
  });
  if (candidates.length === 0) {
    report.skipped = "nothing-to-do";
    return finish();
  }
  if (!deps.account) {
    report.skipped = "no-key";
    return finish();
  }
  const signer = deps.account.address;
  const deadline = BigInt(Math.floor(now() / 1000) + PROTECT_DEADLINE_SECONDS);

  // Pre-flight: the exact calldata that would be signed, simulated from the signer. A revert is never signed.
  let chosen: { target: ProtectTarget; decision: Extract<ProtectionDecision, { action: "partial" | "close" }>; data: Hex } | null = null;
  for (const c of candidates) {
    const fp = c.row.fingerprint!;
    const bo = deps.backoff?.(c.target.borrower) ?? null;
    if (bo && head < BigInt(bo.untilHead) && bo.fingerprint === fp) {
      c.row.decision = { action: "none", reason: "backoff", error: bo.error, untilHead: bo.untilHead };
      continue;
    }
    const data = encodeProtect(c.target.preLiq, c.target.borrower, c.decision.seizedAssets, c.decision.repaidShares, 0n, deadline);
    const sim = await simulate(deps.rpc, signer, deps.protector, data);
    c.row.simulation = sim.simulation;
    if (sim.verdict === "revert") {
      c.row.decision = { action: "none", reason: "would-revert", error: sim.error };
      continue;
    }
    if (sim.verdict === "unavailable") {
      c.row.decision = { action: "none", reason: "simulation-unavailable", error: sim.error };
      continue;
    }
    chosen = { target: c.target, decision: c.decision, data };
    break;
  }
  if (!chosen) {
    report.skipped = whyNone(candidates.map((c) => c.row.decision));
    return finish();
  }
  if (deps.dryRun) {
    report.skipped = "dry-run";
    return finish();
  }
  const { target, decision, data } = chosen;

  try {
    const [slotValue, nonceHex, gasPriceHex] = await Promise.all([
      deps.rpc.read("eth_getStorageAt", [target.feed, `0x${target.feedSlot.toString(16)}`, "latest"]) as Promise<Hex>,
      deps.rpc.read("eth_getTransactionCount", [signer, "pending"]) as Promise<Hex>,
      deps.rpc.read("eth_gasPrice", []) as Promise<Hex>,
    ]);
    const nonce = Number(hexToBigInt(nonceHex));
    const gasPrice = hexToBigInt(gasPriceHex);
    const episodeHead = deps.episodeHead?.(target.borrower) ?? null;
    const signAt = (fees: ReturnType<typeof rearmFees>) =>
      deps.account!.signTransaction({
        chainId: deps.chainId,
        type: "eip1559",
        nonce,
        to: deps.protector,
        data,
        value: 0n,
        gas: PROTECT_GAS_LIMIT,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
    // The action lands only while the feed still shows the round the decision was made on.
    const arm = async (raw: Hex, h: bigint): Promise<{ hash: Hex; retry: boolean }> => {
      try {
        return { hash: await deps.rpc.submitValidity(raw, predicatesFor(target.feed, target.feedSlot, slotValue, h, "held")), retry: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isAlreadyKnown(msg) || isUnderpriced(msg)) return { hash: "0x" as Hex, retry: true };
        throw err;
      }
    };
    let fees = rearmFees(gasPrice, episodeHead, head);
    let attempts = 1;
    let res = await arm(await signAt(fees), head);
    let bound = head + 30n;
    if (res.retry) {
      // An earlier submission with this nonce is still alive. Give it time to expire, then re-sign two fee steps up:
      // a new hash (identical bytes re-submitted after expiry were never included) that also replaces a live one.
      await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(deps.rearmAfterMs ?? REARM_AFTER_MS);
      const h2 = hexToBigInt((await deps.rpc.read("eth_blockNumber", [])) as Hex);
      fees = rearmFees(gasPrice, episodeHead ?? head, h2, 2);
      attempts += 1;
      res = await arm(await signAt(fees), h2);
      bound = h2 + 30n;
    }
    report.armed = {
      preLiq: target.preLiq,
      borrower: target.borrower,
      action: decision.action,
      hash: res.hash,
      nonce,
      bound: Number(bound),
      attempts,
      alreadyKnown: res.retry,
      feeStep: fees.step,
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
    };
  } catch (err) {
    report.errors.push(`arm failed: ${err instanceof Error ? ((err as Error & { shortMessage?: string }).shortMessage ?? err.message) : String(err)}`);
  }
  return finish();
}

// ---------------------------------------------------------------------------------------------- pre-flight

/** Why no candidate was signed: any simulated revert wins, then an unavailable simulation, else every one is backing off. */
export function whyNone(decisions: readonly ({ action: string; reason?: string } | null)[]): "would-revert" | "simulation-unavailable" | "backoff" {
  const reasons = decisions.map((d) => (d && "reason" in d ? d.reason : undefined));
  if (reasons.includes("would-revert")) return "would-revert";
  if (reasons.includes("simulation-unavailable")) return "simulation-unavailable";
  return "backoff";
}

export type SimulationVerdict = { verdict: "ok"; simulation: Simulation } | { verdict: "revert" | "unavailable"; error: string; simulation: Simulation };

/**
 * eth_call of the exact action from the signer: `latest` must succeed, `pending` must not revert (an unavailable
 * `pending` answer is ignored). The revert is decoded by its 4-byte selector (reverts.ts); no simulation, no signature.
 */
export async function simulate(rpc: Pick<ProtectRpc, "read">, from: Address, to: Address, data: Hex): Promise<SimulationVerdict> {
  const one = async (tag: "latest" | "pending"): Promise<{ ok: true } | { ok: false; revert: boolean; error: string }> => {
    try {
      await rpc.read("eth_call", [{ from, to, data }, tag]);
      return { ok: true };
    } catch (err) {
      if (err instanceof RpcCallError) return { ok: false, revert: true, error: decodeRevert(revertDataOf(err) ?? (err.message.includes("revert") ? "0x" : null)) };
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, revert: /revert/i.test(msg), error: /revert/i.test(msg) ? decodeRevert(revertDataOf(err)) : msg };
    }
  };
  const [latest, pending] = await Promise.all([one("latest"), one("pending")]);
  const simulation: Simulation = {
    latest: latest.ok ? "ok" : latest.error,
    pending: pending.ok ? "ok" : pending.revert ? pending.error : null,
  };
  if (!latest.ok) return { verdict: latest.revert ? "revert" : "unavailable", error: latest.error, simulation };
  if (!pending.ok && pending.revert) return { verdict: "revert", error: `pending: ${pending.error}`, simulation };
  return { verdict: "ok", simulation };
}

// ---------------------------------------------------------------------------------------------- live wiring

const accounts = new Map<Hex, PrivateKeyAccount>();
export function protectAccount(key: Hex | null): PrivateKeyAccount | null {
  if (!key) return null;
  let a = accounts.get(key);
  if (!a) {
    a = privateKeyToAccount(key);
    accounts.set(key, a);
  }
  return a;
}

/** The Sepolia side of both protection jobs: reads over the raw client (rpc.ts), validity submissions to the sequencer. */
export interface SepoliaRpc extends ProtectRpc {
  call<T = unknown>(method: string, params: readonly unknown[]): Promise<T>;
  batch(calls: readonly RpcCall[]): Promise<RpcOutcome[]>;
}

/** base_sendRawTransactionValidity over a fetch-like (injectable for the warm-up and tests). */
export function validitySubmitter(sequencerUrl: string, fetchImpl: FetchLike = (u, i) => fetch(u, i), timeoutMs = 15_000) {
  return async (raw: Hex, validity: Predicate[]): Promise<Hex> => {
    const res = await fetchImpl(sequencerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "base_sendRawTransactionValidity", params: [raw, { validity }] }),
      ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    const body = (await res.json()) as { result?: Hex; error?: { code: number; message: string } };
    if (body.error) throw new Error(`base_sendRawTransactionValidity: ${body.error.code} ${body.error.message}`);
    if (!body.result) throw new Error("base_sendRawTransactionValidity: no hash");
    return body.result;
  };
}

/** A SepoliaRpc over any client (the live one below, or a fake in the warm-up and tests). */
export function sepoliaRpcOver(client: RpcClient, submit: (raw: Hex, validity: Predicate[]) => Promise<Hex>): SepoliaRpc {
  return {
    read: (method, params) => client.call(method, params),
    call: (method, params) => client.call(method, params),
    batch: (calls) => client.batch(calls),
    submitValidity: submit,
  };
}

const liveRpcs = new Map<string, SepoliaRpc>();
/** Memoised per isolate: one raw client per (read list, sequencer). */
export function liveProtectRpc(readRpcList: string, sequencerUrl: string): SepoliaRpc {
  const key = `${readRpcList}|${sequencerUrl}`;
  let r = liveRpcs.get(key);
  if (!r) {
    r = sepoliaRpcOver(rpcFor(readRpcList), validitySubmitter(sequencerUrl));
    liveRpcs.set(key, r);
  }
  return r;
}
