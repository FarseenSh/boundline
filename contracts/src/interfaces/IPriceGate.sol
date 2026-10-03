// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMarketCalendar} from "./IMarketCalendar.sol";

/// @title IPriceGate
/// @notice The session-aware price gate every Boundline component reads: a price is
///         returned only while the market is open, the feed is fresh, the Coinbase
///         OracleRegistry has not paused the token and the token itself is not
///         transfer-paused. Everything else is a named refusal, never a held number.
interface IPriceGate {
    enum GateState {
        OPEN, // a price is safe to use
        MARKET_CLOSED, // calendar says WEEKEND, HOLIDAY or UNKNOWN
        FEED_PAUSED, // OracleRegistry.getOracleParams(token).paused
        TRANSFER_PAUSED, // B20 isPaused(TRANSFER)
        FEED_STALE, // updatedAt older than heartbeat + tolerance
        FEED_INVALID, // answer <= 0 or updatedAt in the future
        UNKNOWN_TOKEN // token has no feed configured on this gate
    }

    struct Verdict {
        GateState state;
        IMarketCalendar.Session session;
        int256 answer; // raw feed answer (8 decimals for Coinbase feeds), 0 when no feed
        uint256 updatedAt; // feed updatedAt, 0 when no feed
        uint256 multiplier; // OracleRegistry multiplier (1e18 scale), 0 when unknown
        bool registryPaused;
        bool transferPaused;
    }

    /// @notice Full verdict for `token`. Never reverts.
    function check(address token) external view returns (Verdict memory);

    /// @notice Price of one whole token in USD with 8 decimals. Reverts with the
    ///         GateState name when not OPEN.
    function priceOf(address token) external view returns (uint256);
}
