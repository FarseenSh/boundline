// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMarketCalendar} from "../../src/interfaces/IMarketCalendar.sol";
import {IPriceGate} from "../../src/interfaces/IPriceGate.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {TestPriceFeed} from "../../src/test/TestPriceFeed.sol";
import {MirrorOracleRegistry} from "../../src/test/MirrorOracleRegistry.sol";
import {MockB20} from "../../src/test/MockB20.sol";
import {MockStable} from "../../src/test/MockStable.sol";
import {MockSwapPool} from "../../src/test/MockSwapPool.sol";
import {MockV2Pool} from "../../src/test/MockV2Pool.sol";
import {IUniswapV3SwapCallback} from "../../src/protection/interfaces/ICLSwapPool.sol";
import {LocalPayoutRouter} from "../../src/payout/LocalPayoutRouter.sol";

/// @dev A Slipstream-shaped pool that only fills half of an exact-input swap (price limit reached), so the
///      router's refund of the unspent input can be exercised.
contract HalfFillPool {
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable price36;

    constructor(address t0, address t1, uint256 p) {
        token0 = t0;
        token1 = t1;
        price36 = p;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(!zeroForOne && amountSpecified > 0, "test pool: token1 exact-in only");
        uint256 amountIn = uint256(amountSpecified) / 2;
        uint256 amountOut = amountIn * price36 / 1e36;
        IERC20(token0).transfer(recipient, amountOut);
        amount1 = int256(amountIn);
        amount0 = -int256(amountOut);
        uint256 before = IERC20(token1).balanceOf(address(this));
        IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(token1).balanceOf(address(this)) >= before + amountIn, "unpaid");
    }
}

contract LocalPayoutRouterTest is Test {
    uint256 constant T_REGULAR = 1_790_877_600; // Thu 2026-10-01 14:00 ET
    uint256 constant T_SAT = 1_791_024_480; // Sat 2026-10-03 06:48 ET
    int256 constant PRICE = 33_366_495_000; // $333.66495
    uint256 constant RATE36 = 0.92e36; // EURCt per USDC, token0 per token1 (both 6 decimals)
    uint256 constant V2_RATE18 = 1_086_956_521_739_130_434; // USDC per EURCt (1/0.92), token1 per token0

    address owner = makeAddr("owner");
    address user = makeAddr("user");
    address friend = makeAddr("friend");
    address stranger = makeAddr("stranger");

    MockB20 aapl;
    MockStable usdc;
    MockStable eurc;
    MarketCalendar cal;
    MirrorOracleRegistry registry;
    TestPriceFeed feed;
    SessionGate gate;
    MockSwapPool cl;
    MockV2Pool v2;
    LocalPayoutRouter router;

    function setUp() public {
        vm.warp(T_REGULAR);
        aapl = new MockB20("Coinbase Wrapped AAPL", "AAPLc", 8);
        usdc = new MockStable("USD Coin", "USDC", 6, owner);
        eurc = new MockStable("Boundline test EURC", "EURCt", 6, owner);
        cal = new MarketCalendar(owner);
        vm.prank(owner);
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        registry = new MirrorOracleRegistry(owner);
        feed = new TestPriceFeed(owner, 8, "Coinbase AAPL", PRICE);
        gate = new SessionGate(owner, cal, registry);
        vm.prank(owner);
        gate.setFeed(address(aapl), feed, 0, 0);

        // token0 = EURCt, token1 = USDC, as the mainnet EURC/USDC Slipstream pool is laid out.
        cl = new MockSwapPool(address(eurc), address(usdc), 50, owner);
        vm.prank(owner);
        cl.setPrice36(RATE36);
        v2 = new MockV2Pool(address(eurc), address(usdc), true, V2_RATE18, 5);
        router = new LocalPayoutRouter(gate);

        vm.startPrank(owner);
        eurc.mint(address(cl), 1_000_000e6);
        eurc.mint(address(v2), 1_000_000e6);
        usdc.mint(user, 1000e6);
        vm.stopPrank();
        v2.sync();
        vm.prank(user);
        usdc.approve(address(router), type(uint256).max);
    }

    function _params(LocalPayoutRouter.PoolKind kind, address pool, uint256 amountIn, uint256 minOut, address gateToken)
        internal
        view
        returns (LocalPayoutRouter.PayoutParams memory)
    {
        return LocalPayoutRouter.PayoutParams({
            kind: kind,
            pool: pool,
            tokenIn: address(usdc),
            tokenOut: address(eurc),
            amountIn: amountIn,
            minOut: minOut,
            to: user,
            deadline: block.timestamp + 600,
            gateToken: gateToken
        });
    }

    // ------------------------------------------------------------ happy paths

    function test_clPayoutInSession() public {
        LocalPayoutRouter.PayoutParams memory p =
            _params(LocalPayoutRouter.PoolKind.CL, address(cl), 10e6, 9.2e6, address(aapl));
        vm.expectEmit(true, true, true, true, address(router));
        emit LocalPayoutRouter.Payout(user, user, address(usdc), address(eurc), 10e6, 9.2e6, address(cl));
        vm.prank(user);
        uint256 out = router.payout(p);
        assertEq(out, 9.2e6, "0.92 EURCt per USDC");
        assertEq(eurc.balanceOf(user), 9.2e6);
        assertEq(usdc.balanceOf(user), 990e6);
        assertEq(usdc.balanceOf(address(router)), 0, "router holds nothing");
        assertEq(eurc.balanceOf(address(router)), 0);
        assertEq(router.payoutCount(user), 1);
        LocalPayoutRouter.Record memory r = router.payoutAt(user, 0);
        assertEq(r.at, uint64(block.timestamp));
        assertEq(r.tokenIn, address(usdc));
        assertEq(r.tokenOut, address(eurc));
        assertEq(r.amountIn, 10e6);
        assertEq(r.amountOut, 9.2e6);
        assertEq(r.pool, address(cl));
        assertEq(r.to, user);
    }

    function test_clPayoutToAnotherReceiverWithoutGateCheck() public {
        LocalPayoutRouter.PayoutParams memory p =
            _params(LocalPayoutRouter.PoolKind.CL, address(cl), 3e6, 2.76e6, address(0));
        p.to = friend;
        vm.warp(T_SAT); // no gate token: the session is not consulted
        p.deadline = block.timestamp + 1;
        vm.prank(user);
        uint256 out = router.payout(p);
        assertEq(out, 2.76e6);
        assertEq(eurc.balanceOf(friend), 2.76e6);
        assertEq(router.payoutAt(user, 0).to, friend);
    }

    function test_v2Payout() public {
        // 10 USDC less 5 bps = 9.995 USDC → 9.1954 EURCt at 0.92
        uint256 expected = v2.getAmountOut(10e6, address(usdc));
        assertEq(expected, 9_195_400);
        assertEq(router.quoteV2(address(v2), address(usdc), 10e6), expected);
        LocalPayoutRouter.PayoutParams memory p =
            _params(LocalPayoutRouter.PoolKind.V2, address(v2), 10e6, expected, address(aapl));
        vm.prank(user);
        uint256 out = router.payout(p);
        assertEq(out, expected);
        assertEq(eurc.balanceOf(user), expected);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(address(v2)), 10e6);
    }

    function test_partialFillRefundsTheRest() public {
        HalfFillPool half = new HalfFillPool(address(eurc), address(usdc), RATE36);
        vm.prank(owner);
        eurc.mint(address(half), 100e6);
        LocalPayoutRouter.PayoutParams memory p =
            _params(LocalPayoutRouter.PoolKind.CL, address(half), 10e6, 4.6e6, address(aapl));
        vm.prank(user);
        uint256 out = router.payout(p);
        assertEq(out, 4.6e6, "half the input was swapped");
        assertEq(usdc.balanceOf(user), 995e6, "the unfilled half came back");
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(router.payoutAt(user, 0).amountIn, 5e6, "the record keeps what was spent");
    }

    function test_payoutsPagination() public {
        for (uint256 i = 1; i <= 5; i++) {
            vm.prank(user);
            router.payout(_params(LocalPayoutRouter.PoolKind.CL, address(cl), i * 1e6, 0, address(0)));
        }
        LocalPayoutRouter.Record[] memory page = router.payouts(user, 1, 3);
        assertEq(page.length, 3);
        assertEq(page[0].amountIn, 2e6);
        assertEq(page[2].amountIn, 4e6);
        assertEq(router.payouts(user, 4, 10).length, 1);
        assertEq(router.payouts(user, 5, 10).length, 0);
        assertEq(router.payouts(stranger, 0, 10).length, 0);
    }

    function testFuzz_fixedRateCL(uint256 amountIn) public {
        amountIn = bound(amountIn, 1, 500e6);
        uint256 expected = amountIn * RATE36 / 1e36;
        LocalPayoutRouter.PayoutParams memory p =
            _params(LocalPayoutRouter.PoolKind.CL, address(cl), amountIn, expected, address(aapl));
        vm.prank(user);
        assertEq(router.payout(p), expected);
        p.minOut = expected + 1;
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LocalPayoutRouter.SlippageExceeded.selector, expected, expected + 1));
        router.payout(p);
    }

    // ------------------------------------------------------------ refusals

    function test_refusesAfterDeadline() public {
        LocalPayoutRouter.PayoutParams memory p =
            _params(LocalPayoutRouter.PoolKind.CL, address(cl), 1e6, 0, address(0));
        p.deadline = block.timestamp - 1;
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LocalPayoutRouter.Expired.selector, block.timestamp - 1));
        router.payout(p);
    }

    function test_refusesWhileTheMarketIsClosed() public {
        vm.warp(T_SAT);
        LocalPayoutRouter.PayoutParams memory p =
            _params(LocalPayoutRouter.PoolKind.CL, address(cl), 1e6, 0, address(aapl));
        assertEq(uint256(gate.check(address(aapl)).state), uint256(IPriceGate.GateState.MARKET_CLOSED));
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(LocalPayoutRouter.SessionClosed.selector, IPriceGate.GateState.MARKET_CLOSED)
        );
        router.payout(p);
        assertEq(usdc.balanceOf(user), 1000e6, "nothing moved");
    }

    function test_refusesWhileTheFeedIsStale() public {
        vm.warp(T_REGULAR + 2 days); // Sat 3 Oct 14:00 ET is closed; use Mon 5 Oct 14:00 ET instead
        vm.warp(1_791_223_200); // Mon 2026-10-05 14:00 ET, regular session, feed untouched since 1 Oct
        LocalPayoutRouter.PayoutParams memory p =
            _params(LocalPayoutRouter.PoolKind.CL, address(cl), 1e6, 0, address(aapl));
        IPriceGate.Verdict memory v = gate.check(address(aapl));
        assertEq(uint256(v.state), uint256(IPriceGate.GateState.FEED_STALE));
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(LocalPayoutRouter.SessionClosed.selector, IPriceGate.GateState.FEED_STALE)
        );
        router.payout(p);
    }

    function test_refusesAnUnknownGateToken() public {
        LocalPayoutRouter.PayoutParams memory p =
            _params(LocalPayoutRouter.PoolKind.CL, address(cl), 1e6, 0, address(usdc));
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(LocalPayoutRouter.SessionClosed.selector, IPriceGate.GateState.UNKNOWN_TOKEN)
        );
        router.payout(p);
    }

    function test_refusesSlippage() public {
        LocalPayoutRouter.PayoutParams memory p =
            _params(LocalPayoutRouter.PoolKind.CL, address(cl), 10e6, 9.3e6, address(aapl));
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LocalPayoutRouter.SlippageExceeded.selector, 9.2e6, 9.3e6));
        router.payout(p);
    }

    function test_refusesAPoolThatDoesNotHoldThePair() public {
        LocalPayoutRouter.PayoutParams memory p =
            _params(LocalPayoutRouter.PoolKind.CL, address(cl), 1e6, 0, address(0));
        p.tokenOut = address(aapl);
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(LocalPayoutRouter.PoolMismatch.selector, address(cl), address(usdc), address(aapl))
        );
        router.payout(p);
        p = _params(LocalPayoutRouter.PoolKind.V2, address(v2), 1e6, 0, address(0));
        p.tokenIn = address(aapl);
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(LocalPayoutRouter.PoolMismatch.selector, address(v2), address(aapl), address(eurc))
        );
        router.payout(p);
    }

    function test_refusesZeroes() public {
        LocalPayoutRouter.PayoutParams memory p = _params(LocalPayoutRouter.PoolKind.CL, address(cl), 0, 0, address(0));
        vm.prank(user);
        vm.expectRevert(LocalPayoutRouter.ZeroAmount.selector);
        router.payout(p);
        p = _params(LocalPayoutRouter.PoolKind.CL, address(cl), 1e6, 0, address(0));
        p.to = address(0);
        vm.prank(user);
        vm.expectRevert(LocalPayoutRouter.ZeroAddress.selector);
        router.payout(p);
        vm.expectRevert(LocalPayoutRouter.ZeroAddress.selector);
        new LocalPayoutRouter(IPriceGate(address(0)));
    }

    function test_refusesACallbackOutsideASwap() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(LocalPayoutRouter.UnexpectedCallback.selector, stranger));
        router.uniswapV3SwapCallback(1, -1, abi.encode(true));
    }

    function test_refusesWithoutAllowance() public {
        LocalPayoutRouter.PayoutParams memory p =
            _params(LocalPayoutRouter.PoolKind.CL, address(cl), 1e6, 0, address(0));
        vm.prank(stranger);
        vm.expectRevert();
        router.payout(p);
    }
}
