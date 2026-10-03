// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MarketCalendar} from "../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../src/calendar/Nyse2026.sol";

/// @notice Deploys MarketCalendar, loads the 2026 NYSE calendar, and hands ownership to
///         CALENDAR_OWNER (two-step: the new owner must call acceptOwnership).
///
///   dry run:  forge script script/DeployCalendar.s.sol
///   sepolia:  forge script script/DeployCalendar.s.sol --rpc-url base_sepolia --broadcast --verify
///
/// The broadcaster is the initial owner so `loadYear` can run in the same transaction batch.
contract DeployCalendar is Script {
    function run() external returns (MarketCalendar calendar) {
        address finalOwner = vm.envOr("CALENDAR_OWNER", msg.sender);

        vm.startBroadcast();
        address deployer = msg.sender;
        calendar = new MarketCalendar(deployer);
        calendar.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        if (finalOwner != deployer) calendar.transferOwnership(finalOwner);
        vm.stopBroadcast();

        console.log("MarketCalendar:", address(calendar));
        console.log("owner:", calendar.owner());
        if (finalOwner != deployer) {
            console.log("pending owner (must call acceptOwnership):", finalOwner);
        }
        console.log("2026 loaded:", calendar.isYearLoaded(2026));
    }
}
