/**
 * Table-driven tests for @boundline/calendar. Every expectation is an ISO instant with an
 * explicit UTC offset, so the epoch is computed by Date.parse and never by the module under
 * test. Labels carry the ET wall clock so a wrong conversion fails loudly.
 */
import { describe as suite, expect, test } from "vitest";

import {
  BOUNDARY_MARKS,
  NYSE_2026,
  SESSIONS,
  SESSION_CODE,
  dateKeyOf,
  describe,
  isEarlyClose,
  isFeedLive,
  isHoliday,
  isYearLoaded,
  nextTransition,
  sessionAt,
  wallClockToEpoch,
  zoneFields,
  type Session,
} from "../src/index.js";

const at = (iso: string): number => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`bad instant ${iso}`);
  return ms / 1000;
};

/** label, instant with explicit offset, expected session */
const TABLE: readonly [string, string, Session][] = [
  ["Thu 2026-09-03 03:59 EDT", "2026-09-03T03:59:00-04:00", "OVERNIGHT"],
  ["Thu 2026-09-03 04:00 EDT pre-market opens", "2026-09-03T04:00:00-04:00", "PRE"],
  ["Thu 2026-09-03 09:29 EDT", "2026-09-03T09:29:00-04:00", "PRE"],
  ["Thu 2026-09-03 09:30 EDT bell", "2026-09-03T09:30:00-04:00", "REGULAR"],
  ["Thu 2026-09-03 15:59 EDT", "2026-09-03T15:59:00-04:00", "REGULAR"],
  ["Thu 2026-09-03 16:00 EDT close", "2026-09-03T16:00:00-04:00", "POST"],
  ["Thu 2026-09-03 19:59 EDT", "2026-09-03T19:59:00-04:00", "POST"],
  ["Thu 2026-09-03 20:00 EDT overnight into Friday", "2026-09-03T20:00:00-04:00", "OVERNIGHT"],
  ["Fri 2026-01-02 03:59 EST", "2026-01-02T03:59:00-05:00", "OVERNIGHT"],
  ["Fri 2026-01-02 04:00 EST", "2026-01-02T04:00:00-05:00", "PRE"],
  ["Fri 2026-01-02 09:30 EST bell", "2026-01-02T09:30:00-05:00", "REGULAR"],
  ["Fri 2026-01-02 15:59 EST", "2026-01-02T15:59:00-05:00", "REGULAR"],
  ["Fri 2026-01-02 16:00 EST close", "2026-01-02T16:00:00-05:00", "POST"],
  ["Fri 2026-01-02 19:59 EST", "2026-01-02T19:59:00-05:00", "POST"],
  ["Fri 2026-01-02 20:00 EST feed closes for the weekend", "2026-01-02T20:00:00-05:00", "WEEKEND"],
  ["Fri 2026-03-06 08:30 EST, Friday before DST", "2026-03-06T08:30:00-05:00", "PRE"],
  ["Fri 2026-03-06 09:30 EST", "2026-03-06T09:30:00-05:00", "REGULAR"],
  ["Sun 2026-03-08 09:30, DST transition day", "2026-03-08T09:30:00-04:00", "WEEKEND"],
  ["Mon 2026-03-09 08:30 EDT, Monday after DST", "2026-03-09T08:30:00-04:00", "PRE"],
  ["Mon 2026-03-09 09:30 EDT", "2026-03-09T09:30:00-04:00", "REGULAR"],
  ["Fri 2026-10-30 09:30 EDT, Friday before DST ends", "2026-10-30T09:30:00-04:00", "REGULAR"],
  ["Sun 2026-11-01 09:30, DST ends", "2026-11-01T09:30:00-05:00", "WEEKEND"],
  ["Mon 2026-11-02 08:30 EST", "2026-11-02T08:30:00-05:00", "PRE"],
  ["Mon 2026-11-02 09:30 EST", "2026-11-02T09:30:00-05:00", "REGULAR"],
  ["Sat 2026-09-05 13:00", "2026-09-05T13:00:00-04:00", "WEEKEND"],
  ["Sun 2026-09-06 13:00", "2026-09-06T13:00:00-04:00", "WEEKEND"],
  ["Sun 2026-09-06 19:59 before Labor Day", "2026-09-06T19:59:00-04:00", "WEEKEND"],
  ["Sun 2026-09-06 20:00, no reopen into Labor Day", "2026-09-06T20:00:00-04:00", "HOLIDAY"],
  ["Mon 2026-09-07 12:00 Labor Day", "2026-09-07T12:00:00-04:00", "HOLIDAY"],
  ["Mon 2026-09-07 19:59 Labor Day", "2026-09-07T19:59:00-04:00", "HOLIDAY"],
  ["Mon 2026-09-07 20:00 overnight into Tuesday", "2026-09-07T20:00:00-04:00", "OVERNIGHT"],
  ["Sun 2026-10-04 19:59 before the reopen", "2026-10-04T19:59:00-04:00", "WEEKEND"],
  ["Sun 2026-10-04 20:00 reopen", "2026-10-04T20:00:00-04:00", "OVERNIGHT"],
  ["Mon 2026-10-05 00:00", "2026-10-05T00:00:00-04:00", "OVERNIGHT"],
  ["Fri 2026-11-27 09:30 half day bell", "2026-11-27T09:30:00-05:00", "REGULAR"],
  ["Fri 2026-11-27 12:59 half day", "2026-11-27T12:59:00-05:00", "REGULAR"],
  ["Fri 2026-11-27 13:00 early close", "2026-11-27T13:00:00-05:00", "POST"],
  ["Fri 2026-11-27 16:59", "2026-11-27T16:59:00-05:00", "POST"],
  ["Fri 2026-11-27 17:00 early post end", "2026-11-27T17:00:00-05:00", "OVERNIGHT"],
  ["Fri 2026-11-27 19:59", "2026-11-27T19:59:00-05:00", "OVERNIGHT"],
  ["Fri 2026-11-27 20:00 weekend", "2026-11-27T20:00:00-05:00", "WEEKEND"],
  ["Thu 2026-12-24 12:59 half day", "2026-12-24T12:59:00-05:00", "REGULAR"],
  ["Thu 2026-12-24 13:00 early close", "2026-12-24T13:00:00-05:00", "POST"],
  ["Thu 2026-12-24 17:00 early post end", "2026-12-24T17:00:00-05:00", "OVERNIGHT"],
  ["Thu 2026-12-24 20:00 eve of Christmas", "2026-12-24T20:00:00-05:00", "HOLIDAY"],
  ["Fri 2026-12-25 12:00 Christmas", "2026-12-25T12:00:00-05:00", "HOLIDAY"],
  ["Fri 2026-12-25 20:00 weekend", "2026-12-25T20:00:00-05:00", "WEEKEND"],
  ["Wed 2026-12-23 16:30 full day post", "2026-12-23T16:30:00-05:00", "POST"],
  ["Thu 2026-04-02 20:00 eve of Good Friday", "2026-04-02T20:00:00-04:00", "HOLIDAY"],
  ["Fri 2026-04-03 12:00 Good Friday", "2026-04-03T12:00:00-04:00", "HOLIDAY"],
  ["Fri 2026-04-03 20:00 weekend", "2026-04-03T20:00:00-04:00", "WEEKEND"],
  ["Wed 2026-11-25 20:00 eve of Thanksgiving", "2026-11-25T20:00:00-05:00", "HOLIDAY"],
  ["Thu 2026-11-26 12:00 Thanksgiving", "2026-11-26T12:00:00-05:00", "HOLIDAY"],
  ["Thu 2026-11-26 20:00 overnight into the half day", "2026-11-26T20:00:00-05:00", "OVERNIGHT"],
  ["Wed 2025-12-31 19:59, session date 2025 not loaded", "2025-12-31T19:59:00-05:00", "UNKNOWN"],
  ["Wed 2025-12-31 20:00, session date is New Year's Day 2026", "2025-12-31T20:00:00-05:00", "HOLIDAY"],
  ["Thu 2026-01-01 12:00 New Year's Day", "2026-01-01T12:00:00-05:00", "HOLIDAY"],
  ["Thu 2026-01-01 20:00 overnight into Friday", "2026-01-01T20:00:00-05:00", "OVERNIGHT"],
  ["Thu 2026-12-31 19:59 last covered instant", "2026-12-31T19:59:00-05:00", "POST"],
  ["Thu 2026-12-31 20:00, session date 2027 not loaded", "2026-12-31T20:00:00-05:00", "UNKNOWN"],
  ["Mon 2027-01-04 09:30, no 2027 data", "2027-01-04T09:30:00-05:00", "UNKNOWN"],
  ["Mon 2025-06-02 09:30, before coverage", "2025-06-02T09:30:00-04:00", "UNKNOWN"],
  ["Thu 2026-07-02 20:00 eve of observed Independence Day", "2026-07-02T20:00:00-04:00", "HOLIDAY"],
  ["Fri 2026-07-03 12:00 Independence Day observed", "2026-07-03T12:00:00-04:00", "HOLIDAY"],
  ["Fri 2026-07-03 20:00 weekend", "2026-07-03T20:00:00-04:00", "WEEKEND"],
  ["Mon 2026-01-19 12:00 MLK Day", "2026-01-19T12:00:00-05:00", "HOLIDAY"],
  ["Mon 2026-02-16 12:00 Washington's Birthday", "2026-02-16T12:00:00-05:00", "HOLIDAY"],
  ["Mon 2026-05-25 12:00 Memorial Day", "2026-05-25T12:00:00-04:00", "HOLIDAY"],
  ["Fri 2026-06-19 12:00 Juneteenth", "2026-06-19T12:00:00-04:00", "HOLIDAY"],
  ["Sat 2026-10-03 06:48 EDT, the day this test was written", "2026-10-03T06:48:00-04:00", "WEEKEND"],
];

/** label, from instant, expected to, expected at */
const TRANSITIONS: readonly [string, string, Session, string][] = [
  ["Thu 15:59 -> POST at 16:00", "2026-09-03T15:59:00-04:00", "POST", "2026-09-03T16:00:00-04:00"],
  ["Thu 16:00 -> OVERNIGHT at 20:00", "2026-09-03T16:00:00-04:00", "OVERNIGHT", "2026-09-03T20:00:00-04:00"],
  ["Fri 19:00 -> WEEKEND at 20:00", "2026-01-02T19:00:00-05:00", "WEEKEND", "2026-01-02T20:00:00-05:00"],
  ["Sat 13:00 -> HOLIDAY at Sun 20:00 (Labor Day weekend)", "2026-09-05T13:00:00-04:00", "HOLIDAY", "2026-09-06T20:00:00-04:00"],
  ["Labor Day 12:00 -> OVERNIGHT at 20:00", "2026-09-07T12:00:00-04:00", "OVERNIGHT", "2026-09-07T20:00:00-04:00"],
  ["Sat 2026-10-03 06:48 -> OVERNIGHT at Sun 20:00", "2026-10-03T06:48:00-04:00", "OVERNIGHT", "2026-10-04T20:00:00-04:00"],
  ["Half day 12:00 -> POST at 13:00", "2026-11-27T12:00:00-05:00", "POST", "2026-11-27T13:00:00-05:00"],
  ["Half day 13:30 -> OVERNIGHT at 17:00", "2026-11-27T13:30:00-05:00", "OVERNIGHT", "2026-11-27T17:00:00-05:00"],
  ["Half day 17:30 -> WEEKEND at 20:00", "2026-11-27T17:30:00-05:00", "WEEKEND", "2026-11-27T20:00:00-05:00"],
  ["Mon 03:00 -> PRE at 04:00", "2026-10-05T03:00:00-04:00", "PRE", "2026-10-05T04:00:00-04:00"],
  ["Mon 05:00 -> REGULAR at 09:30", "2026-10-05T05:00:00-04:00", "REGULAR", "2026-10-05T09:30:00-04:00"],
  ["Fri 2026-03-06 19:00 EST -> WEEKEND at 20:00 EST", "2026-03-06T19:00:00-05:00", "WEEKEND", "2026-03-06T20:00:00-05:00"],
  ["Sun 2026-03-08 12:00 (DST day) -> OVERNIGHT at Sun 20:00 EDT", "2026-03-08T12:00:00-04:00", "OVERNIGHT", "2026-03-08T20:00:00-04:00"],
  ["Sun 2026-11-01 12:00 (DST ends) -> OVERNIGHT at Sun 20:00 EST", "2026-11-01T12:00:00-05:00", "OVERNIGHT", "2026-11-01T20:00:00-05:00"],
];

suite("sessionAt", () => {
  test.each(TABLE)("%s", (_label, iso, expected) => {
    expect(sessionAt(at(iso))).toBe(expected);
  });

  test("accepts fractional seconds and ignores them", () => {
    expect(sessionAt(at("2026-09-03T09:29:59-04:00") + 0.999)).toBe("PRE");
    expect(sessionAt(at("2026-09-03T09:30:00-04:00") + 0.5)).toBe("REGULAR");
  });

  test("fails closed on unusable instants", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 17_999]) {
      expect(sessionAt(value)).toBe("UNKNOWN");
      expect(isFeedLive(value)).toBe(false);
      expect(nextTransition(value)).toEqual({ to: "UNKNOWN", at: 0 });
      expect(dateKeyOf(value)).toBe(0);
    }
  });
});

suite("nextTransition", () => {
  test.each(TRANSITIONS)("%s", (_label, fromIso, to, atIso) => {
    expect(nextTransition(at(fromIso), 14)).toEqual({ to, at: at(atIso) });
  });

  test("runs out of calendar instead of guessing", () => {
    expect(nextTransition(at("2026-12-31T19:00:00-05:00"), 14)).toEqual({ to: "UNKNOWN", at: 0 });
    expect(nextTransition(at("2027-03-02T12:00:00-05:00"), 14)).toEqual({ to: "UNKNOWN", at: 0 });
  });

  test("a horizon of zero days still finds a same-day change", () => {
    expect(nextTransition(at("2026-09-03T15:59:00-04:00"), 0)).toEqual({
      to: "POST",
      at: at("2026-09-03T16:00:00-04:00"),
    });
  });
});

suite("holidays and early closes", () => {
  test("every 2026 NYSE holiday is HOLIDAY at midday and flagged", () => {
    expect(NYSE_2026.holidays).toHaveLength(10);
    for (const key of NYSE_2026.holidays) {
      const y = Math.floor(key / 10_000);
      const m = Math.floor(key / 100) % 100;
      const d = key % 100;
      const noon = wallClockToEpoch(y, m, d, 12 * 60);
      expect(sessionAt(noon), String(key)).toBe("HOLIDAY");
      expect(isHoliday(key)).toBe(true);
      expect(describe(noon).sessionDate).toBe(key);
      // the eve's 20:00 ET already belongs to the holiday
      const eve = wallClockToEpoch(y, m, d - 1, 20 * 60);
      expect(describe(eve).sessionDate, `eve of ${key}`).toBe(key);
      expect(isFeedLive(eve)).toBe(false);
    }
  });

  test("4 July 2026 is a Saturday, so the observed holiday is Friday 3 July", () => {
    expect(NYSE_2026.holidays).not.toContain(20260704);
    expect(zoneFields(at("2026-07-04T12:00:00-04:00")).weekday).toBe(6);
  });

  test("the two early closes relabel the afternoon and keep the feed live", () => {
    expect([...NYSE_2026.earlyCloses].sort()).toEqual([20261127, 20261224]);
    for (const key of NYSE_2026.earlyCloses) {
      expect(isEarlyClose(key)).toBe(true);
      const y = Math.floor(key / 10_000);
      const m = Math.floor(key / 100) % 100;
      const d = key % 100;
      const afternoon = wallClockToEpoch(y, m, d, 14 * 60);
      expect(describe(afternoon)).toMatchObject({ session: "POST", earlyClose: true });
      expect(isFeedLive(afternoon)).toBe(true);
    }
    // the Monday after a half day is a full day again
    expect(sessionAt(at("2026-11-30T15:30:00-05:00"))).toBe("REGULAR");
    expect(sessionAt(at("2026-11-30T16:30:00-05:00"))).toBe("POST");
  });

  test("coverage", () => {
    expect(isYearLoaded(2026)).toBe(true);
    expect(isYearLoaded(2027)).toBe(false);
    expect(describe(at("2027-01-04T09:30:00-05:00")).covered).toBe(false);
  });
});

suite("describe and zone fields", () => {
  test("Saturday 3 October 2026 06:48 EDT", () => {
    const f = describe(at("2026-10-03T06:48:00-04:00"));
    expect(f).toEqual({
      session: "WEEKEND",
      exchangeDate: 20261003,
      sessionDate: 20261003,
      minutesOfDay: 6 * 60 + 48,
      weekday: 6,
      dst: true,
      earlyClose: false,
      covered: true,
    });
  });

  test("Friday 2 January 2026 20:00 EST rolls into Saturday's session", () => {
    const f = describe(at("2026-01-02T20:00:00-05:00"));
    expect(f.exchangeDate).toBe(20260102);
    expect(f.sessionDate).toBe(20260103);
    expect(f.dst).toBe(false);
    expect(f.session).toBe("WEEKEND");
  });

  test("DST flag flips with the tz database, not a rule", () => {
    expect(zoneFields(at("2026-03-08T06:59:59Z")).offsetSeconds).toBe(-5 * 3600);
    expect(zoneFields(at("2026-03-08T07:00:00Z")).offsetSeconds).toBe(-4 * 3600);
    expect(zoneFields(at("2026-11-01T05:59:59Z")).offsetSeconds).toBe(-4 * 3600);
    expect(zoneFields(at("2026-11-01T06:00:00Z")).offsetSeconds).toBe(-5 * 3600);
  });

  test("wallClockToEpoch round-trips through the tz database on both sides of DST", () => {
    expect(wallClockToEpoch(2026, 3, 6, 9 * 60 + 30)).toBe(at("2026-03-06T09:30:00-05:00"));
    expect(wallClockToEpoch(2026, 3, 9, 9 * 60 + 30)).toBe(at("2026-03-09T09:30:00-04:00"));
    expect(wallClockToEpoch(2026, 11, 1, 20 * 60)).toBe(at("2026-11-01T20:00:00-05:00"));
    expect(wallClockToEpoch(2026, 12, 31, 20 * 60)).toBe(at("2026-12-31T20:00:00-05:00"));
  });

  test("dateKeyOf follows the ET date, not the UTC date", () => {
    expect(dateKeyOf(at("2026-01-03T01:00:00Z"))).toBe(20260102);
    expect(dateKeyOf(at("2026-07-01T03:59:00Z"))).toBe(20260630);
  });

  test("session codes follow the Solidity enum order", () => {
    SESSIONS.forEach((s, i) => expect(SESSION_CODE[s]).toBe(i));
    expect(BOUNDARY_MARKS).toEqual([240, 570, 780, 960, 1020, 1200]);
  });
});
