// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {IMarketCalendar} from "../src/interfaces/IMarketCalendar.sol";
import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {IPriceGate} from "../src/interfaces/IPriceGate.sol";
import {ICLPool} from "../src/interfaces/ICLPool.sol";
import {MarketCalendar} from "../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../src/calendar/Nyse2026.sol";
import {SessionGate} from "../src/oracle/SessionGate.sol";
import {SessionGuard} from "../src/oracle/SessionGuard.sol";
import {ShadowGuard} from "../src/oracle/ShadowGuard.sol";
import {TestPriceFeed} from "../src/test/TestPriceFeed.sol";
import {MirrorOracleRegistry} from "../src/test/MirrorOracleRegistry.sol";
import {MockB20} from "../src/test/MockB20.sol";
import {MockCLPool} from "../src/test/MockCLPool.sol";

/// Epochs are ET wall-clock instants in 2026 computed by Python's tz database.
contract SessionOraclesTest is Test {
    uint256 constant T_REGULAR = 1_790_877_600; // Thu 2026-10-01 14:00 ET
    uint256 constant T_PRE = 1_791_189_000; // Mon 2026-10-05 04:30 ET
    uint256 constant T_POST = 1_791_232_200; // Mon 2026-10-05 16:30 ET
    uint256 constant T_OVERNIGHT = 1_791_246_600; // Mon 2026-10-05 20:30 ET
    uint256 constant T_WEEKEND = 1_791_024_480; // Sat 2026-10-03 06:48 ET
    uint256 constant T_HOLIDAY = 1_788_796_800; // Mon 2026-09-07 12:00 ET, Labor Day

    int256 constant AAPL_ANSWER = 33_366_495_000; // $333.66495, the live AAPLc feed on 3 Oct 2026
    int24 constant AAPL_TICK = -12_049; // the live 1h average tick of the Aerodrome AAPLc/USDC pool
    uint256 constant AAPL_TWAP36 = 3_336_224_435_346_020_837_703_594_217_356_394_496; // 1e36 * 1.0001^12049, Python double

    address owner = makeAddr("owner");
    MarketCalendar cal;
    MirrorOracleRegistry registry;
    MockB20 aapl;
    MockB20 usdc;
    TestPriceFeed feed;
    SessionGate gate;
    SessionGuard guard;
    MockCLPool pool;
    ShadowGuard shadow;

    function setUp() public {
        cal = new MarketCalendar(owner);
        vm.prank(owner);
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        registry = new MirrorOracleRegistry(owner);
        aapl = new MockB20("Coinbase Wrapped AAPL", "AAPLc", 8);
        usdc = new MockB20("USD Coin", "USDC", 6);
        vm.warp(T_REGULAR);
        feed = new TestPriceFeed(owner, 8, "Coinbase AAPL", AAPL_ANSWER);
        gate = new SessionGate(owner, cal, registry);
        vm.prank(owner);
        gate.setFeed(address(aapl), feed, 0, 0);
        guard = new SessionGuard(gate, address(aapl), 8, address(usdc), 6, 0);
        pool = new MockCLPool(address(usdc), address(aapl), 10);
        pool.setAverageTick(3600, AAPL_TICK);
        shadow = new ShadowGuard(owner, gate, address(aapl), 8, address(usdc), 6, pool, 3600);
    }

    function _fresh() internal {
        vm.prank(owner);
        feed.setAnswer(AAPL_ANSWER);
    }

    // ============================================================ SessionGate

    function test_gate_openInRegularSession() public {
        _fresh();
        IPriceGate.Verdict memory v = gate.check(address(aapl));
        assertEq(uint256(v.state), uint256(IPriceGate.GateState.OPEN));
        assertEq(uint256(v.session), uint256(IMarketCalendar.Session.REGULAR));
        assertEq(v.answer, AAPL_ANSWER);
        assertEq(v.multiplier, 1e18);
        assertFalse(v.registryPaused);
        assertFalse(v.transferPaused);
        assertEq(gate.priceOf(address(aapl)), uint256(AAPL_ANSWER));
    }

    function test_gate_openInExtendedSessions() public {
        uint256[3] memory when = [T_PRE, T_POST, T_OVERNIGHT];
        IMarketCalendar.Session[3] memory want =
            [IMarketCalendar.Session.PRE, IMarketCalendar.Session.POST, IMarketCalendar.Session.OVERNIGHT];
        for (uint256 i = 0; i < 3; ++i) {
            vm.warp(when[i]);
            _fresh();
            (uint256 p, IMarketCalendar.Session s) = gate.priceAndSession(address(aapl));
            assertEq(p, uint256(AAPL_ANSWER));
            assertEq(uint256(s), uint256(want[i]));
        }
    }

    function test_gate_weekendIsMarketClosed() public {
        _fresh();
        vm.warp(T_WEEKEND);
        IPriceGate.Verdict memory v = gate.check(address(aapl));
        assertEq(uint256(v.state), uint256(IPriceGate.GateState.MARKET_CLOSED));
        assertEq(uint256(v.session), uint256(IMarketCalendar.Session.WEEKEND));
        assertEq(v.answer, AAPL_ANSWER, "the held answer is still reported");
        vm.expectRevert(abi.encodeWithSelector(SessionGate.MarketClosed.selector, IMarketCalendar.Session.WEEKEND));
        gate.priceOf(address(aapl));
    }

    function test_gate_holidayIsMarketClosed() public {
        vm.warp(T_HOLIDAY - 1 days);
        _fresh();
        vm.warp(T_HOLIDAY);
        vm.expectRevert(abi.encodeWithSelector(SessionGate.MarketClosed.selector, IMarketCalendar.Session.HOLIDAY));
        gate.priceOf(address(aapl));
    }

    function test_gate_registryPause() public {
        _fresh();
        vm.prank(owner);
        registry.setPaused(address(aapl), true);
        IPriceGate.Verdict memory v = gate.check(address(aapl));
        assertEq(uint256(v.state), uint256(IPriceGate.GateState.FEED_PAUSED));
        assertTrue(v.registryPaused);
        vm.expectRevert(abi.encodeWithSelector(SessionGate.FeedPaused.selector, address(aapl)));
        gate.priceOf(address(aapl));
    }

    function test_gate_transferPause() public {
        _fresh();
        aapl.setPaused(IB20.PausableFeature.TRANSFER, true);
        IPriceGate.Verdict memory v = gate.check(address(aapl));
        assertEq(uint256(v.state), uint256(IPriceGate.GateState.TRANSFER_PAUSED));
        assertTrue(v.transferPaused);
        vm.expectRevert(abi.encodeWithSelector(SessionGate.TransferPaused.selector, address(aapl)));
        gate.priceOf(address(aapl));
    }

    function test_gate_mintPauseDoesNotMatter() public {
        _fresh();
        aapl.setPaused(IB20.PausableFeature.MINT, true);
        assertEq(uint256(gate.check(address(aapl)).state), uint256(IPriceGate.GateState.OPEN));
    }

    function test_gate_staleAfterHeartbeatPlusTolerance() public {
        vm.prank(owner);
        feed.setAnswerAt(AAPL_ANSWER, T_REGULAR - 26 hours);
        assertEq(uint256(gate.check(address(aapl)).state), uint256(IPriceGate.GateState.OPEN), "exactly 26h is fine");
        vm.prank(owner);
        feed.setAnswerAt(AAPL_ANSWER, T_REGULAR - 26 hours - 1);
        IPriceGate.Verdict memory v = gate.check(address(aapl));
        assertEq(uint256(v.state), uint256(IPriceGate.GateState.FEED_STALE));
        vm.expectRevert(
            abi.encodeWithSelector(SessionGate.FeedStale.selector, address(aapl), T_REGULAR - 26 hours - 1, 26 hours)
        );
        gate.priceOf(address(aapl));
    }

    function test_gate_invalidAnswerOrFutureTimestamp() public {
        vm.prank(owner);
        feed.setAnswer(0);
        assertEq(uint256(gate.check(address(aapl)).state), uint256(IPriceGate.GateState.FEED_INVALID));
        vm.prank(owner);
        feed.setAnswerAt(AAPL_ANSWER, T_REGULAR + 1);
        assertEq(uint256(gate.check(address(aapl)).state), uint256(IPriceGate.GateState.FEED_INVALID));
        vm.expectRevert(
            abi.encodeWithSelector(SessionGate.FeedInvalid.selector, address(aapl), AAPL_ANSWER, T_REGULAR + 1)
        );
        gate.priceOf(address(aapl));
    }

    function test_gate_unknownToken() public {
        address other = makeAddr("other");
        assertEq(uint256(gate.check(other).state), uint256(IPriceGate.GateState.UNKNOWN_TOKEN));
        vm.expectRevert(abi.encodeWithSelector(SessionGate.UnknownToken.selector, other));
        gate.priceOf(other);
    }

    function test_gate_precedence_closedBeatsPaused() public {
        _fresh();
        vm.prank(owner);
        registry.setPaused(address(aapl), true);
        aapl.setPaused(IB20.PausableFeature.TRANSFER, true);
        vm.warp(T_WEEKEND);
        IPriceGate.Verdict memory v = gate.check(address(aapl));
        assertEq(uint256(v.state), uint256(IPriceGate.GateState.MARKET_CLOSED));
        assertTrue(v.registryPaused, "flags are still reported");
        assertTrue(v.transferPaused);
    }

    function test_gate_registryWithoutCodeFailsClosed() public {
        SessionGate g = new SessionGate(owner, cal, IOracleRegistry(makeAddr("no-code-registry")));
        vm.prank(owner);
        g.setFeed(address(aapl), feed, 0, 0);
        _fresh();
        assertEq(uint256(g.check(address(aapl)).state), uint256(IPriceGate.GateState.FEED_PAUSED));
    }

    function test_gate_tokenWithoutCodeFailsClosed() public {
        address eoaToken = makeAddr("eoa-token");
        vm.prank(owner);
        gate.setFeed(eoaToken, feed, 0, 0);
        _fresh();
        assertEq(uint256(gate.check(eoaToken).state), uint256(IPriceGate.GateState.TRANSFER_PAUSED));
    }

    function test_gate_feedWithoutCodeIsInvalid() public {
        vm.mockCall(
            makeAddr("dead-feed"), abi.encodeWithSelector(IAggregatorV3.decimals.selector), abi.encode(uint8(8))
        );
        vm.prank(owner);
        gate.setFeed(address(aapl), IAggregatorV3(makeAddr("dead-feed")), 0, 0);
        vm.clearMockedCalls();
        assertEq(uint256(gate.check(address(aapl)).state), uint256(IPriceGate.GateState.FEED_INVALID));
    }

    function test_gate_scalesEighteenDecimalFeedToEight() public {
        TestPriceFeed f18 = new TestPriceFeed(owner, 18, "18 dec", 333.66495e18);
        vm.prank(owner);
        gate.setFeed(address(aapl), f18, 0, 0);
        assertEq(gate.priceOf(address(aapl)), 33_366_495_000);
        assertEq(gate.feedOf(address(aapl)).feedDecimals, 18);
    }

    function test_gate_setFeedValidation() public {
        vm.startPrank(owner);
        vm.expectRevert(SessionGate.ZeroAddress.selector);
        gate.setFeed(address(0), feed, 0, 0);
        vm.expectRevert(SessionGate.ZeroAddress.selector);
        gate.setFeed(address(aapl), IAggregatorV3(address(0)), 0, 0);
        vm.expectRevert(abi.encodeWithSelector(SessionGate.BadWindow.selector, uint32(30), uint32(2 hours)));
        gate.setFeed(address(aapl), feed, 30, 0);
        vm.expectRevert(abi.encodeWithSelector(SessionGate.BadWindow.selector, uint32(24 hours), uint32(8 days)));
        gate.setFeed(address(aapl), feed, 0, 8 days);
        TestPriceFeed f20 = new TestPriceFeed(owner, 20, "20 dec", 1);
        vm.expectRevert(abi.encodeWithSelector(SessionGate.BadFeedDecimals.selector, uint8(20)));
        gate.setFeed(address(aapl), f20, 0, 0);
        vm.stopPrank();
        vm.expectRevert();
        gate.setFeed(address(aapl), feed, 0, 0); // not owner
        assertEq(gate.tokens().length, 1);
        assertEq(gate.maxAge(address(aapl)), 26 hours);
    }

    function test_gate_lockMakesFeedImmutable() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(SessionGate.FeedNotSet.selector, address(usdc)));
        gate.lockFeed(address(usdc));
        gate.lockFeed(address(aapl));
        assertTrue(gate.feedOf(address(aapl)).locked);
        vm.expectRevert(abi.encodeWithSelector(SessionGate.FeedAlreadyLocked.selector, address(aapl)));
        gate.setFeed(address(aapl), feed, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(SessionGate.FeedAlreadyLocked.selector, address(aapl)));
        gate.lockFeed(address(aapl));
        vm.stopPrank();
    }

    // ============================================================ SessionGuard (Morpho IOracle)

    function test_guard_priceIsMorphoScaled() public {
        _fresh();
        assertEq(guard.SCALE(), 1e26);
        assertEq(guard.price(), uint256(AAPL_ANSWER) * 1e26); // $333.66 -> 3.3366e36
        assertEq(guard.price() / 1e34, 333, "1e34 is one dollar: the price reads as $333");
    }

    function test_guard_revertsWhileClosed_soBorrowWithdrawLiquidateFail() public {
        _fresh();
        vm.warp(T_WEEKEND);
        vm.expectRevert(abi.encodeWithSelector(SessionGate.MarketClosed.selector, IMarketCalendar.Session.WEEKEND));
        guard.price();
        assertEq(uint256(guard.verdict().state), uint256(IPriceGate.GateState.MARKET_CLOSED));
    }

    function test_guard_extendedHaircutOnlyOutsideRegular() public {
        SessionGuard hair = new SessionGuard(gate, address(aapl), 8, address(usdc), 6, 100);
        _fresh();
        assertEq(hair.price(), uint256(AAPL_ANSWER) * 1e26, "no haircut in REGULAR");
        vm.warp(T_OVERNIGHT);
        _fresh();
        assertEq(hair.price(), (uint256(AAPL_ANSWER) * 1e26 * 9900) / 10_000, "1% haircut overnight");
    }

    function test_guard_constructorBounds() public {
        vm.expectRevert(abi.encodeWithSelector(SessionGuard.HaircutTooLarge.selector, uint16(2001)));
        new SessionGuard(gate, address(aapl), 8, address(usdc), 6, 2001);
        vm.expectRevert(SessionGuard.ScaleUnderflow.selector);
        new SessionGuard(gate, address(aapl), 40, address(usdc), 6, 0);
        SessionGuard g18 = new SessionGuard(gate, address(aapl), 18, address(usdc), 6, 0);
        assertEq(g18.SCALE(), 1e16);
    }

    // ============================================================ ShadowGuard (pre-liquidation oracle)

    function test_shadow_usesFeedInSession() public {
        _fresh();
        (uint256 p, ShadowGuard.Source src,) = shadow.shadowPrice();
        assertEq(p, uint256(AAPL_ANSWER) * 1e26);
        assertEq(uint256(src), uint256(ShadowGuard.Source.FEED));
        assertEq(shadow.price(), p);
    }

    function test_shadow_usesTwapLessHaircutOnTheWeekend() public {
        _fresh();
        vm.warp(T_WEEKEND);
        uint256 twap = shadow.twapPrice36();
        assertApproxEqRel(twap, AAPL_TWAP36, 1e13, "TickMath vs Python within 1e-5");
        (uint256 p, ShadowGuard.Source src, IPriceGate.Verdict memory v) = shadow.shadowPrice();
        assertEq(uint256(src), uint256(ShadowGuard.Source.TWAP));
        assertEq(uint256(v.state), uint256(IPriceGate.GateState.MARKET_CLOSED));
        assertEq(p, (twap * 9800) / 10_000);
        assertEq(shadow.price(), p);
        assertTrue(p < uint256(AAPL_ANSWER) * 1e26, "haircut puts the shadow below the held feed");
    }

    function test_shadow_usesTwapWhenFeedStaleInSession() public {
        vm.prank(owner);
        feed.setAnswerAt(AAPL_ANSWER, T_REGULAR - 30 hours);
        (uint256 p, ShadowGuard.Source src, IPriceGate.Verdict memory v) = shadow.shadowPrice();
        assertEq(uint256(src), uint256(ShadowGuard.Source.TWAP));
        assertEq(uint256(v.state), uint256(IPriceGate.GateState.FEED_STALE));
        assertEq(p, (shadow.twapPrice36() * 9800) / 10_000);
    }

    function test_shadow_refusesIssuerPauseEvenOnTheWeekend() public {
        _fresh();
        vm.prank(owner);
        registry.setPaused(address(aapl), true);
        vm.warp(T_WEEKEND);
        vm.expectRevert(
            abi.encodeWithSelector(
                ShadowGuard.ShadowUnavailable.selector, IPriceGate.GateState.MARKET_CLOSED, true, false
            )
        );
        shadow.price();
        vm.prank(owner);
        registry.setPaused(address(aapl), false);
        aapl.setPaused(IB20.PausableFeature.TRANSFER, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                ShadowGuard.ShadowUnavailable.selector, IPriceGate.GateState.MARKET_CLOSED, false, true
            )
        );
        shadow.price();
    }

    function test_shadow_refusesInvalidFeedAndUnknownToken() public {
        vm.prank(owner);
        feed.setAnswer(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                ShadowGuard.ShadowUnavailable.selector, IPriceGate.GateState.FEED_INVALID, false, false
            )
        );
        shadow.price();
    }

    function test_shadow_refusesLargeDeviationFromTheHeldFeed() public {
        vm.prank(owner);
        feed.setAnswer(200e8); // DEX says ~$333, feed held at $200: 66% apart
        vm.warp(T_WEEKEND);
        uint256 twap = shadow.twapPrice36();
        vm.expectRevert(abi.encodeWithSelector(ShadowGuard.ShadowDeviation.selector, twap, 200e8 * 1e26, uint16(3000)));
        shadow.price();
        vm.prank(owner);
        shadow.setMaxDeviation(5000);
        vm.expectRevert(abi.encodeWithSelector(ShadowGuard.ShadowDeviation.selector, twap, 200e8 * 1e26, uint16(5000)));
        shadow.price(); // still 66% apart
    }

    function test_shadow_deviationJustInsideTheBoundPasses() public {
        // 25% gap: feed held at 333.66, DEX at ~250 (tick for 250: ln(1e36/250e26... ) use feed move instead)
        vm.prank(owner);
        feed.setAnswer(int256((uint256(AAPL_ANSWER) * 10_000) / 12_900)); // DEX is 29% above the held feed
        vm.warp(T_WEEKEND);
        (, ShadowGuard.Source src,) = shadow.shadowPrice();
        assertEq(uint256(src), uint256(ShadowGuard.Source.TWAP));
    }

    function test_shadow_poolWithoutHistoryReverts() public {
        _fresh();
        vm.warp(T_WEEKEND);
        pool.setObserveReverts(true);
        vm.expectRevert(MockCLPool.OLD.selector);
        shadow.price();
    }

    function test_shadow_collateralAsToken0() public {
        MockCLPool flipped = new MockCLPool(address(aapl), address(usdc), 10);
        flipped.setAverageTick(3600, -AAPL_TICK); // token1/token0 = USDC per AAPLc raw = 1.0001^12049
        ShadowGuard s = new ShadowGuard(owner, gate, address(aapl), 8, address(usdc), 6, flipped, 3600);
        assertFalse(s.COLLATERAL_IS_TOKEN1());
        assertApproxEqRel(s.twapPrice36(), AAPL_TWAP36, 1e13);
    }

    function test_shadow_negativeTickRoundsTowardNegativeInfinity() public {
        // delta = -3601 over a 3600s window: floor is -2, truncation would be -1
        pool.setCumulative(3600, 0);
        pool.setCumulative(0, -3601);
        uint256 atMinus2 = _quote(-2);
        assertEq(shadow.twapPrice36(), atMinus2);
    }

    function test_shadow_ownerBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(ShadowGuard.HaircutTooLarge.selector, uint16(1001)));
        shadow.setHaircut(1001);
        shadow.setHaircut(0);
        assertEq(shadow.haircutBps(), 0);
        vm.expectRevert(abi.encodeWithSelector(ShadowGuard.DeviationOutOfRange.selector, uint16(999)));
        shadow.setMaxDeviation(999);
        vm.expectRevert(abi.encodeWithSelector(ShadowGuard.DeviationOutOfRange.selector, uint16(5001)));
        shadow.setMaxDeviation(5001);
        vm.stopPrank();
        vm.expectRevert();
        shadow.setHaircut(100);
    }

    function test_shadow_constructorValidation() public {
        MockCLPool wrong = new MockCLPool(address(usdc), makeAddr("other"), 10);
        vm.expectRevert(abi.encodeWithSelector(ShadowGuard.PoolMismatch.selector, address(usdc), makeAddr("other")));
        new ShadowGuard(owner, gate, address(aapl), 8, address(usdc), 6, wrong, 3600);
        vm.expectRevert(abi.encodeWithSelector(ShadowGuard.BadWindow.selector, uint32(60)));
        new ShadowGuard(owner, gate, address(aapl), 8, address(usdc), 6, pool, 60);
        vm.expectRevert(abi.encodeWithSelector(ShadowGuard.BadWindow.selector, uint32(2 days)));
        new ShadowGuard(owner, gate, address(aapl), 8, address(usdc), 6, pool, 2 days);
    }

    function testFuzz_shadow_twapMonotoneInTick(int24 a, int24 b) public {
        a = int24(bound(int256(a), -400_000, 400_000));
        b = int24(bound(int256(b), -400_000, 400_000));
        if (a > b) (a, b) = (b, a);
        // collateral is token1: a higher tick means more collateral per loan unit, so a lower price
        assertGe(_quote(a), _quote(b));
    }

    function _quote(int24 tick) internal returns (uint256) {
        pool.setAverageTick(3600, tick);
        return shadow.twapPrice36();
    }
}
