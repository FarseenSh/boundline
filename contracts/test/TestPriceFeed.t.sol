// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TestPriceFeed} from "../src/test/TestPriceFeed.sol";

contract TestPriceFeedTest is Test {
    TestPriceFeed internal feed;
    address internal owner = makeAddr("owner");

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    function setUp() public {
        vm.warp(1_791_024_483); // Sat 3 Oct 2026 10:48:03 UTC
        feed = new TestPriceFeed(owner, 8, "Boundline test feed AAPLt", 33_366_495_000);
    }

    function test_constructor_setsRoundOne() public view {
        assertEq(feed.decimals(), 8);
        assertEq(feed.description(), "Boundline test feed AAPLt");
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            feed.latestRoundData();
        assertEq(roundId, 1);
        assertEq(answer, 33_366_495_000);
        assertEq(startedAt, block.timestamp);
        assertEq(updatedAt, block.timestamp);
        assertEq(answeredInRound, 1);
        assertEq(feed.owner(), owner);
    }

    function test_setAnswer_newRoundAtBlockTime() public {
        vm.warp(block.timestamp + 3600);
        vm.expectEmit(true, true, false, true);
        emit AnswerUpdated(340e8, 2, block.timestamp);
        vm.prank(owner);
        feed.setAnswer(340e8);
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
        assertEq(roundId, 2);
        assertEq(answer, 340e8);
        assertEq(updatedAt, block.timestamp);
        assertEq(answeredInRound, 2);
    }

    function test_setAnswerAt_backdatedAndFuture() public {
        uint256 friday = block.timestamp - 65_284;
        vm.prank(owner);
        feed.setAnswerAt(333e8, friday);
        (, int256 answer, uint256 startedAt, uint256 updatedAt,) = feed.latestRoundData();
        assertEq(answer, 333e8);
        assertEq(startedAt, friday);
        assertEq(updatedAt, friday);

        vm.prank(owner);
        feed.setAnswerAt(334e8, block.timestamp + 1 days);
        (,,, updatedAt,) = feed.latestRoundData();
        assertEq(updatedAt, block.timestamp + 1 days);
    }

    function test_setRoundData_raw() public {
        vm.prank(owner);
        feed.setRoundData(9, -1, 0, 0, 7);
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            feed.latestRoundData();
        assertEq(roundId, 9);
        assertEq(answer, -1);
        assertEq(startedAt, 0);
        assertEq(updatedAt, 0);
        assertEq(answeredInRound, 7);
    }

    function test_getRoundData_onlyLatest() public {
        (uint80 roundId, int256 answer,,,) = feed.getRoundData(1);
        assertEq(roundId, 1);
        assertEq(answer, 33_366_495_000);
        vm.expectRevert(TestPriceFeed.NoData.selector);
        feed.getRoundData(2);
    }

    function test_onlyOwner() public {
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        feed.setAnswer(1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        feed.setAnswerAt(1, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        feed.setRoundData(1, 1, 1, 1, 1);
        vm.stopPrank();
    }
}
