// Enum names in the order CreditDesk.sol declares them. A value outside the list is reported as UNKNOWN, never as a number.

export const REASONS = [
  "NONE", "DESK_PAUSED", "LINE_NOT_OPEN", "LINE_HELD", "PARTNER_INACTIVE", "MARKET_DISABLED", "MARKET_CLOSED",
  "FEED_PAUSED", "TRANSFER_PAUSED", "FEED_STALE", "FEED_INVALID", "UNKNOWN_TOKEN", "TICKER_NOT_ALLOWED", "NOT_ELIGIBLE",
  "BELOW_MIN_DRAW", "ABOVE_MAX_DRAW", "PARTNER_CAP", "TICKER_CAP", "INSUFFICIENT_CAPACITY", "NOT_AUTHORIZED_ON_VENUE",
] as const;

export const SESSIONS = ["UNKNOWN", "PRE", "REGULAR", "POST", "OVERNIGHT", "WEEKEND", "HOLIDAY"] as const;

export const LINE_STATUSES = ["NONE", "OPEN", "HELD", "CLOSED"] as const;

export const OBLIGATION_STATUSES = [
  "NONE", "OPEN", "HOLD_SESSION", "HOLD_FEED", "HOLD_ISSUER", "HOLD_TRANSFER", "HOLD_KEEPER", "CLOSED",
] as const;

export function enumName(list: readonly string[], index: number): string {
  return Number.isInteger(index) && index >= 0 && index < list.length ? (list[index] as string) : "UNKNOWN";
}
