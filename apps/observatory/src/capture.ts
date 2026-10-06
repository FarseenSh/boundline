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

/** A hole in the recorder's own one-minute cadence, so the run states its uptime honestly. */
export interface TickGap {
  from: number;
  to: number;
}

export interface CaptureSummary {
  perToken: Record<string, TokenCaptureSummary>;
  ticks: number;
  lastTickAt: number | null;
  /** Ticks the cron should have delivered but did not (gaps longer than MISSED_TICK_SECONDS). */
  missedTicks?: number;
  gaps?: TickGap[];
}

/** A gap between consecutive ticks longer than this counts as missed ticks. */
export const MISSED_TICK_SECONDS = 90;

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
  return { perToken: {}, ticks: 0, lastTickAt: null, missedTicks: 0, gaps: [] };
}

/** Days ahead to look for the next liveness flip: any US long weekend with margin to spare. */
export const MAX_FLIP_LOOKAHEAD_DAYS = 14;
/** How long a "no flip within the lookahead" answer is reused before the walk runs again. */
const NULL_CACHE_SECONDS = 600;

interface NextCache {
  computedAt: number;
  next: LivenessTransition | null;
}

/** Per calendar: the first flip strictly after `computedAt` is also the first flip after any later `now` before it. */
const nextCache = new WeakMap<CalendarPort, NextCache>();

/**
 * The next instant after `now` where feed liveness flips. Liveness changes only at 20:00 ET, so the walk
 * visits one boundary per day (14 at most) instead of every session boundary, and the answer is cached per
 * calendar until it has passed: a warm isolate pays nothing, a cold one a few dozen arithmetic conversions.
 */
export function nextLivenessTransition(calendar: CalendarPort, now: number, maxDays = MAX_FLIP_LOOKAHEAD_DAYS): LivenessTransition | null {
  const hit = nextCache.get(calendar);
  if (hit && hit.computedAt <= now && (hit.next ? now < hit.next.at : now - hit.computedAt < NULL_CACHE_SECONDS)) return hit.next;
  let next: LivenessTransition | null = null;
  let t = now;
  for (let day = 0; day < maxDays; day += 1) {
    const b = calendar.feedBoundaryAfter(t);
    if (b === null || b <= t) break;
    const liveBefore = calendar.isFeedLive(b - 1);
    const liveAfter = calendar.isFeedLive(b);
    if (liveBefore !== liveAfter) {
      next = { at: b, from: calendar.sessionAt(b - 1), to: calendar.sessionAt(b), kind: liveAfter ? "reopen" : "close" };
      break;
    }
    t = b;
  }
  nextCache.set(calendar, { computedAt: now, next });
  return next;
}

/** The liveness flip within the capture window behind `now`, to the second (so a Worker deployed minutes after a reopen still joins the run). */
export function lastLivenessTransition(calendar: CalendarPort, now: number): LivenessTransition | null {
  const liveNow = calendar.isFeedLive(now);
  // Look one second past the window so a flip exactly CAPTURE_AFTER_SECONDS ago (the completing tick) is still found.
  const earliest = now - CAPTURE_AFTER_SECONDS - 1;
  if (calendar.isFeedLive(earliest) === liveNow) return null;
  // One liveness flip at most inside 90 minutes: binary-search its exact second.
  let lo = earliest;
  let hi = now;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (calendar.isFeedLive(mid) === liveNow) hi = mid;
    else lo = mid;
  }
  return { at: hi, from: calendar.sessionAt(hi - 1), to: calendar.sessionAt(hi), kind: liveNow ? "reopen" : "close" };
}

/** The next liveness flip after `now`, and the last one within the capture window behind it. */
export function findLivenessTransitions(
  calendar: CalendarPort,
  now: number,
  maxDays = MAX_FLIP_LOOKAHEAD_DAYS,
): { next: LivenessTransition | null; last: LivenessTransition | null } {
  return { next: nextLivenessTransition(calendar, now, maxDays), last: lastLivenessTransition(calendar, now) };
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
  let missedTicks = summary.missedTicks ?? 0;
  let gaps = summary.gaps ?? [];
  if (summary.lastTickAt !== null && snapshot.takenAt - summary.lastTickAt > MISSED_TICK_SECONDS) {
    missedTicks += Math.max(1, Math.round((snapshot.takenAt - summary.lastTickAt) / 60) - 1);
    gaps = [...gaps, { from: summary.lastTickAt, to: snapshot.takenAt }];
  }
  return { perToken, ticks: summary.ticks + 1, lastTickAt: snapshot.takenAt, missedTicks, gaps };
}

/** Earliest post-transition feed print across tokens, or null when none printed yet. */
export function firstUpdateAt(summary: CaptureSummary): number | null {
  let min: number | null = null;
  for (const t of Object.values(summary.perToken)) {
    if (t.first && (min === null || t.first.feedUpdatedAt < min)) min = t.first.feedUpdatedAt;
  }
  return min;
}
