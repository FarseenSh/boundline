// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {IMarketCalendar} from "../interfaces/IMarketCalendar.sol";
import {IOracleRegistry} from "../interfaces/IOracleRegistry.sol";
import {IPriceGate} from "../interfaces/IPriceGate.sol";

/// @title SessionGate
/// @notice The shared verdict engine behind every Boundline oracle. For a tokenized stock it
///         combines four inputs the live venues ignore: the market calendar (is Wall Street
///         open), the Coinbase OracleRegistry pause flag, the token's own transfer pause, and
///         the Chainlink feed's `updatedAt`. It returns a price only when all four agree; every
///         other outcome is a named state, never a held number.
///
/// @dev One SessionGate serves many tokens. Per-market oracles (`SessionGuard`, `ShadowGuard`)
///      bind one token each and read `priceAndSession`. Feed configuration is owner-set and can
///      be locked per token, after which it is immutable.
contract SessionGate is IPriceGate, Ownable2Step {
    struct FeedConfig {
        IAggregatorV3 feed;
        uint8 feedDecimals;
        uint32 heartbeat; // feed's nominal heartbeat, 24h for the Coinbase feeds
        uint32 tolerance; // grace on top of the heartbeat before FEED_STALE
        bool locked;
    }

    uint32 public constant DEFAULT_HEARTBEAT = 24 hours;
    uint32 public constant DEFAULT_TOLERANCE = 2 hours;
    uint32 public constant MIN_HEARTBEAT = 1 minutes;
    uint32 public constant MAX_WINDOW = 7 days;
    uint8 public constant PRICE_DECIMALS = 8;

    IMarketCalendar public immutable CALENDAR;
    IOracleRegistry public immutable REGISTRY;

    mapping(address token => FeedConfig) private _feeds;
    address[] private _tokens;

    event FeedSet(address indexed token, address indexed feed, uint8 feedDecimals, uint32 heartbeat, uint32 tolerance);
    event FeedLocked(address indexed token, address indexed feed);

    error FeedAlreadyLocked(address token);
    error FeedNotSet(address token);
    error BadFeedDecimals(uint8 decimals);
    error BadWindow(uint32 heartbeat, uint32 tolerance);
    error ZeroAddress();

    // priceOf refusals, by name
    error MarketClosed(IMarketCalendar.Session session);
    error FeedPaused(address token);
    error TransferPaused(address token);
    error FeedStale(address token, uint256 updatedAt, uint256 maxAge);
    error FeedInvalid(address token, int256 answer, uint256 updatedAt);
    error UnknownToken(address token);

    constructor(address initialOwner, IMarketCalendar calendar, IOracleRegistry registry) Ownable(initialOwner) {
        if (address(calendar) == address(0) || address(registry) == address(0)) revert ZeroAddress();
        CALENDAR = calendar;
        REGISTRY = registry;
    }

    // ---------------------------------------------------------------- owner

    /// @notice Bind `token` to its Chainlink feed. Pass 0 for the default heartbeat or tolerance.
    function setFeed(address token, IAggregatorV3 feed, uint32 heartbeat, uint32 tolerance) external onlyOwner {
        if (token == address(0) || address(feed) == address(0)) revert ZeroAddress();
        FeedConfig storage c = _feeds[token];
        if (c.locked) revert FeedAlreadyLocked(token);
        if (heartbeat == 0) heartbeat = DEFAULT_HEARTBEAT;
        if (tolerance == 0) tolerance = DEFAULT_TOLERANCE;
        if (heartbeat < MIN_HEARTBEAT || heartbeat > MAX_WINDOW || tolerance > MAX_WINDOW) {
            revert BadWindow(heartbeat, tolerance);
        }
        uint8 decimals = feed.decimals();
        if (decimals > 18) revert BadFeedDecimals(decimals);
        if (address(c.feed) == address(0)) _tokens.push(token);
        c.feed = feed;
        c.feedDecimals = decimals;
        c.heartbeat = heartbeat;
        c.tolerance = tolerance;
        emit FeedSet(token, address(feed), decimals, heartbeat, tolerance);
    }

    /// @notice Make `token`'s configuration immutable. Irreversible.
    function lockFeed(address token) external onlyOwner {
        FeedConfig storage c = _feeds[token];
        if (address(c.feed) == address(0)) revert FeedNotSet(token);
        if (c.locked) revert FeedAlreadyLocked(token);
        c.locked = true;
        emit FeedLocked(token, address(c.feed));
    }

    // ---------------------------------------------------------------- views

    function feedOf(address token) external view returns (FeedConfig memory) {
        return _feeds[token];
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    /// @notice Oldest `updatedAt` still accepted for `token` right now.
    function maxAge(address token) public view returns (uint256) {
        FeedConfig storage c = _feeds[token];
        return uint256(c.heartbeat) + uint256(c.tolerance);
    }

    /// @inheritdoc IPriceGate
    function check(address token) public view returns (Verdict memory v) {
        FeedConfig memory c = _feeds[token];
        v.session = CALENDAR.sessionAt(block.timestamp);
        if (address(c.feed) == address(0)) {
            v.state = GateState.UNKNOWN_TOKEN;
            return v;
        }

        // Coinbase OracleRegistry: a failed read is treated as paused (fail closed).
        (bool ok, bytes memory data) =
            address(REGISTRY).staticcall(abi.encodeCall(IOracleRegistry.getOracleParams, (token)));
        if (ok && data.length >= 64) {
            (v.multiplier, v.registryPaused) = abi.decode(data, (uint256, bool));
        } else {
            v.registryPaused = true;
        }

        // Token transfer pause: a failed read is treated as paused (fail closed).
        (ok, data) = token.staticcall(abi.encodeCall(IB20.isPaused, (IB20.PausableFeature.TRANSFER)));
        if (ok && data.length >= 32) {
            v.transferPaused = abi.decode(data, (bool));
        } else {
            v.transferPaused = true;
        }

        // Feed: a failed read is FEED_INVALID.
        bool feedOk;
        (feedOk, data) = address(c.feed).staticcall(abi.encodeCall(IAggregatorV3.latestRoundData, ()));
        if (feedOk && data.length >= 160) {
            (, v.answer,, v.updatedAt,) = abi.decode(data, (uint80, int256, uint256, uint256, uint80));
        } else {
            feedOk = false;
        }

        bool live = v.session == IMarketCalendar.Session.PRE || v.session == IMarketCalendar.Session.REGULAR
            || v.session == IMarketCalendar.Session.POST || v.session == IMarketCalendar.Session.OVERNIGHT;

        if (!live) {
            v.state = GateState.MARKET_CLOSED;
        } else if (v.registryPaused) {
            v.state = GateState.FEED_PAUSED;
        } else if (v.transferPaused) {
            v.state = GateState.TRANSFER_PAUSED;
        } else if (!feedOk || v.answer <= 0 || v.updatedAt == 0 || v.updatedAt > block.timestamp) {
            v.state = GateState.FEED_INVALID;
        } else if (block.timestamp - v.updatedAt > uint256(c.heartbeat) + uint256(c.tolerance)) {
            v.state = GateState.FEED_STALE;
        } else {
            v.state = GateState.OPEN;
        }
    }

    /// @inheritdoc IPriceGate
    function priceOf(address token) external view returns (uint256) {
        (uint256 price,) = priceAndSession(token);
        return price;
    }

    /// @notice 8-decimal USD price plus the session it was read in. Reverts by name when not OPEN.
    function priceAndSession(address token) public view returns (uint256 price, IMarketCalendar.Session session) {
        Verdict memory v = check(token);
        _requireOpen(token, v);
        FeedConfig storage c = _feeds[token];
        return (_scaleTo8(uint256(v.answer), c.feedDecimals), v.session);
    }

    // ---------------------------------------------------------------- internals

    function _requireOpen(address token, Verdict memory v) internal view {
        if (v.state == GateState.OPEN) return;
        if (v.state == GateState.MARKET_CLOSED) revert MarketClosed(v.session);
        if (v.state == GateState.FEED_PAUSED) revert FeedPaused(token);
        if (v.state == GateState.TRANSFER_PAUSED) revert TransferPaused(token);
        if (v.state == GateState.FEED_STALE) revert FeedStale(token, v.updatedAt, maxAge(token));
        if (v.state == GateState.FEED_INVALID) revert FeedInvalid(token, v.answer, v.updatedAt);
        revert UnknownToken(token);
    }

    function _scaleTo8(uint256 answer, uint8 decimals) internal pure returns (uint256) {
        if (decimals == PRICE_DECIMALS) return answer;
        if (decimals > PRICE_DECIMALS) return answer / (10 ** (decimals - PRICE_DECIMALS));
        return answer * (10 ** (PRICE_DECIMALS - decimals));
    }
}
