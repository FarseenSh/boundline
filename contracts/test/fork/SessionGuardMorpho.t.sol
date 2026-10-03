// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id, Position, Market} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {IMarketCalendar} from "../../src/interfaces/IMarketCalendar.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {SessionGuard} from "../../src/oracle/SessionGuard.sol";
import {TestPriceFeed} from "../../src/test/TestPriceFeed.sol";
import {MirrorOracleRegistry} from "../../src/test/MirrorOracleRegistry.sol";
import {MockB20} from "../../src/test/MockB20.sol";

/// @notice Runs against a Base mainnet fork (BASE_RPC_URL) and proves the promise on the real
///         Morpho Blue contract: a market whose oracle is SessionGuard refuses `borrow`,
///         `withdrawCollateral` and `liquidate` while Wall Street is closed and still accepts
///         `repay` and `supplyCollateral`. Collateral is a mock 8-decimal stock because stock
///         forge cannot execute the B20 precompiles; Morpho, the IRM and USDC are the live ones.
contract SessionGuardMorphoForkTest is Test {
    using MarketParamsLib for MarketParams;

    IMorpho constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    address constant IRM = 0x46415998764C29aB2a25CbeA6254146D50D22687;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 constant LLTV = 0.625e18;
    int256 constant PRICE = 33_366_495_000; // $333.66

    uint256 constant T_MON_PRE = 1_791_189_000; // Mon 2026-10-05 04:30 ET
    uint256 constant T_SAT = 1_791_640_800; // Sat 2026-10-10 10:00 ET
    uint256 constant T_MON_PRE_2 = 1_791_793_800; // Mon 2026-10-12 04:30 ET

    address owner = makeAddr("owner");
    address supplier = makeAddr("supplier");
    address borrower = makeAddr("borrower");
    address liquidator = makeAddr("liquidator");

    MarketCalendar cal;
    MirrorOracleRegistry registry;
    MockB20 stock;
    TestPriceFeed feed;
    SessionGate gate;
    SessionGuard guard;
    MarketParams params;
    Id id;

    function setUp() public {
        string memory url = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        assertTrue(MORPHO.isIrmEnabled(IRM), "AdaptiveCurveIrm enabled on Base");
        assertTrue(MORPHO.isLltvEnabled(LLTV), "62.5% LLTV enabled on Base");

        vm.warp(T_MON_PRE);
        cal = new MarketCalendar(owner);
        vm.prank(owner);
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        registry = new MirrorOracleRegistry(owner);
        stock = new MockB20("Boundline test AAPL", "AAPLt", 8);
        feed = new TestPriceFeed(owner, 8, "Boundline test feed AAPLt", PRICE);
        gate = new SessionGate(owner, cal, registry);
        vm.prank(owner);
        gate.setFeed(address(stock), feed, 0, 0);
        guard = new SessionGuard(gate, address(stock), 8, USDC, 6, 0);

        params = MarketParams({
            loanToken: USDC, collateralToken: address(stock), oracle: address(guard), irm: IRM, lltv: LLTV
        });
        id = params.id();
        MORPHO.createMarket(params);

        deal(USDC, supplier, 100_000e6);
        vm.startPrank(supplier);
        IERC20(USDC).approve(address(MORPHO), type(uint256).max);
        MORPHO.supply(params, 100_000e6, 0, supplier, "");
        vm.stopPrank();

        stock.mint(borrower, 10e8); // 10 shares, about $3,336 of collateral
        vm.startPrank(borrower);
        stock.approve(address(MORPHO), type(uint256).max);
        IERC20(USDC).approve(address(MORPHO), type(uint256).max);
        MORPHO.supplyCollateral(params, 10e8, borrower, "");
        vm.stopPrank();
    }

    function _fresh(int256 answer) internal {
        vm.prank(owner);
        feed.setAnswer(answer);
    }

    function test_fork_marketExistsWithSessionGuardAsOracle() public view {
        MarketParams memory p = MORPHO.idToMarketParams(id);
        assertEq(p.oracle, address(guard));
        assertEq(p.collateralToken, address(stock));
        assertEq(MORPHO.market(id).totalSupplyAssets, 100_000e6);
    }

    function test_fork_borrowInSession_refusedOnWeekend_repayAndCollateralAlwaysOpen() public {
        // Monday pre-market: a fresh feed, the draw clears.
        _fresh(PRICE);
        vm.prank(borrower);
        (uint256 drawn,) = MORPHO.borrow(params, 1000e6, 0, borrower, borrower);
        assertEq(drawn, 1000e6);
        assertEq(IERC20(USDC).balanceOf(borrower), 1000e6);

        // Saturday: the feed holds Friday's value; the market refuses to price anything.
        vm.warp(T_SAT);
        bytes memory closed = abi.encodeWithSelector(SessionGate.MarketClosed.selector, IMarketCalendar.Session.WEEKEND);

        vm.prank(borrower);
        vm.expectRevert(closed);
        MORPHO.borrow(params, 1e6, 0, borrower, borrower);

        vm.prank(borrower);
        vm.expectRevert(closed);
        MORPHO.withdrawCollateral(params, 1e8, borrower, borrower);

        deal(USDC, liquidator, 10_000e6);
        vm.startPrank(liquidator);
        IERC20(USDC).approve(address(MORPHO), type(uint256).max);
        vm.expectRevert(closed);
        MORPHO.liquidate(params, borrower, 1e8, 0, "");
        vm.stopPrank();

        // ... but protection is always open: repay and add collateral never touch the oracle.
        vm.startPrank(borrower);
        (uint256 repaid,) = MORPHO.repay(params, 400e6, 0, borrower, "");
        assertEq(repaid, 400e6);
        stock.mint(borrower, 1e8);
        MORPHO.supplyCollateral(params, 1e8, borrower, "");
        vm.stopPrank();
        Position memory pos = MORPHO.position(id, borrower);
        assertEq(pos.collateral, 11e8);

        // Monday again, fresh feed: draws clear.
        vm.warp(T_MON_PRE_2);
        _fresh(PRICE);
        vm.prank(borrower);
        MORPHO.borrow(params, 100e6, 0, borrower, borrower);
    }

    function test_fork_liquidationStillWorksInSessionWhenUnhealthy() public {
        _fresh(PRICE);
        vm.prank(borrower);
        MORPHO.borrow(params, 2000e6, 0, borrower, borrower); // ~60% LTV of $3,336

        _fresh(150e8); // the stock halves in session: 11.. collateral $1,500 x 62.5% < $2,000 debt
        deal(USDC, liquidator, 10_000e6);
        vm.startPrank(liquidator);
        IERC20(USDC).approve(address(MORPHO), type(uint256).max);
        (uint256 seized, uint256 repaidAssets) = MORPHO.liquidate(params, borrower, 2e8, 0, "");
        vm.stopPrank();
        assertEq(seized, 2e8);
        assertGt(repaidAssets, 0);
        assertEq(stock.balanceOf(liquidator), 2e8);
    }

    function test_fork_holidayBehavesLikeWeekend() public {
        _fresh(PRICE);
        vm.warp(1_795_712_400); // Thanksgiving noon ET
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(SessionGate.MarketClosed.selector, IMarketCalendar.Session.HOLIDAY));
        MORPHO.borrow(params, 1e6, 0, borrower, borrower);
    }
}
