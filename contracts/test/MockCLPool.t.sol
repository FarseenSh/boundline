// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockCLPool} from "../src/test/MockCLPool.sol";

contract MockCLPoolTest is Test {
    MockCLPool internal pool;
    address internal usdc = makeAddr("USDC");
    address internal aapl = makeAddr("AAPLc");

    function setUp() public {
        pool = new MockCLPool(usdc, aapl, 10);
    }

    function test_immutablesAndSlot0() public {
        assertEq(pool.token0(), usdc);
        assertEq(pool.token1(), aapl);
        assertEq(pool.tickSpacing(), 10);

        pool.setSlot0(43_382_422_884_745_101_848_021_795_540, -12_047);
        pool.setObservationCardinality(2048);
        pool.setLiquidity(476_209_392_808_947);
        (uint160 sqrtPriceX96, int24 tick, uint16 index, uint16 cardinality, uint16 cardinalityNext, bool unlocked) =
            pool.slot0();
        assertEq(sqrtPriceX96, 43_382_422_884_745_101_848_021_795_540);
        assertEq(tick, -12_047);
        assertEq(index, 0);
        assertEq(cardinality, 2048);
        assertEq(cardinalityNext, 2048);
        assertTrue(unlocked);
        assertEq(pool.liquidity(), 476_209_392_808_947);
    }

    function test_observe_returnsCumulativesInRequestOrder() public {
        pool.setCumulative(3600, -99_140_738_406);
        pool.setCumulative(0, -99_184_115_416);
        uint32[] memory ago = new uint32[](2);
        ago[0] = 3600;
        ago[1] = 0;
        (int56[] memory cumulatives, uint160[] memory perLiquidity) = pool.observe(ago);
        assertEq(cumulatives.length, 2);
        assertEq(cumulatives[0], -99_140_738_406);
        assertEq(cumulatives[1], -99_184_115_416);
        assertEq(perLiquidity.length, 2);
        assertEq(perLiquidity[0], 0);
        assertEq(perLiquidity[1], 0);
        // reversed request, reversed answer
        ago[0] = 0;
        ago[1] = 3600;
        (cumulatives,) = pool.observe(ago);
        assertEq(cumulatives[0], -99_184_115_416);
        assertEq(cumulatives[1], -99_140_738_406);
    }

    function test_setAverageTick_scriptsAnExactWindow() public {
        pool.setAverageTick(3600, -12_049);
        uint32[] memory ago = new uint32[](2);
        ago[0] = 3600;
        ago[1] = 0;
        (int56[] memory cumulatives,) = pool.observe(ago);
        int56 delta = cumulatives[1] - cumulatives[0];
        assertEq(delta / int56(3600), -12_049);
        assertEq(delta % int56(3600), 0);
    }

    function test_observe_missingAndOld() public {
        uint32[] memory ago = new uint32[](1);
        ago[0] = 1800;
        vm.expectRevert(abi.encodeWithSelector(MockCLPool.MissingObservation.selector, 1800));
        pool.observe(ago);

        pool.setAverageTick(1800, 5);
        pool.setObserveReverts(true);
        vm.expectRevert(MockCLPool.OLD.selector);
        pool.observe(ago);
        pool.setObserveReverts(false);
        (int56[] memory cumulatives,) = pool.observe(ago);
        assertEq(cumulatives[0], 0);
    }
}
