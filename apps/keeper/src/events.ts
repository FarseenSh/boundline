// Keeper events for partners (plan M7 webhooks: grace, protect, hold, recovery): what the keeper saw change, sent to
// the partner API through an RPC binding (`API_EVENTS` → boundline-api, entrypoint `Events`, method `ingest`), which
// turns them into signed webhook deliveries. The keeper only says what happened; the API decides who hears it.
//
// State (KV `KEEPER_STATE`, key `state`) is what makes events edge-triggered rather than per tick: the lines in grace
// and the actions armed and not yet seen executed. It is written only when it changes (a grace entry or exit, a new
// arming episode, an execution or an expiry), never per re-arm, which keeps the KV free tier's 1,000 writes a day far
// away. Execution is read from the contracts' own `Protected` logs, so it does not depend on remembering every hash a
// re-arm produced.
import type { Address, Hex } from "viem";
import { BACKOFF_BLOCKS, type BackoffEntry } from "./protect.js";
import type { ProtectReport } from "./protect-job.js";
import { addressWord, hexToBigInt, strip, word } from "./raw.js";
import type { RpcCall, RpcOutcome } from "./rpc.js";
import { VAULT_PROTECTED_TOPIC, pct, usdc } from "./vault.js";
import type { VaultReport } from "./vault-job.js";

export interface KeeperEvent {
  type: "grace" | "grace.cleared" | "protect" | "hold" | "release" | "recovery" | "settle";
  chainId: number;
  at: number;
  source: "keeper" | "indexer";
  lineId?: string;
  borrower?: string;
  txHash?: string;
  decisionHash?: string;
  data: Record<string, string | number | boolean | null>;
}

/** The API's RPC entrypoint as the keeper sees it (Lane I implements `Events.ingest`). */
export interface EventsBinding {
  ingest(evt: KeeperEvent): Promise<{ accepted: boolean; id: string; deliveries: number }>;
  /** One bounded, idempotent webhook tick of the API (its own cron trigger never fires on this account). */
  tick?(): Promise<Record<string, unknown>>;
}

/** The Protector's `Protected(uint256 indexed decision, address indexed preLiquidation, address indexed borrower, …)` topic. */
export const PROTECTOR_PROTECTED_TOPIC: Hex = "0xc4b3a4508e924fa58f0a37b501b77bde60055ac86a8223cf545f7699f58bbcd8";

export const STATE_KEY = "state";
/** An action armed this many blocks ago and never seen executed is dropped (sepolia.base.org caps eth_getLogs at 500). */
export const ARMED_EXPIRY_BLOCKS = 450;

export interface ArmedEntry {
  kind: "vault-repay" | "pre-liquidation";
  /** The head when the episode's first arming happened: execution is looked for from here. */
  head: number;
  nonce: number;
  at: number;
  lineId?: string;
  borrower?: string;
  amountUsdc?: string;
  /** The first submission's hash (a re-arm can change it; the log is the proof of execution). */
  firstHash?: string;
}

export interface KeeperState {
  v: 1;
  /** In grace since (unix), keyed "line:<id>" for desk lines and "borrower:<0x…>" for pre-liquidation targets. */
  grace: Record<string, number>;
  /** Armed actions not yet seen executed, same keys. */
  armed: Record<string, ArmedEntry>;
  /** Targets whose action simulated as a revert: left alone until `untilHead` unless their fingerprint changes. */
  backoff: Record<string, BackoffEntry>;
}

export const EMPTY_STATE: KeeperState = { v: 1, grace: {}, armed: {}, backoff: {} };

export function parseState(raw: string | null): KeeperState {
  if (!raw) return { v: 1, grace: {}, armed: {}, backoff: {} };
  try {
    const s = JSON.parse(raw) as Partial<KeeperState>;
    if (s && s.v === 1 && typeof s.grace === "object" && typeof s.armed === "object" && s.grace && s.armed) {
      return { v: 1, grace: { ...s.grace }, armed: { ...s.armed }, backoff: s.backoff && typeof s.backoff === "object" ? { ...s.backoff } : {} };
    }
  } catch {
    /* a bad value starts from empty */
  }
  return { v: 1, grace: {}, armed: {}, backoff: {} };
}

export const lineKey = (lineId: string): string => `line:${lineId}`;
export const borrowerKey = (borrower: string): string => `borrower:${borrower.toLowerCase()}`;

// ---------------------------------------------------------------------------------------------- executions

export interface Execution {
  key: string;
  txHash: Hex;
  block: number;
  decisionHash: Hex;
  data: Record<string, string | number | boolean | null>;
}

/** One eth_getLogs per armed entry, from its arming head to latest, filtered on the line id or the borrower. */
export function executionReads(state: KeeperState, vault: Address | null, protector: Address | null): { key: string; call: RpcCall }[] {
  const out: { key: string; call: RpcCall }[] = [];
  for (const [key, a] of Object.entries(state.armed)) {
    const fromBlock = `0x${a.head.toString(16)}`;
    if (a.kind === "vault-repay" && vault && a.lineId) {
      out.push({ key, call: { method: "eth_getLogs", params: [{ address: vault, topics: [VAULT_PROTECTED_TOPIC, `0x${word(BigInt(a.lineId))}`], fromBlock, toBlock: "latest" }] } });
    } else if (a.kind === "pre-liquidation" && protector && a.borrower) {
      out.push({ key, call: { method: "eth_getLogs", params: [{ address: protector, topics: [PROTECTOR_PROTECTED_TOPIC, null, null, `0x${addressWord(a.borrower as Address)}`], fromBlock, toBlock: "latest" }] } });
    }
  }
  return out;
}

interface RawLog {
  transactionHash: Hex;
  blockNumber: Hex;
  data: Hex;
  topics: Hex[];
}

/** The first matching log per entry, decoded into an execution; entries with no log yet are left out. */
export function decodeExecutions(reads: readonly { key: string }[], outcomes: readonly RpcOutcome[], state: KeeperState): Execution[] {
  const found: Execution[] = [];
  reads.forEach((r, i) => {
    const o = outcomes[i];
    if (!o?.ok || !Array.isArray(o.result) || o.result.length === 0) return;
    const log = (o.result as RawLog[])[0]!;
    const a = state.armed[r.key];
    const d = strip(log.data);
    const w = (k: number): bigint => BigInt(`0x${d.slice(k * 64, (k + 1) * 64) || "0"}`);
    const block = Number(hexToBigInt(log.blockNumber));
    if (a?.kind === "vault-repay") {
      found.push({
        key: r.key,
        txHash: log.transactionHash,
        block,
        decisionHash: `0x${d.slice(6 * 64, 7 * 64)}` as Hex,
        data: { kind: "vault-repay", phase: "executed", block, repaidUsdc: usdc(w(0)), fromUserUsdc: usdc(w(1)), fromPartnerUsdc: usdc(w(2)), fromAdvanceUsdc: usdc(w(3)), debtBeforeUsdc: usdc(w(4)), debtAfterUsdc: usdc(w(5)) },
      });
    } else {
      found.push({
        key: r.key,
        txHash: log.transactionHash,
        block,
        decisionHash: `0x${d.slice(5 * 64, 6 * 64)}` as Hex,
        data: { kind: "pre-liquidation", phase: "executed", block, seizedRaw: w(0).toString(), repaidUsdc: usdc(w(1)), collateralSoldRaw: w(2).toString() },
      });
    }
  });
  return found;
}

// ---------------------------------------------------------------------------------------------- transitions

export interface TransitionInput {
  chainId: number;
  now: number;
  vault: VaultReport | null;
  protect: ProtectReport | null;
  executions: readonly Execution[];
  /** The chain head this tick (for expiring stale armed entries); null when unknown. */
  head: number | null;
}

/** The next state and the events it implies. Pure. */
export function transitions(prev: KeeperState, input: TransitionInput): { next: KeeperState; events: KeeperEvent[]; changed: boolean } {
  const next: KeeperState = { v: 1, grace: { ...prev.grace }, armed: { ...prev.armed }, backoff: { ...(prev.backoff ?? {}) } };
  const events: KeeperEvent[] = [];
  const at = input.now;

  // Desk lines: grace in and out. Only a definite reading clears grace (a failed read or a missing shadow price does not).
  for (const t of input.vault?.targets ?? []) {
    if (!t.sizing) continue;
    const key = lineKey(t.lineId);
    const inGrace = t.sizing.standing === "IN_GRACE";
    const definiteOut = t.sizing.standing === "BELOW_GRACE" || t.sizing.standing === "NO_DEBT" || t.sizing.standing === "LINE_CLOSED";
    const data = {
      shadowLtvPct: pct(t.sizing.shadowLtvWad),
      venueLtvPct: pct(t.sizing.venueLtvWad),
      graceLtvBps: t.graceLtvBps,
      targetLtvBps: t.targetLtvBps,
      debtUsdc: usdc(t.sizing.debt),
      amountUsdc: usdc(t.sizing.amount),
      session: t.quote?.session ?? null,
      standing: t.sizing.standing,
    };
    if (inGrace && next.grace[key] === undefined) {
      next.grace[key] = at;
      events.push({ type: "grace", chainId: input.chainId, at, source: "keeper", lineId: t.lineId, ...(t.line ? { borrower: t.line.user } : {}), data });
    } else if (!inGrace && definiteOut && next.grace[key] !== undefined) {
      const since = next.grace[key]!;
      delete next.grace[key];
      events.push({ type: "grace.cleared", chainId: input.chainId, at, source: "keeper", lineId: t.lineId, ...(t.line ? { borrower: t.line.user } : {}), data: { ...data, inGraceSince: since } });
    }
  }
  // Pre-liquidation targets: IN_BAND is their grace.
  for (const t of input.protect?.targets ?? []) {
    if (!t.sizing) continue;
    const key = borrowerKey(t.borrower);
    const inBand = t.sizing.standing === "IN_BAND";
    const definiteOut = t.sizing.standing === "BELOW_BAND" || t.sizing.standing === "NO_POSITION";
    const data = { kind: "pre-liquidation", standing: t.sizing.standing, shadowLtvPct: pct(t.sizing.shadowLtvWad), venueOracleLive: t.sizing.venueOracleLive, decision: t.decision?.action ?? null, fullCloseAllowed: t.sizing.fullCloseAllowed };
    if (inBand && next.grace[key] === undefined) {
      next.grace[key] = at;
      events.push({ type: "grace", chainId: input.chainId, at, source: "keeper", borrower: t.borrower, data });
    } else if (!inBand && definiteOut && next.grace[key] !== undefined) {
      const since = next.grace[key]!;
      delete next.grace[key];
      events.push({ type: "grace.cleared", chainId: input.chainId, at, source: "keeper", borrower: t.borrower, data: { ...data, inGraceSince: since } });
    }
  }

  // Simulated reverts start a backoff (no event: nothing was signed); a backoff that has run out is dropped.
  if (input.head !== null) {
    const head = input.head;
    const mark = (key: string, fingerprint: string | undefined, error: string) => {
      if (!fingerprint) return;
      const cur = next.backoff[key];
      if (cur && cur.fingerprint === fingerprint && head < cur.untilHead) return;
      next.backoff[key] = { untilHead: head + BACKOFF_BLOCKS, fingerprint, error, at };
    };
    for (const t of input.vault?.targets ?? []) if (t.decision?.action === "none" && t.decision.reason === "would-revert") mark(lineKey(t.lineId), t.fingerprint, t.decision.error);
    for (const t of input.protect?.targets ?? []) if (t.decision?.action === "none" && t.decision.reason === "would-revert") mark(borrowerKey(t.borrower), t.fingerprint, t.decision.error);
    for (const [key, b] of Object.entries(next.backoff)) if (head >= b.untilHead) delete next.backoff[key];
  }

  // Arming: one event per episode (the first submission), not per re-arm.
  const va = input.vault?.armed;
  if (va && !va.alreadyKnown) {
    const key = lineKey(va.lineId);
    delete next.backoff[key];
    if (!next.armed[key]) {
      const amountUsdc = usdc(va.amount);
      next.armed[key] = { kind: "vault-repay", head: va.head, nonce: va.nonce, at, lineId: va.lineId, amountUsdc, firstHash: va.hash };
      const borrower = input.vault?.targets.find((t) => t.lineId === va.lineId)?.line?.user;
      events.push({
        type: "protect",
        chainId: input.chainId,
        at,
        source: "keeper",
        lineId: va.lineId,
        ...(borrower ? { borrower } : {}),
        txHash: va.hash,
        data: { kind: "vault-repay", phase: "armed", amountUsdc, fromUserUsdc: usdc(va.funding.fromUser), fromPartnerUsdc: usdc(va.funding.fromPartner), fromAdvanceUsdc: usdc(va.funding.fromAdvance), nonce: va.nonce, bound: va.bound, predicate: "feed round held" },
      });
    }
  }
  const pa = input.protect?.armed;
  if (pa && !pa.alreadyKnown) {
    const key = borrowerKey(pa.borrower);
    delete next.backoff[key];
    if (!next.armed[key]) {
      next.armed[key] = { kind: "pre-liquidation", head: pa.bound - 30, nonce: pa.nonce, at, borrower: pa.borrower, firstHash: pa.hash };
      events.push({ type: "protect", chainId: input.chainId, at, source: "keeper", borrower: pa.borrower, txHash: pa.hash, data: { kind: "pre-liquidation", phase: "armed", action: pa.action, nonce: pa.nonce, bound: pa.bound, predicate: "feed round held" } });
    }
  }

  // Executions seen in the logs close their episode.
  for (const x of input.executions) {
    const a = next.armed[x.key];
    if (!a) continue;
    delete next.armed[x.key];
    events.push({
      type: "protect",
      chainId: input.chainId,
      at,
      source: "keeper",
      ...(a.lineId ? { lineId: a.lineId } : {}),
      ...(a.borrower ? { borrower: a.borrower } : {}),
      txHash: x.txHash,
      decisionHash: x.decisionHash,
      data: x.data,
    });
  }
  // Episodes armed long ago and never executed are dropped (the predicate never held, or another action took the nonce).
  if (input.head !== null) {
    for (const [key, a] of Object.entries(next.armed)) if (input.head - a.head > ARMED_EXPIRY_BLOCKS) delete next.armed[key];
  }

  const changed = JSON.stringify(next) !== JSON.stringify(prev);
  return { next, events, changed };
}

/**
 * Drives the partner API's webhook tick (bounded indexer poll, retries) once a minute: the API's own cron trigger has
 * never fired on this account (8 Oct 2026), while this one does. A missing binding or a failed call never fails the tick.
 */
export async function apiTick(binding: EventsBinding | undefined, timeoutMs = 10_000): Promise<string> {
  if (!binding?.tick) return "unbound";
  try {
    const r = await Promise.race([binding.tick(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))]);
    return typeof r.cron === "string" ? r.cron : "ok";
  } catch (err) {
    return `failed(${err instanceof Error ? err.message : String(err)})`;
  }
}

/** Sends every event through the binding; a missing binding or a failed call never fails the tick. */
export async function emitEvents(binding: EventsBinding | undefined, events: readonly KeeperEvent[], timeoutMs = 5_000): Promise<string[]> {
  if (events.length === 0) return [];
  if (!binding) return events.map((e) => `${e.type}:unsent(no binding)`);
  const out: string[] = [];
  for (const e of events) {
    try {
      const r = await Promise.race([binding.ingest(e), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))]);
      out.push(`${e.type}:${r.accepted ? "accepted" : "refused"}:${r.id}:${r.deliveries}`);
    } catch (err) {
      out.push(`${e.type}:failed(${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return out;
}
