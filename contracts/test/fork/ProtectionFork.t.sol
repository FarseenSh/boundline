// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IMarketCalendar} from "../../src/interfaces/IMarketCalendar.sol";
import {IOracleRegistry} from "../../src/interfaces/IOracleRegistry.sol";
import {IPriceGate} from "../../src/interfaces/IPriceGate.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {ShadowGuard} from "../../src/oracle/ShadowGuard.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {ICLSwapPool} from "../../src/protection/interfaces/ICLSwapPool.sol";
import {Protector} from "../../src/protection/Protector.sol";
import {IPreLiquidation, PreLiquidationParams} from "../../src/protection/vendor/interfaces/IPreLiquidation.sol";
import {IPreLiquidationFactory} from "../../src/protection/vendor/interfaces/IPreLiquidationFactory.sol";

/// @notice Protected mode on the live Steakhouse AAPLc/USDC market, on a Base mainnet fork (BASE_RPC_URL):
///         a pre-liquidation contract created on Morpho's official factory with ShadowGuard as its oracle,
///         bound to the real AAPLc feed, the real OracleRegistry and the real Aerodrome pool, then a Saturday
///         pre-liquidation of a real borrower at the DEX price while the venue, pricing at the held feed, sees
///         a healthy position and refuses to liquidate.
///
///         The seized collateral is a B20 transfer, which stock forge cannot execute on a fork (the token's
///         code is one byte the node interprets), so the execution tests run under `base-forge` and skip
///         elsewhere; creation and the venue's own reads work on both builds.
contract ProtectionForkTest is Test {
    using MorphoBalancesLib for IMorpho;

    IMorpho constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant AAPLC = 0xb200000000000000000000C2e324d24d7eEcd1fb;
    IAggregatorV3 constant FEED = IAggregatorV3(0x787f13dEa48Db0897CbCDD985de77809D837F988);
    IOracleRegistry constant REGISTRY = IOracleRegistry(0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD);
    ICLSwapPool constant POOL = ICLSwapPool(0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0);
    IPreLiquidationFactory constant FACTORY = IPreLiquidationFactory(0x8cd16b62E170Ee0bA83D80e1F80E6085367e2aef);
    /// @dev Steakhouse AAPLc/USDC, LLTV 62.5%, MorphoChainlinkOracleV2 (serves the held feed at any hour).
    Id constant MARKET = Id.wrap(0xae1a30486234bf7e7ac166c7c03d9bc5f2cd8a39be2c48e73c665ac7148c3c28);
    /// @dev A real borrower of that market (about 32 AAPLc against USDC on 6 Oct 2026).
    address constant BORROWER = 0x8E8745Acd6fbE3e70Afc96042c7F3eC84B1f0e9f;
    uint256 constant LLTV = 0.625e18;
    uint256 constant TARGET_VENUE_LTV = 0.595e18; // where the position is staged: inside the band at the shadow price
    uint256 constant T_SAT = 1_791_640_800; // Sat 2026-10-10 10:00 ET
    /// @dev The fork block: Thu 8 Oct 2026, before the 9-11 Oct weekend this suite stages, where it passed and the evidence
    ///      was taken. Forking later would warp back in time past feeds updated since; FORK_BLOCK overrides it.
    uint256 constant FORK_BLOCK = 52_327_527;

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address supplier = makeAddr("supplier");
    address liquidator = makeAddr("liquidator");

    MarketCalendar cal;
    SessionGate gate;
    ShadowGuard shadow;
    IPreLiquidation preLiq;
    Protector protector;
    MarketParams mp;
    bool b20Live;

    function setUp() public {
        string memory url = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url, vm.envOr("FORK_BLOCK", FORK_BLOCK));
        mp = MORPHO.idToMarketParams(MARKET);
        assertEq(mp.collateralToken, AAPLC, "Steakhouse AAPLc market");
        assertEq(mp.loanToken, USDC);
        assertEq(mp.lltv, LLTV);

        cal = new MarketCalendar(owner);
        vm.prank(owner);
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        gate = new SessionGate(owner, cal, REGISTRY);
        vm.prank(owner);
        gate.setFeed(AAPLC, FEED, 0, 0);
        shadow = new ShadowGuard(owner, gate, AAPLC, 8, USDC, 6, POOL, 3600);
        preLiq = FACTORY.createPreLiquidation(
            MARKET,
            PreLiquidationParams({
                preLltv: 0.58e18,
                preLCF1: 1e18,
                preLCF2: 1e18,
                preLIF1: 1.01e18,
                preLIF2: 1.02e18,
                preLiquidationOracle: address(shadow)
            })
        );
        protector = new Protector(owner, MORPHO, keeper);
        vm.prank(owner);
        protector.setRoute(AAPLC, POOL);

        (bool ok, bytes memory data) = AAPLC.staticcall(abi.encodeCall(IERC20.balanceOf, (BORROWER)));
        b20Live = ok && data.length >= 32;

        // Liquidity for the staging borrow, then the real borrower is moved just inside the band and opts in.
        deal(USDC, supplier, 100_000e6);
        vm.startPrank(supplier);
        IERC20(USDC).approve(address(MORPHO), type(uint256).max);
        MORPHO.supply(mp, 100_000e6, 0, supplier, "");
        vm.stopPrank();
        uint256 venuePrice = IOracle(mp.oracle).price();
        Position memory pos = MORPHO.position(MARKET, BORROWER);
        uint256 debt = MORPHO.expectedBorrowAssets(mp, BORROWER);
        uint256 wanted = (uint256(pos.collateral) * venuePrice / 1e36) * TARGET_VENUE_LTV / 1e18;
        vm.startPrank(BORROWER);
        if (wanted > debt) MORPHO.borrow(mp, wanted - debt, 0, BORROWER, BORROWER);
        MORPHO.setAuthorization(address(preLiq), true);
        vm.stopPrank();
    }

    function _debt() internal view returns (uint256) {
        return MORPHO.expectedBorrowAssets(mp, BORROWER);
    }

    function _healthy(uint256 price36) internal view returns (bool) {
        uint256 collateral = MORPHO.position(MARKET, BORROWER).collateral;
        return (collateral * price36 / 1e36) * LLTV / 1e18 >= _debt();
    }

    function test_fork_preLiquidationLivesOnTheOfficialFactory() public {
        assertTrue(FACTORY.isPreLiquidation(address(preLiq)));
        assertEq(address(preLiq.MORPHO()), address(MORPHO));
        assertEq(Id.unwrap(preLiq.ID()), Id.unwrap(MARKET));
        assertEq(preLiq.preLiquidationParams().preLiquidationOracle, address(shadow));
        assertTrue(MORPHO.isAuthorized(BORROWER, address(preLiq)), "the borrower opted in with one authorisation");
        assertGt(MORPHO.position(MARKET, BORROWER).borrowShares, 0);
    }

    function test_fork_weekend_theVenueSeesNothingWrong() public {
        vm.warp(T_SAT);
        IPriceGate.Verdict memory v = gate.check(AAPLC);
        assertEq(uint256(v.state), uint256(IPriceGate.GateState.MARKET_CLOSED));
        assertEq(uint256(v.session), uint256(IMarketCalendar.Session.WEEKEND));
        // The Steakhouse oracle still answers the held Friday value and the position is healthy at it.
        uint256 venuePrice = IOracle(mp.oracle).price();
        assertEq(venuePrice, uint256(v.answer) * 1e26, "MorphoChainlinkOracleV2 serves the held feed");
        assertTrue(_healthy(venuePrice));
        deal(USDC, liquidator, 10_000e6);
        vm.startPrank(liquidator);
        IERC20(USDC).approve(address(MORPHO), type(uint256).max);
        vm.expectRevert(bytes("position is healthy"));
        MORPHO.liquidate(mp, BORROWER, 1e8, 0, "");
        vm.stopPrank();
    }

    function test_fork_weekend_shadowSizingOnTheLiveBorrower() public {
        vm.warp(T_SAT);
        Protector.Sizing memory z = protector.sizing(preLiq, BORROWER, 0);
        if (!b20Live) {
            // Stock forge: the gate's isPaused read on the B20 precompile fails and the gate fails closed.
            assertEq(uint256(z.standing), uint256(Protector.Standing.NO_SHADOW_PRICE));
            return;
        }
        (uint256 p, ShadowGuard.Source source,) = shadow.shadowPrice();
        assertEq(uint256(source), uint256(ShadowGuard.Source.TWAP));
        assertEq(z.shadowPrice36, p);
        assertTrue(z.venueOracleLive);
        assertEq(uint256(z.standing), uint256(Protector.Standing.IN_BAND));
        assertGt(z.maxSeizedAssets, 0);
        assertGt(z.maxRepaidAssets, 0);
        assertLt(z.maxSeizedAssets, z.fullCloseSeizedAssets);
    }

    function test_fork_weekend_protectAtTheTwap() public {
        if (!b20Live) vm.skip(true);
        vm.warp(T_SAT);
        Protector.Sizing memory z = protector.sizing(preLiq, BORROWER, 0);
        assertEq(uint256(z.standing), uint256(Protector.Standing.IN_BAND));
        uint256 debtBefore = _debt();
        uint256 collateralBefore = MORPHO.position(MARKET, BORROWER).collateral;

        vm.prank(keeper);
        (uint256 seized, uint256 repaid) = protector.protect(preLiq, BORROWER, z.maxSeizedAssets, 0, 0, T_SAT + 1 hours);

        assertEq(seized, z.maxSeizedAssets);
        assertEq(repaid, z.maxRepaidAssets);
        assertEq(MORPHO.position(MARKET, BORROWER).collateral, collateralBefore - seized);
        assertLt(_debt(), debtBefore);
        assertTrue(_healthy(z.venuePrice36), "healthy at the venue's held price");
        assertTrue(_healthy(z.shadowPrice36), "healthy at the DEX price");
        assertGt(IERC20(AAPLC).balanceOf(address(protector)), 0, "the incentive stays in the Protector");
        assertEq(IERC20(USDC).balanceOf(address(protector)), 0);
        assertEq(uint256(protector.sizing(preLiq, BORROWER, 0).standing), uint256(Protector.Standing.BELOW_BAND));
    }
}
