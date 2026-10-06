// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

// Vendored from morpho-org/pre-liquidation (commit 6f15d20, 8 Sep 2026); only the morpho-blue import path changed.
import {Id, IMorpho} from "morpho-blue/interfaces/IMorpho.sol";
import {IPreLiquidation, PreLiquidationParams} from "./IPreLiquidation.sol";

interface IPreLiquidationFactory {
    function MORPHO() external view returns (IMorpho);

    function isPreLiquidation(address) external returns (bool);

    function createPreLiquidation(Id id, PreLiquidationParams calldata preLiquidationParams)
        external
        returns (IPreLiquidation preLiquidation);
}
