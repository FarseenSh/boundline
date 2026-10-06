// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.27;

// Vendored from morpho-org/pre-liquidation (commit 6f15d20, 8 Sep 2026): pragma widened to `^0.8.27`, imports
// pointed at this repository's remappings. Logic unchanged. Deployed by Boundline on Base Sepolia, where Morpho's
// own factory does not exist; on Base mainnet the official factory 0x8cd16b62E170Ee0bA83D80e1F80E6085367e2aef is used.
import {IPreLiquidation, PreLiquidationParams} from "./interfaces/IPreLiquidation.sol";
import {IPreLiquidationFactory} from "./interfaces/IPreLiquidationFactory.sol";
import {IMorpho, Id} from "morpho-blue/interfaces/IMorpho.sol";

import {ErrorsLib} from "./libraries/ErrorsLib.sol";
import {EventsLib} from "./libraries/EventsLib.sol";

import {PreLiquidation} from "./PreLiquidation.sol";

/// @title PreLiquidationFactory
/// @author Morpho Labs
/// @custom:contact security@morpho.org
/// @notice A linear LIF and linear LCF pre-liquidation factory contract for Morpho.
contract PreLiquidationFactory is IPreLiquidationFactory {
    /* IMMUTABLE */

    /// @notice The address of the Morpho contract.
    IMorpho public immutable MORPHO;

    /* STORAGE */

    /// @notice Mapping which returns true if the address is a PreLiquidation contract created by this factory.
    mapping(address => bool) public isPreLiquidation;

    /* CONSTRUCTOR */

    /// @param morpho The address of the Morpho contract.
    constructor(address morpho) {
        require(morpho != address(0), ErrorsLib.ZeroAddress());

        MORPHO = IMorpho(morpho);
    }

    /* EXTERNAL */

    /// @notice Creates a PreLiquidation contract.
    /// @param id The Morpho market for PreLiquidations.
    /// @param preLiquidationParams The PreLiquidation params for the PreLiquidation contract.
    /// @dev Warning: This function will revert without data if the pre-liquidation already exists.
    function createPreLiquidation(Id id, PreLiquidationParams calldata preLiquidationParams)
        external
        returns (IPreLiquidation)
    {
        IPreLiquidation preLiquidation =
            IPreLiquidation(address(new PreLiquidation{salt: 0}(address(MORPHO), id, preLiquidationParams)));

        emit EventsLib.CreatePreLiquidation(address(preLiquidation), id, preLiquidationParams);

        isPreLiquidation[address(preLiquidation)] = true;

        return preLiquidation;
    }
}
