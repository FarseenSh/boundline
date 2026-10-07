// Pure helpers that turn API records into the rows the timelines render.
import type { Decision, DecisionsResponse, Drill, DrillRun, TimelineEvent } from "./types.js";

export const ACTION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  OPEN: "Line opened",
  ADD_COLLATERAL: "Collateral added",
  DRAW: "Drawn",
  REPAY: "Repaid",
  WITHDRAW_COLLATERAL: "Collateral withdrawn",
  CLOSE: "Line closed",
  HOLD: "Put on hold by the keeper",
  RELEASE: "Hold released",
  PROTECT: "Protected",
  RECOVER: "Collateral recovered",
});

const SHARE_ACTIONS: ReadonlySet<string> = new Set(["ADD_COLLATERAL", "WITHDRAW_COLLATERAL"]);

export interface TimelineRow {
  kind: "decision" | "event";
  label: string;
  detail: string;
  hash: string | null;
  txHash: string;
  blockNumber: number;
  blockTime: number;
  logIndex: number;
}

function formatShares(raw: string, decimals = 8, places = 4): string {
  const x = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = x / base;
  const frac = (x % base).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function formatUsdc(raw: string): string {
  const x = BigInt(raw);
  const whole = x / 1_000_000n;
  const frac = (x % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `$${whole}.${frac}`;
}

export function decisionDetail(d: Decision): string {
  const parts: string[] = [];
  const amount = BigInt(d.amount || "0");
  if (amount !== 0n) parts.push(SHARE_ACTIONS.has(d.action) ? `${formatShares(d.amount)} sh` : formatUsdc(d.amount));
  const price = BigInt(d.price8 || "0");
  if (price !== 0n) parts.push(`at $${(Number(price) / 1e8).toFixed(2)}`);
  return parts.join(" ");
}

function eventDetail(e: TimelineEvent): string {
  const skip = new Set(["lineId", "decisionHash", "hash"]);
  return Object.entries(e.args)
    .filter(([k, v]) => !skip.has(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
    .map(([k, v]) => `${k}=${String(v).length > 20 ? `${String(v).slice(0, 10)}…${String(v).slice(-6)}` : String(v)}`)
    .join(" ");
}

/** Decisions and the other desk events of a line, oldest first, in block then log order. */
export function buildLineTimeline(res: Pick<DecisionsResponse, "decisions" | "timeline">): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const d of res.decisions) {
    rows.push({ kind: "decision", label: ACTION_WORDS[d.action] ?? d.action, detail: decisionDetail(d), hash: d.hash || null, txHash: d.txHash, blockNumber: d.blockNumber, blockTime: d.blockTime, logIndex: d.logIndex });
  }
  for (const e of res.timeline) {
    rows.push({ kind: "event", label: e.event, detail: eventDetail(e), hash: e.hash, txHash: e.txHash, blockNumber: e.blockNumber, blockTime: e.blockTime, logIndex: e.logIndex });
  }
  return rows.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

export function explorerTx(chainId: number, hash: string): string {
  return `${chainId === 8453 ? "https://basescan.org" : "https://sepolia.basescan.org"}/tx/${hash}`;
}

export function explorerAddress(chainId: number, address: string): string {
  return `${chainId === 8453 ? "https://basescan.org" : "https://sepolia.basescan.org"}/address/${address}`;
}

export function latestRun(drill: Pick<Drill, "runs">): DrillRun | null {
  if (drill.runs.length === 0) return null;
  return [...drill.runs].sort((a, b) => b.ranAt - a.ranAt)[0] ?? null;
}

export type Tone = "live" | "bad" | "warn" | "plain";

/** PASS / executed / included read as live; FAIL / reverted as bad; partial or pending as warn. */
export function outcomeTone(outcome: string): Tone {
  const o = outcome.toLowerCase();
  if (/fail|revert|missed|lost|error/.test(o)) return "bad";
  if (/partial|pending|waiting|not included|deferred/.test(o)) return "warn";
  if (/pass|ok|executed|included|landed|protected|refused as designed|held as designed|success/.test(o)) return "live";
  return "plain";
}

export function statusTone(status: string): Tone {
  const s = status.toUpperCase();
  if (s === "OPEN" || s === "PASS" || s === "ALLOW" || s === "APPLIED") return "live";
  if (s.startsWith("HOLD") || s === "HELD" || s === "PREPARED" || s === "WARN") return "warn";
  if (s === "FAIL" || s === "CLOSED" || s === "PROTECT" || s === "NONE") return "bad";
  return "plain";
}
