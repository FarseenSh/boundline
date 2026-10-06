// The slice of @boundline/calendar the Observatory depends on, as an injectable port so the
// snapshot and HTML modules can be unit-tested with a stub and never touch the real package.
export type Session = "UNKNOWN" | "PRE" | "REGULAR" | "POST" | "OVERNIGHT" | "WEEKEND" | "HOLIDAY";

export interface Transition {
  to: Session;
  /** Unix seconds of the transition, null when the calendar or horizon runs out. */
  at: number | null;
}

export interface CalendarPort {
  sessionAt(epochSeconds: number): Session;
  isFeedLive(epochSeconds: number): boolean;
  nextTransition(epochSeconds: number): Transition;
  /**
   * First 20:00 ET instant strictly after `epochSeconds`, the only mark at which feed liveness can change
   * (Friday close, Sunday reopen, holiday eve and holiday day, end of coverage). Null when unknown.
   */
  feedBoundaryAfter(epochSeconds: number): number | null;
  readonly source: string;
}

export const LIVE_SESSIONS: ReadonlySet<Session> = new Set<Session>(["PRE", "REGULAR", "POST", "OVERNIGHT"]);
