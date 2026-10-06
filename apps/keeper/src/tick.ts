// One cron tick: read both chains, plan, send what differs with contiguous nonces, report. Never throws.
import type { Address, Hex } from "viem";
import type { MirrorChain, Receipt, SideReads } from "./chain.js";
import { MAX_TX_PER_TICK, type MirrorPair } from "./config.js";
import { planFeedMirror, planRegistryMirror, shouldSend, type FeedPlan, type RegistryPlan } from "./plan.js";

export interface TxReport {
  symbol: string;
  kind: "feed" | "registry";
  to: Address;
  nonce: string;
  hash?: Hex;
  receipt?: { block: string; status: Receipt["status"]; gasUsed: string } | "pending";
  error?: string;
}

export interface SymbolReport {
  symbol: string;
  feed: { plan: FeedPlan["action"] | "error"; reason: string; changed?: readonly string[] };
  registry: { plan: RegistryPlan["action"] | "error"; reason: string };
}

export interface TickReport {
  at: number;
  durationMs: number;
  keeper: Address | null;
  /** Why nothing was sent, when nothing was. */
  skipped: "no-key" | "in-flight" | "nothing-to-do" | "read-failed" | null;
  nonces: { latest: string; pending: string } | null;
  blocks: { mainnet: string; sepolia: string } | null;
  planned: number;
  sent: number;
  /** Planned transactions left for the next tick (the per-tick cap, or a rejected send). */
  deferred: number;
  symbols: SymbolReport[];
  txs: TxReport[];
  errors: string[];
}

interface PlannedTx {
  symbol: string;
  kind: "feed" | "registry";
  to: Address;
  send: (nonce: bigint) => Promise<Hex>;
}

export interface TickOptions {
  /** Transactions signed and sent in this tick; see MAX_TX_PER_TICK. */
  maxTxPerTick?: number;
  now?: () => number;
}

function reasonOf(plan: FeedPlan | RegistryPlan): string {
  return plan.reason;
}

/** Plans every pair from two side reads: every feed update, then every registry update. Pure; exported for tests. */
export function planAll(pairs: readonly MirrorPair[], mainnet: SideReads, sepolia: SideReads, chain: MirrorChain) {
  const symbols: SymbolReport[] = [];
  const feedTxs: PlannedTx[] = [];
  const registryTxs: PlannedTx[] = [];
  for (const p of pairs) {
    const mr = mainnet.rounds.get(p.symbol);
    const sr = sepolia.rounds.get(p.symbol);
    const mg = mainnet.registry.get(p.symbol);
    const sg = sepolia.registry.get(p.symbol);
    const report: SymbolReport = { symbol: p.symbol, feed: { plan: "error", reason: "unread" }, registry: { plan: "error", reason: "unread" } };

    if (!mr || !mr.ok) {
      report.feed = { plan: "error", reason: `mainnet read failed: ${mr?.ok === false ? mr.error : "missing"}` };
    } else {
      const plan = planFeedMirror(mr.value, sr?.ok ? sr.value : null);
      report.feed = plan.action === "skip" ? { plan: "skip", reason: reasonOf(plan) } : { plan: "setRoundData", reason: plan.reason, changed: plan.changed };
      if (plan.action === "setRoundData") {
        const args = plan.args;
        feedTxs.push({ symbol: p.symbol, kind: "feed", to: p.sepoliaFeed, send: (nonce) => chain.setRoundData(p.sepoliaFeed, args, nonce) });
      }
    }

    if (!mg || !mg.ok) {
      report.registry = { plan: "error", reason: `mainnet read failed: ${mg?.ok === false ? mg.error : "missing"}` };
    } else {
      const plan = planRegistryMirror(mg.value, sg?.ok ? sg.value : null);
      report.registry = { plan: plan.action, reason: plan.reason };
      if (plan.action === "setOracleParams") {
        const [multiplier, paused] = plan.args;
        registryTxs.push({ symbol: p.symbol, kind: "registry", to: p.sepoliaToken, send: (nonce) => chain.setOracleParams(p.sepoliaToken, multiplier, paused, nonce) });
      }
    }
    symbols.push(report);
  }
  // Feeds first: they decide whether the gate opens; registry params change rarely.
  return { symbols, txs: [...feedTxs, ...registryTxs] };
}

export async function runTick(chain: MirrorChain, pairs: readonly MirrorPair[], opts: TickOptions = {}): Promise<TickReport> {
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const report: TickReport = {
    at: Math.floor(started / 1000),
    durationMs: 0,
    keeper: chain.keeper,
    skipped: null,
    nonces: null,
    blocks: null,
    planned: 0,
    sent: 0,
    deferred: 0,
    symbols: [],
    txs: [],
    errors: [],
  };
  const finish = (): TickReport => {
    report.durationMs = now() - started;
    return report;
  };

  let mainnet: SideReads;
  let sepolia: SideReads;
  try {
    [mainnet, sepolia] = await Promise.all([chain.readMainnet(pairs), chain.readSepolia(pairs)]);
  } catch (err) {
    report.skipped = "read-failed";
    report.errors.push(`read failed: ${err instanceof Error ? err.message : String(err)}`);
    return finish();
  }
  report.blocks = { mainnet: mainnet.block.toString(), sepolia: sepolia.block.toString() };

  const { symbols, txs } = planAll(pairs, mainnet, sepolia, chain);
  report.symbols = symbols;
  report.planned = txs.length;
  if (txs.length === 0) {
    report.skipped = "nothing-to-do";
    return finish();
  }
  if (chain.keeper === null) {
    report.skipped = "no-key";
    return finish();
  }

  let nonces: { latest: bigint; pending: bigint };
  try {
    nonces = await chain.nonces();
  } catch (err) {
    report.skipped = "read-failed";
    report.errors.push(`nonce read failed: ${err instanceof Error ? err.message : String(err)}`);
    return finish();
  }
  report.nonces = { latest: nonces.latest.toString(), pending: nonces.pending.toString() };
  if (!shouldSend(nonces.latest, nonces.pending)) {
    report.skipped = "in-flight";
    return finish();
  }

  const limit = Math.max(0, Math.floor(opts.maxTxPerTick ?? MAX_TX_PER_TICK));
  let nonce = nonces.pending;
  for (const tx of txs) {
    if (report.sent >= limit) break;
    const row: TxReport = { symbol: tx.symbol, kind: tx.kind, to: tx.to, nonce: nonce.toString() };
    report.txs.push(row);
    try {
      row.hash = await tx.send(nonce);
    } catch (err) {
      // A rejected send leaves the nonce unused; stop here so the next tick starts from a clean nonce.
      row.error = err instanceof Error ? ((err as Error & { shortMessage?: string }).shortMessage ?? err.message) : String(err);
      report.errors.push(`${tx.symbol} ${tx.kind}: ${row.error}`);
      break;
    }
    // Never wait for the receipt inside a tick: the next tick's nonce check (pending > latest) covers a transaction
    // still in flight, and a revert shows up as the plan still differing a minute later.
    row.receipt = "pending";
    report.sent += 1;
    nonce += 1n;
  }
  report.deferred = txs.length - report.txs.length;
  return finish();
}
