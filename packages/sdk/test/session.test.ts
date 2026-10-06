import { wallClockToEpoch } from "@boundline/calendar";
import { describe, expect, it } from "vitest";
import { countdown, formatEt, nextLivenessFlip, sessionInfo } from "../src/session.js";

const TUE_PRE = 1791285705; // Tue 6 Oct 2026 07:21:45 ET
const FRI_CLOSE = wallClockToEpoch(2026, 10, 9, 20 * 60); // Fri 9 Oct 20:00 ET
const SUN_REOPEN = wallClockToEpoch(2026, 10, 11, 20 * 60); // Sun 11 Oct 20:00 ET
const SAT_NOON = wallClockToEpoch(2026, 10, 10, 12 * 60);

describe("sessionInfo", () => {
  it("Tuesday pre-market: live, closes Friday 20:00 ET, reopens Sunday 20:00 ET", () => {
    const s = sessionInfo(TUE_PRE);
    expect(s.session).toBe("PRE");
    expect(s.feedLive).toBe(true);
    expect(s.closedUntil).toBeNull();
    expect(s.nextClose).toBe(FRI_CLOSE);
    expect(s.nextReopen).toBe(SUN_REOPEN);
    expect(FRI_CLOSE).toBe(1791590400);
    expect(SUN_REOPEN).toBe(1791763200);
    expect(s.nextTransition).toEqual({ to: "REGULAR", at: wallClockToEpoch(2026, 10, 6, 9 * 60 + 30) });
  });
  it("Saturday: held until Sunday 20:00 ET", () => {
    const s = sessionInfo(SAT_NOON);
    expect(s.session).toBe("WEEKEND");
    expect(s.feedLive).toBe(false);
    expect(s.closedUntil).toBe(SUN_REOPEN);
    expect(s.nextReopen).toBe(SUN_REOPEN);
    expect(s.nextClose).toBe(wallClockToEpoch(2026, 10, 16, 20 * 60));
  });
  it("Friday 19:59 ET still live, flips in a minute", () => {
    const s = sessionInfo(FRI_CLOSE - 60);
    expect(s.feedLive).toBe(true);
    expect(s.nextClose).toBe(FRI_CLOSE);
  });
  it("Thanksgiving: holiday until Thursday 20:00 ET, Friday is a half day", () => {
    const thu = wallClockToEpoch(2026, 11, 26, 12 * 60);
    const s = sessionInfo(thu);
    expect(s.session).toBe("HOLIDAY");
    expect(s.closedUntil).toBe(wallClockToEpoch(2026, 11, 26, 20 * 60));
    const fri = sessionInfo(wallClockToEpoch(2026, 11, 27, 12 * 60));
    expect(fri.session).toBe("REGULAR");
    expect(fri.earlyClose).toBe(true);
  });
  it("nextLivenessFlip from either state", () => {
    expect(nextLivenessFlip(TUE_PRE, false)).toBe(FRI_CLOSE);
    expect(nextLivenessFlip(TUE_PRE, true)).toBe(SUN_REOPEN);
    expect(nextLivenessFlip(SAT_NOON, true)).toBe(SUN_REOPEN);
  });
});

describe("formatting", () => {
  it("formatEt", () => {
    expect(formatEt(SUN_REOPEN)).toBe("Sun 11 Oct, 20:00 ET");
    expect(formatEt(SUN_REOPEN, { date: false })).toBe("20:00 ET");
    expect(formatEt(null)).toBe("—");
  });
  it("countdown", () => {
    expect(countdown(0)).toBe("now");
    expect(countdown(59)).toBe("1m");
    expect(countdown(3 * 3600 + 5 * 60)).toBe("3h 5m");
    expect(countdown(2 * 86400 + 4 * 3600)).toBe("2d 4h");
  });
});
