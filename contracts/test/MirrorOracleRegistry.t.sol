// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MirrorOracleRegistry} from "../src/test/MirrorOracleRegistry.sol";

contract MirrorOracleRegistryTest is Test {
    MirrorOracleRegistry internal registry;
    address internal owner = makeAddr("owner");
    address internal token = makeAddr("AAPLt");

    event OraclePausedSet(address indexed token, bool paused);
    event MultiplierSet(address indexed token, uint256 multiplier);

    function setUp() public {
        registry = new MirrorOracleRegistry(owner);
    }

    function test_default_unpausedAtOne() public view {
        (uint256 multiplier, bool paused) = registry.getOracleParams(token);
        assertEq(multiplier, 1e18);
        assertFalse(paused);
        assertFalse(registry.isConfigured(token));
    }

    function test_setOracleParams() public {
        vm.expectEmit(true, false, false, true);
        emit MultiplierSet(token, 2e18);
        vm.expectEmit(true, false, false, true);
        emit OraclePausedSet(token, true);
        vm.prank(owner);
        registry.setOracleParams(token, 2e18, true);
        (uint256 multiplier, bool paused) = registry.getOracleParams(token);
        assertEq(multiplier, 2e18);
        assertTrue(paused);
        assertTrue(registry.isConfigured(token));
    }

    function test_setPaused_keepsDefaultMultiplier() public {
        vm.prank(owner);
        registry.setPaused(token, true);
        (uint256 multiplier, bool paused) = registry.getOracleParams(token);
        assertEq(multiplier, 1e18);
        assertTrue(paused);
        assertTrue(registry.isConfigured(token));

        vm.prank(owner);
        registry.setPaused(token, false);
        (, paused) = registry.getOracleParams(token);
        assertFalse(paused);
    }

    function test_setMultiplier_keepsPauseFlag() public {
        vm.startPrank(owner);
        registry.setPaused(token, true);
        registry.setMultiplier(token, 1_000_377_000_000_000_000);
        vm.stopPrank();
        (uint256 multiplier, bool paused) = registry.getOracleParams(token);
        assertEq(multiplier, 1_000_377_000_000_000_000);
        assertTrue(paused);
    }

    function test_onlyOwner() public {
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.setOracleParams(token, 1, false);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.setPaused(token, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.setMultiplier(token, 1);
        vm.stopPrank();
    }
}
