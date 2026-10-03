// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IMorpho, MarketParams, Id, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IrmMock} from "morpho-blue/mocks/IrmMock.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IPolicyRegistry} from "base-std/interfaces/IPolicyRegistry.sol";
import {IMarketCalendar} from "../src/interfaces/IMarketCalendar.sol";
import {IEligibility} from "../src/interfaces/IEligibility.sol";
import {MarketCalendar} from "../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../src/calendar/Nyse2026.sol";
import {SessionGate} from "../src/oracle/SessionGate.sol";
import {SessionGuard} from "../src/oracle/SessionGuard.sol";
import {CreditDesk} from "../src/desk/CreditDesk.sol";
import {TestPriceFeed} from "../src/test/TestPriceFeed.sol";
import {MirrorOracleRegistry} from "../src/test/MirrorOracleRegistry.sol";
import {MockB20} from "../src/test/MockB20.sol";

contract MockEligibility is IEligibility {
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

/// @notice CreditDesk against the real Morpho Blue bytecode (etched from Base mainnet at its own
///         address, owner slot set) so every venue call path is the production one, with no network.
contract CreditDeskTest is Test {
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    address constant MORPHO_ADDR = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    IMorpho constant MORPHO = IMorpho(MORPHO_ADDR);
    uint256 constant LLTV = 0.625e18;
    bytes32 constant PARTNER = "boundline";
    int256 constant PRICE = 33_366_495_000; // $333.66495
    uint256 constant T_REGULAR = 1_790_877_600; // Thu 2026-10-01 14:00 ET
    uint256 constant T_SAT = 1_791_024_480; // Sat 2026-10-03 06:48 ET
    uint256 constant REPAY_ALL = type(uint256).max;
    uint256 constant T_MON = 1_791_208_800; // Mon 2026-10-05 10:00 ET

    address owner = makeAddr("owner");
    address partnerAdmin = makeAddr("partnerAdmin");
    address keeper = makeAddr("keeper");
    address user = makeAddr("user");
    address supplier = makeAddr("supplier");
    address stranger = makeAddr("stranger");
    uint256 signerKey = 0xA11CE;
    address signer = vm.addr(signerKey);

    IrmMock irm;
    MockB20 usdc;
    MockB20 aapl;
    MarketCalendar cal;
    MirrorOracleRegistry registry;
    TestPriceFeed feed;
    SessionGate gate;
    SessionGuard guard;
    CreditDesk desk;
    MarketParams params;
    Id id;
    uint256 lineId;

    function setUp() public {
        vm.warp(T_REGULAR);
        bytes memory code = vm.parseBytes(vm.readFile("test/fixtures/morpho-blue-8453.runtime.hex"));
        vm.etch(MORPHO_ADDR, code);
        vm.store(MORPHO_ADDR, bytes32(0), bytes32(uint256(uint160(owner)))); // Morpho.owner
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

        params = MarketParams({
            loanToken: address(usdc),
            collateralToken: address(aapl),
            oracle: address(guard),
            irm: address(irm),
            lltv: LLTV
        });
        id = params.id();
        MORPHO.createMarket(params);

        usdc.mint(supplier, 1_000_000e6);
        vm.startPrank(supplier);
        usdc.approve(MORPHO_ADDR, type(uint256).max);
        MORPHO.supply(params, 1_000_000e6, 0, supplier, "");
        vm.stopPrank();

        desk = new CreditDesk(owner, MORPHO, gate, IPolicyRegistry(address(0)), false, keeper);
        vm.startPrank(owner);
        desk.registerMarket(params);
        desk.createPartner(PARTNER, partnerAdmin, address(0), IEligibility(address(0)), 100_000e6);
        vm.stopPrank();
        vm.prank(partnerAdmin);
        desk.setTickerPolicy(PARTNER, address(aapl), true, 0.5e18, 10e6, 5000e6, 50_000e6);

        aapl.mint(user, 10e8);
        vm.startPrank(user);
        aapl.approve(address(desk), type(uint256).max);
        usdc.approve(address(desk), type(uint256).max);
        MORPHO.setAuthorization(address(desk), true);
        lineId = desk.openLine(PARTNER, id, 0, "");
        desk.addCollateral(lineId, 10e8);
        vm.stopPrank();
    }

    function _fresh() internal {
        vm.prank(owner);
        feed.setAnswer(PRICE);
    }

    function _draw(uint256 amount) internal {
        vm.prank(user);
        desk.draw(lineId, amount);
    }

    function _expectRefused(CreditDesk.Reason r) internal {
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.Refused.selector, r));
    }

    // ------------------------------------------------------------ open

    function test_openLine_recordsTheLine() public view {
        CreditDesk.Line memory l = desk.line(lineId);
        assertEq(l.partnerId, PARTNER);
        assertEq(l.user, user);
        assertEq(Id.unwrap(l.marketId), Id.unwrap(id));
        assertEq(l.collateral, address(aapl));
        assertEq(uint256(l.status), uint256(CreditDesk.LineStatus.OPEN));
        assertEq(l.policyVersion, 2); // created at 1, ticker policy bumped it
        assertEq(desk.lineOf(PARTNER, user, id), lineId);
        assertEq(desk.lineCount(), 1);
    }

    function test_openLine_refusals() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.UnknownPartner.selector, bytes32("nobody")));
        desk.openLine("nobody", id, 0, "");
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.UnknownMarket.selector, Id.wrap(bytes32(uint256(1)))));
        desk.openLine(PARTNER, Id.wrap(bytes32(uint256(1))), 0, "");
        vm.stopPrank();

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.LineExists.selector, lineId));
        desk.openLine(PARTNER, id, 0, "");

        vm.prank(owner);
        desk.setMarketEnabled(id, false);
        vm.prank(stranger);
        _expectRefused(CreditDesk.Reason.MARKET_DISABLED);
        desk.openLine(PARTNER, id, 0, "");
        vm.prank(owner);
        desk.setMarketEnabled(id, true);

        vm.prank(partnerAdmin);
        desk.setTickerPolicy(PARTNER, address(aapl), false, 0.5e18, 10e6, 5000e6, 50_000e6);
        vm.prank(stranger);
        _expectRefused(CreditDesk.Reason.TICKER_NOT_ALLOWED);
        desk.openLine(PARTNER, id, 0, "");
        vm.prank(partnerAdmin);
        desk.setTickerPolicy(PARTNER, address(aapl), true, 0.5e18, 10e6, 5000e6, 50_000e6);

        vm.prank(partnerAdmin);
        desk.setPartnerConfig(PARTNER, address(0), IEligibility(address(0)), 100_000e6, false);
        vm.prank(stranger);
        _expectRefused(CreditDesk.Reason.PARTNER_INACTIVE);
        desk.openLine(PARTNER, id, 0, "");
        vm.prank(partnerAdmin);
        desk.setPartnerConfig(PARTNER, address(0), IEligibility(address(0)), 100_000e6, true);

        vm.prank(owner);
        desk.setPaused(true);
        vm.prank(stranger);
        _expectRefused(CreditDesk.Reason.DESK_PAUSED);
        desk.openLine(PARTNER, id, 0, "");
    }

    function test_openLine_withPartnerSignature() public {
        bytes32 signed = "signed";
        vm.prank(owner);
        desk.createPartner(signed, partnerAdmin, signer, IEligibility(address(0)), 0);
        vm.prank(partnerAdmin);
        desk.setTickerPolicy(signed, address(aapl), true, 0.5e18, 0, 0, 0);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = desk.lineAuthorizationDigest(signed, stranger, id, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(stranger);
        vm.expectRevert(CreditDesk.BadAuthorization.selector);
        desk.openLine(signed, id, deadline, hex"");

        vm.prank(user); // a signature for `stranger` does not open a line for `user`
        vm.expectRevert(CreditDesk.BadAuthorization.selector);
        desk.openLine(signed, id, deadline, sig);

        vm.prank(stranger);
        uint256 newLine = desk.openLine(signed, id, deadline, sig);
        assertEq(desk.line(newLine).user, stranger);
        assertEq(desk.nonces(stranger), 1);

        // replay: the nonce moved on, the same signature is dead
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.LineExists.selector, newLine));
        desk.openLine(signed, id, deadline, sig);

        vm.warp(deadline + 1);
        bytes32 d2 = desk.lineAuthorizationDigest(signed, keeper, id, 0, deadline);
        (v, r, s) = vm.sign(signerKey, d2);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.AuthorizationExpired.selector, deadline));
        desk.openLine(signed, id, deadline, abi.encodePacked(r, s, v));
    }

    // ------------------------------------------------------------ collateral and capacity

    function test_addCollateral_landsOnTheUsersOwnPosition() public {
        Position memory p = MORPHO.position(id, user);
        assertEq(p.collateral, 10e8);
        assertEq(aapl.balanceOf(address(desk)), 0, "the desk holds nothing");
        aapl.mint(stranger, 1e8);
        vm.startPrank(stranger);
        aapl.approve(address(desk), 1e8);
        desk.addCollateral(lineId, 1e8); // anyone may fund, it still lands on the owner's position
        vm.stopPrank();
        assertEq(MORPHO.position(id, user).collateral, 11e8);
    }

    function test_capacity_inSession() public view {
        CreditDesk.Quote memory q = desk.capacity(lineId);
        assertEq(uint256(q.reason), uint256(CreditDesk.Reason.NONE));
        assertEq(q.price8, uint256(PRICE));
        assertEq(q.collateralRaw, 10e8);
        assertEq(q.collateralValue, 3_336_649_500); // $3,336.6495 in USDC units
        assertEq(q.effectiveMaxLtvWad, 0.5e18);
        assertEq(q.maxDebt, 1_668_324_750);
        assertEq(q.available, 1_668_324_750);
        assertEq(q.debt, 0);
        assertFalse(q.corporateActionHaircut);
    }

    function test_policyIsClampedToTheVenueLltv() public {
        vm.prank(partnerAdmin);
        desk.setTickerPolicy(PARTNER, address(aapl), true, 0.9e18, 0, 0, 0);
        assertEq(desk.capacity(lineId).effectiveMaxLtvWad, LLTV);
        vm.prank(partnerAdmin);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.BadLtv.selector, uint64(1e18)));
        desk.setTickerPolicy(PARTNER, address(aapl), true, 1e18, 0, 0, 0);
        vm.prank(partnerAdmin);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.BadDrawBounds.selector, uint128(50e6), uint128(10e6)));
        desk.setTickerPolicy(PARTNER, address(aapl), true, 0.5e18, 50e6, 10e6, 0);
    }

    function testFuzz_effectiveLtvNeverExceedsVenueLltv(uint64 maxLtv) public {
        maxLtv = uint64(bound(maxLtv, 1, 1e18 - 1));
        vm.prank(partnerAdmin);
        desk.setTickerPolicy(PARTNER, address(aapl), true, maxLtv, 0, 0, 0);
        assertLe(desk.capacity(lineId).effectiveMaxLtvWad, LLTV);
    }

    // ------------------------------------------------------------ draw

    function test_draw_inSessionPaysTheOwner() public {
        _draw(1000e6);
        assertEq(usdc.balanceOf(user), 1000e6);
        assertEq(usdc.balanceOf(address(desk)), 0);
        assertGt(MORPHO.position(id, user).borrowShares, 0);
        assertEq(desk.line(lineId).drawnPrincipal, 1000e6);
        assertEq(desk.partner(PARTNER).exposure, 1000e6);
        assertEq(desk.tickerPolicy(PARTNER, address(aapl)).exposure, 1000e6);
        CreditDesk.Quote memory q = desk.capacity(lineId);
        assertEq(q.debt, 1000e6);
        assertEq(q.available, 668_324_750);
    }

    function test_draw_onlyTheOwner() public {
        vm.prank(stranger);
        vm.expectRevert(CreditDesk.NotLineOwner.selector);
        desk.draw(lineId, 100e6);
    }

    function test_draw_refusedOnTheWeekend() public {
        _fresh();
        vm.warp(T_SAT);
        CreditDesk.Quote memory q = desk.quote(lineId, 100e6);
        assertEq(uint256(q.reason), uint256(CreditDesk.Reason.MARKET_CLOSED));
        assertEq(uint256(q.session), uint256(IMarketCalendar.Session.WEEKEND));
        assertEq(q.price8, 0, "no price is quoted while closed");
        _expectRefused(CreditDesk.Reason.MARKET_CLOSED);
        _draw(100e6);
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(CreditDesk.ObligationStatus.HOLD_SESSION));
    }

    function test_draw_policyRefusals() public {
        _expectRefused(CreditDesk.Reason.BELOW_MIN_DRAW);
        _draw(5e6);
        _expectRefused(CreditDesk.Reason.ABOVE_MAX_DRAW);
        _draw(6000e6);
        _expectRefused(CreditDesk.Reason.INSUFFICIENT_CAPACITY);
        _draw(1700e6);

        vm.prank(partnerAdmin);
        desk.setPartnerConfig(PARTNER, address(0), IEligibility(address(0)), 500e6, true);
        _expectRefused(CreditDesk.Reason.PARTNER_CAP);
        _draw(600e6);
        vm.prank(partnerAdmin);
        desk.setPartnerConfig(PARTNER, address(0), IEligibility(address(0)), 100_000e6, true);

        vm.prank(partnerAdmin);
        desk.setTickerPolicy(PARTNER, address(aapl), true, 0.5e18, 10e6, 5000e6, 300e6);
        _expectRefused(CreditDesk.Reason.TICKER_CAP);
        _draw(400e6);
        vm.prank(partnerAdmin);
        desk.setTickerPolicy(PARTNER, address(aapl), true, 0.5e18, 10e6, 5000e6, 50_000e6);

        vm.prank(user);
        MORPHO.setAuthorization(address(desk), false);
        _expectRefused(CreditDesk.Reason.NOT_AUTHORIZED_ON_VENUE);
        _draw(100e6);
        vm.prank(user);
        MORPHO.setAuthorization(address(desk), true);

        _draw(100e6); // and the same amount clears once nothing refuses it
    }

    function test_draw_gateRefusals() public {
        vm.prank(owner);
        registry.setPaused(address(aapl), true);
        _expectRefused(CreditDesk.Reason.FEED_PAUSED);
        _draw(100e6);
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(CreditDesk.ObligationStatus.HOLD_ISSUER));
        vm.prank(owner);
        registry.setPaused(address(aapl), false);

        aapl.setPaused(IB20.PausableFeature.TRANSFER, true);
        _expectRefused(CreditDesk.Reason.TRANSFER_PAUSED);
        _draw(100e6);
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(CreditDesk.ObligationStatus.HOLD_TRANSFER));
        aapl.setPaused(IB20.PausableFeature.TRANSFER, false);

        vm.prank(owner);
        feed.setAnswerAt(PRICE, block.timestamp - 27 hours);
        _expectRefused(CreditDesk.Reason.FEED_STALE);
        _draw(100e6);
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(CreditDesk.ObligationStatus.HOLD_FEED));
        _fresh();
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(CreditDesk.ObligationStatus.OPEN));
    }

    function test_draw_eligibilityHook() public {
        MockEligibility hook = new MockEligibility();
        vm.prank(partnerAdmin);
        desk.setPartnerConfig(PARTNER, address(0), hook, 100_000e6, true);
        _expectRefused(CreditDesk.Reason.NOT_ELIGIBLE);
        _draw(100e6);
        hook.set(user, true);
        _draw(100e6);
        hook.setRevertAll(true);
        _expectRefused(CreditDesk.Reason.NOT_ELIGIBLE); // a broken hook fails closed
        _draw(100e6);
    }

    function test_draw_whilePausedOrHeld() public {
        vm.prank(keeper);
        desk.hold(lineId, "shadow HF below grace");
        _expectRefused(CreditDesk.Reason.LINE_HELD);
        _draw(100e6);
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(CreditDesk.ObligationStatus.HOLD_KEEPER));
        vm.prank(keeper);
        desk.release(lineId);
        vm.prank(owner);
        desk.setPaused(true);
        _expectRefused(CreditDesk.Reason.DESK_PAUSED);
        _draw(100e6);
    }

    function testFuzz_drawNeverExceedsThePolicyLtv(uint96 amount) public {
        amount = uint96(bound(amount, 10e6, 5000e6));
        CreditDesk.Quote memory q = desk.quote(lineId, amount);
        if (q.reason != CreditDesk.Reason.NONE) {
            _expectRefused(q.reason);
            _draw(amount);
            return;
        }
        _draw(amount);
        uint256 debt = MORPHO.expectedBorrowAssets(params, user);
        assertLe(debt, q.maxDebt + 1);
    }

    // ------------------------------------------------------------ repay

    function test_repay_alwaysOpenForAnyone() public {
        _draw(1000e6);
        _fresh();
        vm.warp(T_SAT);
        vm.prank(user);
        assertEq(desk.repay(lineId, 400e6), 400e6);
        usdc.mint(stranger, 100e6);
        vm.startPrank(stranger);
        usdc.approve(address(desk), 100e6);
        assertEq(desk.repay(lineId, 100e6), 100e6);
        vm.stopPrank();
        uint256 debt = desk.capacity(lineId).debt;
        assertApproxEqAbs(debt, 500e6, 10_000, "500 USDC plus two days of interest");
        assertEq(desk.line(lineId).drawnPrincipal, 500e6, "principal is tracked net of interest");
        assertEq(desk.partner(PARTNER).exposure, 500e6);

        uint256 before = usdc.balanceOf(user);
        vm.prank(user);
        uint256 repaid = desk.repay(lineId, REPAY_ALL);
        assertEq(repaid, debt, "a full repay costs exactly the quoted debt");
        assertEq(before - usdc.balanceOf(user), debt, "nothing more is pulled");
        assertEq(MORPHO.position(id, user).borrowShares, 0);
        assertEq(desk.line(lineId).drawnPrincipal, 0);
        assertEq(desk.partner(PARTNER).exposure, 0);
        assertEq(desk.tickerPolicy(PARTNER, address(aapl)).exposure, 0);
    }

    function test_repay_clearsAccruedInterest() public {
        _draw(1000e6);
        vm.warp(T_REGULAR + 365 days);
        uint256 debt = MORPHO.expectedBorrowAssets(params, user);
        assertGt(debt, 1000e6, "interest accrued");
        usdc.mint(user, debt);
        vm.prank(user);
        uint256 repaid = desk.repay(lineId, REPAY_ALL);
        assertEq(repaid, debt);
        assertEq(MORPHO.position(id, user).borrowShares, 0);
        assertEq(desk.line(lineId).drawnPrincipal, 0, "principal never goes negative");
    }

    function test_repay_nothingToRepay() public {
        vm.prank(user);
        vm.expectRevert(CreditDesk.NothingToRepay.selector);
        desk.repay(lineId, 1e6);
    }

    // ------------------------------------------------------------ withdraw and close

    function test_withdrawCollateral_sessionGatedAndPolicyBound() public {
        _draw(1000e6);
        vm.prank(user);
        desk.withdrawCollateral(lineId, 2e8); // 8 shares left: $2,669 x 50% = $1,334 >= $1,000
        assertEq(aapl.balanceOf(user), 2e8);
        assertEq(MORPHO.position(id, user).collateral, 8e8);

        vm.prank(user);
        _expectRefused(CreditDesk.Reason.INSUFFICIENT_CAPACITY); // 3 shares left: $1,000 x 50% < $1,000
        desk.withdrawCollateral(lineId, 5e8);

        vm.prank(user);
        _expectRefused(CreditDesk.Reason.INSUFFICIENT_CAPACITY); // more than the position holds
        desk.withdrawCollateral(lineId, 9e8);

        _fresh();
        vm.warp(T_SAT);
        vm.prank(user);
        _expectRefused(CreditDesk.Reason.MARKET_CLOSED);
        desk.withdrawCollateral(lineId, 1e8);

        vm.prank(stranger);
        vm.expectRevert(CreditDesk.NotLineOwner.selector);
        desk.withdrawCollateral(lineId, 1e8);
    }

    function test_closeLine() public {
        _draw(100e6);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.DebtOutstanding.selector, 100e6));
        desk.closeLine(lineId);
        vm.startPrank(user);
        desk.repay(lineId, REPAY_ALL);
        desk.closeLine(lineId);
        vm.stopPrank();
        assertEq(uint256(desk.line(lineId).status), uint256(CreditDesk.LineStatus.CLOSED));
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(CreditDesk.ObligationStatus.CLOSED));
        assertEq(desk.lineOf(PARTNER, user, id), 0);
        vm.prank(user);
        _expectRefused(CreditDesk.Reason.LINE_NOT_OPEN);
        desk.draw(lineId, 100e6);
        vm.prank(user);
        uint256 again = desk.openLine(PARTNER, id, 0, "");
        assertEq(again, 2);
        assertEq(MORPHO.position(id, user).collateral, 10e8, "collateral stayed on the user's position");
    }

    // ------------------------------------------------------------ keeper, corporate actions, admin

    function test_keeperOnly() public {
        vm.prank(stranger);
        vm.expectRevert(CreditDesk.NotKeeper.selector);
        desk.hold(lineId, "x");
        vm.prank(keeper);
        desk.hold(lineId, "x");
        assertEq(desk.line(lineId).holdReason, bytes32("x"));
        vm.prank(keeper);
        _expectRefused(CreditDesk.Reason.LINE_NOT_OPEN);
        desk.hold(lineId, "twice");
        _draw_refusedButRepayWorksWhileHeld();
    }

    function _draw_refusedButRepayWorksWhileHeld() internal {
        vm.prank(keeper);
        desk.release(lineId);
        _draw(100e6);
        vm.prank(keeper);
        desk.hold(lineId, "grace");
        vm.prank(user);
        desk.repay(lineId, 50e6); // protection never waits for a release
        assertEq(desk.capacity(lineId).debt, 50e6);
    }

    function test_corporateActionHaircut() public {
        aapl.setUIMultiplier(1e18, 0.5e18, block.timestamp + 1 days); // reverse split inside the horizon
        CreditDesk.Quote memory q = desk.capacity(lineId);
        assertTrue(q.corporateActionHaircut);
        assertEq(q.collateralValue, 3_336_649_500 / 2);
        aapl.setUIMultiplier(1e18, 0.5e18, block.timestamp + 8 days); // beyond the horizon
        assertFalse(desk.capacity(lineId).corporateActionHaircut);
        aapl.setUIMultiplier(1e18, 2e18, block.timestamp + 1 days); // a split adds, never haircuts
        q = desk.capacity(lineId);
        assertFalse(q.corporateActionHaircut);
        assertEq(q.collateralValue, 3_336_649_500);
    }

    function test_registerMarket_validation() public {
        MarketParams memory other = MarketParams({
            loanToken: address(usdc),
            collateralToken: address(aapl),
            oracle: address(feed),
            irm: address(irm),
            lltv: LLTV
        });
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.UnknownMarket.selector, other.id()));
        desk.registerMarket(other);
        MORPHO.createMarket(other);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.OracleNotSessionGuard.selector, address(feed)));
        desk.registerMarket(other);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.MarketAlreadyRegistered.selector, id));
        desk.registerMarket(params);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert();
        desk.registerMarket(params);
    }

    function test_decisionHashesAreUniquePerTransition() public {
        vm.recordLogs();
        _draw(100e6);
        vm.prank(user);
        desk.repay(lineId, 50e6);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 decisionTopic = keccak256("Decision(uint256,bytes32,bytes32,uint256,uint256)");
        bytes32 first;
        uint256 seen;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] != decisionTopic) continue;
            (bytes32 h,,) = abi.decode(logs[i].data, (bytes32, uint256, uint256));
            if (seen == 0) first = h;
            else assertTrue(h != first, "hashes differ");
            seen++;
        }
        assertEq(seen, 2);
    }
}
