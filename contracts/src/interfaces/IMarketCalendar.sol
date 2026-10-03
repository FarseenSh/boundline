// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IMarketCalendar
/// @notice US equity session state for a UTC timestamp, as the Chainlink Coinbase
///         feeds observe it: live from Sunday 20:00 ET to Friday 20:00 ET, excluding
///         NYSE holidays, with the instants at or after 20:00 ET belonging to the next
///         exchange date's overnight session.
/// @dev `UNKNOWN` is the fail-closed answer for any instant the calendar has no
///      verified data for. Callers must treat it as "not open".
interface IMarketCalendar {
    enum Session {
        UNKNOWN, // no holiday data loaded for the exchange date: never assume open
        PRE, // 04:00 to 09:30 ET on a trading day
        REGULAR, // 09:30 to 16:00 ET (13:00 on an early-close day)
        POST, // 16:00 to 20:00 ET (13:00 to 17:00 on an early-close day)
        OVERNIGHT, // 20:00 ET to 04:00 ET into a trading day; also 17:00 to 20:00 after an early close
        WEEKEND, // Friday 20:00 ET to Sunday 20:00 ET
        HOLIDAY // 20:00 ET on the eve of an NYSE full-day closure until 20:00 ET on that date
    }

    struct Fields {
        Session session;
        uint256 exchangeDate; // yyyymmdd of the ET wall clock at the instant (not the session date)
        uint256 sessionDate; // yyyymmdd of the exchange date the session belongs to
        uint256 minutesOfDay; // ET minutes since midnight at the instant
        uint8 weekday; // 0 = Sunday ... 6 = Saturday, of exchangeDate
        bool dst; // true when America/New_York is on daylight time at the instant
        bool earlyClose; // sessionDate closes at 13:00 ET
        bool covered; // holiday data is loaded for sessionDate's year
    }

    /// @notice Session the feed is in at `timestamp`.
    function sessionAt(uint256 timestamp) external view returns (Session);

    /// @notice True when the feed publishes at `timestamp`: PRE, REGULAR, POST or OVERNIGHT.
    function isFeedLive(uint256 timestamp) external view returns (bool);

    /// @notice Session plus the fields an operator needs to explain it.
    function describe(uint256 timestamp) external view returns (Fields memory);

    /// @notice First instant after `timestamp` at which the session changes, within `horizonDays`.
    /// @return to Session in force from `at`; `UNKNOWN` with `at == 0` when the horizon or the
    ///         loaded calendar runs out first.
    /// @return at UTC timestamp of the transition, 0 when none was found.
    function nextTransition(uint256 timestamp, uint256 horizonDays) external view returns (Session to, uint256 at);

    /// @notice True when `dateKey` (yyyymmdd) is a loaded full-day closure.
    function isHoliday(uint256 dateKey) external view returns (bool);

    /// @notice True when `dateKey` (yyyymmdd) is a loaded 13:00 ET early close.
    function isEarlyClose(uint256 dateKey) external view returns (bool);

    /// @notice True when holiday data for `year` has been loaded.
    function isYearLoaded(uint256 year) external view returns (bool);
}
