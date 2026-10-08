// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IMorpho} from "morpho-blue/interfaces/IMorpho.sol";
import {IPriceGate} from "../src/interfaces/IPriceGate.sol";
import {CreditDesk} from "../src/desk/CreditDesk.sol";
import {ICLSwapPool} from "../src/protection/interfaces/ICLSwapPool.sol";
import {DividendHarvester} from "../src/harvest/DividendHarvester.sol";

/// @notice Deploys the DividendHarvester (the self-repaying leg) for one network: bound to the SessionGate whose
///         registry multiplier the feed composes with, optionally to a CreditDesk (desk lines repay through
///         `desk.repay`), with one sale route per collateral. On mainnet `DeployMainnet` does this as phase 8.
///
///   Base Sepolia (dry run, no key):
///   GATE=0x92f59437d4ef5CDcEAe2CcDE89B03A7B4B1Ae427 DESK=0x39aBaDc0aAa12D1F7e259b89536Aa1848997399a \
///   KEEPER=<keeper> ROUTE_TOKENS=0xB2000000000000000000000E063E65377cA34141 \
///   ROUTE_POOLS=0x5069f3753961efcaea8c7f6ec49a182e2c40081b \
///     forge script script/DeployHarvest.s.sol --tc DeployHarvest --rpc-url base_sepolia --sender <deployer>
///
/// Add `--broadcast --verify --slow --private-key "$KEY"` to send it. On Base Sepolia the test stocks' Cobalt
/// receiver allowlists must then admit the harvester (it receives the dividend collateral from Morpho before
/// selling it), exactly as the Protector was admitted on 6 Oct: see the follow-up the script prints.
///
/// | Env | Default |
/// | --- | --- |
/// | `GATE` | required |
/// | `DESK` | none (plain Morpho positions only) |
/// | `KEEPER` | the broadcaster |
/// | `ROUTE_TOKENS`, `ROUTE_POOLS` | comma lists of equal length; none |
/// | `MAX_STEP_BPS`, `MAX_SLIPPAGE_BPS` | the contract's defaults (500, 100) |
/// | `MORPHO` | `0xBBBB…FFCb` |
contract DeployHarvest is Script {
    address public constant MORPHO_DEFAULT = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    error MissingEnv(string name);
    error RouteLengths(uint256 tokens, uint256 pools);

    function run() external returns (DividendHarvester harvester) {
        address gate = vm.envOr("GATE", address(0));
        if (gate == address(0)) revert MissingEnv("GATE");
        address desk = vm.envOr("DESK", address(0));
        address[] memory none = new address[](0);
        address[] memory tokens = vm.envOr("ROUTE_TOKENS", ",", none);
        address[] memory pools = vm.envOr("ROUTE_POOLS", ",", none);
        if (tokens.length != pools.length) revert RouteLengths(tokens.length, pools.length);
        uint256 maxStep = vm.envOr("MAX_STEP_BPS", uint256(0));
        uint256 maxSlippage = vm.envOr("MAX_SLIPPAGE_BPS", uint256(0));

        vm.startBroadcast();
        address deployer = msg.sender;
        address keeper = vm.envOr("KEEPER", deployer);
        harvester = new DividendHarvester(
            deployer, IMorpho(vm.envOr("MORPHO", MORPHO_DEFAULT)), IPriceGate(gate), CreditDesk(desk), keeper
        );
        for (uint256 i = 0; i < tokens.length; ++i) {
            harvester.setRoute(tokens[i], ICLSwapPool(pools[i]));
        }
        if (maxStep != 0 || maxSlippage != 0) {
            harvester.setParams(
                uint16(maxStep == 0 ? harvester.maxStepBps() : maxStep),
                uint16(maxSlippage == 0 ? harvester.maxSlippageBps() : maxSlippage)
            );
        }
        vm.stopBroadcast();

        console.log("{");
        console.log('  "chainId": %s,', block.chainid);
        console.log('  "dividendHarvester": "%s",', address(harvester));
        console.log('  "owner": "%s", "keeper": "%s",', deployer, keeper);
        console.log('  "gate": "%s", "desk": "%s",', gate, desk);
        console.log(
            '  "maxStepBps": %s, "maxSlippageBps": %s,',
            uint256(harvester.maxStepBps()),
            uint256(harvester.maxSlippageBps())
        );
        console.log('  "routes": %s', tokens.length);
        console.log("}");
        if (block.chainid == 84_532) {
            console.log(
                "follow-up on Base Sepolia: admit the harvester to AAPLt's Cobalt receiver allowlist (policy admin)"
            );
            console.log(
                "  TOKEN=0xB2000000000000000000000E063E65377cA34141 ACCOUNTS=%s SENDER=<deployer> contracts/script/wire-protection-sepolia.sh",
                address(harvester)
            );
            console.log("  (check-only first; then the same with DEPLOYER_KEY to write)");
            console.log(
                "borrower opt-in, one batch: Morpho.setAuthorization(harvester, true); harvester.enroll(marketId, lineId, 1)"
            );
        }
    }
}
