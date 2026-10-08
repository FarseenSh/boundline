// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IMarketCalendar} from "../../src/interfaces/IMarketCalendar.sol";
import {IEligibility} from "../../src/interfaces/IEligibility.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {TestPriceFeed} from "../../src/test/TestPriceFeed.sol";
import {MirrorOracleRegistry} from "../../src/test/MirrorOracleRegistry.sol";
import {MockB20} from "../../src/test/MockB20.sol";
import {AaveDesk} from "../../src/aave/AaveDesk.sol";
import {AaveTypes as T} from "../../src/aave/AaveTypes.sol";
import {AaveEnrolment} from "../../src/aave/AaveEnrolment.sol";
import {IAaveSpoke, ITakerPositionManager, IGiverPositionManager} from "../../src/aave/interfaces/IAaveV4.sol";
import {MockAaveSpoke} from "./mocks/MockAaveSpoke.sol";
import {MockTaker, MockGiver} from "./mocks/MockPositionManagers.sol";

contract AaveMockEligibility is IEligibility {
    mapping(address => bool) public ok;
    bool public revertAll;

    function set(address user, bool value) external {
        ok[user] = value;
    }

    function setRevertAll(bool value) external {
        revertAll = value;
    }

    function isEligible(bytes32, address user) external view returns (bool) {
        if (revertAll) revert("hook down");
        return ok[user];
    }
}

/// @notice AaveDesk against a mock spoke that keeps the real spoke's rules (position-manager gate, health
///         check after borrow and withdraw) and mocks of the Taker and the Giver that keep theirs
///         (allowances, pay-the-caller, cap-at-debt). The SessionGate, calendar, feed and registry are real.
contract AaveDeskTest is Test {
    bytes32 constant PARTNER = "boundline";
    int256 constant PRICE = 33_366_495_000; // $333.66495
    uint256 constant T_REGULAR = 1_790_877_600; // Thu 2026-10-01 14:00 ET
    uint256 constant T_SAT = 1_791_024_480; // Sat 2026-10-03 06:48 ET
    uint256 constant T_MON = 1_791_208_800; // Mon 2026-10-05 10:00 ET
    uint256 constant REPAY_ALL = type(uint256).max;
    uint256 constant WAD = 1e18;

    address owner = makeAddr("owner");
    address partnerAdmin = makeAddr("partnerAdmin");
    address keeper = makeAddr("keeper");
    address user = makeAddr("user");
    address stranger = makeAddr("stranger");
    uint256 signerKey = 0xA11CE;
    address signer = vm.addr(signerKey);

    MockB20 usdc;
    MockB20 aapl;
    MarketCalendar cal;
    MirrorOracleRegistry registry;
    TestPriceFeed feed;
    SessionGate gate;
    MockAaveSpoke spoke;
    MockTaker taker;
    MockGiver giver;
    AaveDesk desk;
    uint256 aaplRes;
    uint256 usdcRes;
    uint256 lineId;

    function setUp() public {
        vm.warp(T_REGULAR);
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

        spoke = new MockAaveSpoke();
        aaplRes = spoke.addReserve(address(aapl), 8, 7800, false, uint256(PRICE)); // 78% like Base
        usdcRes = spoke.addReserve(address(usdc), 6, 0, true, 1e8);
        taker = new MockTaker();
        giver = new MockGiver();
        taker.registerSpoke(address(spoke), true);
        giver.registerSpoke(address(spoke), true);
        spoke.updatePositionManager(address(taker), true);
        spoke.updatePositionManager(address(giver), true);
        usdc.mint(address(spoke), 1_000_000e6); // lending liquidity

        desk = new AaveDesk(
            owner,
            IAaveSpoke(address(spoke)),
            ITakerPositionManager(address(taker)),
            IGiverPositionManager(address(giver)),
            gate,
            usdcRes,
            keeper
        );
        vm.startPrank(owner);
        desk.enableReserve(aaplRes);
        desk.createPartner(PARTNER, partnerAdmin, address(0), IEligibility(address(0)), 100_000e6);
        vm.stopPrank();
        vm.prank(partnerAdmin);
        desk.setReservePolicy(PARTNER, aaplRes, true, 0.5e18, 10e6, 5000e6, 50_000e6);

        aapl.mint(user, 10e8);
        vm.startPrank(user);
        aapl.approve(address(spoke), type(uint256).max);
        spoke.supply(aaplRes, 10e8, user); // the user's own Aave position
        spoke.setUserPositionManager(address(taker), true);
        spoke.setUserPositionManager(address(giver), true);
        taker.approveBorrow(address(spoke), usdcRes, address(desk), 10_000e6);
        usdc.approve(address(desk), type(uint256).max);
        lineId = desk.openLine(PARTNER, aaplRes, 0, "");
        vm.stopPrank();
    }

    function _fresh() internal {
        vm.prank(owner);
        feed.setAnswer(PRICE);
    }

    function _refused(T.Reason r) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(AaveDesk.Refused.selector, r);
    }

    function _draw(uint256 amount) internal {
        vm.prank(user);
        desk.draw(lineId, amount);
    }

    // ------------------------------------------------------------ capacity

    function test_capacity_regularSession() public view {
        T.Quote memory q = desk.capacity(lineId);
        assertEq(uint256(q.reason), uint256(T.Reason.NONE));
        assertEq(uint256(q.session), uint256(IMarketCalendar.Session.REGULAR));
        assertEq(q.price8, uint256(PRICE));
        assertEq(q.collateralRaw, 10e8);
        assertEq(q.collateralValue, 3_336_649_500); // $3,336.6495 in USDC units
        assertEq(q.effectiveMaxLtvWad, 0.5e18);
        assertEq(q.maxDebt, 1_668_324_750);
        assertEq(q.available, 1_668_324_750); // policy binds before the venue's 78%
        assertEq(q.venueAvailable, 2_602_586_610); // 78% of the same value, what Aave alone would lend
        assertEq(q.venueHealthFactor, type(uint256).max);
        assertFalse(q.corporateActionHaircut);
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(T.ObligationStatus.OPEN));
    }

    function test_capacity_venueHeadroomCapsPolicy() public {
        // Debt taken outside the desk still counts: the user borrows 2,000 USDC directly on the spoke.
        vm.prank(user);
        spoke.borrow(usdcRes, 2000e6, user);
        T.Quote memory q = desk.capacity(lineId);
        assertEq(q.debt, 2000e6);
        assertEq(q.available, 0); // policy: 1,668 max debt already exceeded
        assertEq(q.venueAvailable, 602_586_610); // Aave: 2,602.59 - 2,000
    }

    function test_capacity_clampsToCollateralFactorWhenItDrops() public {
        spoke.setCollateralFactor(aaplRes, 4000);
        T.Quote memory q = desk.capacity(lineId);
        assertEq(q.effectiveMaxLtvWad, 0.4e18);
        assertEq(q.maxDebt, 1_334_659_800);
    }

    function test_capacity_corporateActionHaircut() public {
        aapl.setUIMultiplier(1e18, 0.5e18, block.timestamp + 1 days); // 2-for-1 lands this week
        T.Quote memory q = desk.capacity(lineId);
        assertTrue(q.corporateActionHaircut);
        assertEq(q.collateralValue, 3_336_649_500 / 2);
    }

    // ------------------------------------------------------------ draw

    function test_draw_forwardsEveryUnitToTheUser() public {
        uint256 before = usdc.balanceOf(user);
        vm.expectEmit(true, false, false, false, address(desk));
        emit AaveDesk.Drawn(lineId, 100e6, uint256(PRICE), IMarketCalendar.Session.REGULAR, bytes32(0));
        _draw(100e6);
        assertEq(usdc.balanceOf(user) - before, 100e6);
        assertEq(usdc.balanceOf(address(desk)), 0, "the desk keeps nothing");
        assertEq(usdc.balanceOf(address(taker)), 0, "the taker keeps nothing");
        assertEq(spoke.debt(usdcRes, user), 100e6);
        assertEq(desk.line(lineId).drawnPrincipal, 100e6);
        assertEq(desk.partner(PARTNER).exposure, 100e6);
        assertEq(desk.reservePolicy(PARTNER, aaplRes).exposure, 100e6);
        assertEq(taker.borrowAllowance(address(spoke), usdcRes, user, address(desk)), 9900e6, "allowance consumed");
    }

    function test_draw_onlyLineOwner() public {
        vm.prank(stranger);
        vm.expectRevert(AaveDesk.NotLineOwner.selector);
        desk.draw(lineId, 100e6);
    }

    function test_draw_refusedOnWeekend_andHeldSessionInRecord() public {
        vm.warp(T_SAT);
        T.Quote memory q = desk.quote(lineId, 100e6);
        assertEq(uint256(q.reason), uint256(T.Reason.MARKET_CLOSED));
        assertEq(uint256(q.session), uint256(IMarketCalendar.Session.WEEKEND));
        assertEq(q.price8, 0);
        vm.prank(user);
        vm.expectRevert(_refused(T.Reason.MARKET_CLOSED));
        desk.draw(lineId, 100e6);
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(T.ObligationStatus.HOLD_SESSION));
    }

    function test_draw_refusedStaleFeed() public {
        vm.prank(owner);
        feed.setAnswerAt(PRICE, block.timestamp - 27 hours);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.FEED_STALE));
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(T.ObligationStatus.HOLD_FEED));
    }

    function test_draw_refusedRegistryPause() public {
        vm.prank(owner);
        registry.setPaused(address(aapl), true);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.FEED_PAUSED));
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(T.ObligationStatus.HOLD_ISSUER));
    }

    function test_draw_refusedTransferPause() public {
        aapl.setPaused(IB20.PausableFeature.TRANSFER, true);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.TRANSFER_PAUSED));
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(T.ObligationStatus.HOLD_TRANSFER));
    }

    function test_draw_refusedWhenVenuePausedOrFrozen() public {
        spoke.setFlags(aaplRes, true, false, false);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.VENUE_PAUSED));
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(T.ObligationStatus.HOLD_VENUE));
        spoke.setFlags(aaplRes, false, true, false);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.VENUE_FROZEN));
        spoke.setFlags(aaplRes, false, false, false);
        spoke.setFlags(usdcRes, false, false, false); // USDC no longer borrowable
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.MARKET_DISABLED));
    }

    function test_draw_refusedWhenVenueUnhealthy() public {
        vm.prank(user);
        spoke.borrow(usdcRes, 2500e6, user); // 75% LTV at 78% CF: still healthy on Aave
        spoke.setPrice(aaplRes, 300e8); // Aave's own price falls, HF < 1
        T.Quote memory q = desk.capacity(lineId);
        assertEq(uint256(q.reason), uint256(T.Reason.VENUE_UNHEALTHY));
        assertLt(q.venueHealthFactor, WAD);
    }

    // ------------------------------------------------------------ the hub's halt switch

    /// @dev Aave's real halt is the hub's SpokeConfig (the Security Council set `halted` for every MAG7 asset on
    ///      24 Sep 2026), not the spoke's reserve flags. Whichever asset it hits, collateral or USDC, the desk
    ///      quotes VENUE_HALTED, records HOLD_VENUE and refuses draws and withdrawals; a deactivated spoke reads the
    ///      same; lifting it reopens the line.
    function test_hubHalt_refusesDrawsAndWithdrawals_recordsHoldVenue() public {
        spoke.setHubHalted(aaplRes, true);
        T.Quote memory q = desk.capacity(lineId);
        assertEq(uint256(q.reason), uint256(T.Reason.VENUE_HALTED));
        assertEq(q.available, 0);
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(T.ObligationStatus.HOLD_VENUE));
        vm.prank(user);
        vm.expectRevert(_refused(T.Reason.VENUE_HALTED));
        desk.draw(lineId, 100e6);
        vm.prank(user);
        vm.expectRevert(_refused(T.Reason.VENUE_HALTED));
        desk.withdrawCollateral(lineId, 1e8);
        spoke.setHubHalted(aaplRes, false);

        spoke.setHubHalted(usdcRes, true);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.VENUE_HALTED));
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(T.ObligationStatus.HOLD_VENUE));
        spoke.setHubHalted(usdcRes, false);

        spoke.setHubActive(aaplRes, false);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.VENUE_HALTED));
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(T.ObligationStatus.HOLD_VENUE));
        spoke.setHubActive(aaplRes, true);

        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.NONE));
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(T.ObligationStatus.OPEN));
        _draw(100e6);
        assertEq(spoke.debt(usdcRes, user), 100e6);
    }

    /// @dev The hub's halt outranks the spoke's own flags and the session: one reason, the hardest one.
    function test_hubHalt_outranksReserveFlagsAndTheWeekend() public {
        spoke.setHubHalted(aaplRes, true);
        spoke.setFlags(aaplRes, true, true, false);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.VENUE_HALTED));
        vm.warp(T_SAT);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.VENUE_HALTED));
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(T.ObligationStatus.HOLD_VENUE));
        spoke.setHubHalted(aaplRes, false);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.VENUE_PAUSED));
    }

    /// @dev A hub that cannot be read is a halted one for anything that lends (fail closed).
    function test_hubUnreadable_failsClosedForDraws() public {
        spoke.setHubUnreadable(true);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.VENUE_HALTED));
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(T.ObligationStatus.HOLD_VENUE));
        vm.prank(user);
        vm.expectRevert(_refused(T.Reason.VENUE_HALTED));
        desk.draw(lineId, 100e6);
    }

    /// @dev The reasons the CreditDesk shares keep their places; the hub's halt is appended after VENUE_UNHEALTHY
    ///      and the obligation statuses are unchanged.
    function test_reasonOrder_venueHaltedAppendedLast() public pure {
        assertEq(uint256(T.Reason.NOT_AUTHORIZED_ON_VENUE), 19);
        assertEq(uint256(T.Reason.VENUE_PAUSED), 20);
        assertEq(uint256(T.Reason.VENUE_FROZEN), 21);
        assertEq(uint256(T.Reason.VENUE_UNHEALTHY), 24);
        assertEq(uint256(T.Reason.VENUE_HALTED), 25);
        assertEq(uint256(T.ObligationStatus.CLOSED), 7);
        assertEq(uint256(T.ObligationStatus.HOLD_VENUE), 8);
    }

    function test_draw_policyBounds() public {
        assertEq(uint256(desk.quote(lineId, 5e6).reason), uint256(T.Reason.BELOW_MIN_DRAW));
        assertEq(uint256(desk.quote(lineId, 5001e6).reason), uint256(T.Reason.ABOVE_MAX_DRAW));
        assertEq(uint256(desk.quote(lineId, 1700e6).reason), uint256(T.Reason.INSUFFICIENT_CAPACITY));
        vm.prank(partnerAdmin);
        desk.setReservePolicy(PARTNER, aaplRes, true, 0.5e18, 10e6, 5000e6, 150e6);
        assertEq(uint256(desk.quote(lineId, 151e6).reason), uint256(T.Reason.TICKER_CAP));
        vm.prank(partnerAdmin);
        desk.setPartnerConfig(PARTNER, address(0), IEligibility(address(0)), true, 120e6);
        assertEq(uint256(desk.quote(lineId, 121e6).reason), uint256(T.Reason.PARTNER_CAP));
        vm.prank(partnerAdmin);
        desk.setPartnerConfig(PARTNER, address(0), IEligibility(address(0)), false, 120e6);
        assertEq(uint256(desk.quote(lineId, 100e6).reason), uint256(T.Reason.PARTNER_INACTIVE));
    }

    function test_policy_ltvMustBeBelowCollateralFactor() public {
        vm.prank(partnerAdmin);
        vm.expectRevert(abi.encodeWithSelector(AaveDesk.BadLtv.selector, uint64(0.78e18), 0.78e18));
        desk.setReservePolicy(PARTNER, aaplRes, true, 0.78e18, 10e6, 5000e6, 0);
        vm.prank(partnerAdmin);
        desk.setReservePolicy(PARTNER, aaplRes, true, 0.7799e18, 10e6, 5000e6, 0);
    }

    function test_draw_refusedWithoutCollateralOrWhenDisabled() public {
        address other = makeAddr("other");
        vm.prank(other);
        uint256 id2 = desk.openLine(PARTNER, aaplRes, 0, "");
        assertEq(uint256(desk.capacity(id2).reason), uint256(T.Reason.NO_COLLATERAL));
        vm.prank(user);
        spoke.setUsingAsCollateral(aaplRes, false, user);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.COLLATERAL_DISABLED));
    }

    function test_draw_refusedWithoutTakerApprovalOrAllowance() public {
        vm.prank(user);
        taker.approveBorrow(address(spoke), usdcRes, address(desk), 50e6);
        assertEq(uint256(desk.quote(lineId, 60e6).reason), uint256(T.Reason.NOT_AUTHORIZED_ON_VENUE));
        assertEq(uint256(desk.quote(lineId, 50e6).reason), uint256(T.Reason.NONE));
        vm.prank(user);
        spoke.setUserPositionManager(address(taker), false);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.NOT_AUTHORIZED_ON_VENUE));
    }

    function test_draw_refusedWhenDeskPaused() public {
        vm.prank(owner);
        desk.setPaused(true);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.DESK_PAUSED));
        vm.prank(user);
        vm.expectRevert(_refused(T.Reason.DESK_PAUSED));
        desk.draw(lineId, 100e6);
    }

    function testFuzz_drawWithinCapacityKeepsVenueHealthy(uint256 amount) public {
        T.Quote memory q = desk.capacity(lineId);
        amount = bound(amount, 10e6, q.available);
        _draw(amount);
        IAaveSpoke.UserAccountData memory ad = spoke.getUserAccountData(user);
        assertGe(ad.healthFactor, WAD);
        assertLe(spoke.debt(usdcRes, user) * WAD / q.collateralValue, 0.5e18);
    }

    // ------------------------------------------------------------ repay

    function test_repay_worksOnTheWeekendFromAnyone() public {
        _draw(100e6);
        vm.warp(T_SAT);
        vm.prank(user);
        uint256 r1 = desk.repay(lineId, 40e6);
        assertEq(r1, 40e6);
        assertEq(spoke.debt(usdcRes, user), 60e6);
        assertEq(desk.line(lineId).drawnPrincipal, 60e6);

        usdc.mint(stranger, 100e6);
        vm.startPrank(stranger);
        usdc.approve(address(desk), type(uint256).max);
        uint256 r2 = desk.repay(lineId, REPAY_ALL);
        vm.stopPrank();
        assertEq(r2, 60e6);
        assertEq(usdc.balanceOf(stranger), 40e6, "only the debt was pulled");
        assertEq(spoke.debt(usdcRes, user), 0);
        assertEq(desk.line(lineId).drawnPrincipal, 0);
        assertEq(desk.partner(PARTNER).exposure, 0);
        assertEq(usdc.balanceOf(address(desk)), 0);
    }

    function test_repay_capsAtDebtAndRefundsTheRest() public {
        _draw(100e6);
        spoke.accrue(usdcRes, user, 5e6); // interest
        usdc.mint(user, 10e6);
        uint256 before = usdc.balanceOf(user);
        vm.prank(user);
        uint256 repaid = desk.repay(lineId, 500e6);
        assertEq(repaid, 105e6);
        assertEq(before - usdc.balanceOf(user), 105e6);
        assertEq(desk.line(lineId).drawnPrincipal, 0, "principal floors at zero");
    }

    function test_repay_refusedWithoutGiverApproval() public {
        _draw(100e6);
        vm.startPrank(user);
        spoke.setUserPositionManager(address(giver), false);
        vm.expectRevert(_refused(T.Reason.NOT_AUTHORIZED_ON_VENUE));
        desk.repay(lineId, 10e6);
        vm.stopPrank();
    }

    function test_repay_nothingToRepay() public {
        vm.prank(user);
        vm.expectRevert(AaveDesk.NothingToRepay.selector);
        desk.repay(lineId, 10e6);
    }

    /// @dev Repays through the Giver restore USDC's asset only: a hub halt of the collateral's asset leaves them
    ///      open, a halt of USDC's asset (or a paused USDC reserve) refuses them by name before any USDC moves, and
    ///      an unreadable hub never blocks one (the venue decides; repaying can only help the borrower).
    function test_repay_refusedOnlyWhileTheVenueRefusesUsdcRepays() public {
        _draw(100e6);
        usdc.mint(stranger, 100e6);
        vm.prank(stranger);
        usdc.approve(address(desk), type(uint256).max);

        spoke.setHubHalted(aaplRes, true);
        vm.prank(stranger);
        assertEq(desk.repay(lineId, 10e6), 10e6);
        spoke.setHubHalted(aaplRes, false);

        spoke.setHubHalted(usdcRes, true);
        vm.prank(stranger);
        vm.expectRevert(_refused(T.Reason.VENUE_HALTED));
        desk.repay(lineId, 10e6);
        spoke.setHubHalted(usdcRes, false);

        spoke.setFlags(usdcRes, true, false, true);
        vm.prank(stranger);
        vm.expectRevert(_refused(T.Reason.VENUE_PAUSED));
        desk.repay(lineId, 10e6);
        spoke.setFlags(usdcRes, false, true, true); // frozen still repays
        vm.prank(stranger);
        assertEq(desk.repay(lineId, 10e6), 10e6);
        spoke.setFlags(usdcRes, false, false, true);

        spoke.setHubUnreadable(true);
        vm.prank(stranger);
        assertEq(desk.repay(lineId, 10e6), 10e6);
        assertEq(spoke.debt(usdcRes, user), 70e6);
        assertEq(usdc.balanceOf(stranger), 70e6);
    }

    // ------------------------------------------------------------ withdraw collateral

    function test_withdrawCollateral_inSessionWithinPolicy() public {
        _draw(500e6);
        vm.startPrank(user);
        vm.expectRevert(_refused(T.Reason.NOT_AUTHORIZED_ON_VENUE));
        desk.withdrawCollateral(lineId, 1e8);
        taker.approveWithdraw(address(spoke), aaplRes, address(desk), 10e8);
        desk.withdrawCollateral(lineId, 1e8);
        vm.stopPrank();
        assertEq(aapl.balanceOf(user), 1e8);
        assertEq(aapl.balanceOf(address(desk)), 0);
        assertEq(spoke.supplied(aaplRes, user), 9e8);
        // 500 debt at 50% LTV needs $1,000 of collateral = 3 shares; taking 7 more leaves 2 -> refused
        vm.prank(user);
        vm.expectRevert(_refused(T.Reason.INSUFFICIENT_CAPACITY));
        desk.withdrawCollateral(lineId, 7e8);
    }

    function test_withdrawCollateral_refusedOnWeekend() public {
        vm.prank(user);
        taker.approveWithdraw(address(spoke), aaplRes, address(desk), 10e8);
        vm.warp(T_SAT);
        vm.prank(user);
        vm.expectRevert(_refused(T.Reason.MARKET_CLOSED));
        desk.withdrawCollateral(lineId, 1e8);
    }

    // ------------------------------------------------------------ hold, release, close

    function test_holdAndRelease() public {
        vm.prank(stranger);
        vm.expectRevert(AaveDesk.NotKeeper.selector);
        desk.hold(lineId, "SHADOW_HF");
        vm.prank(keeper);
        desk.hold(lineId, "SHADOW_HF");
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.LINE_HELD));
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(T.ObligationStatus.HOLD_KEEPER));
        vm.prank(user);
        vm.expectRevert(_refused(T.Reason.LINE_HELD));
        desk.draw(lineId, 100e6);
        vm.prank(keeper);
        desk.release(lineId);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.NONE));
    }

    function test_closeLine_needsPrincipalRepaid() public {
        _draw(100e6);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(AaveDesk.DebtOutstanding.selector, 100e6));
        desk.closeLine(lineId);
        vm.startPrank(user);
        desk.repay(lineId, REPAY_ALL);
        desk.closeLine(lineId);
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(T.ObligationStatus.CLOSED));
        assertEq(desk.lineOf(PARTNER, user, aaplRes), 0);
        uint256 again = desk.openLine(PARTNER, aaplRes, 0, "");
        vm.stopPrank();
        assertEq(again, lineId + 1);
    }

    function test_openLine_refusals() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(AaveDesk.LineExists.selector, lineId));
        desk.openLine(PARTNER, aaplRes, 0, "");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AaveDesk.UnknownPartner.selector, bytes32("nobody")));
        desk.openLine("nobody", aaplRes, 0, "");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AaveDesk.ReserveNotEnabled.selector, usdcRes));
        desk.openLine(PARTNER, usdcRes, 0, "");
    }

    // ------------------------------------------------------------ eligibility and authorisation

    function test_eligibilityHook_gatesOpenAndDraw() public {
        AaveMockEligibility hook = new AaveMockEligibility();
        vm.prank(partnerAdmin);
        desk.setPartnerConfig(PARTNER, address(0), hook, true, 100_000e6);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.NOT_ELIGIBLE));
        hook.set(user, true);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.NONE));
        hook.setRevertAll(true);
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.NOT_ELIGIBLE), "a reverting hook fails closed");
        vm.prank(stranger);
        vm.expectRevert(_refused(T.Reason.NOT_ELIGIBLE));
        desk.openLine(PARTNER, aaplRes, 0, "");
    }

    function test_openLine_partnerSignature() public {
        vm.prank(partnerAdmin);
        desk.setPartnerConfig(PARTNER, signer, IEligibility(address(0)), true, 100_000e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = desk.lineAuthorizationDigest(PARTNER, stranger, aaplRes, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(stranger);
        vm.expectRevert(AaveDesk.BadAuthorization.selector);
        desk.openLine(PARTNER, aaplRes, deadline, abi.encodePacked(r, s, uint8(v == 27 ? 28 : 27)));

        vm.warp(deadline + 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AaveDesk.AuthorizationExpired.selector, deadline));
        desk.openLine(PARTNER, aaplRes, deadline, sig);

        vm.warp(deadline - 1);
        vm.prank(stranger);
        uint256 id2 = desk.openLine(PARTNER, aaplRes, deadline, sig);
        assertEq(desk.line(id2).user, stranger);
        assertEq(desk.nonces(stranger), 1);
    }

    // ------------------------------------------------------------ construction and enrolment

    function test_constructor_checksManagers() public {
        spoke.updatePositionManager(address(taker), false);
        vm.expectRevert(abi.encodeWithSelector(AaveDesk.ManagerNotActive.selector, address(taker)));
        new AaveDesk(
            owner,
            IAaveSpoke(address(spoke)),
            ITakerPositionManager(address(taker)),
            IGiverPositionManager(address(giver)),
            gate,
            usdcRes,
            keeper
        );
        spoke.updatePositionManager(address(taker), true);
        giver.registerSpoke(address(spoke), false);
        vm.expectRevert(abi.encodeWithSelector(AaveDesk.SpokeNotRegistered.selector, address(giver)));
        new AaveDesk(
            owner,
            IAaveSpoke(address(spoke)),
            ITakerPositionManager(address(taker)),
            IGiverPositionManager(address(giver)),
            gate,
            usdcRes,
            keeper
        );
    }

    function test_enableReserve_checks() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(AaveDesk.ReserveNotCollateral.selector, usdcRes));
        desk.enableReserve(usdcRes);
        uint256 nvda = spoke.addReserve(address(new MockB20("NVDA", "NVDAc", 8)), 8, 7000, false, 240e8);
        vm.expectRevert(abi.encodeWithSelector(AaveDesk.GateHasNoFeed.selector, spoke.getReserve(nvda).underlying));
        desk.enableReserve(nvda);
        vm.expectRevert(abi.encodeWithSelector(AaveDesk.ReserveAlreadyEnabled.selector, aaplRes));
        desk.enableReserve(aaplRes);
        desk.setReserveEnabled(aaplRes, false);
        vm.stopPrank();
        assertEq(uint256(desk.capacity(lineId).reason), uint256(T.Reason.MARKET_DISABLED));
    }

    function test_enrolmentCallsAndStatus() public view {
        address vault = address(0xBEEF);
        AaveEnrolment.Call[] memory calls = desk.enrolmentCalls(aaplRes, 500e6, vault, 1e8);
        assertEq(calls.length, 4);
        assertEq(calls[0].target, address(spoke));
        assertEq(calls[0].data, abi.encodeCall(IAaveSpoke.setUserPositionManager, (address(taker), true)));
        assertEq(calls[1].data, abi.encodeCall(IAaveSpoke.setUserPositionManager, (address(giver), true)));
        assertEq(calls[2].target, address(taker));
        assertEq(
            calls[2].data,
            abi.encodeCall(ITakerPositionManager.approveBorrow, (address(spoke), usdcRes, address(desk), 500e6))
        );
        assertEq(
            calls[3].data, abi.encodeCall(ITakerPositionManager.approveWithdraw, (address(spoke), aaplRes, vault, 1e8))
        );
        assertEq(desk.enrolmentCalls(aaplRes, 500e6, address(0), 1e8).length, 3);
        (bool t, bool g, uint256 b, uint256 w) = desk.enrolment(user, aaplRes);
        assertTrue(t);
        assertTrue(g);
        assertEq(b, 10_000e6);
        assertEq(w, 0);
    }

    function test_decisionHashesAreUniqueAndEmitted() public {
        vm.recordLogs();
        _draw(100e6);
        vm.prank(user);
        desk.repay(lineId, 50e6);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 drawHash;
        bytes32 repayHash;
        bytes32 sig = keccak256("Decision(uint256,bytes32,bytes32,uint256,uint256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(desk) || logs[i].topics[0] != sig) continue;
            (bytes32 h,,) = abi.decode(logs[i].data, (bytes32, uint256, uint256));
            if (logs[i].topics[2] == bytes32("DRAW")) drawHash = h;
            if (logs[i].topics[2] == bytes32("REPAY")) repayHash = h;
        }
        assertTrue(drawHash != bytes32(0) && repayHash != bytes32(0));
        assertTrue(drawHash != repayHash);
    }
}
