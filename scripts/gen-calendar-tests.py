#!/usr/bin/env python3
"""Generate contracts/test/MarketCalendar.t.sol from Python's tz database.

Python's zoneinfo(America/New_York) is an oracle independent of the Solidity
time-zone math under test, so every expectation below is a UTC epoch computed
from an ET wall-clock label. Run from the repo root:

    python3 scripts/gen-calendar-tests.py
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
OUT = Path(__file__).resolve().parent.parent / "contracts" / "test" / "MarketCalendar.t.sol"


def et(s: str) -> int:
    return int(datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=ET).timestamp())


TABLE = [
    ("Thu 2026-09-03 03:59 EDT", "2026-09-03 03:59", "OVERNIGHT"),
    ("Thu 2026-09-03 04:00 EDT pre-market opens", "2026-09-03 04:00", "PRE"),
    ("Thu 2026-09-03 09:29 EDT", "2026-09-03 09:29", "PRE"),
    ("Thu 2026-09-03 09:30 EDT bell", "2026-09-03 09:30", "REGULAR"),
    ("Thu 2026-09-03 15:59 EDT", "2026-09-03 15:59", "REGULAR"),
    ("Thu 2026-09-03 16:00 EDT close", "2026-09-03 16:00", "POST"),
    ("Thu 2026-09-03 19:59 EDT", "2026-09-03 19:59", "POST"),
    ("Thu 2026-09-03 20:00 EDT overnight into Friday", "2026-09-03 20:00", "OVERNIGHT"),
    ("Fri 2026-01-02 03:59 EST", "2026-01-02 03:59", "OVERNIGHT"),
    ("Fri 2026-01-02 04:00 EST", "2026-01-02 04:00", "PRE"),
    ("Fri 2026-01-02 09:30 EST bell", "2026-01-02 09:30", "REGULAR"),
    ("Fri 2026-01-02 15:59 EST", "2026-01-02 15:59", "REGULAR"),
    ("Fri 2026-01-02 16:00 EST close", "2026-01-02 16:00", "POST"),
    ("Fri 2026-01-02 19:59 EST", "2026-01-02 19:59", "POST"),
    ("Fri 2026-01-02 20:00 EST feed closes for the weekend", "2026-01-02 20:00", "WEEKEND"),
    ("Fri 2026-03-06 08:30 EST, Friday before DST", "2026-03-06 08:30", "PRE"),
    ("Fri 2026-03-06 09:30 EST", "2026-03-06 09:30", "REGULAR"),
    ("Sun 2026-03-08 09:30, DST transition day", "2026-03-08 09:30", "WEEKEND"),
    ("Mon 2026-03-09 08:30 EDT, Monday after DST", "2026-03-09 08:30", "PRE"),
    ("Mon 2026-03-09 09:30 EDT", "2026-03-09 09:30", "REGULAR"),
    ("Fri 2026-10-30 09:30 EDT, Friday before DST ends", "2026-10-30 09:30", "REGULAR"),
    ("Sun 2026-11-01 09:30, DST ends", "2026-11-01 09:30", "WEEKEND"),
    ("Mon 2026-11-02 08:30 EST", "2026-11-02 08:30", "PRE"),
    ("Mon 2026-11-02 09:30 EST", "2026-11-02 09:30", "REGULAR"),
    ("Sat 2026-09-05 13:00", "2026-09-05 13:00", "WEEKEND"),
    ("Sun 2026-09-06 13:00", "2026-09-06 13:00", "WEEKEND"),
    ("Sun 2026-09-06 19:59 before Labor Day", "2026-09-06 19:59", "WEEKEND"),
    ("Sun 2026-09-06 20:00, no reopen into Labor Day", "2026-09-06 20:00", "HOLIDAY"),
    ("Mon 2026-09-07 12:00 Labor Day", "2026-09-07 12:00", "HOLIDAY"),
    ("Mon 2026-09-07 19:59 Labor Day", "2026-09-07 19:59", "HOLIDAY"),
    ("Mon 2026-09-07 20:00 overnight into Tuesday", "2026-09-07 20:00", "OVERNIGHT"),
    ("Sun 2026-10-04 19:59 before the reopen", "2026-10-04 19:59", "WEEKEND"),
    ("Sun 2026-10-04 20:00 reopen", "2026-10-04 20:00", "OVERNIGHT"),
    ("Mon 2026-10-05 00:00", "2026-10-05 00:00", "OVERNIGHT"),
    ("Fri 2026-11-27 09:30 half day bell", "2026-11-27 09:30", "REGULAR"),
    ("Fri 2026-11-27 12:59 half day", "2026-11-27 12:59", "REGULAR"),
    ("Fri 2026-11-27 13:00 early close", "2026-11-27 13:00", "POST"),
    ("Fri 2026-11-27 16:59", "2026-11-27 16:59", "POST"),
    ("Fri 2026-11-27 17:00 early post end", "2026-11-27 17:00", "OVERNIGHT"),
    ("Fri 2026-11-27 19:59", "2026-11-27 19:59", "OVERNIGHT"),
    ("Fri 2026-11-27 20:00 weekend", "2026-11-27 20:00", "WEEKEND"),
    ("Thu 2026-12-24 12:59 half day", "2026-12-24 12:59", "REGULAR"),
    ("Thu 2026-12-24 13:00 early close", "2026-12-24 13:00", "POST"),
    ("Thu 2026-12-24 17:00 early post end", "2026-12-24 17:00", "OVERNIGHT"),
    ("Thu 2026-12-24 20:00 eve of Christmas", "2026-12-24 20:00", "HOLIDAY"),
    ("Fri 2026-12-25 12:00 Christmas", "2026-12-25 12:00", "HOLIDAY"),
    ("Fri 2026-12-25 20:00 weekend", "2026-12-25 20:00", "WEEKEND"),
    ("Wed 2026-12-23 16:30 full day post", "2026-12-23 16:30", "POST"),
    ("Thu 2026-04-02 20:00 eve of Good Friday", "2026-04-02 20:00", "HOLIDAY"),
    ("Fri 2026-04-03 12:00 Good Friday", "2026-04-03 12:00", "HOLIDAY"),
    ("Fri 2026-04-03 20:00 weekend", "2026-04-03 20:00", "WEEKEND"),
    ("Wed 2026-11-25 20:00 eve of Thanksgiving", "2026-11-25 20:00", "HOLIDAY"),
    ("Thu 2026-11-26 12:00 Thanksgiving", "2026-11-26 12:00", "HOLIDAY"),
    ("Thu 2026-11-26 20:00 overnight into the half day", "2026-11-26 20:00", "OVERNIGHT"),
    ("Wed 2025-12-31 19:59, session date 2025 not loaded", "2025-12-31 19:59", "UNKNOWN"),
    ("Wed 2025-12-31 20:00, session date is New Year's Day 2026", "2025-12-31 20:00", "HOLIDAY"),
    ("Thu 2026-01-01 12:00 New Year's Day", "2026-01-01 12:00", "HOLIDAY"),
    ("Thu 2026-01-01 20:00 overnight into Friday", "2026-01-01 20:00", "OVERNIGHT"),
    ("Thu 2026-12-31 19:59 last covered instant", "2026-12-31 19:59", "POST"),
    ("Thu 2026-12-31 20:00, session date 2027 not loaded", "2026-12-31 20:00", "UNKNOWN"),
    ("Mon 2027-01-04 09:30, no 2027 data", "2027-01-04 09:30", "UNKNOWN"),
    ("Mon 2025-06-02 09:30, before coverage", "2025-06-02 09:30", "UNKNOWN"),
    ("Thu 2026-07-02 20:00 eve of observed Independence Day", "2026-07-02 20:00", "HOLIDAY"),
    ("Fri 2026-07-03 12:00 Independence Day observed", "2026-07-03 12:00", "HOLIDAY"),
    ("Fri 2026-07-03 20:00 weekend", "2026-07-03 20:00", "WEEKEND"),
    ("Mon 2026-01-19 12:00 MLK Day", "2026-01-19 12:00", "HOLIDAY"),
    ("Mon 2026-02-16 12:00 Washington's Birthday", "2026-02-16 12:00", "HOLIDAY"),
    ("Mon 2026-05-25 12:00 Memorial Day", "2026-05-25 12:00", "HOLIDAY"),
    ("Fri 2026-06-19 12:00 Juneteenth", "2026-06-19 12:00", "HOLIDAY"),
    ("Sat 2026-10-03 06:48 EDT, the day this test was written", "2026-10-03 06:48", "WEEKEND"),
]

TRANS = [
    ("Thu 15:59 -> POST at 16:00", "2026-09-03 15:59", "POST", "2026-09-03 16:00"),
    ("Thu 16:00 -> OVERNIGHT at 20:00", "2026-09-03 16:00", "OVERNIGHT", "2026-09-03 20:00"),
    ("Fri 19:00 -> WEEKEND at 20:00", "2026-01-02 19:00", "WEEKEND", "2026-01-02 20:00"),
    ("Sat 13:00 -> HOLIDAY at Sun 20:00 (Labor Day weekend)", "2026-09-05 13:00", "HOLIDAY", "2026-09-06 20:00"),
    ("Labor Day 12:00 -> OVERNIGHT at 20:00", "2026-09-07 12:00", "OVERNIGHT", "2026-09-07 20:00"),
    ("Sat 2026-10-03 06:48 -> OVERNIGHT at Sun 20:00", "2026-10-03 06:48", "OVERNIGHT", "2026-10-04 20:00"),
    ("Half day 12:00 -> POST at 13:00", "2026-11-27 12:00", "POST", "2026-11-27 13:00"),
    ("Half day 13:30 -> OVERNIGHT at 17:00", "2026-11-27 13:30", "OVERNIGHT", "2026-11-27 17:00"),
    ("Half day 17:30 -> WEEKEND at 20:00", "2026-11-27 17:30", "WEEKEND", "2026-11-27 20:00"),
    ("Mon 03:00 -> PRE at 04:00", "2026-10-05 03:00", "PRE", "2026-10-05 04:00"),
    ("Mon 05:00 -> REGULAR at 09:30", "2026-10-05 05:00", "REGULAR", "2026-10-05 09:30"),
    ("Fri 2026-03-06 19:00 EST -> WEEKEND at 20:00 EST", "2026-03-06 19:00", "WEEKEND", "2026-03-06 20:00"),
    ("Sun 2026-03-08 12:00 (DST day) -> OVERNIGHT at Sun 20:00 EDT", "2026-03-08 12:00", "OVERNIGHT", "2026-03-08 20:00"),
    ("Sun 2026-11-01 12:00 (DST ends) -> OVERNIGHT at Sun 20:00 EST", "2026-11-01 12:00", "OVERNIGHT", "2026-11-01 20:00"),
]


def dst_bounds(year: int):
    start = end = None
    t = datetime(year, 1, 1, tzinfo=timezone.utc)
    prev = t.astimezone(ET).utcoffset()
    while t.year == year:
        off = t.astimezone(ET).utcoffset()
        if off != prev:
            if off > prev:
                start = int(t.timestamp())
            else:
                end = int(t.timestamp())
            prev = off
        t += timedelta(hours=1)
    return start, end


def fields(when: str):
    d = datetime.strptime(when, "%Y-%m-%d %H:%M").replace(tzinfo=ET)
    return int(d.timestamp()), int(d.strftime("%Y%m%d")), d.hour * 60 + d.minute, (d.weekday() + 1) % 7, d.dst().total_seconds() > 0


HEADER = """// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// GENERATED by scripts/gen-calendar-tests.py from Python's zoneinfo (America/New_York),
// an oracle independent of the Solidity time-zone math under test. Regenerate, do not edit.

import {Test} from "forge-std/Test.sol";
import {MarketCalendar} from "../src/calendar/MarketCalendar.sol";
import {IMarketCalendar} from "../src/interfaces/IMarketCalendar.sol";
import {Nyse2026} from "../src/calendar/Nyse2026.sol";

contract MarketCalendarTest is Test {
    MarketCalendar internal cal;
    address internal owner = makeAddr("owner");

    uint256 internal constant Y2026_START = @@Y_START@@; // 2026-01-01 00:00 ET
    uint256 internal constant Y2026_END = @@Y_END@@; // 2026-12-15 00:00 ET (keeps a 14-day horizon inside 2026)

    function setUp() public {
        cal = new MarketCalendar(owner);
        vm.prank(owner);
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
    }

    function _s(IMarketCalendar.Session s) internal pure returns (string memory) {
        string[7] memory names = ["UNKNOWN", "PRE", "REGULAR", "POST", "OVERNIGHT", "WEEKEND", "HOLIDAY"];
        return names[uint256(s)];
    }

    function _check(uint256 ts, IMarketCalendar.Session expected, string memory label) internal view {
        IMarketCalendar.Session got = cal.sessionAt(ts);
        assertEq(uint256(got), uint256(expected), string.concat(label, ": got ", _s(got), " want ", _s(expected)));
    }
"""

FOOTER = """
    // ------------------------------------------------------------ invariants over 2026

    function testFuzz_feedLiveMatchesSessionVocabulary(uint256 ts) public view {
        ts = bound(ts, Y2026_START, Y2026_END);
        IMarketCalendar.Session s = cal.sessionAt(ts);
        bool live = s == IMarketCalendar.Session.PRE || s == IMarketCalendar.Session.REGULAR
            || s == IMarketCalendar.Session.POST || s == IMarketCalendar.Session.OVERNIGHT;
        assertEq(cal.isFeedLive(ts), live);
        assertTrue(s != IMarketCalendar.Session.UNKNOWN, "2026 is loaded, never UNKNOWN");
    }

    function testFuzz_weekendInstantsAreNeverLive(uint256 ts) public view {
        ts = bound(ts, Y2026_START, Y2026_END);
        IMarketCalendar.Fields memory f = cal.describe(ts);
        uint256 sessionWeekday = _weekdayOfKey(f.sessionDate);
        if (sessionWeekday == 0 || sessionWeekday == 6) {
            assertEq(uint256(f.session), uint256(IMarketCalendar.Session.WEEKEND));
            assertFalse(cal.isFeedLive(ts));
        }
    }

    function testFuzz_holidayInstantsAreNeverLive(uint256 ts) public view {
        ts = bound(ts, Y2026_START, Y2026_END);
        IMarketCalendar.Fields memory f = cal.describe(ts);
        if (cal.isHoliday(f.sessionDate) && f.session != IMarketCalendar.Session.WEEKEND) {
            assertEq(uint256(f.session), uint256(IMarketCalendar.Session.HOLIDAY));
            assertFalse(cal.isFeedLive(ts));
        }
    }

    function testFuzz_nextTransitionIsTheFirstChange(uint256 ts) public view {
        ts = bound(ts, Y2026_START, Y2026_END);
        IMarketCalendar.Session from = cal.sessionAt(ts);
        (IMarketCalendar.Session to, uint256 at) = cal.nextTransition(ts, 14);
        assertGt(at, ts, "transition is in the future");
        assertTrue(to != from, "transition changes the session");
        assertEq(uint256(cal.sessionAt(at)), uint256(to), "session at the transition");
        assertEq(uint256(cal.sessionAt(at - 1)), uint256(from), "session one second before");
        assertLt(at - ts, 5 days, "no 2026 gap exceeds a long weekend");
    }

    function testFuzz_sessionIsConstantWithinAMinute(uint256 ts) public view {
        ts = bound(ts, Y2026_START, Y2026_END);
        uint256 minuteStart = ts - (ts - (ts / 60) * 60);
        assertEq(uint256(cal.sessionAt(ts)), uint256(cal.sessionAt(minuteStart)));
    }

    // ------------------------------------------------------------ owner surface

    function test_loadYear_onlyOnce() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MarketCalendar.YearAlreadyLoaded.selector, 2026));
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
    }

    function test_loadYear_rejectsDateOutsideYear() public {
        uint256[] memory h = new uint256[](1);
        h[0] = 20_260_101;
        uint256[] memory e = new uint256[](0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MarketCalendar.DateOutsideYear.selector, 20_260_101, 2027));
        cal.loadYear(2027, h, e, "x");
    }

    function test_loadYear_rejectsInvalidDate() public {
        uint256[] memory h = new uint256[](1);
        h[0] = 20_270_230; // 30 Feb
        uint256[] memory e = new uint256[](0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MarketCalendar.InvalidDate.selector, 20_270_230));
        cal.loadYear(2027, h, e, "x");
    }

    function test_loadYear_onlyOwner() public {
        uint256[] memory e = new uint256[](0);
        vm.expectRevert();
        cal.loadYear(2027, e, e, "x");
    }

    function test_addClosure_makesTheDayAHoliday() public {
        uint256 noon = @@WED_NOON@@; // Wed 2026-10-07 12:00 ET
        assertEq(uint256(cal.sessionAt(noon)), uint256(IMarketCalendar.Session.REGULAR));
        vm.prank(owner);
        cal.addClosure(20_261_007, "national day of mourning");
        assertEq(uint256(cal.sessionAt(noon)), uint256(IMarketCalendar.Session.HOLIDAY));
        // the eve's overnight session is closed too
        assertEq(uint256(cal.sessionAt(@@TUE_2000@@)), uint256(IMarketCalendar.Session.HOLIDAY)); // Tue 2026-10-06 20:00 ET
    }

    function test_addClosure_requiresLoadedYear() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MarketCalendar.YearNotLoaded.selector, 2027));
        cal.addClosure(20_270_107, "x");
    }

    function test_addEarlyClose_relabelsButKeepsTheFeedLive() public {
        uint256 at1400 = @@WED_1400@@; // Wed 2026-10-07 14:00 ET
        assertEq(uint256(cal.sessionAt(at1400)), uint256(IMarketCalendar.Session.REGULAR));
        vm.prank(owner);
        cal.addEarlyClose(20_261_007, "unscheduled early close");
        assertEq(uint256(cal.sessionAt(at1400)), uint256(IMarketCalendar.Session.POST));
        assertTrue(cal.isFeedLive(at1400));
    }

    function test_unloadedYearIsUnknown() public view {
        assertFalse(cal.isYearLoaded(2027));
        assertEq(uint256(cal.sessionAt(@@Y2027_NOON@@)), uint256(IMarketCalendar.Session.UNKNOWN)); // 2027-03-02 12:00 ET
        (IMarketCalendar.Session to, uint256 at) = cal.nextTransition(@@Y2027_NOON@@, 14);
        assertEq(uint256(to), uint256(IMarketCalendar.Session.UNKNOWN));
        assertEq(at, 0);
    }

    function test_nextTransition_horizonBound() public {
        vm.expectRevert(abi.encodeWithSelector(MarketCalendar.HorizonTooLong.selector, 61));
        cal.nextTransition(Y2026_START, 61);
    }

    /// @dev Sakamoto's weekday algorithm, independent of the contract's civil-date code.
    function _weekdayOfKey(uint256 key) internal pure returns (uint256) {
        uint256 y = key / 10_000;
        uint256 m = (key / 100) - (key / 10_000) * 100;
        uint256 d = key - (key / 100) * 100;
        uint8[12] memory t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
        if (m < 3) y -= 1;
        uint256 v = y + y / 4 - y / 100 + y / 400 + t[m - 1] + d;
        return v - (v / 7) * 7;
    }
}
"""


def main() -> None:
    out = [HEADER.replace("@@Y_START@@", str(et("2026-01-01 00:00"))).replace("@@Y_END@@", str(et("2026-12-15 00:00")))]
    out.append("    function test_table_sessionBoundariesDstHolidaysHalfDays() public view {")
    for label, when, exp in TABLE:
        out.append(f'        _check({et(when)}, IMarketCalendar.Session.{exp}, "{label}");')
    out.append("    }\n")
    out.append("    function test_table_nextTransition() public view {")
    for label, when, to, at in TRANS:
        out.append("        {")
        out.append(f"            (IMarketCalendar.Session to, uint256 at) = cal.nextTransition({et(when)}, 14);")
        out.append(f'            assertEq(uint256(to), uint256(IMarketCalendar.Session.{to}), "{label} (to)");')
        out.append(f'            assertEq(at, {et(at)}, "{label} (at)");')
        out.append("        }")
    out.append("    }\n")
    out.append("    function test_dstBoundaries_matchTzDatabase() public view {")
    for y in (2026, 2027, 2028, 2030):
        s, e = dst_bounds(y)
        out.append(f'        assertEq(cal.dstStart({y}), {s}, "dst start {y}");')
        out.append(f'        assertEq(cal.dstEnd({y}), {e}, "dst end {y}");')
    out.append("    }\n")
    out.append("    function test_describe_fields() public view {")
    for when in ("2026-10-03 06:48", "2026-01-02 20:00", "2026-07-15 23:30", "2025-12-31 20:00"):
        ts, key, mod, wd, dst = fields(when)
        out.append("        {")
        out.append(f"            IMarketCalendar.Fields memory f = cal.describe({ts});")
        out.append(f'            assertEq(f.exchangeDate, {key}, "exchangeDate {when}");')
        out.append(f'            assertEq(f.minutesOfDay, {mod}, "minutesOfDay {when}");')
        out.append(f'            assertEq(uint256(f.weekday), {wd}, "weekday {when}");')
        out.append(f'            assertEq(f.dst, {"true" if dst else "false"}, "dst {when}");')
        out.append("        }")
    out.append("    }")
    footer = (
        FOOTER.replace("@@WED_NOON@@", str(et("2026-10-07 12:00")))
        .replace("@@TUE_2000@@", str(et("2026-10-06 20:00")))
        .replace("@@WED_1400@@", str(et("2026-10-07 14:00")))
        .replace("@@Y2027_NOON@@", str(et("2027-03-02 12:00")))
    )
    out.append(footer)
    OUT.write_text("\n".join(out))
    print(f"wrote {OUT.relative_to(OUT.parents[2])}: {len(TABLE)} table rows, {len(TRANS)} transitions")


if __name__ == "__main__":
    main()
