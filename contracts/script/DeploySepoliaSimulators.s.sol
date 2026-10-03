// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MirrorOracleRegistry} from "../src/test/MirrorOracleRegistry.sol";
import {TestPriceFeed} from "../src/test/TestPriceFeed.sol";

/// @notice Deploys the Base Sepolia simulators: one MirrorOracleRegistry and one 8-decimal
///         TestPriceFeed per test stock symbol. Prints a JSON block of addresses.
///
///   env  TEST_STOCK_SYMBOLS  comma-separated symbols, default "AAPLt,NVDAt,TSLAt"
///   env  TEST_STOCK_ANSWERS  comma-separated int256 answers (8 decimals), default 100e8 each
///   env  SIMULATOR_OWNER     owner of every simulator, default the broadcaster
///
///   dry run:  forge script script/DeploySepoliaSimulators.s.sol
///   sepolia:  forge script script/DeploySepoliaSimulators.s.sol --rpc-url base_sepolia --broadcast --verify
contract DeploySepoliaSimulators is Script {
    int256 internal constant DEFAULT_ANSWER = 100e8;

    function run() external returns (MirrorOracleRegistry registry, TestPriceFeed[] memory feeds) {
        string[] memory defaultSymbols = new string[](3);
        defaultSymbols[0] = "AAPLt";
        defaultSymbols[1] = "NVDAt";
        defaultSymbols[2] = "TSLAt";
        string[] memory symbols = vm.envOr("TEST_STOCK_SYMBOLS", ",", defaultSymbols);
        int256[] memory answers = vm.envOr("TEST_STOCK_ANSWERS", ",", new int256[](0));
        address finalOwner = vm.envOr("SIMULATOR_OWNER", msg.sender);

        vm.startBroadcast();
        address deployer = msg.sender;
        registry = new MirrorOracleRegistry(deployer);
        feeds = new TestPriceFeed[](symbols.length);
        for (uint256 i = 0; i < symbols.length; ++i) {
            int256 answer = i < answers.length ? answers[i] : DEFAULT_ANSWER;
            feeds[i] = new TestPriceFeed(deployer, 8, string.concat("Boundline test feed ", symbols[i]), answer);
            if (finalOwner != deployer) feeds[i].transferOwnership(finalOwner);
        }
        if (finalOwner != deployer) registry.transferOwnership(finalOwner);
        vm.stopBroadcast();

        console.log("{");
        console.log('  "chainId": %s,', block.chainid);
        console.log('  "owner": "%s",', finalOwner);
        console.log('  "mirrorOracleRegistry": "%s",', address(registry));
        console.log('  "feeds": {');
        for (uint256 i = 0; i < symbols.length; ++i) {
            console.log('    "%s": "%s"%s', symbols[i], address(feeds[i]), i + 1 < symbols.length ? "," : "");
        }
        console.log("  }");
        console.log("}");
    }
}
