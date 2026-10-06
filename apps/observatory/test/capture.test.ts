import { describe, expect, it } from "vitest";
import { liveCalendar } from "../src/calendar-impl.js";
import type { CalendarPort, Session } from "../src/calendar-port.js";
import {
  CAPTURE_AFTER_SECONDS,
  CAPTURE_BEFORE_SECONDS,
  activeTransition,
  captureRows,
  emptySummary,
  findLivenessTransitions,
  firstUpdateAt,
  gapBps,
  isComplete,
  nextLivenessTransition,
  phaseFor,
  updateSummary,
} from "../src/capture.js";
import { buildSnapshot } from "../src/snapshot.js";
import { pool, reads, token } from "./fixtures.js";

/** Sunday 4 Oct 2026 20:00 ET: WEEKEND -> OVERNIGHT, then PRE at 04:00 ET, REGULAR at 09:30 ET. */
export const REOPEN = 1791158400;
const PRE_AT = REOPEN + 8 * 3600;
const REGULAR_AT = REOPEN + 13.5 * 3600;
/** Friday close before it: Fri 2 Oct 20:00 ET = REOPEN - 48h, POST -> WEEKEND. */
const CLOSE = REOPEN - 48 * 3600;

/** A calendar with one weekend between CLOSE and REOPEN and a normal day after. */
export function weekendCalendar(): CalendarPort {
  const sessionAt = (t: number): Session => {
    if (t < CLOSE - 4 * 3600) return "REGULAR";
    if (t < CLOSE) return "POST";
    if (t < REOPEN) return "WEEKEND";
    if (t < PRE_AT) return "OVERNIGHT";
    if (t < REGULAR_AT) return "PRE";
    return "REGULAR";
  };
  const boundaries = [CLOSE - 4 * 3600, CLOSE, REOPEN, PRE_AT, REGULAR_AT];
  return {
    sessionAt,
    isFeedLive: (t) => sessionAt(t) !== "WEEKEND",
    nextTransition: (t) => {
      const at = boundaries.find((b) => b > t);
      return at === undefined ? { to: "UNKNOWN", at: null } : { to: sessionAt(at), at };
    },
    // 20:00 ET marks: CLOSE is one, and every 24 h after it (no DST inside this synthetic week).
    feedBoundaryAfter: (t) => CLOSE + (Math.floor((t - CLOSE) / 86400) + 1) * 86400,
    source: "weekend test calendar",
  };
}

describe("findLivenessTransitions", () => {
  const cal = weekendCalendar();

  it("finds the Sunday reopen ahead during the weekend and nothing behind", () => {
    const { next, last } = findLivenessTransitions(cal, REOPEN - 20 * 3600);
    expect(next).toEqual({ at: REOPEN, from: "WEEKEND", to: "OVERNIGHT", kind: "reopen" });
    expect(last).toBeNull();
  });

  it("skips live-to-live boundaries: after the reopen the next flip is the Friday close, not PRE", () => {
    const { next } = findLivenessTransitions(cal, REOPEN + 3600);
    expect(next).toBeNull(); // the test calendar stays REGULAR for ever after REOPEN: no flip inside the 14-day lookahead
    const { next: beforeClose } = findLivenessTransitions(cal, CLOSE - 6 * 3600);
    expect(beforeClose).toEqual({ at: CLOSE, from: "POST", to: "WEEKEND", kind: "close" });
  });

  it("finds the reopen just behind it to the second, so a late deploy joins the run", () => {
    const { last } = findLivenessTransitions(cal, REOPEN + 37 * 60 + 11);
    expect(last).toEqual({ at: REOPEN, from: "WEEKEND", to: "OVERNIGHT", kind: "reopen" });
    expect(findLivenessTransitions(cal, REOPEN).last?.at).toBe(REOPEN);
    expect(findLivenessTransitions(cal, REOPEN + CAPTURE_AFTER_SECONDS + 1).last).toBeNull();
  });
});

describe("phaseFor and activeTransition", () => {
  const cal = weekendCalendar();

  it("is outside the window until 15 minutes before and after 90 minutes", () => {
    expect(phaseFor(REOPEN - CAPTURE_BEFORE_SECONDS - 1, REOPEN)).toBeNull();
    expect(phaseFor(REOPEN - CAPTURE_BEFORE_SECONDS, REOPEN)).toBe("before");
    expect(phaseFor(REOPEN, REOPEN)).toBe("at");
    expect(phaseFor(REOPEN + 59, REOPEN)).toBe("at");
    expect(phaseFor(REOPEN + 60, REOPEN)).toBe("after");
    expect(phaseFor(REOPEN + CAPTURE_AFTER_SECONDS, REOPEN)).toBe("after");
    expect(phaseFor(REOPEN + CAPTURE_AFTER_SECONDS + 1, REOPEN)).toBeNull();
  });

  it("arms the reopen 15 minutes early, stays on it 90 minutes, and is idle otherwise", () => {
    expect(activeTransition(cal, REOPEN - 3600)).toBeNull();
    expect(activeTransition(cal, REOPEN - 10 * 60)?.at).toBe(REOPEN);
    expect(activeTransition(cal, REOPEN + 45 * 60)?.at).toBe(REOPEN);
    expect(activeTransition(cal, REOPEN + 2 * 3600)).toBeNull();
    expect(activeTransition(cal, CLOSE - 60)?.kind).toBe("close");
  });

  it("completes exactly 90 minutes after the transition", () => {
    expect(isComplete(REOPEN + CAPTURE_AFTER_SECONDS - 1, REOPEN)).toBe(false);
    expect(isComplete(REOPEN + CAPTURE_AFTER_SECONDS, REOPEN)).toBe(true);
  });
});

describe("summary across a synthetic reopen", () => {
  const cal = weekendCalendar();
  const transition = { at: REOPEN, from: "WEEKEND" as Session, to: "OVERNIGHT" as Session, kind: "reopen" as const };
  const held = { feedAnswer: 33366495000n, feedUpdatedAt: BigInt(CLOSE - 1), feedRoundId: 100n };

  function tick(at: number, overrides: Parameters<typeof token>[0] = {}) {
    return buildSnapshot({ ...reads([token({ ...held, ...overrides })], [pool()]), blockNumber: 52200000n + BigInt((at - REOPEN) / 2), blockTimestamp: at }, cal, at);
  }

  it("keeps the held print, then records the first post-transition round with lag and gap", () => {
    let s = emptySummary();
    for (let at = REOPEN - 15 * 60; at < REOPEN + 3 * 60; at += 60) s = updateSummary(s, transition, tick(at));
    expect(s.ticks).toBe(18);
    expect(s.perToken["AAPLc"]).toEqual({ heldAnswer: "33366495000", heldUpdatedAt: CLOSE - 1, first: null });
    expect(firstUpdateAt(s)).toBeNull();

    // the feed prints 4 minutes and 7 seconds after the reopen, 0.5% lower
    const printedAt = REOPEN + 247;
    const seenAt = REOPEN + 5 * 60;
    s = updateSummary(s, transition, tick(seenAt, { feedAnswer: 33199662525n, feedUpdatedAt: BigInt(printedAt), feedRoundId: 101n }));
    const first = s.perToken["AAPLc"]?.first;
    expect(first).toMatchObject({ feedUpdatedAt: printedAt, seenAt, roundId: "101", answer: "33199662525", lagSeconds: 247 });
    expect(first?.gapBps).toBeCloseTo(-50, 6);
    expect(firstUpdateAt(s)).toBe(printedAt);

    // later rounds do not overwrite the first one
    s = updateSummary(s, transition, tick(seenAt + 60, { feedAnswer: 33000000000n, feedUpdatedAt: BigInt(printedAt + 60), feedRoundId: 102n }));
    expect(s.perToken["AAPLc"]?.first?.roundId).toBe("101");
    expect(s.ticks).toBe(20);
  });

  it("leaves the gap null when the held print was never seen", () => {
    const s = updateSummary(emptySummary(), transition, tick(REOPEN + 120, { feedUpdatedAt: BigInt(REOPEN + 90), feedRoundId: 101n }));
    expect(s.perToken["AAPLc"]?.first?.gapBps).toBeNull();
    expect(s.perToken["AAPLc"]?.heldAnswer).toBeNull();
    expect(gapBps(null, "1")).toBeNull();
    expect(gapBps("0", "1")).toBeNull();
    expect(gapBps("20000000000", "20200000000")).toBeCloseTo(100, 9);
  });

  it("writes one capture row per token with the phase and the DEX prices", () => {
    const rows = captureRows(tick(REOPEN + 30), transition, "at");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ transitionAt: REOPEN, fromSession: "WEEKEND", toSession: "OVERNIGHT", tokenSymbol: "AAPLc", phase: "at", takenAt: REOPEN + 30, feedAnswer: "33366495000", note: null });
    expect(rows[0]?.twapPrice).not.toBeNull();
    const withErrors = captureRows(tick(REOPEN + 30, { errors: ["latestRoundData"] }), transition, "at");
    expect(withErrors[0]?.note).toBe("read errors: latestRoundData");
  });
});

const iso = (s: string): number => Date.parse(s) / 1000;

describe("findLivenessTransitions on the real 2026 calendar", () => {
  it("sees the Friday close from a Tuesday morning (the mid-week null is gone)", () => {
    const { next, last } = findLivenessTransitions(liveCalendar, iso("2026-10-06T07:21:00-04:00"));
    expect(next).toEqual({ at: 1791590400, from: "POST", to: "WEEKEND", kind: "close" });
    expect(iso("2026-10-09T20:00:00-04:00")).toBe(1791590400);
    expect(last).toBeNull();
  });

  it("at Friday 19:59 the close is 60 seconds away; at Sunday 19:45 the reopen is the next flip and nothing is behind", () => {
    expect(findLivenessTransitions(liveCalendar, iso("2026-10-09T19:59:00-04:00")).next).toMatchObject({ at: 1791590400, kind: "close" });
    const sunday = findLivenessTransitions(liveCalendar, REOPEN - 15 * 60);
    expect(sunday.next).toEqual({ at: REOPEN, from: "WEEKEND", to: "OVERNIGHT", kind: "reopen" });
    expect(sunday.last).toBeNull();
    const after = findLivenessTransitions(liveCalendar, REOPEN + 10 * 60);
    expect(after.last).toEqual({ at: REOPEN, from: "WEEKEND", to: "OVERNIGHT", kind: "reopen" });
    expect(after.next?.at).toBe(1791590400);
  });

  it("walks the Thanksgiving week: eve close, holiday reopen, no flip at the half day's 13:00, weekend close at 20:00", () => {
    expect(findLivenessTransitions(liveCalendar, iso("2026-11-25T12:00:00-05:00")).next).toEqual({ at: iso("2026-11-25T20:00:00-05:00"), from: "POST", to: "HOLIDAY", kind: "close" });
    expect(findLivenessTransitions(liveCalendar, iso("2026-11-26T12:00:00-05:00")).next).toEqual({ at: iso("2026-11-26T20:00:00-05:00"), from: "HOLIDAY", to: "OVERNIGHT", kind: "reopen" });
    expect(findLivenessTransitions(liveCalendar, iso("2026-11-27T12:00:00-05:00")).next).toEqual({ at: iso("2026-11-27T20:00:00-05:00"), from: "OVERNIGHT", to: "WEEKEND", kind: "close" });
    expect(liveCalendar.sessionAt(iso("2026-11-27T13:00:00-05:00"))).toBe("POST");
  });

  it("finds the Labor Day reopen across a three-day weekend and the end of coverage", () => {
    expect(findLivenessTransitions(liveCalendar, iso("2026-09-05T13:00:00-04:00")).next).toEqual({ at: iso("2026-09-07T20:00:00-04:00"), from: "HOLIDAY", to: "OVERNIGHT", kind: "reopen" });
    expect(findLivenessTransitions(liveCalendar, iso("2026-12-30T12:00:00-05:00")).next).toEqual({ at: iso("2026-12-31T20:00:00-05:00"), from: "POST", to: "UNKNOWN", kind: "close" });
    expect(findLivenessTransitions(liveCalendar, iso("2027-01-05T12:00:00-05:00")).next).toBeNull();
  });

  it("reuses the cached answer until the flip has passed", () => {
    const cal: CalendarPort = { ...liveCalendar };
    let walks = 0;
    const counting: CalendarPort = { ...cal, feedBoundaryAfter: (t) => (walks += 1, cal.feedBoundaryAfter(t)) };
    const tuesday = iso("2026-10-06T07:21:00-04:00");
    const first = nextLivenessTransition(counting, tuesday);
    const walksAfterFirst = walks;
    expect(walksAfterFirst).toBeGreaterThan(0);
    expect(nextLivenessTransition(counting, tuesday + 3600)).toBe(first);
    expect(nextLivenessTransition(counting, 1791590400 - 1)).toBe(first);
    expect(walks).toBe(walksAfterFirst);
    const next = nextLivenessTransition(counting, 1791590400);
    expect(next?.at).toBe(REOPEN + 7 * 86400); // Sun 11 Oct 20:00 ET reopen
    expect(walks).toBeGreaterThan(walksAfterFirst);
    // moving backwards recomputes rather than serving a later answer
    expect(nextLivenessTransition(counting, tuesday)?.at).toBe(1791590400);
  });

  it("records missed ticks and gaps in the running summary", () => {
    const transition = { at: REOPEN, from: "WEEKEND" as Session, to: "OVERNIGHT" as Session, kind: "reopen" as const };
    const snap = (at: number) => buildSnapshot({ ...reads([token()], [pool()]), blockTimestamp: at }, weekendCalendar(), at);
    let s = emptySummary();
    s = updateSummary(s, transition, snap(REOPEN - 600));
    s = updateSummary(s, transition, snap(REOPEN - 540));
    s = updateSummary(s, transition, snap(REOPEN - 180)); // five ticks missing
    expect(s.missedTicks).toBe(5);
    expect(s.gaps).toEqual([{ from: REOPEN - 540, to: REOPEN - 180 }]);
    const legacy = updateSummary({ perToken: {}, ticks: 3, lastTickAt: REOPEN - 300 }, transition, snap(REOPEN));
    expect(legacy.missedTicks).toBe(4);
  });
});
