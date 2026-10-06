// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

// Vendored unchanged from morpho-org/pre-liquidation (commit 6f15d20, 8 Sep 2026).

/// @title ErrorsLib
/// @author Morpho Labs
/// @custom:contact security@morpho.org
/// @notice Library exposing errors.
library ErrorsLib {
    /* PRELIQUIDATION ERRORS */

    error PreLltvTooHigh();

    error PreLCFDecreasing();

    error PreLCFTooHigh();

    error PreLIFTooLow();

    error PreLIFDecreasing();

    error PreLIFTooHigh();

    error InconsistentInput();

    error NotPreLiquidatablePosition();

    error LiquidatablePosition();

    error PreLiquidationTooLarge(uint256 repaidShares, uint256 repayableShares);

    error NotMorpho();

    error NonexistentMarket();

    /* PRELIQUIDATION FACTORY ERRORS */

    error ZeroAddress();
}
