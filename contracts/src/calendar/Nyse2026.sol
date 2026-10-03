// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Nyse2026
/// @notice The 2026 NYSE scheduled calendar, as published at
///         https://www.nyse.com/markets/hours-calendars, in yyyymmdd keys.
///         Used by the deploy script and the tests to load `MarketCalendar`.
library Nyse2026 {
    string internal constant SOURCE = "https://www.nyse.com/markets/hours-calendars (2026 scheduled calendar)";

    /// @dev New Year's Day, MLK Day, Washington's Birthday, Good Friday, Memorial Day,
    ///      Juneteenth, Independence Day (observed Fri 3 Jul), Labor Day, Thanksgiving, Christmas.
    function holidays() internal pure returns (uint256[] memory h) {
        h = new uint256[](10);
        h[0] = 20_260_101;
        h[1] = 20_260_119;
        h[2] = 20_260_216;
        h[3] = 20_260_403;
        h[4] = 20_260_525;
        h[5] = 20_260_619;
        h[6] = 20_260_703;
        h[7] = 20_260_907;
        h[8] = 20_261_126;
        h[9] = 20_261_225;
    }

    /// @dev Day after Thanksgiving and Christmas Eve close at 13:00 ET.
    function earlyCloses() internal pure returns (uint256[] memory e) {
        e = new uint256[](2);
        e[0] = 20_261_127;
        e[1] = 20_261_224;
    }
}
