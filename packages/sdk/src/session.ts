// The exchange clock, for the health bar and the copy: which session it is, when it changes, and
// when the feeds next go live (the reopen) or next stop (the close). Pure; uses @boundline/calendar.
import { describe, isFeedLive, nextTransition, sessionAt, type Session } from "@boundline/calendar";

export interface SessionInfo {
  now: number;
  session: Session;
  /** The Chainlink Coinbase feeds publish in this session (PRE, REGULAR, POST, OVERNIGHT). */
  feedLive: boolean;
  /** Next session boundary of any kind. */
  nextTransition: { to: Session; at: number | null };
  /** Next instant the feeds go live after a held period; null when the calendar horizon ends first. */
  nextReopen: number | null;
  /** Next instant the feeds stop (Friday 20:00 ET or a holiday eve); null when the horizon ends first. */
  nextClose: number | null;
  /** When closed now: the reopen the position waits for. */
  closedUntil: number | null;
  /** True when the REGULAR session is in force (09:30 to 16:00 ET, 13:00 on an early close). */
  regular: boolean;
  earlyClose: boolean;
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Walks session boundaries until feed liveness becomes `wantLive`. Liveness flips only at 20:00 ET
 * (Friday close, Sunday reopen, holiday eves and holiday evenings), so a week needs ~20 boundaries;
 * 80 covers a holiday weekend with room to spare. Returns null past the calendar horizon.
 */
export function nextLivenessFlip(now: number, wantLive: boolean, maxBoundaries = 80): number | null {
  let t = now;
  if (isFeedLive(t) === wantLive) {
    // Already in the wanted state: first leave it, then find the way back.
    const leave = nextLivenessFlip(t, !wantLive, maxBoundaries);
    if (leave === null) return null;
    t = leave;
  }
  for (let i = 0; i < maxBoundaries; i += 1) {
    const n = nextTransition(t, 14);
    if (!(n.at > t)) return null;
    if (isFeedLive(n.at) === wantLive) return n.at;
    t = n.at;
  }
  return null;
}

export function sessionInfo(now: number = nowSeconds()): SessionInfo {
  const d = describe(now);
  const session = sessionAt(now);
  const live = isFeedLive(now);
  const n = nextTransition(now, 14);
  const nextReopen = live ? nextLivenessFlip(now, true) : nextLivenessFlip(now, true);
  const nextClose = nextLivenessFlip(now, false);
  return {
    now,
    session,
    feedLive: live,
    nextTransition: { to: n.to, at: n.at > 0 ? n.at : null },
    nextReopen,
    nextClose,
    closedUntil: live ? null : nextReopen,
    regular: session === "REGULAR",
    earlyClose: d.earlyClose,
  };
}

const ET = "America/New_York";

/** "Sun 11 Oct, 20:00 ET" (or without the date when `date` is false). */
export function formatEt(epochSeconds: number | null, opts: { date?: boolean; seconds?: boolean } = {}): string {
  if (epochSeconds === null || !Number.isFinite(epochSeconds)) return "—";
  const withDate = opts.date ?? true;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(opts.seconds ? { second: "2-digit" } : {}),
    hour12: false,
  }).formatToParts(new Date(epochSeconds * 1000));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const time = opts.seconds ? `${hour}:${get("minute")}:${get("second")}` : `${hour}:${get("minute")}`;
  return withDate ? `${get("weekday")} ${get("day")} ${get("month")}, ${time} ET` : `${time} ET`;
}

/** "2d 4h", "4h 12m", "12m", "now". */
export function countdown(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}

/** Human name for a session, for the ribbon. */
export const SESSION_LABEL: Readonly<Record<Session, string>> = Object.freeze({
  UNKNOWN: "No calendar",
  PRE: "Pre-market",
  REGULAR: "Regular session",
  POST: "After hours",
  OVERNIGHT: "Overnight",
  WEEKEND: "Weekend",
  HOLIDAY: "Holiday",
});
