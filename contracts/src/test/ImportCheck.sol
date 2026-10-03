// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Compile-time check that every external dependency the plan names resolves
// through the remappings in foundry.toml. Not deployed.
import {IMorpho, IMorphoBase, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {IPreLiquidation} from "pre-liquidation/interfaces/IPreLiquidation.sol";
import {IPreLiquidationFactory} from "pre-liquidation/interfaces/IPreLiquidationFactory.sol";
import {IPreLiquidationCallback} from "pre-liquidation/interfaces/IPreLiquidationCallback.sol";
import {ISpoke} from "aave-v4/spoke/interfaces/ISpoke.sol";
import {ITakerPositionManager} from "aave-v4/position-manager/interfaces/ITakerPositionManager.sol";
import {IGiverPositionManager} from "aave-v4/position-manager/interfaces/IGiverPositionManager.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IB20Asset} from "base-std/interfaces/IB20Asset.sol";
import {IPolicyRegistry} from "base-std/interfaces/IPolicyRegistry.sol";
import {StdPrecompiles} from "base-std/StdPrecompiles.sol";
import {B20Constants} from "base-std/lib/B20Constants.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract ImportCheck {
    function morphoSelector() external pure returns (bytes4) {
        return IMorphoBase.createMarket.selector;
    }
}
