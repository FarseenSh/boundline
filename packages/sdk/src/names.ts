// Enum names in the order the Solidity sources declare them, so a uint8 from the chain maps to a word.
// Sources (contracts/src): desk/CreditDesk.sol LineStatus lines 39-44, ObligationStatus 47-56, Reason 58-79;
// interfaces/IMarketCalendar.sol Session line 12; interfaces/IPriceGate.sol GateState lines 12-20.
// A value outside a list is reported as "UNKNOWN", never as a number.

export const REASONS = [
  "NONE", "DESK_PAUSED", "LINE_NOT_OPEN", "LINE_HELD", "PARTNER_INACTIVE", "MARKET_DISABLED", "MARKET_CLOSED",
  "FEED_PAUSED", "TRANSFER_PAUSED", "FEED_STALE", "FEED_INVALID", "UNKNOWN_TOKEN", "TICKER_NOT_ALLOWED", "NOT_ELIGIBLE",
  "BELOW_MIN_DRAW", "ABOVE_MAX_DRAW", "PARTNER_CAP", "TICKER_CAP", "INSUFFICIENT_CAPACITY", "NOT_AUTHORIZED_ON_VENUE",
] as const;
export type ReasonName = (typeof REASONS)[number] | "UNKNOWN";

export const SESSIONS = ["UNKNOWN", "PRE", "REGULAR", "POST", "OVERNIGHT", "WEEKEND", "HOLIDAY"] as const;
export type SessionName = (typeof SESSIONS)[number];

export const LINE_STATUSES = ["NONE", "OPEN", "HELD", "CLOSED"] as const;
export type LineStatusName = (typeof LINE_STATUSES)[number] | "UNKNOWN";

export const OBLIGATION_STATUSES = [
  "NONE", "OPEN", "HOLD_SESSION", "HOLD_FEED", "HOLD_ISSUER", "HOLD_TRANSFER", "HOLD_KEEPER", "CLOSED",
] as const;
export type ObligationStatusName = (typeof OBLIGATION_STATUSES)[number] | "UNKNOWN";

export const GATE_STATES = [
  "OPEN", "MARKET_CLOSED", "FEED_PAUSED", "TRANSFER_PAUSED", "FEED_STALE", "FEED_INVALID", "UNKNOWN_TOKEN",
] as const;
export type GateStateName = (typeof GATE_STATES)[number] | "UNKNOWN";

/** Sessions in which the Chainlink Coinbase feeds publish (the gate can be OPEN). */
export const LIVE_SESSION_NAMES: ReadonlySet<SessionName> = new Set<SessionName>(["PRE", "REGULAR", "POST", "OVERNIGHT"]);

/** Reasons that come from the session, the feed or the issuer rather than from the line itself. */
export const GATE_REASONS: ReadonlySet<ReasonName> = new Set<ReasonName>([
  "MARKET_CLOSED", "FEED_PAUSED", "TRANSFER_PAUSED", "FEED_STALE", "FEED_INVALID", "UNKNOWN_TOKEN",
]);

export function enumName<const T extends readonly string[]>(list: T, index: number | bigint): T[number] | "UNKNOWN" {
  const i = typeof index === "bigint" ? Number(index) : index;
  return Number.isInteger(i) && i >= 0 && i < list.length ? (list[i] as T[number]) : "UNKNOWN";
}

/** Plain words for a refusal reason, written for the person holding the line. */
export const REASON_COPY: Readonly<Record<ReasonName, string>> = Object.freeze({
  NONE: "Ready.",
  DESK_PAUSED: "Boundline paused the desk. Repay and add collateral still work.",
  LINE_NOT_OPEN: "This line is not open.",
  LINE_HELD: "Boundline's keeper put this line on hold. Repay and add collateral still work.",
  PARTNER_INACTIVE: "This partner is inactive on the desk.",
  MARKET_DISABLED: "This market is disabled on the desk.",
  MARKET_CLOSED: "Wall Street is closed. No draws and no liquidations until the reopen; repay and add collateral any time.",
  FEED_PAUSED: "Coinbase paused this stock's oracle. Nothing is priced until it resumes; repay and add collateral still work.",
  TRANSFER_PAUSED: "The issuer paused transfers of this stock. Draws wait for transfers to resume.",
  FEED_STALE: "The price feed has not printed for over a day. Draws wait for a fresh print; repay and add collateral still work.",
  FEED_INVALID: "The price feed returned an invalid answer. Draws wait for a valid print.",
  UNKNOWN_TOKEN: "This stock has no feed on the gate.",
  TICKER_NOT_ALLOWED: "This partner does not lend against this stock.",
  NOT_ELIGIBLE: "This wallet is not eligible under the partner's policy.",
  BELOW_MIN_DRAW: "Below the minimum draw for this stock.",
  ABOVE_MAX_DRAW: "Above the maximum draw for this stock.",
  PARTNER_CAP: "The partner's exposure cap is reached.",
  TICKER_CAP: "The exposure cap for this stock is reached.",
  INSUFFICIENT_CAPACITY: "More than your collateral allows at the policy's loan-to-value limit.",
  NOT_AUTHORIZED_ON_VENUE: "Authorise the desk on Morpho once, then draw.",
  UNKNOWN: "The desk returned a reason this app does not know.",
});
