// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {IMarketCalendar} from "../interfaces/IMarketCalendar.sol";
import {IPriceGate} from "../interfaces/IPriceGate.sol";
import {SessionGate} from "./SessionGate.sol";

/// @title SessionGuard
/// @notice Morpho Blue market oracle for one tokenized stock. Returns the fresh Chainlink price
///         while Wall Street is open and reverts by name otherwise, so on a market that uses it
///         `borrow`, `withdrawCollateral` and `liquidate` fail while the feed is held and
///         `repay` and `supplyCollateral` (which never call the oracle) keep working.
///
///         The promise a partner can print: no draws and no liquidations while the market is
///         closed; repay and add collateral at any hour.
///
/// @dev Immutable. One instance per (collateral, loan token) pair. `price()` is scaled the way
///      Morpho expects: the price of 10**collateralDecimals collateral in 10**loanDecimals loan
///      units with 36 decimals, so $100 for an 8-decimal stock against 6-decimal USDC is 1e36.
contract SessionGuard is IOracle {
    SessionGate public immutable GATE;
    address public immutable COLLATERAL;
    address public immutable LOAN_TOKEN;
    /// @dev Multiplies an 8-decimal USD price into Morpho's 36-decimal scale.
    uint256 public immutable SCALE;
    /// @notice Optional haircut applied outside REGULAR hours (PRE, POST, OVERNIGHT), in bps.
    uint16 public immutable EXTENDED_HAIRCUT_BPS;

    uint16 public constant MAX_HAIRCUT_BPS = 2000;

    error HaircutTooLarge(uint16 bps);
    error ScaleUnderflow();
    error ZeroAddress();

    constructor(
        SessionGate gate,
        address collateral,
        uint8 collateralDecimals,
        address loanToken,
        uint8 loanDecimals,
        uint16 extendedHaircutBps
    ) {
        if (address(gate) == address(0) || collateral == address(0) || loanToken == address(0)) {
            revert ZeroAddress();
        }
        if (extendedHaircutBps > MAX_HAIRCUT_BPS) revert HaircutTooLarge(extendedHaircutBps);
        // price36 = usd8 * 10**(36 + loanDecimals - 8 - collateralDecimals)
        if (36 + uint256(loanDecimals) < 8 + uint256(collateralDecimals)) revert ScaleUnderflow();
        GATE = gate;
        COLLATERAL = collateral;
        LOAN_TOKEN = loanToken;
        SCALE = 10 ** (36 + uint256(loanDecimals) - 8 - uint256(collateralDecimals));
        EXTENDED_HAIRCUT_BPS = extendedHaircutBps;
    }

    /// @inheritdoc IOracle
    function price() external view returns (uint256) {
        (uint256 usd8, IMarketCalendar.Session session) = GATE.priceAndSession(COLLATERAL);
        uint256 p = usd8 * SCALE;
        if (EXTENDED_HAIRCUT_BPS != 0 && session != IMarketCalendar.Session.REGULAR) {
            p = (p * (10_000 - EXTENDED_HAIRCUT_BPS)) / 10_000;
        }
        return p;
    }

    /// @notice The gate's full verdict for this market's collateral. Never reverts.
    function verdict() external view returns (IPriceGate.Verdict memory) {
        return GATE.check(COLLATERAL);
    }
}
