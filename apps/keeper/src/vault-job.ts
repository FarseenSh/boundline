// The vault job's network side: one JSON-RPC batch per tick (head, one Multicall3 read of every target, the feed
// slots, the signer's nonces and the gas price), a pure decision (vault.ts), and at most one signed `protect` armed as
// a validity transaction. Signs with the protection signer (PROTECT_KEY), the same key as the Protector job, so the
// two share one rule: one signature per tick, the Protector first. Never throws.
import type { Address, Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { isAlreadyKnown, isUnderpriced, predicatesFor, rearmFees, type BackoffEntry, type Predicate } from "./protect.js";
import { whyNone, type SimulationVerdict } from "./protect-job.js";
import { decodeRevert } from "./reverts.js";
import { MULTICALL3, decodeAggregate3, describeRevert, encodeAggregate3, hexToBigInt, type Call3 } from "./raw.js";
import type { RpcCall, RpcOutcome } from "./rpc.js";
import {
  LADDER_PROBE,
  VAULT_PROTECT_GAS_LIMIT,
  VAULT_SELECTOR,
  decideVault,
  decodeAddress,
  decodeFunding,
  decodeLine,
  decodeQuote,
  decodeUint,
  encodeCapacity,
  encodeLine,
  encodePreviewProtect,
  encodeVaultProtect,
  sizeVault,
  type DeskLine,
  type DeskQuote,
  type Funding,
  type VaultDecision,
  type VaultSizing,
  type VaultTarget,
} from "./vault.js";

/** Second arming attempt in the same tick when the first answer is "already known" (the same bytes are still alive). */
export const VAULT_REARM_AFTER_MS = 35_000;
/** What decides a repay, without the fields interest moves every block (so a backoff can hold). */
export function vaultFingerprint(amount: bigint, ladder: Funding | null, paused: boolean, status: string, shadowPrice36: bigint | null): string {
  return `${amount}:${ladder ? `${ladder.fromUser}/${ladder.fromPartner}/${ladder.fromAdvance}` : "-"}:${paused}:${status}:${shadowPrice36 ?? "-"}`;
}

/** The vault's pre-flight: eth_call of protect(lineId, amount) from the signer at latest and pending, in one batch. */
export async function simulateBatch(rpc: Pick<VaultRpc, "batch">, from: Address, to: Address, data: Hex): Promise<SimulationVerdict> {
  let out: RpcOutcome[];
  try {
    out = await rpc.batch([
      { method: "eth_call", params: [{ from, to, data }, "latest"] },
      { method: "eth_call", params: [{ from, to, data }, "pending"] },
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { verdict: "unavailable", error: msg, simulation: { latest: msg, pending: null } };
  }
  const read = (o: RpcOutcome | undefined): { ok: true } | { ok: false; revert: boolean; error: string } => {
    if (o?.ok) return { ok: true };
    if (!o) return { ok: false, revert: false, error: "missing" };
    const revert = /revert|rpc 3 /i.test(o.error) || typeof o.data === "string";
    return { ok: false, revert, error: revert ? decodeRevert(o.data ?? "0x") : o.error };
  };
  const latest = read(out[0]);
  const pending = read(out[1]);
  const simulation = { latest: latest.ok ? "ok" : latest.error, pending: pending.ok ? "ok" : pending.revert ? pending.error : null };
  if (!latest.ok) return { verdict: latest.revert ? "revert" : "unavailable", error: latest.error, simulation };
  if (!pending.ok && pending.revert) return { verdict: "revert", error: `pending: ${pending.error}`, simulation };
  return { verdict: "ok", simulation };
}

export interface VaultRpc {
  batch(calls: readonly RpcCall[]): Promise<RpcOutcome[]>;
  call<T = unknown>(method: string, params: readonly unknown[]): Promise<T>;
  submitValidity(raw: Hex, validity: Predicate[]): Promise<Hex>;
}

export interface VaultTargetReport {
  lineId: string;
  graceLtvBps: number;
  targetLtvBps: number;
  line: Pick<DeskLine, "user" | "partnerId" | "status" | "drawnPrincipal" | "marketId" | "collateral"> | null;
  quote: Pick<DeskQuote, "reason" | "session" | "price8" | "collateralValue" | "corporateActionHaircut"> | null;
  sizing: VaultSizing | null;
  /** The whole ladder for this line right now (user reserve, partner reserve, advance room). */
  ladder: Funding | null;
  /** How the decided amount would be funded (previewProtect at that amount, computed from the ladder). */
  funding: Funding | null;
  decision: VaultDecision | null;
  /** Present when the repay was simulated this run (eth_call from the signer at latest and pending). */
  simulation?: { latest: string; pending: string | null };
  /** What decides the repay (vaultFingerprint), present when there was one to consider. */
  fingerprint?: string;
  error?: string;
}

export interface VaultArmed {
  lineId: string;
  amount: bigint;
  funding: Funding;
  hash: Hex;
  nonce: number;
  /** The block-number bound of the last submission. */
  bound: number;
  /** The head when the action was armed (execution is looked for from here). */
  head: number;
  attempts: number;
  alreadyKnown: boolean;
  /** The re-arm fee step (protect.ts rearmFees): 0 on an episode's first arming, rising 25% per 30 blocks after. */
  feeStep: number;
}

export interface VaultReport {
  at: number;
  ms: number;
  vault: Address;
  keeper: Address | null;
  signer: Address | null;
  keeperIsSigner: boolean | null;
  paused: boolean | null;
  head: number | null;
  targets: VaultTargetReport[];
  armed: VaultArmed | null;
  skipped: "no-targets" | "read-failed" | "nothing-to-do" | "no-key" | "not-keeper" | "would-revert" | "backoff" | "simulation-unavailable" | "signer-busy" | "in-flight" | null;
  errors: string[];
}

export interface VaultDeps {
  rpc: VaultRpc;
  vault: Address;
  desk: Address;
  targets: readonly VaultTarget[];
  account: PrivateKeyAccount | null;
  chainId: number;
  /** True when the Protector job wanted to sign in this tick: the shared signer then belongs to it. */
  signerBusy?: boolean;
  /** Live view only: decide and simulate, never sign. */
  dryRun?: boolean;
  /** A standing backoff for this line after a simulated revert (KV state). */
  backoff?: (lineId: string) => BackoffEntry | null;
  /** The head at which this line's current arming episode began (KV state), for the re-arm fee schedule. */
  episodeHead?: (lineId: string) => bigint | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rearmAfterMs?: number;
}

const PER_TARGET_CALLS = 4;

function outcomeHex(o: RpcOutcome | undefined, what: string): Hex {
  if (!o) throw new Error(`${what}: missing`);
  if (!o.ok) throw new Error(`${what}: ${o.error}`);
  return o.result as Hex;
}

export async function runVault(deps: VaultDeps): Promise<VaultReport> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const report: VaultReport = {
    at: Math.floor(started / 1000),
    ms: 0,
    vault: deps.vault,
    keeper: null,
    signer: deps.account?.address ?? null,
    keeperIsSigner: null,
    paused: null,
    head: null,
    targets: [],
    armed: null,
    skipped: null,
    errors: [],
  };
  const finish = (): VaultReport => {
    report.ms = now() - started;
    return report;
  };
  // ---- one batch: head, the multicall, every distinct feed slot, the signer's nonces and the gas price
  const calls: Call3[] = [
    { target: deps.vault, allowFailure: true, callData: VAULT_SELECTOR.keeper },
    { target: deps.vault, allowFailure: true, callData: VAULT_SELECTOR.paused },
  ];
  for (const t of deps.targets) {
    calls.push({ target: deps.desk, allowFailure: true, callData: encodeLine(t.lineId) });
    calls.push({ target: deps.desk, allowFailure: true, callData: encodeCapacity(t.lineId) });
    calls.push({ target: t.shadowOracle, allowFailure: true, callData: VAULT_SELECTOR.price });
    calls.push({ target: deps.vault, allowFailure: true, callData: encodePreviewProtect(t.lineId, LADDER_PROBE) });
  }
  const slots = new Map<string, { feed: Address; slot: bigint }>();
  for (const t of deps.targets) slots.set(`${t.feed.toLowerCase()}:${t.feedSlot}`, { feed: t.feed, slot: t.feedSlot });
  const slotKeys = [...slots.keys()];
  const batch: RpcCall[] = [
    { method: "eth_blockNumber", params: [] },
    { method: "eth_call", params: [{ to: MULTICALL3, data: encodeAggregate3(calls) }, "latest"] },
    ...slotKeys.map((k) => {
      const s = slots.get(k)!;
      return { method: "eth_getStorageAt", params: [s.feed, `0x${s.slot.toString(16)}`, "latest"] };
    }),
  ];
  const signer = deps.account?.address ?? null;
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
  const slotValue = new Map<string, Hex>();
  slotKeys.forEach((k, i) => {
    const o = out[2 + i];
    if (o?.ok) slotValue.set(k, o.result as Hex);
  });

  const keeperRes = results[0];
  const pausedRes = results[1];
  report.keeper = keeperRes?.success ? decodeAddress(keeperRes.returnData) : null;
  report.paused = pausedRes?.success ? decodeUint(pausedRes.returnData) !== 0n : null;
  report.keeperIsSigner = signer && report.keeper ? report.keeper.toLowerCase() === signer.toLowerCase() : signer ? false : null;

  // ---- per target: decode, size, decide
  const candidates: { target: VaultTarget; row: VaultTargetReport; decision: Extract<VaultDecision, { action: "protect" }> }[] = [];
  deps.targets.forEach((t, i) => {
    const base = 2 + i * PER_TARGET_CALLS;
    const row: VaultTargetReport = { lineId: t.lineId.toString(), graceLtvBps: t.graceLtvBps, targetLtvBps: t.targetLtvBps, line: null, quote: null, sizing: null, ladder: null, funding: null, decision: null };
    try {
      const [l, q, p, f] = [results[base], results[base + 1], results[base + 2], results[base + 3]];
      if (!l?.success) throw new Error(`line: ${l ? describeRevert(l.returnData) : "no result"}`);
      if (!q?.success) throw new Error(`capacity: ${q ? describeRevert(q.returnData) : "no result"}`);
      const line = decodeLine(l.returnData);
      const quote = decodeQuote(q.returnData);
      row.line = { user: line.user, partnerId: line.partnerId, status: line.status, drawnPrincipal: line.drawnPrincipal, marketId: line.marketId, collateral: line.collateral };
      row.quote = { reason: quote.reason, session: quote.session, price8: quote.price8, collateralValue: quote.collateralValue, corporateActionHaircut: quote.corporateActionHaircut };
      // The ShadowGuard reverts when it cannot price (issuer or transfer pause, an invalid feed, TWAP too far): no action.
      const shadow = p?.success ? decodeUint(p.returnData) : null;
      row.sizing = sizeVault(line, quote, shadow, t);
      row.ladder = f?.success ? decodeFunding(f.returnData) : null;
      row.decision = decideVault(row.sizing, row.ladder, report.paused === true);
      if (row.decision.action === "protect") {
        row.funding = row.decision.funding;
        row.fingerprint = vaultFingerprint(row.decision.amount, row.ladder, report.paused === true, line.status, shadow);
        candidates.push({ target: t, row, decision: row.decision });
      }
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    }
    report.targets.push(row);
  });

  if (candidates.length === 0) {
    report.skipped = deps.targets.length === 0 ? "no-targets" : "nothing-to-do";
    return finish();
  }
  if (!deps.account || !signer) {
    report.skipped = "no-key";
    return finish();
  }
  if (report.keeperIsSigner !== true) {
    // Until the owner points the vault's keeper at this signer, the job watches and never signs.
    report.skipped = "not-keeper";
    return finish();
  }
  // Highest shadow LTV first; every repay is simulated from the signer before it may be signed (a revert never is).
  candidates.sort((a, b) => ((b.row.sizing?.shadowLtvWad ?? 0n) > (a.row.sizing?.shadowLtvWad ?? 0n) ? 1 : -1));
  let chosen: { target: VaultTarget; row: VaultTargetReport; decision: Extract<VaultDecision, { action: "protect" }> } | null = null;
  for (const c of candidates) {
    const bo = deps.backoff?.(c.row.lineId) ?? null;
    if (bo && head < BigInt(bo.untilHead) && bo.fingerprint === c.row.fingerprint) {
      c.row.decision = { action: "none", reason: "backoff", error: bo.error, untilHead: bo.untilHead };
      continue;
    }
    const sim = await simulateBatch(deps.rpc, signer, deps.vault, encodeVaultProtect(c.target.lineId, c.decision.amount));
    c.row.simulation = sim.simulation;
    if (sim.verdict !== "ok") {
      c.row.decision = { action: "none", reason: sim.verdict === "revert" ? "would-revert" : "simulation-unavailable", error: sim.error };
      continue;
    }
    chosen = c;
    break;
  }
  if (!chosen) {
    report.skipped = whyNone(candidates.map((c) => c.row.decision));
    return finish();
  }
  if (deps.signerBusy) {
    report.skipped = "signer-busy";
    return finish();
  }
  const latestO = out[2 + slotKeys.length];
  const pendingO = out[3 + slotKeys.length];
  const gasO = out[4 + slotKeys.length];
  let latest: bigint;
  let pending: bigint;
  let gasPrice: bigint;
  try {
    latest = hexToBigInt(outcomeHex(latestO, "nonce latest"));
    pending = hexToBigInt(outcomeHex(pendingO, "nonce pending"));
    gasPrice = hexToBigInt(outcomeHex(gasO, "eth_gasPrice"));
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

  const { target, decision } = chosen as { target: VaultTarget; row: VaultTargetReport; decision: Extract<VaultDecision, { action: "protect" }> };
  const slotKey = `${target.feed.toLowerCase()}:${target.feedSlot}`;
  const held = slotValue.get(slotKey);
  if (!held) {
    report.errors.push(`feed slot unread for ${target.feed}`);
    report.skipped = "read-failed";
    return finish();
  }
  try {
    const data = encodeVaultProtect(target.lineId, decision.amount);
    const episodeHead = deps.episodeHead?.(target.lineId.toString()) ?? null;
    const signAt = (fees: ReturnType<typeof rearmFees>) =>
      deps.account!.signTransaction({
        chainId: deps.chainId,
        type: "eip1559",
        nonce: Number(pending),
        to: deps.vault,
        data,
        value: 0n,
        gas: VAULT_PROTECT_GAS_LIMIT,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
    // The repay lands only while the feed still shows the round the decision was made on.
    const arm = async (raw: Hex, h: bigint): Promise<{ hash: Hex; retry: boolean }> => {
      try {
        return { hash: await deps.rpc.submitValidity(raw, predicatesFor(target.feed, target.feedSlot, held, h, "held")), retry: false };
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
      // An earlier submission with this nonce is alive: let it expire, then re-sign two fee steps up (a new hash;
      // identical bytes re-submitted after expiry were accepted but never included, 8 Oct 2026).
      await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(deps.rearmAfterMs ?? VAULT_REARM_AFTER_MS);
      const h2 = hexToBigInt(await deps.rpc.call<Hex>("eth_blockNumber", []));
      fees = rearmFees(gasPrice, episodeHead ?? head, h2, 2);
      attempts += 1;
      res = await arm(await signAt(fees), h2);
      bound = h2 + 30n;
    }
    report.armed = { lineId: target.lineId.toString(), amount: decision.amount, funding: decision.funding, hash: res.hash, nonce: Number(pending), bound: Number(bound), head: Number(head), attempts, alreadyKnown: res.retry, feeStep: fees.step };
  } catch (err) {
    report.errors.push(`arm failed: ${err instanceof Error ? ((err as Error & { shortMessage?: string }).shortMessage ?? err.message) : String(err)}`);
  }
  return finish();
}
