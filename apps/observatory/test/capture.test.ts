import { describe, expect, it } from "vitest";
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
    expect(next).toBeNull(); // the test calendar has no close after REOPEN inside 12 boundaries
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
