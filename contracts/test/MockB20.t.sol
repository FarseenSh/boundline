// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {MockB20} from "../src/test/MockB20.sol";

contract MockB20Test is Test {
    MockB20 internal token;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new MockB20("Test Apple", "AAPLt", 8);
        token.mint(alice, 10e8);
    }

    function test_metadataAndMint() public view {
        assertEq(token.name(), "Test Apple");
        assertEq(token.symbol(), "AAPLt");
        assertEq(token.decimals(), 8);
        assertEq(token.totalSupply(), 10e8);
        assertEq(token.balanceOf(alice), 10e8);
    }

    function test_transferAndTransferFrom() public {
        vm.prank(alice);
        assertTrue(token.transfer(bob, 3e8));
        assertEq(token.balanceOf(bob), 3e8);

        vm.prank(alice);
        token.approve(bob, 2e8);
        vm.prank(bob);
        assertTrue(token.transferFrom(alice, bob, 2e8));
        assertEq(token.balanceOf(alice), 5e8);
        assertEq(token.allowance(alice, bob), 0);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MockB20.InsufficientAllowance.selector, bob, 0, 1));
        token.transferFrom(alice, bob, 1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockB20.InsufficientBalance.selector, alice, 5e8, 6e8));
        token.transfer(bob, 6e8);
    }

    function test_transferPauseBlocksBothPaths() public {
        token.setPaused(IB20.PausableFeature.TRANSFER, true);
        assertTrue(token.isPaused(IB20.PausableFeature.TRANSFER));
        assertFalse(token.isPaused(IB20.PausableFeature.MINT));

        vm.prank(alice);
        vm.expectRevert(MockB20.TransferPaused.selector);
        token.transfer(bob, 1);

        vm.prank(alice);
        token.approve(bob, 1);
        vm.prank(bob);
        vm.expectRevert(MockB20.TransferPaused.selector);
        token.transferFrom(alice, bob, 1);

        token.setPaused(IB20.PausableFeature.TRANSFER, false);
        vm.prank(alice);
        assertTrue(token.transfer(bob, 1));
    }

    function test_pausedFeaturesList() public {
        assertEq(token.pausedFeatures().length, 0);
        token.setPaused(IB20.PausableFeature.SEIZE, true);
        token.setPaused(IB20.PausableFeature.MINT, true);
        IB20.PausableFeature[] memory features = token.pausedFeatures();
        assertEq(features.length, 2);
        assertEq(uint8(features[0]), uint8(IB20.PausableFeature.MINT));
        assertEq(uint8(features[1]), uint8(IB20.PausableFeature.SEIZE));
    }

    function test_multiplierSurface() public {
        assertEq(token.uiMultiplier(), 1e18);
        assertEq(token.newUIMultiplier(), 1e18);
        assertEq(token.effectiveAt(), 0);
        token.setUIMultiplier(1e18, 2e18, block.timestamp + 1 days);
        assertEq(token.uiMultiplier(), 1e18);
        assertEq(token.newUIMultiplier(), 2e18);
        assertEq(token.effectiveAt(), block.timestamp + 1 days);
    }
}
