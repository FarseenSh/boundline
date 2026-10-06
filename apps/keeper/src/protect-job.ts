// The protection job's network side: read every target's sizing in one multicall, read the feed slot, decide, and
// arm the chosen action as a validity transaction signed by PROTECT_KEY (a key of its own: a transaction that
// waits for a state change must not block the mirror key's nonce). Never throws; one JSON line per run.
import { CHAIN_IDS, createBaseClient, splitRpcUrls } from "@boundline/chain";
import type { Address, Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { PRIORITY_FEE_WEI, MIN_MAX_FEE_WEI } from "./config.js";
import {
  decideProtection,
  decodeSizing,
  encodeProtect,
  encodeSizing,
  hexToBigInt,
  isAlreadyKnown,
  predicatesFor,
  type Predicate,
  type ProtectionDecision,
  type ProtectTarget,
  type Sizing,
} from "./protect.js";
import { MULTICALL3, decodeAggregate3, encodeAggregate3, describeRevert } from "./raw.js";

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

export interface TargetReport {
  preLiq: Address;
  borrower: Address;
  sizing: Sizing | null;
  error?: string;
  decision: ProtectionDecision | null;
}

export interface ProtectReport {
  at: number;
  ms: number;
  signer: Address | null;
  targets: TargetReport[];
  armed: { preLiq: Address; borrower: Address; action: string; hash: Hex; nonce: number; bound: number; attempts: number; alreadyKnown: boolean } | null;
  skipped: "no-targets" | "no-key" | "nothing-to-do" | "read-failed" | null;
  errors: string[];
}

export interface ProtectDeps {
  rpc: ProtectRpc;
  protector: Address;
  targets: ProtectTarget[];
  account: PrivateKeyAccount | null;
  chainId: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rearmAfterMs?: number;
}

export async function runProtect(deps: ProtectDeps): Promise<ProtectReport> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const report: ProtectReport = { at: Math.floor(started / 1000), ms: 0, signer: deps.account?.address ?? null, targets: [], armed: null, skipped: null, errors: [] };
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
    sizings = decodeAggregate3(raw);
  } catch (err) {
    report.skipped = "read-failed";
    report.errors.push(`read failed: ${err instanceof Error ? err.message : String(err)}`);
    return finish();
  }

  let chosen: { target: ProtectTarget; decision: Extract<ProtectionDecision, { action: "partial" | "close" }> } | null = null;
  deps.targets.forEach((t, i) => {
    const r = sizings[i];
    const row: TargetReport = { preLiq: t.preLiq, borrower: t.borrower, sizing: null, decision: null };
    try {
      if (!r) throw new Error("no result");
      if (!r.success) throw new Error(describeRevert(r.returnData));
      row.sizing = decodeSizing(r.returnData);
      row.decision = decideProtection(row.sizing);
      if (!chosen && row.decision.action !== "none") chosen = { target: t, decision: row.decision };
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    }
    report.targets.push(row);
  });
  if (!chosen) {
    report.skipped = "nothing-to-do";
    return finish();
  }
  if (!deps.account) {
    report.skipped = "no-key";
    return finish();
  }
  const { target, decision } = chosen as { target: ProtectTarget; decision: Extract<ProtectionDecision, { action: "partial" | "close" }> };

  try {
    const [slotValue, nonceHex, gasPriceHex] = await Promise.all([
      deps.rpc.read("eth_getStorageAt", [target.feed, `0x${target.feedSlot.toString(16)}`, "latest"]) as Promise<Hex>,
      deps.rpc.read("eth_getTransactionCount", [deps.account.address, "pending"]) as Promise<Hex>,
      deps.rpc.read("eth_gasPrice", []) as Promise<Hex>,
    ]);
    const nonce = Number(hexToBigInt(nonceHex));
    const gasPrice = hexToBigInt(gasPriceHex);
    const maxFeePerGas = (gasPrice * 3n > MIN_MAX_FEE_WEI ? gasPrice * 3n : MIN_MAX_FEE_WEI) + PRIORITY_FEE_WEI;
    const deadline = BigInt(Math.floor(now() / 1000) + PROTECT_DEADLINE_SECONDS);
    const data = encodeProtect(target.preLiq, target.borrower, decision.seizedAssets, decision.repaidShares, 0n, deadline);
    const raw = await deps.account.signTransaction({
      chainId: deps.chainId,
      type: "eip1559",
      nonce,
      to: deps.protector,
      data,
      value: 0n,
      gas: PROTECT_GAS_LIMIT,
      maxFeePerGas,
      maxPriorityFeePerGas: PRIORITY_FEE_WEI,
    });
    // The action lands only while the feed still shows the round the decision was made on.
    const arm = async (h: bigint): Promise<{ hash: Hex; alreadyKnown: boolean }> => {
      try {
        return { hash: await deps.rpc.submitValidity(raw, predicatesFor(target.feed, target.feedSlot, slotValue, h, "held")), alreadyKnown: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isAlreadyKnown(msg)) return { hash: "0x" as Hex, alreadyKnown: true };
        throw err;
      }
    };
    let attempts = 1;
    let res = await arm(head);
    let bound = head + 30n;
    if (res.alreadyKnown) {
      // The previous tick's window is still alive; try once more after it has had time to expire.
      await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(deps.rearmAfterMs ?? REARM_AFTER_MS);
      const h2 = hexToBigInt((await deps.rpc.read("eth_blockNumber", [])) as Hex);
      attempts += 1;
      res = await arm(h2);
      bound = h2 + 30n;
    }
    report.armed = { preLiq: target.preLiq, borrower: target.borrower, action: decision.action, hash: res.hash, nonce, bound: Number(bound), attempts, alreadyKnown: res.alreadyKnown };
  } catch (err) {
    report.errors.push(`arm failed: ${err instanceof Error ? ((err as Error & { shortMessage?: string }).shortMessage ?? err.message) : String(err)}`);
  }
  return finish();
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

export function liveProtectRpc(readRpcList: string, sequencerUrl: string): ProtectRpc {
  const client = createBaseClient({ chainId: CHAIN_IDS.baseSepolia, rpcUrl: splitRpcUrls(readRpcList).join(",") });
  return {
    read: (method, params) => client.request({ method, params } as never) as Promise<unknown>,
    async submitValidity(raw, validity) {
      const res = await fetch(sequencerUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "base_sendRawTransactionValidity", params: [raw, { validity }] }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as { result?: Hex; error?: { code: number; message: string } };
      if (body.error) throw new Error(`base_sendRawTransactionValidity: ${body.error.code} ${body.error.message}`);
      if (!body.result) throw new Error("base_sendRawTransactionValidity: no hash");
      return body.result;
    },
  };
}
