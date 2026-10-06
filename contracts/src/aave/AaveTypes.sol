// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMarketCalendar} from "../interfaces/IMarketCalendar.sol";
import {IEligibility} from "../interfaces/IEligibility.sol";

/// @title AaveTypes
/// @notice The record shapes shared by `AaveDesk`, `AaveDeskLib` and `ProtectionVault`. The first
///         twenty `Reason` values and the first eight `ObligationStatus` values are the CreditDesk's,
///         in the same order, so one name table serves both venues; the Aave-only values follow.
library AaveTypes {
    enum LineStatus {
        NONE,
        OPEN,
        HELD, // keeper hold
        CLOSED
    }

    enum ObligationStatus {
        NONE,
        OPEN,
        HOLD_SESSION,
        HOLD_FEED,
        HOLD_ISSUER,
        HOLD_TRANSFER,
        HOLD_KEEPER,
        CLOSED,
        HOLD_VENUE // the Aave reserve is paused or frozen (the venue's own halt switch)
    }

    enum Reason {
        NONE,
        DESK_PAUSED,
        LINE_NOT_OPEN,
        LINE_HELD,
        PARTNER_INACTIVE,
        MARKET_DISABLED, // the collateral reserve is disabled on this desk, or USDC is not borrowable
        MARKET_CLOSED,
        FEED_PAUSED,
        TRANSFER_PAUSED,
        FEED_STALE,
        FEED_INVALID,
        UNKNOWN_TOKEN,
        TICKER_NOT_ALLOWED,
        NOT_ELIGIBLE,
        BELOW_MIN_DRAW,
        ABOVE_MAX_DRAW,
        PARTNER_CAP,
        TICKER_CAP,
        INSUFFICIENT_CAPACITY,
        NOT_AUTHORIZED_ON_VENUE, // Taker not approved on the spoke, or no borrow allowance for the desk
        VENUE_PAUSED, // Aave reserve paused
        VENUE_FROZEN, // Aave reserve frozen (no new activity)
        NO_COLLATERAL, // nothing supplied on the line's reserve
        COLLATERAL_DISABLED, // supplied but not enabled as collateral on the spoke
        VENUE_UNHEALTHY // the venue's own health factor is already at or below 1
    }

    struct Partner {
        address admin;
        address signer; // signs LineAuthorization; zero means open access
        IEligibility eligibility; // optional hook
        bool active;
        uint32 policyVersion;
        uint128 exposureCap; // USDC units across all the partner's lines
        uint128 exposure; // outstanding drawn principal
    }

    /// @dev Per partner, per collateral reserve.
    struct ReservePolicy {
        bool allowed;
        uint64 maxLtvWad; // strictly below the reserve's collateral factor; clamped to it at quote time
        uint128 minDraw;
        uint128 maxDraw;
        uint128 exposureCap;
        uint128 exposure;
    }

    struct Line {
        bytes32 partnerId;
        address user;
        uint32 reserveId; // the collateral reserve on the spoke
        address collateral; // its underlying B20 token
        uint32 policyVersion;
        LineStatus status;
        bytes32 holdReason;
        uint64 openedAt;
        uint128 drawnPrincipal;
    }

    struct Quote {
        Reason reason;
        IMarketCalendar.Session session;
        uint256 price8; // 8-decimal USD price of one whole collateral token from the gate, 0 when refused
        uint256 collateralRaw; // supplied assets on the reserve, token units
        uint256 collateralValue; // USDC units, after any corporate-action haircut
        uint256 debt; // the user's USDC debt on the spoke, interest accrued
        uint256 maxDebt; // policy: collateralValue x effectiveMaxLtv
        uint256 available; // min(policy headroom, the venue's own headroom)
        uint256 effectiveMaxLtvWad; // min(policy LTV, the reserve's collateral factor)
        bool corporateActionHaircut;
        uint256 venueHealthFactor; // Aave's health factor, WAD
        uint256 venueAvailable; // what Aave alone would let the user borrow now, USDC units
    }
}
