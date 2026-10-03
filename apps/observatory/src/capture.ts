// Reopen capture: pure logic around a feed liveness transition (Friday close, Sunday reopen, holidays).
// The cron records every tick inside [transition - 15 min, transition + 90 min] and keeps a running
// summary per token: the held print, the first post-transition print, its lag and the gap it printed.
import type { CalendarPort, Session } from "./calendar-port.js";
import type { Snapshot } from "./snapshot.js";

export const CAPTURE_BEFORE_SECONDS = 15 * 60;
export const CAPTURE_AFTER_SECONDS = 90 * 60;
/** Ticks inside the first minute after the transition are phase "at". */
export const CAPTURE_AT_SECONDS = 60;

export type TransitionKind = "reopen" | "close";
export type CapturePhase = "before" | "at" | "after";

export interface LivenessTransition {
  at: number;
  from: Session;
  to: Session;
  /** reopen: held -> live (the feeds resume); close: live -> held (the feeds stop). */
  kind: TransitionKind;
}

export interface FirstPrint {
  /** The feed's updatedAt of the first round past the transition. */
  feedUpdatedAt: number;
  /** When the Observatory first saw it. */
  seenAt: number;
  block: number;
  roundId: string;
  answer: string;
  /** feedUpdatedAt - transition.at: how long after the boundary the feed actually printed. */
  lagSeconds: number;
  /** (first - held) / held in basis points; null when the held print is unknown. */
  gapBps: number | null;
}

export interface TokenCaptureSummary {
  /** Last answer printed at or before the transition (raw 8 decimals). */
  heldAnswer: string | null;
  heldUpdatedAt: number | null;
  first: FirstPrint | null;
}

export interface CaptureSummary {
  perToken: Record<string, TokenCaptureSummary>;
  ticks: number;
  lastTickAt: number | null;
}

export interface CaptureRow {
  transitionAt: number;
  fromSession: Session;
  toSession: Session;
  tokenSymbol: string;
  phase: CapturePhase;
  takenAt: number;
  blockNumber: number;
  feedRoundId: string;
  feedAnswer: string;
  feedUpdatedAt: number;
  dexPrice: number | null;
  twapPrice: number | null;
  note: string | null;
}

export function emptySummary(): CaptureSummary {
  return { perToken: {}, ticks: 0, lastTickAt: null };
}

/**
 * The next boundary after `now` where feed liveness flips, and the last one within the capture
 * window behind `now` (so a Worker deployed minutes after a reopen still joins the run).
 */
export function findLivenessTransitions(
  calendar: CalendarPort,
  now: number,
  maxBoundaries = 12,
): { next: LivenessTransition | null; last: LivenessTransition | null } {
  let next: LivenessTransition | null = null;
  let t = now;
  for (let i = 0; i < maxBoundaries; i += 1) {
    const n = calendar.nextTransition(t);
    if (n.at === null || n.at <= t) break;
    const liveBefore = calendar.isFeedLive(n.at - 1);
    const liveAfter = calendar.isFeedLive(n.at);
    if (liveBefore !== liveAfter) {
      next = { at: n.at, from: calendar.sessionAt(n.at - 1), to: n.to, kind: liveAfter ? "reopen" : "close" };
      break;
    }
    t = n.at;
  }

  let last: LivenessTransition | null = null;
  const liveNow = calendar.isFeedLive(now);
  // Look one second past the window so a flip exactly CAPTURE_AFTER_SECONDS ago (the completing tick) is still found.
  const earliest = now - CAPTURE_AFTER_SECONDS - 1;
  if (calendar.isFeedLive(earliest) !== liveNow) {
    // One liveness flip at most inside 90 minutes: binary-search its exact second.
    let lo = earliest;
    let hi = now;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (calendar.isFeedLive(mid) === liveNow) hi = mid;
      else lo = mid;
    }
    last = { at: hi, from: calendar.sessionAt(hi - 1), to: calendar.sessionAt(hi), kind: liveNow ? "reopen" : "close" };
  }
  return { next, last };
}

/** Phase of `now` relative to a transition, or null outside the capture window. */
export function phaseFor(now: number, transitionAt: number): CapturePhase | null {
  if (now < transitionAt - CAPTURE_BEFORE_SECONDS || now > transitionAt + CAPTURE_AFTER_SECONDS) return null;
  if (now < transitionAt) return "before";
  if (now < transitionAt + CAPTURE_AT_SECONDS) return "at";
  return "after";
}

/** The transition whose window contains `now`: the one just behind us first, else the one ahead once armed. */
export function activeTransition(calendar: CalendarPort, now: number): LivenessTransition | null {
  const { next, last } = findLivenessTransitions(calendar, now);
  if (last && phaseFor(now, last.at) !== null) return last;
  if (next && phaseFor(now, next.at) !== null) return next;
  return null;
}

export function isComplete(now: number, transitionAt: number): boolean {
  return now >= transitionAt + CAPTURE_AFTER_SECONDS;
}

export function captureRows(snapshot: Snapshot, transition: LivenessTransition, phase: CapturePhase): CaptureRow[] {
  return snapshot.tokens.map((t) => ({
    transitionAt: transition.at,
    fromSession: transition.from,
    toSession: transition.to,
    tokenSymbol: t.symbol,
    phase,
    takenAt: snapshot.takenAt,
    blockNumber: snapshot.block,
    feedRoundId: t.feedRoundId,
    feedAnswer: t.feedAnswer,
    feedUpdatedAt: t.feedUpdatedAt,
    dexPrice: t.dexPrice,
    twapPrice: t.dexTwap1h,
    note: t.readErrors.length > 0 ? `read errors: ${t.readErrors.join(",")}` : null,
  }));
}

export function gapBps(heldAnswer: string | null, answer: string): number | null {
  if (heldAnswer === null) return null;
  const held = Number(heldAnswer);
  if (!(held > 0)) return null;
  return ((Number(answer) - held) / held) * 10_000;
}

/** Folds one tick into the running summary. Pure: returns a new summary. */
export function updateSummary(summary: CaptureSummary, transition: LivenessTransition, snapshot: Snapshot): CaptureSummary {
  const perToken: Record<string, TokenCaptureSummary> = { ...summary.perToken };
  for (const t of snapshot.tokens) {
    const cur: TokenCaptureSummary = perToken[t.symbol] ?? { heldAnswer: null, heldUpdatedAt: null, first: null };
    const updated: TokenCaptureSummary = { ...cur };
    if (t.feedUpdatedAt <= transition.at) {
      if (updated.heldUpdatedAt === null || t.feedUpdatedAt >= updated.heldUpdatedAt) {
        updated.heldAnswer = t.feedAnswer;
        updated.heldUpdatedAt = t.feedUpdatedAt;
      }
    } else if (updated.first === null) {
      updated.first = {
        feedUpdatedAt: t.feedUpdatedAt,
        seenAt: snapshot.takenAt,
        block: snapshot.block,
        roundId: t.feedRoundId,
        answer: t.feedAnswer,
        lagSeconds: t.feedUpdatedAt - transition.at,
        gapBps: gapBps(updated.heldAnswer, t.feedAnswer),
      };
    }
    perToken[t.symbol] = updated;
  }
  return { perToken, ticks: summary.ticks + 1, lastTickAt: snapshot.takenAt };
}

/** Earliest post-transition feed print across tokens, or null when none printed yet. */
export function firstUpdateAt(summary: CaptureSummary): number | null {
  let min: number | null = null;
  for (const t of Object.values(summary.perToken)) {
    if (t.first && (min === null || t.first.feedUpdatedAt < min)) min = t.first.feedUpdatedAt;
  }
  return min;
}
