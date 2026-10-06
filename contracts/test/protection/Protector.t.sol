// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IMorpho, MarketParams, Id, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IrmMock} from "morpho-blue/mocks/IrmMock.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMarketCalendar} from "../../src/interfaces/IMarketCalendar.sol";
import {IPriceGate} from "../../src/interfaces/IPriceGate.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {SessionGuard} from "../../src/oracle/SessionGuard.sol";
import {ShadowGuard} from "../../src/oracle/ShadowGuard.sol";
import {TestPriceFeed} from "../../src/test/TestPriceFeed.sol";
import {MirrorOracleRegistry} from "../../src/test/MirrorOracleRegistry.sol";
import {MockB20} from "../../src/test/MockB20.sol";
import {MockSwapPool} from "../../src/test/MockSwapPool.sol";
import {ICLSwapPool} from "../../src/protection/interfaces/ICLSwapPool.sol";
import {Protector} from "../../src/protection/Protector.sol";
import {PreLiquidationFactory} from "../../src/protection/vendor/PreLiquidationFactory.sol";
import {IPreLiquidation, PreLiquidationParams} from "../../src/protection/vendor/interfaces/IPreLiquidation.sol";
import {ErrorsLib as PreLiqErrors} from "../../src/protection/vendor/libraries/ErrorsLib.sol";

/// @dev Stands in for MorphoChainlinkOracleV2: the feed's last answer at any hour, held or not.
contract HeldPriceOracle is IOracle {
    SessionGate public immutable GATE;
    address public immutable TOKEN;
    uint256 public immutable SCALE;

    constructor(SessionGate gate, address token, uint256 scale) {
        GATE = gate;
        TOKEN = token;
        SCALE = scale;
    }

    function price() external view returns (uint256) {
        IPriceGate.Verdict memory v = GATE.check(TOKEN);
        require(v.answer > 0, "no answer");
        return uint256(v.answer) * SCALE;
    }
}

/// @notice Protector and the vendored pre-liquidation against the real Morpho Blue bytecode (etched), with two
///         markets on the same collateral: A prices through SessionGuard (reverts while closed), B through a
///         held-price oracle like the live Steakhouse markets. Both pre-liquidate through one ShadowGuard.
contract ProtectorTest is Test {
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    address constant MORPHO_ADDR = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    IMorpho constant MORPHO = IMorpho(MORPHO_ADDR);
    uint256 constant LLTV = 0.625e18;
    uint256 constant PRE_LLTV = 0.58e18;
    uint256 constant PRE_LCF = 1e18;
    uint256 constant PRE_LIF_1 = 1.01e18;
    uint256 constant PRE_LIF_2 = 1.02e18;
    uint256 constant SCALE = 1e26; // 8-decimal stock against 6-decimal USDC
    int256 constant PRICE = 33_366_495_000; // $333.66495
    int24 constant TICK_FEED = -12_050; // about $333.66 in a USDC/stock pool
    int24 constant TICK_GAP = -11_475; // about $315.0: the weekend gap the DEX already shows
    int24 constant TICK_CRASH = -10_300; // about $280: through LLTV
    uint256 constant T_REGULAR = 1_790_877_600; // Thu 2026-10-01 14:00 ET
    uint256 constant T_SAT = 1_791_024_480; // Sat 2026-10-03 06:48 ET
    uint256 constant DEBT = 1868e6; // 56% LTV at the feed, 60.5% at the shadow price of the gap

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address user = makeAddr("user");
    address supplier = makeAddr("supplier");
    address stranger = makeAddr("stranger");
    address liquidator = makeAddr("liquidator");

    IrmMock irm;
    MockB20 usdc;
    MockB20 aapl;
    MarketCalendar cal;
    MirrorOracleRegistry registry;
    TestPriceFeed feed;
    SessionGate gate;
    SessionGuard guard;
    HeldPriceOracle held;
    MockSwapPool pool;
    ShadowGuard shadow;
    PreLiquidationFactory factory;
    IPreLiquidation preLiqA; // SessionGuard market
    IPreLiquidation preLiqB; // held-price market
    Protector protector;
    MarketParams pA;
    MarketParams pB;
    Id idA;
    Id idB;

    function setUp() public {
        vm.warp(T_REGULAR);
        bytes memory code = vm.parseBytes(vm.readFile("test/fixtures/morpho-blue-8453.runtime.hex"));
        vm.etch(MORPHO_ADDR, code);
        vm.store(MORPHO_ADDR, bytes32(0), bytes32(uint256(uint160(owner))));
        irm = new IrmMock();
        vm.startPrank(owner);
        MORPHO.enableIrm(address(irm));
        MORPHO.enableLltv(LLTV);
        vm.stopPrank();

        usdc = new MockB20("USD Coin", "USDC", 6);
        aapl = new MockB20("Coinbase Wrapped AAPL", "AAPLc", 8);
        cal = new MarketCalendar(owner);
        vm.prank(owner);
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        registry = new MirrorOracleRegistry(owner);
        feed = new TestPriceFeed(owner, 8, "Coinbase AAPL", PRICE);
        gate = new SessionGate(owner, cal, registry);
        vm.prank(owner);
        gate.setFeed(address(aapl), feed, 0, 0);
        guard = new SessionGuard(gate, address(aapl), 8, address(usdc), 6, 0);
        held = new HeldPriceOracle(gate, address(aapl), SCALE);

        pool = new MockSwapPool(address(usdc), address(aapl), 10, owner);
        pool.setAverageTick(3600, TICK_FEED);
        vm.prank(owner);
        pool.setPrice36(3.3366e36);
        usdc.mint(address(pool), 1_000_000e6);
        shadow = new ShadowGuard(owner, gate, address(aapl), 8, address(usdc), 6, pool, 3600);

        pA = MarketParams(address(usdc), address(aapl), address(guard), address(irm), LLTV);
        pB = MarketParams(address(usdc), address(aapl), address(held), address(irm), LLTV);
        idA = pA.id();
        idB = pB.id();
        MORPHO.createMarket(pA);
        MORPHO.createMarket(pB);
        usdc.mint(supplier, 2_000_000e6);
        vm.startPrank(supplier);
        usdc.approve(MORPHO_ADDR, type(uint256).max);
        MORPHO.supply(pA, 1_000_000e6, 0, supplier, "");
        MORPHO.supply(pB, 1_000_000e6, 0, supplier, "");
        vm.stopPrank();

        factory = new PreLiquidationFactory(MORPHO_ADDR);
        preLiqA = factory.createPreLiquidation(idA, _params());
        preLiqB = factory.createPreLiquidation(idB, _params());
        protector = new Protector(owner, MORPHO, keeper);
        vm.prank(owner);
        protector.setRoute(address(aapl), ICLSwapPool(address(pool)));

        aapl.mint(user, 20e8);
        vm.startPrank(user);
        aapl.approve(MORPHO_ADDR, type(uint256).max);
        MORPHO.supplyCollateral(pA, 10e8, user, "");
        MORPHO.supplyCollateral(pB, 10e8, user, "");
        MORPHO.setAuthorization(address(preLiqA), true);
        MORPHO.setAuthorization(address(preLiqB), true);
        MORPHO.borrow(pA, DEBT, 0, user, user);
        MORPHO.borrow(pB, DEBT, 0, user, user);
        vm.stopPrank();
    }

    function _params() internal view returns (PreLiquidationParams memory) {
        return PreLiquidationParams({
            preLltv: PRE_LLTV,
            preLCF1: PRE_LCF,
            preLCF2: PRE_LCF,
            preLIF1: PRE_LIF_1,
            preLIF2: PRE_LIF_2,
            preLiquidationOracle: address(shadow)
        });
    }

    /// @dev Saturday with the DEX already showing the gap: the feed holds $333.66, the TWAP says $315.
    function _weekendGap() internal {
        vm.prank(owner);
        feed.setAnswer(PRICE);
        vm.warp(T_SAT);
        pool.setAverageTick(3600, TICK_GAP);
        vm.prank(owner);
        pool.setPrice36(3.15e36);
    }

    function _debt(MarketParams memory p) internal view returns (uint256) {
        return MORPHO.expectedBorrowAssets(p, user);
    }

    function _healthy(MarketParams memory p, uint256 price36) internal view returns (bool) {
        uint256 collateral = MORPHO.position(p.id(), user).collateral;
        uint256 maxBorrow = (collateral * price36 / 1e36) * LLTV / 1e18;
        return maxBorrow >= _debt(p);
    }

    function _protect(IPreLiquidation preLiq, uint256 seized, uint256 shares) internal returns (uint256, uint256) {
        vm.prank(keeper);
        return protector.protect(preLiq, user, seized, shares, 0, vm.getBlockTimestamp() + 1 hours);
    }

    // ------------------------------------------------------------ standing

    function test_inSession_belowBand() public view {
        Protector.Sizing memory z = protector.sizing(preLiqA, user, 0);
        assertEq(uint256(z.standing), uint256(Protector.Standing.BELOW_BAND));
        assertTrue(z.venueOracleLive);
        assertEq(z.shadowPrice36, uint256(PRICE) * SCALE, "in session the shadow price is the feed");
        assertEq(z.venuePrice36, uint256(PRICE) * SCALE);
        assertEq(z.debtAssets, DEBT);
        assertEq(z.targetLtvWad, PRE_LLTV);
    }

    function test_factory_registersAndValidates() public {
        assertTrue(factory.isPreLiquidation(address(preLiqA)));
        assertFalse(factory.isPreLiquidation(address(protector)));
        PreLiquidationParams memory bad = _params();
        bad.preLltv = LLTV;
        vm.expectRevert(PreLiqErrors.PreLltvTooHigh.selector);
        factory.createPreLiquidation(idA, bad);
        bad = _params();
        bad.preLIF2 = 1.7e18; // above 1 / LLTV = 1.6
        vm.expectRevert(PreLiqErrors.PreLIFTooHigh.selector);
        factory.createPreLiquidation(idA, bad);
        assertEq(preLiqA.preLiquidationParams().preLiquidationOracle, address(shadow));
    }

    // ------------------------------------------------------------ weekend, SessionGuard market

    function test_weekend_sessionGuardMarket_onlyAFullCloseCanRun() public {
        _weekendGap();
        uint256 shadowPrice = shadow.price();
        assertLt(shadowPrice, 3.15e36, "TWAP less the 2% haircut");

        Protector.Sizing memory z = protector.sizing(preLiqA, user, 0);
        assertEq(uint256(z.standing), uint256(Protector.Standing.IN_BAND));
        assertFalse(z.venueOracleLive, "SessionGuard refuses while closed");
        assertEq(z.venuePrice36, uint256(PRICE) * SCALE, "the held feed is still reported for the record");
        assertEq(z.maxSeizedAssets, 0, "no partial can pass Morpho's health check");
        assertTrue(z.fullCloseAllowed);
        assertGt(z.fullCloseSeizedAssets, 0);
        assertLt(z.fullCloseSeizedAssets, 10e8);

        // The venue cannot liquidate on the weekend...
        bytes memory closed = abi.encodeWithSelector(SessionGate.MarketClosed.selector, IMarketCalendar.Session.WEEKEND);
        usdc.mint(liquidator, 10_000e6);
        vm.startPrank(liquidator);
        usdc.approve(MORPHO_ADDR, type(uint256).max);
        vm.expectRevert(closed);
        MORPHO.liquidate(pA, user, 1e8, 0, "");
        // ... and a partial pre-liquidation hits the same wall inside withdrawCollateral's health check.
        usdc.approve(address(preLiqA), type(uint256).max);
        vm.expectRevert(closed);
        preLiqA.preLiquidate(user, 1e8, 0, "");
        vm.stopPrank();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Protector.SeizeTooLarge.selector, 1e8, 0));
        protector.protect(preLiqA, user, 1e8, 0, 0, vm.getBlockTimestamp() + 1);

        // The close-out repays every share, so Morpho never asks the market oracle.
        uint256 shares = MORPHO.position(idA, user).borrowShares;
        uint256 poolUsdcBefore = usdc.balanceOf(address(pool));
        vm.recordLogs();
        (uint256 seized, uint256 repaid) = _protect(preLiqA, 0, shares);
        assertEq(seized, z.fullCloseSeizedAssets);
        assertEq(repaid, z.fullCloseRepaidAssets);
        Position memory pos = MORPHO.position(idA, user);
        assertEq(pos.borrowShares, 0, "debt cleared on Saturday at the live price");
        assertEq(pos.collateral, 10e8 - seized, "the rest of the collateral stays on the user's position");
        uint256 sold = poolUsdcBefore - usdc.balanceOf(address(pool));
        assertEq(sold, repaid, "the pool paid exactly the repayment");
        assertGt(aapl.balanceOf(address(protector)), 0, "incentive and haircut spread stay in the Protector");
        assertEq(aapl.balanceOf(address(protector)) + aapl.balanceOf(address(pool)), seized);
        assertEq(usdc.balanceOf(address(protector)), 0, "no loan tokens are retained");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("Protected(uint256,address,address,uint256,uint256,uint256,uint256,uint256,bytes32)");
        bool seen;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] != topic) continue;
            (uint256 s, uint256 r,, uint256 vp, uint256 sp, bytes32 h) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, bytes32));
            assertEq(s, seized);
            assertEq(r, repaid);
            assertEq(vp, uint256(PRICE) * SCALE);
            assertEq(sp, shadowPrice);
            assertTrue(h != bytes32(0));
            seen = true;
        }
        assertTrue(seen, "Protected emitted");
        assertEq(protector.decisionCount(), 1);
    }

    function test_weekend_fullCloseRefusedWhenNotAllowed() public {
        _weekendGap();
        uint256 shares = MORPHO.position(idA, user).borrowShares;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Protector.OnlyFullClose.selector, shares - 1, shares));
        protector.protect(preLiqA, user, 0, shares - 1, 0, vm.getBlockTimestamp() + 1);
    }

    // ------------------------------------------------------------ weekend, held-price market

    function test_weekend_heldPriceMarket_partialAtTheTwap() public {
        _weekendGap();
        Protector.Sizing memory z = protector.sizing(preLiqB, user, 0);
        assertEq(uint256(z.standing), uint256(Protector.Standing.IN_BAND));
        assertTrue(z.venueOracleLive, "a held-price oracle still answers");
        assertEq(z.venuePrice36, uint256(PRICE) * SCALE);
        assertGt(z.maxSeizedAssets, 0);
        assertLt(z.maxSeizedAssets, z.fullCloseSeizedAssets, "a partial takes less than a close-out");
        assertGt(z.shadowLtvWad, PRE_LLTV);
        assertLe(z.shadowLtvWad, LLTV);

        // The venue sees a healthy position at its held price and refuses to liquidate...
        usdc.mint(liquidator, 10_000e6);
        vm.startPrank(liquidator);
        usdc.approve(MORPHO_ADDR, type(uint256).max);
        vm.expectRevert(bytes("position is healthy"));
        MORPHO.liquidate(pB, user, 1e8, 0, "");
        vm.stopPrank();

        // ... while the Protector trims it at the price the DEX shows.
        uint256 debtBefore = _debt(pB);
        (uint256 seized, uint256 repaid) = _protect(preLiqB, z.maxSeizedAssets, 0);
        assertEq(seized, z.maxSeizedAssets);
        assertEq(repaid, z.maxRepaidAssets);
        assertEq(MORPHO.position(idB, user).borrowShares, z.borrowShares - z.maxRepaidShares);
        assertLt(_debt(pB), debtBefore);
        assertTrue(_healthy(pB, uint256(PRICE) * SCALE), "healthy at the venue price");
        assertTrue(_healthy(pB, z.shadowPrice36), "healthy at the shadow price");
        uint256 quoted = MORPHO.position(idB, user).collateral * z.shadowPrice36 / 1e36;
        assertLe(_debt(pB), quoted * PRE_LLTV / 1e18 + 1, "shadow LTV is back at the band's edge");

        // Done: the position is out of the band, a second action is refused.
        Protector.Sizing memory post = protector.sizing(preLiqB, user, 0);
        assertEq(uint256(post.standing), uint256(Protector.Standing.BELOW_BAND));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Protector.NotInBand.selector, Protector.Standing.BELOW_BAND));
        protector.protect(preLiqB, user, 1, 0, 0, vm.getBlockTimestamp() + 1);
    }

    function test_weekend_heldPriceMarket_closeOutRefusedWhilePartialWorks() public {
        _weekendGap();
        Protector.Sizing memory z = protector.sizing(preLiqB, user, 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Protector.PartialAvailable.selector, z.maxSeizedAssets));
        protector.protect(preLiqB, user, 0, z.borrowShares, 0, vm.getBlockTimestamp() + 1);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(Protector.SeizeTooLarge.selector, z.maxSeizedAssets + 1, z.maxSeizedAssets)
        );
        protector.protect(preLiqB, user, z.maxSeizedAssets + 1, 0, 0, vm.getBlockTimestamp() + 1);
    }

    function test_weekend_smallerStepsAreAllowed() public {
        _weekendGap();
        Protector.Sizing memory z = protector.sizing(preLiqB, user, 0);
        uint256 step = z.maxSeizedAssets / 3;
        _protect(preLiqB, step, 0);
        _protect(preLiqB, step, 0);
        Protector.Sizing memory z2 = protector.sizing(preLiqB, user, 0);
        assertEq(uint256(z2.standing), uint256(Protector.Standing.IN_BAND));
        assertGt(z2.maxSeizedAssets, 0);
        assertLt(z2.maxSeizedAssets, z.maxSeizedAssets);
        assertEq(protector.decisionCount(), 2);
    }

    // ------------------------------------------------------------ in session

    function test_inSession_pricesAtTheFeed() public {
        vm.prank(owner);
        feed.setAnswer(315e8); // the stock falls 5.6% during the session: the band is entered at the live feed
        Protector.Sizing memory z = protector.sizing(preLiqA, user, 0);
        assertEq(uint256(z.standing), uint256(Protector.Standing.IN_BAND));
        assertTrue(z.venueOracleLive);
        assertEq(z.shadowPrice36, 315e8 * SCALE, "in session ShadowGuard returns the feed, no haircut");
        assertEq(z.venuePrice36, z.shadowPrice36);
        vm.prank(owner);
        pool.setPrice36(3.15e36);
        (uint256 seized,) = _protect(preLiqA, z.maxSeizedAssets, 0);
        assertEq(seized, z.maxSeizedAssets);
        assertTrue(_healthy(pA, 315e8 * SCALE));
        assertEq(uint256(protector.sizing(preLiqA, user, 0).standing), uint256(Protector.Standing.BELOW_BAND));
    }

    // ------------------------------------------------------------ refusals

    function test_refusedOutsideTheBand() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Protector.NotInBand.selector, Protector.Standing.BELOW_BAND));
        protector.protect(preLiqB, user, 1e8, 0, 0, vm.getBlockTimestamp() + 1);

        _weekendGap();
        pool.setAverageTick(3600, TICK_CRASH); // the DEX is through LLTV: pre-liquidation is too late
        Protector.Sizing memory z = protector.sizing(preLiqB, user, 0);
        assertEq(uint256(z.standing), uint256(Protector.Standing.ABOVE_LLTV));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Protector.NotInBand.selector, Protector.Standing.ABOVE_LLTV));
        protector.protect(preLiqB, user, 1e8, 0, 0, vm.getBlockTimestamp() + 1);
        usdc.mint(liquidator, 10_000e6);
        vm.startPrank(liquidator);
        usdc.approve(address(preLiqB), type(uint256).max);
        vm.expectRevert(PreLiqErrors.LiquidatablePosition.selector);
        preLiqB.preLiquidate(user, 1e8, 0, "");
        vm.stopPrank();
    }

    function test_shadowRefusalReachesTheKeeper() public {
        _weekendGap();
        vm.prank(owner);
        registry.setPaused(address(aapl), true); // issuer pause: no shadow price, no action
        Protector.Sizing memory z = protector.sizing(preLiqB, user, 0);
        assertEq(uint256(z.standing), uint256(Protector.Standing.NO_SHADOW_PRICE));
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                ShadowGuard.ShadowUnavailable.selector, IPriceGate.GateState.MARKET_CLOSED, true, false
            )
        );
        protector.protect(preLiqB, user, 1e8, 0, 0, vm.getBlockTimestamp() + 1);
    }

    function test_deadline() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Protector.Expired.selector, vm.getBlockTimestamp() - 1));
        protector.protect(preLiqB, user, 1e8, 0, 0, vm.getBlockTimestamp() - 1);
    }

    // ------------------------------------------------------------ callbacks and slippage

    function test_callbacksOnlyFromTheActiveCounterparties() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Protector.UnexpectedCallback.selector, stranger));
        protector.onPreLiquidate(1, abi.encode(address(aapl), address(usdc)));
        vm.prank(address(preLiqA)); // the right contract, but no protection is in flight
        vm.expectRevert(abi.encodeWithSelector(Protector.UnexpectedCallback.selector, address(preLiqA)));
        protector.onPreLiquidate(1, abi.encode(address(aapl), address(usdc)));
        vm.prank(address(pool)); // the configured pool, outside a swap
        vm.expectRevert(abi.encodeWithSelector(Protector.UnexpectedCallback.selector, address(pool)));
        protector.uniswapV3SwapCallback(0, 1, abi.encode(address(aapl), uint256(1)));
    }

    function test_slippageBound() public {
        _weekendGap();
        Protector.Sizing memory z = protector.sizing(preLiqB, user, 0);
        // An explicit bound below what the sale needs.
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(Protector.SlippageExceeded.selector, z.maxRepaidAssets * 1e36 / 3.15e36 + 1, 1)
        );
        protector.protect(preLiqB, user, z.maxSeizedAssets, 0, 1, vm.getBlockTimestamp() + 1);
        // The default bound is "no more than was seized": a pool pricing the stock at $200 cannot be paid.
        vm.prank(owner);
        pool.setPrice36(2.0e36);
        vm.prank(keeper);
        vm.expectRevert();
        protector.protect(preLiqB, user, z.maxSeizedAssets, 0, 0, vm.getBlockTimestamp() + 1);
    }

    // ------------------------------------------------------------ access and admin

    function test_onlyOperators() public {
        _weekendGap();
        Protector.Sizing memory z = protector.sizing(preLiqB, user, 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Protector.NotOperator.selector, stranger));
        protector.protect(preLiqB, user, z.maxSeizedAssets, 0, 0, vm.getBlockTimestamp() + 1);
        vm.prank(owner); // the owner is an operator too
        protector.protect(preLiqB, user, z.maxSeizedAssets / 2, 0, 0, vm.getBlockTimestamp() + 1);
    }

    function test_admin() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        protector.setKeeper(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        protector.setRoute(address(aapl), ICLSwapPool(address(pool)));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        protector.sweep(IERC20(address(aapl)), stranger, 1);
        vm.stopPrank();

        MockSwapPool other = new MockSwapPool(address(usdc), address(0xBEEF), 10, owner);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(Protector.PoolMismatch.selector, address(other), address(usdc), address(0xBEEF))
        );
        protector.setRoute(address(aapl), ICLSwapPool(address(other)));

        aapl.mint(address(protector), 5e8);
        vm.prank(owner);
        protector.sweep(IERC20(address(aapl)), owner, 5e8);
        assertEq(aapl.balanceOf(owner), 5e8);
        vm.prank(owner);
        protector.setKeeper(stranger);
        assertEq(protector.keeper(), stranger);
    }

    function test_noRouteRefused() public {
        MockB20 other = new MockB20("Other", "OTH", 8);
        TestPriceFeed f2 = new TestPriceFeed(owner, 8, "x", PRICE);
        vm.prank(owner);
        gate.setFeed(address(other), f2, 0, 0);
        HeldPriceOracle h2 = new HeldPriceOracle(gate, address(other), SCALE);
        MarketParams memory p = MarketParams(address(usdc), address(other), address(h2), address(irm), LLTV);
        MORPHO.createMarket(p);
        IPreLiquidation pl = factory.createPreLiquidation(p.id(), _params());
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Protector.NoRoute.selector, address(other)));
        protector.protect(pl, user, 1, 0, 0, vm.getBlockTimestamp() + 1);
    }

    function test_decisionHashesDiffer() public {
        _weekendGap();
        Protector.Sizing memory z = protector.sizing(preLiqB, user, 0);
        vm.recordLogs();
        _protect(preLiqB, z.maxSeizedAssets / 4, 0);
        _protect(preLiqB, z.maxSeizedAssets / 4, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("Protected(uint256,address,address,uint256,uint256,uint256,uint256,uint256,bytes32)");
        bytes32 first;
        uint256 seen;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] != topic) continue;
            (,,,,, bytes32 h) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, bytes32));
            if (seen == 0) first = h;
            else assertTrue(h != first);
            seen++;
        }
        assertEq(seen, 2);
    }

    // ------------------------------------------------------------ fuzz: the sizing rule keeps both healths

    function testFuzz_sizingKeepsBothHealths(uint256 extraDebt, int24 tick) public {
        extraDebt = bound(extraDebt, 0, 200e6); // up to 62% LTV at the feed
        tick = int24(bound(int256(tick), -11_900, -11_300)); // DEX between about $298 and $322
        if (extraDebt > 0) {
            vm.prank(user);
            MORPHO.borrow(pB, extraDebt, 0, user, user);
        }
        vm.prank(owner);
        feed.setAnswer(PRICE);
        vm.warp(T_SAT);
        pool.setAverageTick(3600, tick);
        uint256 dexPrice36 = shadow.twapPrice36(); // read first: a view inside vm.prank would consume the prank
        vm.prank(owner);
        pool.setPrice36(dexPrice36);

        Protector.Sizing memory z = protector.sizing(preLiqB, user, 0);
        if (z.standing != Protector.Standing.IN_BAND) return;
        if (z.maxSeizedAssets == 0) return;
        uint256 debtBefore = _debt(pB);
        uint256 collateralBefore = MORPHO.position(idB, user).collateral;
        (uint256 seized, uint256 repaid) = _protect(preLiqB, z.maxSeizedAssets, 0);
        assertEq(seized, z.maxSeizedAssets);
        assertGt(repaid, 0);
        assertLt(_debt(pB), debtBefore);
        assertEq(MORPHO.position(idB, user).collateral, collateralBefore - seized);
        assertTrue(_healthy(pB, z.venuePrice36), "venue health");
        assertTrue(_healthy(pB, z.shadowPrice36), "shadow health");
        assertGe(aapl.balanceOf(address(protector)), 0);
    }
}
