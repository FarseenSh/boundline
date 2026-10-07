// Pure policy maths and the draft builder. The API speaks in base units and 1e18 ratios; the editor speaks in
// percent and USDC. Every conversion is exact bigint arithmetic, and the draft carries only what changed.
import type { PartnerConfig, PartnerDraft, PolicyChange, PolicyDraftBody, PolicyResponse, TickerDraft, TickerPolicy } from "./types.js";

export const WAD = 10n ** 18n;
export const USDC_DECIMALS = 6;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function isZeroAddress(a: string | null | undefined): boolean {
  return !a || a.toLowerCase() === ZERO_ADDRESS;
}

/** "580000000000000000" → 58 (four decimals kept). */
export function wadToPercent(wad: string): number {
  const bps4 = (BigInt(wad) * 1_000_000n) / WAD; // percent × 10,000
  return Number(bps4) / 10_000;
}

/** 58 → "580000000000000000"; four decimals of a percent are kept, the rest is dropped. */
export function percentToWad(pct: number): string {
  if (!Number.isFinite(pct) || pct < 0) throw new Error("percent must be a finite non-negative number");
  const bps4 = BigInt(Math.round(pct * 10_000));
  return ((bps4 * WAD) / 1_000_000n).toString();
}

/** Base units → "2.80" style text (two decimals, more only when needed). */
export function formatUsdc(baseUnits: string | bigint): string {
  const x = BigInt(baseUnits);
  const neg = x < 0n;
  const abs = neg ? -x : x;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0");
  const trimmed = frac.replace(/0+$/, "");
  const shown = trimmed.length <= 2 ? frac.slice(0, 2) : trimmed;
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}.${shown}`;
}

/** "2.5" → "2500000"; null when the text is not a plain decimal with at most six places. */
export function parseUsdc(text: string): string | null {
  const t = text.trim().replace(/,/g, "");
  if (t === "") return "0";
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(t);
  if (!m) return null;
  const whole = BigInt(m[1] ?? "0");
  const frac = (m[2] ?? "").padEnd(6, "0");
  return (whole * 1_000_000n + BigInt(frac)).toString();
}

export function parsePercent(text: string): number | null {
  const t = text.trim().replace(/%$/, "");
  if (!/^\d+(?:\.\d{0,4})?$/.test(t)) return null;
  return Number(t);
}

export function tickerDraftFrom(p: TickerPolicy): TickerDraft {
  return { collateral: p.collateral, allowed: p.allowed, maxLtvWad: p.maxLtvWad, minDraw: p.minDraw, maxDraw: p.maxDraw, exposureCap: p.exposureCap };
}

export function partnerDraftFrom(p: PartnerConfig): PartnerDraft {
  return { signer: p.signer, eligibility: p.eligibility, exposureCap: p.exposureCap, active: p.active };
}

const TICKER_FIELDS = ["allowed", "maxLtvWad", "minDraw", "maxDraw", "exposureCap"] as const;
const PARTNER_FIELDS = ["signer", "eligibility", "exposureCap", "active"] as const;

function same(a: string | boolean, b: string | boolean): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) === BigInt(b);
  return a.toLowerCase() === b.toLowerCase();
}

function tickerChanged(current: TickerPolicy, draft: TickerDraft): boolean {
  return TICKER_FIELDS.some((f) => !same(current[f], draft[f]));
}

function partnerChanged(current: PartnerConfig, draft: PartnerDraft): boolean {
  return PARTNER_FIELDS.some((f) => !same(current[f], draft[f]));
}

export interface EditedPolicy {
  tickers: TickerDraft[];
  partner: PartnerDraft;
}

/** Field-level diff of the editor's state against the policy read from the desk, before anything is sent. */
export function localChanges(current: PolicyResponse, edited: EditedPolicy): PolicyChange[] {
  const out: PolicyChange[] = [];
  for (const f of PARTNER_FIELDS) {
    if (!same(current.partner[f], edited.partner[f])) out.push({ scope: "partner", field: f, before: current.partner[f], after: edited.partner[f] });
  }
  for (const d of edited.tickers) {
    const cur = current.tickers.find((t) => t.collateral.toLowerCase() === d.collateral.toLowerCase());
    if (!cur) continue;
    for (const f of TICKER_FIELDS) {
      if (!same(cur[f], d[f])) out.push({ scope: "ticker", collateral: d.collateral, field: f, before: cur[f], after: d[f] });
    }
  }
  return out;
}

/** The POST body: a note plus only the tickers and the partner config that differ from the current policy. */
export function buildDraftBody(current: PolicyResponse, edited: EditedPolicy, note: string): PolicyDraftBody {
  const body: PolicyDraftBody = { note: note.trim() };
  const tickers = edited.tickers.filter((d) => {
    const cur = current.tickers.find((t) => t.collateral.toLowerCase() === d.collateral.toLowerCase());
    return cur ? tickerChanged(cur, d) : false;
  });
  if (tickers.length > 0) body.tickers = tickers;
  if (partnerChanged(current.partner, edited.partner)) body.partner = edited.partner;
  return body;
}

export function hasChanges(body: PolicyDraftBody): boolean {
  return Boolean(body.tickers?.length) || body.partner !== undefined;
}

/** What the desk would refuse, caught before the draft is prepared. */
export function validateDraft(current: PolicyResponse, edited: EditedPolicy): string[] {
  const errors: string[] = [];
  for (const d of edited.tickers) {
    const cur = current.tickers.find((t) => t.collateral.toLowerCase() === d.collateral.toLowerCase());
    const name = cur?.symbol ?? d.collateral;
    const ltv = BigInt(d.maxLtvWad);
    if (ltv <= 0n || ltv >= WAD) errors.push(`${name}: max LTV must be above 0% and below 100%`);
    if (cur && ltv >= BigInt(cur.marketLltvWad)) errors.push(`${name}: max LTV ${wadToPercent(d.maxLtvWad)}% is not below the market LLTV ${wadToPercent(cur.marketLltvWad)}%`);
    const min = BigInt(d.minDraw);
    const max = BigInt(d.maxDraw);
    if (max !== 0n && min > max) errors.push(`${name}: min draw ${formatUsdc(min)} is above max draw ${formatUsdc(max)}`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(edited.partner.signer)) errors.push("partner signer must be an address (zero address for open access)");
  if (!/^0x[0-9a-fA-F]{40}$/.test(edited.partner.eligibility)) errors.push("eligibility hook must be an address (zero address for none)");
  return errors;
}

const FIELD_WORDS: Record<string, string> = {
  allowed: "allowed",
  maxLtvWad: "max LTV",
  minDraw: "min draw",
  maxDraw: "max draw",
  exposureCap: "exposure cap",
  signer: "signer",
  eligibility: "eligibility hook",
  active: "active",
};

export function formatFieldValue(field: string, value: string | boolean | number | null): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (field === "maxLtvWad" || field === "marketLltvWad") return `${wadToPercent(value)}%`;
  if (field === "minDraw" || field === "maxDraw" || field === "exposureCap" || field === "exposure") return BigInt(value) === 0n && field !== "exposure" ? (field === "minDraw" ? "0 (none)" : "0 (no cap)") : `${formatUsdc(value)} USDC`;
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return isZeroAddress(value) ? "none" : `${value.slice(0, 6)}…${value.slice(-4)}`;
  return value;
}

/** "AAPLt max LTV 58% → 55%". */
export function describeChange(change: PolicyChange, symbolOf: (collateral: string) => string = (c) => c): string {
  const subject = change.scope === "ticker" && change.collateral ? symbolOf(change.collateral) : "partner";
  const field = FIELD_WORDS[change.field] ?? change.field;
  return `${subject} ${field} ${formatFieldValue(change.field, change.before)} → ${formatFieldValue(change.field, change.after)}`;
}
