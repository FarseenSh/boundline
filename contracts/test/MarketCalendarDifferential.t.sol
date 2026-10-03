// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MarketCalendar} from "../src/calendar/MarketCalendar.sol";
import {IMarketCalendar} from "../src/interfaces/IMarketCalendar.sol";
import {Nyse2026} from "../src/calendar/Nyse2026.sol";

/// @notice Differential test: the onchain calendar against `@boundline/calendar`, the
///         TypeScript reference that resolves America/New_York through the host tz database
///         instead of the contract's DST rule and civil-date arithmetic.
///
///         Fixture: test/fixtures/calendar-2026.json, flat parallel arrays written by
///         `pnpm --filter @boundline/calendar fixture` (every 2026 session boundary at
///         -1s/0/+1s/+60s, both DST transitions, every holiday and its eve, and a seeded
///         random sample of the year).
contract MarketCalendarDifferentialTest is Test {
    using stdJson for string;

    string internal constant FIXTURE = "test/fixtures/calendar-2026.json";

    MarketCalendar internal cal;
    string internal json;

    function setUp() public {
        cal = new MarketCalendar(address(this));
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        json = vm.readFile(FIXTURE);
    }

    function test_differential_sessionAt() public view {
        uint256[] memory t = json.readUintArray(".t");
        uint256[] memory s = json.readUintArray(".s");
        assertEq(t.length, s.length, "parallel arrays");
        assertGt(t.length, 3000, "fixture is populated");

        uint256 mismatches;
        for (uint256 i = 0; i < t.length; ++i) {
            uint256 got = uint256(cal.sessionAt(t[i]));
            if (got != s[i]) {
                ++mismatches;
                if (mismatches <= 10) {
                    emit log_named_string(
                        "mismatch",
                        string.concat("t=", vm.toString(t[i]), " solidity=", _name(got), " typescript=", _name(s[i]))
                    );
                }
            }
        }
        assertEq(mismatches, 0, "sessionAt disagrees with the TypeScript calendar");
    }

    function test_differential_nextTransition() public view {
        uint256[] memory tt = json.readUintArray(".tt");
        uint256[] memory to = json.readUintArray(".to");
        uint256[] memory at = json.readUintArray(".at");
        assertEq(tt.length, to.length, "parallel arrays (to)");
        assertEq(tt.length, at.length, "parallel arrays (at)");
        assertGt(tt.length, 100, "transitions are populated");

        uint256 mismatches;
        for (uint256 i = 0; i < tt.length; ++i) {
            (IMarketCalendar.Session gotTo, uint256 gotAt) = cal.nextTransition(tt[i], 14);
            if (uint256(gotTo) != to[i] || gotAt != at[i]) {
                ++mismatches;
                if (mismatches <= 10) {
                    emit log_named_string(
                        "mismatch",
                        string.concat(
                            "t=",
                            vm.toString(tt[i]),
                            " solidity=(",
                            _name(uint256(gotTo)),
                            ",",
                            vm.toString(gotAt),
                            ") typescript=(",
                            _name(to[i]),
                            ",",
                            vm.toString(at[i]),
                            ")"
                        )
                    );
                }
            }
        }
        assertEq(mismatches, 0, "nextTransition disagrees with the TypeScript calendar");
    }

    function _name(uint256 code) internal pure returns (string memory) {
        string[7] memory names = ["UNKNOWN", "PRE", "REGULAR", "POST", "OVERNIGHT", "WEEKEND", "HOLIDAY"];
        return code < names.length ? names[code] : string.concat("code(", vm.toString(code), ")");
    }
}
