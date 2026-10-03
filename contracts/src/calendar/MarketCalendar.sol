// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IMarketCalendar} from "../interfaces/IMarketCalendar.sol";

/// @title MarketCalendar
/// @notice Onchain US equity session calendar in America/New_York time, modelled on the
///         window the Chainlink Coinbase tokenized-stock feeds actually publish in:
///         Sunday 20:00 ET to Friday 20:00 ET, minus NYSE full-day closures.
///
///         The logic is immutable. The data (holidays, early closes, unscheduled closures)
///         is append-only and owner-loaded per year, so a year the owner has not loaded
///         resolves to `UNKNOWN` and every caller fails closed.
///
/// @dev Time zone math is done from first principles: the US daylight-saving rule in force
///      since 2007 (second Sunday of March 07:00 UTC to first Sunday of November 06:00 UTC)
///      and Howard Hinnant's civil-date algorithms. No session boundary falls inside the
///      01:00 to 03:00 ET transition window, so no boundary is ever ambiguous.
contract MarketCalendar is IMarketCalendar, Ownable2Step {
    // ---------------------------------------------------------------- constants

    uint256 internal constant SECONDS_PER_DAY = 86_400;
    uint256 internal constant EST_OFFSET = 5 hours; // UTC-5, standard time
    uint256 internal constant EDT_OFFSET = 4 hours; // UTC-4, daylight time

    /// @notice Session boundaries in ET minutes since midnight.
    uint256 public constant PRE_START = 4 * 60;
    uint256 public constant REGULAR_OPEN = 9 * 60 + 30;
    uint256 public constant REGULAR_CLOSE = 16 * 60;
    uint256 public constant EARLY_CLOSE = 13 * 60;
    uint256 public constant POST_END = 20 * 60;
    uint256 public constant EARLY_POST_END = 17 * 60;
    /// @dev Instants at or after this minute belong to the next exchange date's session.
    uint256 public constant NEXT_SESSION_START = 20 * 60;

    uint256 public constant MAX_HORIZON_DAYS = 60;

    // ---------------------------------------------------------------- storage

    mapping(uint256 year => bool loaded) private _yearLoaded;
    mapping(uint256 dateKey => bool closed) private _holiday;
    mapping(uint256 dateKey => bool early) private _earlyClose;
    mapping(uint256 year => string source) private _source;

    // ---------------------------------------------------------------- events, errors

    event YearLoaded(uint256 indexed year, uint256 holidays, uint256 earlyCloses, string source);
    event ClosureAdded(uint256 indexed dateKey, string reason);
    event EarlyCloseAdded(uint256 indexed dateKey, string reason);

    error YearAlreadyLoaded(uint256 year);
    error YearNotLoaded(uint256 year);
    error InvalidDate(uint256 dateKey);
    error DateOutsideYear(uint256 dateKey, uint256 year);
    error HorizonTooLong(uint256 horizonDays);

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ---------------------------------------------------------------- owner (append-only)

    /// @notice Load one year's NYSE full-day closures and 13:00 ET early closes. Once.
    /// @param holidays Date keys (yyyymmdd) of full-day closures.
    /// @param earlyCloses Date keys (yyyymmdd) of 13:00 ET closes.
    /// @param source Provenance of the data, for the record.
    function loadYear(uint256 year, uint256[] calldata holidays, uint256[] calldata earlyCloses, string calldata source)
        external
        onlyOwner
    {
        if (_yearLoaded[year]) revert YearAlreadyLoaded(year);
        for (uint256 i = 0; i < holidays.length; ++i) {
            _requireDateInYear(holidays[i], year);
            _holiday[holidays[i]] = true;
        }
        for (uint256 i = 0; i < earlyCloses.length; ++i) {
            _requireDateInYear(earlyCloses[i], year);
            _earlyClose[earlyCloses[i]] = true;
        }
        _yearLoaded[year] = true;
        _source[year] = source;
        emit YearLoaded(year, holidays.length, earlyCloses.length, source);
    }

    /// @notice Record an unscheduled full-day closure (a day of mourning, a weather closure).
    ///         Closures can only be added, never removed: adding one can only make every
    ///         gate more conservative.
    function addClosure(uint256 dateKey, string calldata reason) external onlyOwner {
        uint256 year = dateKey / 10_000;
        if (!_yearLoaded[year]) revert YearNotLoaded(year);
        _requireDateInYear(dateKey, year);
        _holiday[dateKey] = true;
        emit ClosureAdded(dateKey, reason);
    }

    /// @notice Record an unscheduled 13:00 ET early close. Append-only; it relabels
    ///         sessions and never changes whether the feed is considered live.
    function addEarlyClose(uint256 dateKey, string calldata reason) external onlyOwner {
        uint256 year = dateKey / 10_000;
        if (!_yearLoaded[year]) revert YearNotLoaded(year);
        _requireDateInYear(dateKey, year);
        _earlyClose[dateKey] = true;
        emit EarlyCloseAdded(dateKey, reason);
    }

    // ---------------------------------------------------------------- views

    /// @inheritdoc IMarketCalendar
    function sessionAt(uint256 timestamp) public view returns (Session) {
        return describe(timestamp).session;
    }

    /// @inheritdoc IMarketCalendar
    function isFeedLive(uint256 timestamp) external view returns (bool) {
        Session s = sessionAt(timestamp);
        return s == Session.PRE || s == Session.REGULAR || s == Session.POST || s == Session.OVERNIGHT;
    }

    /// @inheritdoc IMarketCalendar
    function isHoliday(uint256 dateKey) external view returns (bool) {
        return _holiday[dateKey];
    }

    /// @inheritdoc IMarketCalendar
    function isEarlyClose(uint256 dateKey) external view returns (bool) {
        return _earlyClose[dateKey];
    }

    /// @inheritdoc IMarketCalendar
    function isYearLoaded(uint256 year) external view returns (bool) {
        return _yearLoaded[year];
    }

    /// @notice Provenance recorded for `year`'s data.
    function sourceOf(uint256 year) external view returns (string memory) {
        return _source[year];
    }

    /// @inheritdoc IMarketCalendar
    function describe(uint256 timestamp) public view returns (Fields memory f) {
        if (timestamp < EST_OFFSET) return f; // before 1970-01-01 05:00 UTC: UNKNOWN
        bool dst = isDaylightTime(timestamp);
        uint256 local = timestamp - (dst ? EDT_OFFSET : EST_OFFSET);
        uint256 dayIndex = local / SECONDS_PER_DAY;
        uint256 minute = (local % SECONDS_PER_DAY) / 60;

        f.dst = dst;
        f.minutesOfDay = minute;
        f.weekday = uint8((dayIndex + 4) % 7);
        f.exchangeDate = _dateKeyFromDays(dayIndex);

        uint256 sessionDays = minute >= NEXT_SESSION_START ? dayIndex + 1 : dayIndex;
        f.sessionDate = _dateKeyFromDays(sessionDays);
        uint256 sessionYear = f.sessionDate / 10_000;
        f.covered = _yearLoaded[sessionYear];
        f.earlyClose = _earlyClose[f.sessionDate];
        if (!f.covered) {
            f.session = Session.UNKNOWN;
            return f;
        }

        uint256 sessionWeekday = (sessionDays + 4) % 7;
        if (sessionWeekday == 0 || sessionWeekday == 6) {
            f.session = Session.WEEKEND;
        } else if (_holiday[f.sessionDate]) {
            f.session = Session.HOLIDAY;
        } else if (minute >= NEXT_SESSION_START || minute < PRE_START) {
            f.session = Session.OVERNIGHT;
        } else if (minute < REGULAR_OPEN) {
            f.session = Session.PRE;
        } else if (minute < (f.earlyClose ? EARLY_CLOSE : REGULAR_CLOSE)) {
            f.session = Session.REGULAR;
        } else if (minute < (f.earlyClose ? EARLY_POST_END : POST_END)) {
            f.session = Session.POST;
        } else {
            f.session = Session.OVERNIGHT; // 17:00 to 20:00 ET after an early close
        }
    }

    /// @inheritdoc IMarketCalendar
    function nextTransition(uint256 timestamp, uint256 horizonDays) external view returns (Session to, uint256 at) {
        if (horizonDays > MAX_HORIZON_DAYS) revert HorizonTooLong(horizonDays);
        Session from = sessionAt(timestamp);
        if (from == Session.UNKNOWN) return (Session.UNKNOWN, 0);

        uint256 startDay = (timestamp - (isDaylightTime(timestamp) ? EDT_OFFSET : EST_OFFSET)) / SECONDS_PER_DAY;
        uint256[6] memory marks = [PRE_START, REGULAR_OPEN, EARLY_CLOSE, REGULAR_CLOSE, EARLY_POST_END, POST_END];

        for (uint256 offset = 0; offset <= horizonDays; ++offset) {
            uint256 dayIndex = startDay + offset;
            for (uint256 i = 0; i < marks.length; ++i) {
                uint256 candidate = wallClockToUtc(dayIndex, marks[i]);
                if (candidate <= timestamp) continue;
                Session s = sessionAt(candidate);
                if (s == Session.UNKNOWN) return (Session.UNKNOWN, 0);
                if (s != from) return (s, candidate);
            }
        }
        return (Session.UNKNOWN, 0);
    }

    // ---------------------------------------------------------------- time-zone math (pure)

    /// @notice True when America/New_York observes daylight time at `timestamp` (UTC).
    /// @dev US rule since 2007: starts the second Sunday of March at 02:00 EST (07:00 UTC),
    ///      ends the first Sunday of November at 02:00 EDT (06:00 UTC).
    function isDaylightTime(uint256 timestamp) public pure returns (bool) {
        (uint256 year,,) = _civilFromDays(timestamp / SECONDS_PER_DAY);
        return timestamp >= dstStart(year) && timestamp < dstEnd(year);
    }

    /// @notice UTC instant daylight time starts in `year`.
    function dstStart(uint256 year) public pure returns (uint256) {
        uint256 march1 = _daysFromCivil(year, 3, 1);
        uint256 firstSunday = 1 + (7 - (march1 + 4) % 7) % 7;
        return _daysFromCivil(year, 3, firstSunday + 7) * SECONDS_PER_DAY + 7 hours;
    }

    /// @notice UTC instant daylight time ends in `year`.
    function dstEnd(uint256 year) public pure returns (uint256) {
        uint256 nov1 = _daysFromCivil(year, 11, 1);
        uint256 firstSunday = 1 + (7 - (nov1 + 4) % 7) % 7;
        return _daysFromCivil(year, 11, firstSunday) * SECONDS_PER_DAY + 6 hours;
    }

    /// @notice UTC instant of an ET wall-clock minute on the day `dayIndex` days after 1970-01-01 (ET).
    /// @dev Two-pass offset resolution, evaluated at the target instant rather than the guess.
    function wallClockToUtc(uint256 dayIndex, uint256 minutesOfDay) public pure returns (uint256) {
        uint256 naive = dayIndex * SECONDS_PER_DAY + minutesOfDay * 60;
        uint256 guess = naive + EST_OFFSET;
        uint256 utc = naive + (isDaylightTime(guess) ? EDT_OFFSET : EST_OFFSET);
        uint256 again = naive + (isDaylightTime(utc) ? EDT_OFFSET : EST_OFFSET);
        return again;
    }

    /// @notice yyyymmdd of a UTC timestamp's ET wall clock.
    function dateKeyOf(uint256 timestamp) external pure returns (uint256) {
        if (timestamp < EST_OFFSET) return 0;
        uint256 local = timestamp - (isDaylightTime(timestamp) ? EDT_OFFSET : EST_OFFSET);
        return _dateKeyFromDays(local / SECONDS_PER_DAY);
    }

    // ---------------------------------------------------------------- civil-date helpers

    function _dateKeyFromDays(uint256 dayIndex) internal pure returns (uint256) {
        (uint256 y, uint256 m, uint256 d) = _civilFromDays(dayIndex);
        return y * 10_000 + m * 100 + d;
    }

    /// @dev Days since 1970-01-01 for a proleptic Gregorian date. Valid for year >= 1970.
    function _daysFromCivil(uint256 year, uint256 month, uint256 day) internal pure returns (uint256) {
        uint256 y = month <= 2 ? year - 1 : year;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;
        uint256 mp = month > 2 ? month - 3 : month + 9;
        uint256 doy = (153 * mp + 2) / 5 + day - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146_097 + doe - 719_468;
    }

    /// @dev Proleptic Gregorian date from days since 1970-01-01.
    function _civilFromDays(uint256 dayIndex) internal pure returns (uint256 year, uint256 month, uint256 day) {
        uint256 z = dayIndex + 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        uint256 y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        day = doy - (153 * mp + 2) / 5 + 1;
        month = mp < 10 ? mp + 3 : mp - 9;
        year = month <= 2 ? y + 1 : y;
    }

    function _daysInMonth(uint256 year, uint256 month) internal pure returns (uint256) {
        if (month == 2) {
            bool leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
            return leap ? 29 : 28;
        }
        if (month == 4 || month == 6 || month == 9 || month == 11) return 30;
        return 31;
    }

    function _requireDateInYear(uint256 dateKey, uint256 year) internal pure {
        uint256 y = dateKey / 10_000;
        uint256 m = (dateKey / 100) % 100;
        uint256 d = dateKey % 100;
        if (y != year) revert DateOutsideYear(dateKey, year);
        if (m == 0 || m > 12 || d == 0 || d > _daysInMonth(y, m)) revert InvalidDate(dateKey);
    }
}
