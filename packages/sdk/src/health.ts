// The health bar's arithmetic and words. Inputs are the desk's own quote (collateral value after any
// corporate-action haircut, debt with interest, the policy's effective max LTV) and the market's LLTV,
// so the bar agrees with what the desk would do.
import { GATE_REASONS, REASON_COPY, type ReasonName, type SessionName } from "./names.js";
import type { Quote } from "./reads.js";
import { formatEt, formatUsd, nextLivenessFlip } from "./internal.js";

export type HealthState =
  | "no_collateral"
  | "no_debt"
  | "healthy"
  | "watch"
  | "near_limit"
  | "over_policy"
  | "liquidatable";

export interface Health {
  /** debt / collateral value, 0..∞; null without collateral. */
  ltv: number | null;
  /** Share of the policy limit used, 0..1+, null without collateral. */
  usedOfPolicy: number | null;
  policyMaxLtv: number;
  lltv: number;
  state: HealthState;
  /** The gate lets draws through right now. */
  gateOpen: boolean;
  reason: ReasonName;
  session: SessionName;
  /** When the gate is closed by the calendar: the reopen instant. */
  closedUntil: number | null;
  headline: string;
  copy: string;
}

export interface HealthInput {
  quote: Quote;
  lltvWad: bigint;
  now?: number;
}

/** "50%", "62.5%", "7.5%": one decimal only when it carries information. */
const pct = (x: number): string => {
  const v = Math.round(x * 1000) / 10;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}%`;
};

export function computeHealth(input: HealthInput): Health {
  const q = input.quote;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const policyMaxLtv = Number(q.effectiveMaxLtvWad) / 1e18;
  const lltv = Number(input.lltvWad) / 1e18;
  const collateral = Number(q.collateralValue) / 1e6;
  const debt = Number(q.debt) / 1e6;
  const ltv = collateral > 0 ? debt / collateral : null;
  const usedOfPolicy = ltv === null || policyMaxLtv === 0 ? null : ltv / policyMaxLtv;
  const gateOpen = !GATE_REASONS.has(q.reason) && q.reason !== "LINE_HELD" && q.reason !== "DESK_PAUSED";
  const closedUntil = q.reason === "MARKET_CLOSED" ? nextLivenessFlip(now, true) : null;

  let state: HealthState;
  if (q.collateralValue === 0n && q.debt === 0n) state = "no_collateral";
  else if (q.debt === 0n) state = "no_debt";
  else if (ltv !== null && ltv >= lltv) state = "liquidatable";
  else if (ltv !== null && ltv > policyMaxLtv) state = "over_policy";
  else if (usedOfPolicy !== null && usedOfPolicy >= 0.9) state = "near_limit";
  else if (usedOfPolicy !== null && usedOfPolicy >= 0.7) state = "watch";
  else state = "healthy";

  const available = formatUsd(q.available);
  let headline: string;
  let copy: string;
  switch (state) {
    case "no_collateral":
      headline = "No collateral posted";
      copy = "Add shares to the line to open capacity. Adding collateral works at any hour.";
      break;
    case "no_debt":
      headline = gateOpen ? `Borrow up to ${available}` : "Nothing drawn";
      copy = gateOpen
        ? `Nothing drawn yet. The policy lends up to ${pct(policyMaxLtv)} of your collateral; the venue liquidates only above ${pct(lltv)}.`
        : "Nothing drawn yet.";
      break;
    case "healthy":
      headline = `Healthy, ${pct(ltv ?? 0)} borrowed`;
      copy = `You use ${pct(usedOfPolicy ?? 0)} of the policy limit (${pct(policyMaxLtv)} of collateral). The venue liquidates only above ${pct(lltv)}.`;
      break;
    case "watch":
      headline = `${pct(ltv ?? 0)} borrowed, keep an eye on it`;
      copy = `You use ${pct(usedOfPolicy ?? 0)} of the policy limit. Adding collateral or repaying a little widens the gap to ${pct(lltv)}, where the venue liquidates.`;
      break;
    case "near_limit":
      headline = `Close to the limit, ${pct(ltv ?? 0)} borrowed`;
      copy = `You use ${pct(usedOfPolicy ?? 0)} of the policy limit. A price drop of about ${pct(Math.max(0, 1 - (ltv ?? 0) / lltv))} would reach the venue's liquidation threshold.`;
      break;
    case "over_policy":
      headline = `Above the policy limit, ${pct(ltv ?? 0)} borrowed`;
      copy = `New draws are refused until the loan is back under ${pct(policyMaxLtv)} of collateral. Repay or add collateral; both work at any hour.`;
      break;
    case "liquidatable":
      headline = "Above the liquidation threshold";
      copy = `The loan is past ${pct(lltv)} of collateral at the current price. Repay or add collateral now; the venue can liquidate as soon as it prices the position.`;
      break;
  }

  if (!gateOpen) {
    const gate = REASON_COPY[q.reason];
    if (q.reason === "MARKET_CLOSED") {
      const until = closedUntil ? formatEt(closedUntil) : "the next reopen";
      copy = `Wall Street is closed until ${until}. Repay and add collateral stay open; draws and liquidations resume at the reopen. ${copy}`;
      if (state === "no_debt" || state === "healthy" || state === "watch") headline = "Protected while Wall Street is closed";
    } else {
      copy = `${gate} ${copy}`;
    }
  }

  return { ltv, usedOfPolicy, policyMaxLtv, lltv, state, gateOpen, reason: q.reason, session: q.session, closedUntil, headline, copy };
}
