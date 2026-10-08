// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IMorpho, MarketParams, Id, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IrmMock} from "morpho-blue/mocks/IrmMock.sol";
import {IPolicyRegistry} from "base-std/interfaces/IPolicyRegistry.sol";
import {IEligibility} from "../../src/interfaces/IEligibility.sol";
import {IPriceGate} from "../../src/interfaces/IPriceGate.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {SessionGuard} from "../../src/oracle/SessionGuard.sol";
import {CreditDesk} from "../../src/desk/CreditDesk.sol";
import {TestPriceFeed} from "../../src/test/TestPriceFeed.sol";
import {MirrorOracleRegistry} from "../../src/test/MirrorOracleRegistry.sol";
import {MockB20} from "../../src/test/MockB20.sol";
import {MockSwapPool} from "../../src/test/MockSwapPool.sol";
import {ICLSwapPool} from "../../src/protection/interfaces/ICLSwapPool.sol";
import {DividendHarvester} from "../../src/harvest/DividendHarvester.sol";

/// @notice The self-repaying leg on the real Morpho Blue bytecode (etched from Base mainnet): a dividend arrives as a
///         registry multiplier step, the harvester repays the line with exactly the dividend-equivalent collateral in
///         an open session, and every step that is not a dividend (a split, a fall, HEADROOM, no debt) only re-bases.
contract DividendHarvesterTest is Test {
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    address constant MORPHO_ADDR = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    IMorpho constant MORPHO = IMorpho(MORPHO_ADDR);
    uint256 constant LLTV = 0.625e18;
    bytes32 constant PARTNER = "boundline";
    int256 constant PRICE = 33_366_495_000; // $333.66495
    uint256 constant PRICE36 = 3.3366495e36; // the same price in Morpho's scale: USDC raw per AAPL raw × 1e36
    uint256 constant T_REGULAR = 1_790_877_600; // Thu 2026-10-01 14:00 ET
    uint256 constant T_SAT = 1_791_024_480; // Sat 2026-10-03 06:48 ET
    uint256 constant ONE = 1e18;

    address owner = makeAddr("owner");
    address partnerAdmin = makeAddr("partnerAdmin");
    address keeper = makeAddr("keeper");
    address user = makeAddr("user");
    address plain = makeAddr("plain"); // a borrower directly on Morpho, outside the desk
    address supplier = makeAddr("supplier");
    address stranger = makeAddr("stranger");

    IrmMock irm;
    MockB20 usdc;
    MockB20 aapl;
    MarketCalendar cal;
    MirrorOracleRegistry registry;
    TestPriceFeed feed;
    SessionGate gate;
    SessionGuard guard;
    CreditDesk desk;
    MockSwapPool pool;
    DividendHarvester harvester;
    MarketParams params;
    Id id;
    uint256 lineId;

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

        params = MarketParams(address(usdc), address(aapl), address(guard), address(irm), LLTV);
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

        // The desk line: 10 AAPLc and 1,000 USDC of debt (30% LTV), drawn in session.
        aapl.mint(user, 10e8);
        vm.startPrank(user);
        aapl.approve(address(desk), type(uint256).max);
        usdc.approve(address(desk), type(uint256).max);
        MORPHO.setAuthorization(address(desk), true);
        lineId = desk.openLine(PARTNER, id, 0, "");
        desk.addCollateral(lineId, 10e8);
        desk.draw(lineId, 1000e6);
        vm.stopPrank();

        // A plain Morpho position: 4 AAPLc and 600 USDC of debt (45% LTV).
        aapl.mint(plain, 4e8);
        vm.startPrank(plain);
        aapl.approve(MORPHO_ADDR, type(uint256).max);
        MORPHO.supplyCollateral(params, 4e8, plain, "");
        MORPHO.borrow(params, 600e6, 0, plain, plain);
        vm.stopPrank();

        // The sale venue: a fixed-price pool at the feed price holding USDC (token0) and taking AAPLc (token1).
        pool = new MockSwapPool(address(usdc), address(aapl), 10, owner);
        vm.prank(owner);
        pool.setPrice36(PRICE36);
        usdc.mint(address(pool), 1_000_000e6);

        harvester = new DividendHarvester(owner, MORPHO, gate, desk, keeper);
        vm.prank(owner);
        harvester.setRoute(address(aapl), ICLSwapPool(address(pool)));
    }

    // ------------------------------------------------------------ helpers

    function _dividend(uint256 multiplier) internal {
        vm.prank(owner);
        registry.setMultiplier(address(aapl), multiplier);
    }

    function _enrollUser(DividendHarvester.Mode mode) internal {
        vm.startPrank(user);
        MORPHO.setAuthorization(address(harvester), true);
        harvester.enroll(id, lineId, mode);
        vm.stopPrank();
    }

    function _enrollPlain() internal {
        vm.startPrank(plain);
        MORPHO.setAuthorization(address(harvester), true);
        harvester.enroll(id, 0, DividendHarvester.Mode.HARVEST);
        vm.stopPrank();
    }

    function _debt(address who) internal view returns (uint256) {
        return MORPHO.expectedBorrowAssets(params, who);
    }

    function _collateral(address who) internal view returns (uint256) {
        return MORPHO.position(id, who).collateral;
    }

    function _harvest(address who) internal returns (uint256 repaid, uint256 sold) {
        vm.prank(keeper);
        return harvester.harvest(who, id, block.timestamp + 60);
    }

    struct HarvestedData {
        uint256 lineId;
        uint256 baseMultiplier;
        uint256 multiplier;
        uint256 dividendRaw;
        uint256 collateralSold;
        uint256 repaid;
        uint256 collateralReturned;
        uint256 price8;
        bytes32 decisionHash;
    }

    function _checkHarvested(Vm.Log memory lg, DividendHarvester.Preview memory p, uint256 sold, uint256 repaid)
        internal
        view
    {
        assertEq(uint256(lg.topics[1]), 1, "decision nonce");
        assertEq(address(uint160(uint256(lg.topics[2]))), user);
        assertEq(lg.topics[3], Id.unwrap(id));
        HarvestedData memory d = abi.decode(lg.data, (HarvestedData));
        assertEq(d.lineId, lineId);
        assertEq(d.baseMultiplier, ONE);
        assertEq(d.multiplier, 1.004e18);
        assertEq(d.dividendRaw, p.dividendRaw);
        assertEq(d.collateralSold, sold);
        assertEq(d.repaid, repaid);
        assertEq(d.collateralReturned, p.dividendRaw - sold, "unsold dividend collateral went back to the position");
        assertEq(d.price8, uint256(PRICE));
        DividendHarvester.Decision memory decision = DividendHarvester.Decision({
            chainId: block.chainid,
            harvester: address(harvester),
            user: user,
            marketId: id,
            lineId: lineId,
            baseMultiplier: ONE,
            multiplier: 1.004e18,
            dividendRaw: p.dividendRaw,
            collateralSold: sold,
            repaid: repaid,
            price8: uint256(PRICE),
            timestamp: block.timestamp,
            nonce: 1
        });
        assertEq(d.decisionHash, keccak256(abi.encode(decision)), "decision hash over the full tuple");
    }

    // ------------------------------------------------------------ shape and owner

    function test_shape() public view {
        assertEq(address(harvester.MORPHO()), MORPHO_ADDR);
        assertEq(address(harvester.GATE()), address(gate));
        assertEq(address(harvester.DESK()), address(desk));
        assertEq(harvester.keeper(), keeper);
        assertEq(harvester.maxStepBps(), 500);
        assertEq(harvester.maxSlippageBps(), 100);
        (ICLSwapPool p, bool collateralIsToken0) = harvester.routes(address(aapl));
        assertEq(address(p), address(pool));
        assertFalse(collateralIsToken0);
    }

    function test_ownerControls() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        harvester.setParams(400, 50);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.BadParams.selector, uint16(0), uint16(50)));
        harvester.setParams(0, 50);
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.BadParams.selector, uint16(1001), uint16(50)));
        harvester.setParams(1001, 50);
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.BadParams.selector, uint16(500), uint16(501)));
        harvester.setParams(500, 501);
        harvester.setParams(1000, 500);
        assertEq(harvester.maxStepBps(), 1000);
        assertEq(harvester.maxSlippageBps(), 500);

        MockB20 other = new MockB20("Other", "OTH", 6);
        MockSwapPool wrong = new MockSwapPool(address(usdc), address(other), 10, owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                DividendHarvester.PoolMismatch.selector, address(wrong), address(usdc), address(other)
            )
        );
        harvester.setRoute(address(aapl), ICLSwapPool(address(wrong)));
        harvester.setKeeper(stranger);
        assertEq(harvester.keeper(), stranger);
        vm.stopPrank();
    }

    function test_constructorRefusesZero() public {
        vm.expectRevert(DividendHarvester.ZeroAddress.selector);
        new DividendHarvester(owner, IMorpho(address(0)), gate, desk, keeper);
        vm.expectRevert(DividendHarvester.ZeroAddress.selector);
        new DividendHarvester(owner, MORPHO, IPriceGate(address(0)), desk, keeper);
    }

    // ------------------------------------------------------------ enrolment

    function test_enroll_recordsTheRegistryMultiplier() public {
        _dividend(1.0002e18); // a dividend paid before the enrolment is never harvested
        vm.startPrank(user);
        MORPHO.setAuthorization(address(harvester), true);
        vm.expectEmit(true, true, false, true, address(harvester));
        emit DividendHarvester.Enrolled(user, id, lineId, DividendHarvester.Mode.HARVEST, 1.0002e18);
        harvester.enroll(id, lineId, DividendHarvester.Mode.HARVEST);
        vm.stopPrank();
        DividendHarvester.Enrollment memory e = harvester.enrollment(user, id);
        assertEq(e.baseMultiplier, 1.0002e18);
        assertEq(e.lineId, lineId);
        assertEq(uint8(e.mode), uint8(DividendHarvester.Mode.HARVEST));
        assertEq(e.enrolledAt, block.timestamp);
        assertEq(uint8(harvester.preview(user, id).standing), uint8(DividendHarvester.Standing.NO_CHANGE));
    }

    function test_enroll_refusals() public {
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.BadMode.selector, DividendHarvester.Mode.NONE));
        harvester.enroll(id, lineId, DividendHarvester.Mode.NONE);
        harvester.enroll(id, lineId, DividendHarvester.Mode.HARVEST);
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.AlreadyEnrolled.selector, user, id));
        harvester.enroll(id, lineId, DividendHarvester.Mode.HEADROOM);
        vm.stopPrank();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.NotLineOwner.selector, lineId, stranger));
        harvester.enroll(id, lineId, DividendHarvester.Mode.HARVEST);

        // a line on another market
        vm.prank(owner);
        MORPHO.enableLltv(0.5e18);
        MarketParams memory other = MarketParams(address(usdc), address(aapl), address(guard), address(irm), 0.5e18);
        MORPHO.createMarket(other);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.LineMarketMismatch.selector, lineId));
        harvester.enroll(other.id(), lineId, DividendHarvester.Mode.HARVEST);

        Id unknown = Id.wrap(keccak256("no market"));
        vm.prank(plain);
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.UnknownMarket.selector, unknown));
        harvester.enroll(unknown, 0, DividendHarvester.Mode.HARVEST);

        // mid corporate action: the registry is paused, the multiplier is not to be trusted
        vm.prank(owner);
        registry.setPaused(address(aapl), true);
        vm.prank(plain);
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.RegistryUnreadable.selector, address(aapl)));
        harvester.enroll(id, 0, DividendHarvester.Mode.HARVEST);

        // a harvester without a desk serves plain positions only
        DividendHarvester deskless = new DividendHarvester(owner, MORPHO, gate, CreditDesk(address(0)), keeper);
        vm.prank(user);
        vm.expectRevert(DividendHarvester.NoDesk.selector);
        deskless.enroll(id, lineId, DividendHarvester.Mode.HARVEST);
    }

    function test_setMode_and_leave() public {
        _enrollUser(DividendHarvester.Mode.HARVEST);
        vm.startPrank(user);
        harvester.setMode(id, DividendHarvester.Mode.HEADROOM);
        assertEq(uint8(harvester.enrollment(user, id).mode), uint8(DividendHarvester.Mode.HEADROOM));
        harvester.leave(id);
        assertEq(uint8(harvester.enrollment(user, id).mode), uint8(DividendHarvester.Mode.NONE));
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.NotEnrolled.selector, user, id));
        harvester.leave(id);
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.NotEnrolled.selector, user, id));
        harvester.setMode(id, DividendHarvester.Mode.HARVEST);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ preview

    function test_preview_standings() public {
        assertEq(uint8(harvester.preview(user, id).standing), uint8(DividendHarvester.Standing.NOT_ENROLLED));
        vm.prank(user);
        harvester.enroll(id, lineId, DividendHarvester.Mode.HARVEST); // not yet authorised on Morpho

        _dividend(1.004e18);
        DividendHarvester.Preview memory p = harvester.preview(user, id);
        assertEq(uint8(p.standing), uint8(DividendHarvester.Standing.NOT_AUTHORIZED));
        vm.prank(user);
        MORPHO.setAuthorization(address(harvester), true);
        p = harvester.preview(user, id);
        assertEq(uint8(p.standing), uint8(DividendHarvester.Standing.READY));
        assertEq(p.baseMultiplier, ONE);
        assertEq(p.multiplier, 1.004e18);
        assertEq(p.collateral, 10e8);
        assertEq(p.price8, uint256(PRICE));
        assertEq(p.dividendRaw, uint256(10e8) * 0.004e18 / 1.004e18, "raw x (m1 - m0) / m1");
        assertEq(p.dividendValue, p.dividendRaw * uint256(PRICE) / 1e10, "8-dec stock, 6-dec USDC");
        assertEq(p.repayAssets, p.dividendValue * 9900 / 10_000, "less the slippage floor");
        assertFalse(p.fullRepay);

        vm.warp(T_SAT);
        assertEq(uint8(harvester.preview(user, id).standing), uint8(DividendHarvester.Standing.GATE_CLOSED));
        vm.warp(T_REGULAR);
        vm.prank(owner);
        registry.setPaused(address(aapl), true);
        assertEq(uint8(harvester.preview(user, id).standing), uint8(DividendHarvester.Standing.GATE_CLOSED));
        vm.prank(owner);
        registry.setPaused(address(aapl), false);

        _dividend(1.2e18); // a 20% rise is a corporate action, not a dividend
        assertEq(uint8(harvester.preview(user, id).standing), uint8(DividendHarvester.Standing.STEP_TOO_LARGE));
        _dividend(0.5e18);
        assertEq(uint8(harvester.preview(user, id).standing), uint8(DividendHarvester.Standing.STEP_DOWN));
        _dividend(1.004e18);
        vm.prank(user);
        harvester.setMode(id, DividendHarvester.Mode.HEADROOM);
        assertEq(uint8(harvester.preview(user, id).standing), uint8(DividendHarvester.Standing.HEADROOM));
        vm.prank(user);
        harvester.setMode(id, DividendHarvester.Mode.HARVEST);

        _dividend(1.000000001e18); // rounds to no collateral on 10 shares
        assertEq(uint8(harvester.preview(user, id).standing), uint8(DividendHarvester.Standing.TOO_SMALL));
    }

    // ------------------------------------------------------------ harvest

    function test_harvest_deskLine_repaysTheDividendAndKeepsTheShareCount() public {
        _enrollUser(DividendHarvester.Mode.HARVEST);
        _dividend(1.004e18);
        DividendHarvester.Preview memory p = harvester.preview(user, id);
        uint256 debtBefore = _debt(user);
        uint256 collBefore = _collateral(user);
        CreditDesk.Line memory lineBefore = desk.line(lineId);
        uint256 exposureBefore = desk.partner(PARTNER).exposure;

        vm.recordLogs();
        (uint256 repaid, uint256 sold) = _harvest(user);

        assertEq(repaid, p.repayAssets, "repaid what the preview said");
        assertEq(_debt(user), debtBefore - repaid, "debt fell by the repayment");
        assertLe(sold, p.dividendRaw, "never sells more than the dividend collateral");
        assertEq(sold, (repaid * 1e36 + PRICE36 - 1) / PRICE36, "exact-output sale at the pool price");
        assertEq(_collateral(user), collBefore - sold, "only the sold part left the position");
        // The share count held at m0 is kept: collateral after x m1 >= collateral before x m0.
        assertGe(_collateral(user) * 1.004e18, collBefore * ONE);
        // The desk's accounting moved with the repayment.
        assertEq(desk.line(lineId).drawnPrincipal, lineBefore.drawnPrincipal - repaid);
        assertEq(desk.partner(PARTNER).exposure, exposureBefore - repaid);
        // Nothing stays behind in the harvester.
        assertEq(usdc.balanceOf(address(harvester)), 0);
        assertEq(aapl.balanceOf(address(harvester)), 0);
        // The epoch is consumed.
        assertEq(harvester.enrollment(user, id).baseMultiplier, 1.004e18);
        assertEq(harvester.enrollment(user, id).lastHarvestAt, block.timestamp);
        assertEq(harvester.decisionCount(), 1);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(harvester) || logs[i].topics[0] != DividendHarvester.Harvested.selector) {
                continue;
            }
            found = true;
            _checkHarvested(logs[i], p, sold, repaid);
        }
        assertTrue(found, "Harvested emitted");

        // Idempotent: the same multiplier cannot be harvested twice.
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(DividendHarvester.NotHarvestable.selector, DividendHarvester.Standing.NO_CHANGE)
        );
        harvester.harvest(user, id, block.timestamp + 60);
    }

    function test_harvest_plainPosition_repaysOnMorpho() public {
        _enrollPlain();
        _dividend(1.003e18);
        DividendHarvester.Preview memory p = harvester.preview(plain, id);
        uint256 debtBefore = _debt(plain);
        uint256 collBefore = _collateral(plain);
        (uint256 repaid, uint256 sold) = _harvest(plain);
        assertEq(repaid, p.repayAssets);
        assertEq(_debt(plain), debtBefore - repaid);
        assertLe(sold, p.dividendRaw);
        assertEq(_collateral(plain), collBefore - sold);
        assertGe(_collateral(plain) * 1.003e18, collBefore * ONE);
        assertEq(desk.line(lineId).drawnPrincipal, 1000e6, "the desk line is untouched");
    }

    function test_harvest_dividendsAccumulateUntilHarvested() public {
        _enrollUser(DividendHarvester.Mode.HARVEST);
        _dividend(1.002e18);
        _dividend(1.004e18); // a second dividend before any harvest
        DividendHarvester.Preview memory p = harvester.preview(user, id);
        assertEq(p.dividendRaw, uint256(10e8) * 0.004e18 / 1.004e18, "both dividends, against the base");
        _harvest(user);
        assertEq(harvester.enrollment(user, id).baseMultiplier, 1.004e18);
    }

    function test_harvest_fullRepayWhenTheDividendCoversTheDebt() public {
        // A line with 10 USDC of debt on 10 AAPLc: a 1% dividend (about $33) clears it.
        address small = makeAddr("small");
        aapl.mint(small, 10e8);
        vm.startPrank(small);
        aapl.approve(address(desk), type(uint256).max);
        MORPHO.setAuthorization(address(desk), true);
        uint256 smallLine = desk.openLine(PARTNER, id, 0, "");
        desk.addCollateral(smallLine, 10e8);
        desk.draw(smallLine, 10e6);
        MORPHO.setAuthorization(address(harvester), true);
        harvester.enroll(id, smallLine, DividendHarvester.Mode.HARVEST);
        vm.stopPrank();

        _dividend(1.01e18);
        DividendHarvester.Preview memory p = harvester.preview(small, id);
        assertTrue(p.fullRepay);
        assertEq(p.repayAssets, _debt(small));
        (uint256 repaid, uint256 sold) = _harvest(small);
        assertEq(repaid, 10e6);
        assertEq(MORPHO.position(id, small).borrowShares, 0, "the line is debt-free");
        assertEq(desk.line(smallLine).drawnPrincipal, 0);
        assertEq(_collateral(small), 10e8 - sold, "the rest of the dividend stayed on the position");
        assertEq(usdc.balanceOf(address(harvester)), 0);
        assertEq(aapl.balanceOf(address(harvester)), 0);
    }

    function test_harvest_rebasesWhatIsNotADividend() public {
        _enrollUser(DividendHarvester.Mode.HARVEST);
        uint256 collBefore = _collateral(user);
        uint256 debtBefore = _debt(user);

        // A 2-for-1 split (multiplier x2) is not a dividend: re-base, sell nothing.
        _dividend(2e18);
        vm.expectEmit(true, true, false, true, address(harvester));
        emit DividendHarvester.Rebased(user, id, ONE, 2e18, DividendHarvester.Standing.STEP_TOO_LARGE);
        (uint256 repaid, uint256 sold) = _harvest(user);
        assertEq(repaid + sold, 0);
        assertEq(harvester.enrollment(user, id).baseMultiplier, 2e18);

        // A fall: re-base, sell nothing.
        _dividend(1.9e18);
        vm.expectEmit(true, true, false, true, address(harvester));
        emit DividendHarvester.Rebased(user, id, 2e18, 1.9e18, DividendHarvester.Standing.STEP_DOWN);
        _harvest(user);

        // HEADROOM keeps the dividend as shares.
        vm.prank(user);
        harvester.setMode(id, DividendHarvester.Mode.HEADROOM);
        _dividend(1.91e18);
        vm.expectEmit(true, true, false, true, address(harvester));
        emit DividendHarvester.Rebased(user, id, 1.9e18, 1.91e18, DividendHarvester.Standing.HEADROOM);
        _harvest(user);

        assertEq(_collateral(user), collBefore, "no collateral moved");
        assertEq(_debt(user), debtBefore, "no debt moved");
        assertEq(harvester.decisionCount(), 0, "re-bases are not decisions");
    }

    function test_harvest_noDebtKeepsTheDividend() public {
        _enrollUser(DividendHarvester.Mode.HARVEST);
        usdc.mint(user, 2000e6);
        uint256 all = desk.REPAY_ALL();
        vm.prank(user);
        desk.repay(lineId, all);
        _dividend(1.004e18);
        vm.expectEmit(true, true, false, true, address(harvester));
        emit DividendHarvester.Rebased(user, id, ONE, 1.004e18, DividendHarvester.Standing.NO_DEBT);
        _harvest(user);
        assertEq(_collateral(user), 10e8);
    }

    function test_harvest_refusals() public {
        _enrollUser(DividendHarvester.Mode.HARVEST);
        _dividend(1.004e18);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.NotOperator.selector, stranger));
        harvester.harvest(user, id, block.timestamp + 60);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.Expired.selector, block.timestamp - 1));
        harvester.harvest(user, id, block.timestamp - 1);

        // The sale gate: never on a weekend.
        vm.warp(T_SAT);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(DividendHarvester.NotHarvestable.selector, DividendHarvester.Standing.GATE_CLOSED)
        );
        harvester.harvest(user, id, block.timestamp + 60);
        vm.warp(T_REGULAR);

        // Without the Morpho authorisation.
        vm.prank(user);
        MORPHO.setAuthorization(address(harvester), false);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(DividendHarvester.NotHarvestable.selector, DividendHarvester.Standing.NOT_AUTHORIZED)
        );
        harvester.harvest(user, id, block.timestamp + 60);
        vm.prank(user);
        MORPHO.setAuthorization(address(harvester), true);

        // Without a route.
        DividendHarvester bare = new DividendHarvester(owner, MORPHO, gate, desk, keeper);
        vm.startPrank(user);
        MORPHO.setAuthorization(address(bare), true);
        bare.enroll(id, lineId, DividendHarvester.Mode.HARVEST);
        vm.stopPrank();
        _dividend(1.008e18);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.NoRoute.selector, address(aapl)));
        bare.harvest(user, id, block.timestamp + 60);
    }

    function test_harvest_refusesToSellBelowTheFloor() public {
        _enrollUser(DividendHarvester.Mode.HARVEST);
        _dividend(1.004e18);
        vm.prank(owner);
        pool.setPrice36(PRICE36 * 97 / 100); // the pool pays 3% under the feed; the floor is 1%
        vm.prank(keeper);
        vm.expectPartialRevert(DividendHarvester.SlippageExceeded.selector);
        harvester.harvest(user, id, block.timestamp + 60);
        // Within the floor it runs.
        vm.prank(owner);
        pool.setPrice36(PRICE36 * 9950 / 10_000);
        uint256 dividendRaw = harvester.preview(user, id).dividendRaw;
        (uint256 repaid, uint256 sold) = _harvest(user);
        assertGt(repaid, 0);
        assertLe(sold, dividendRaw, "even half a percent under the feed, never more than the dividend");
    }

    function test_callbacksAreGuarded() public {
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.UnexpectedCallback.selector, address(this)));
        harvester.onMorphoFlashLoan(1, "");
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.UnexpectedCallback.selector, address(this)));
        harvester.uniswapV3SwapCallback(0, 1, "");
        vm.prank(address(pool));
        vm.expectRevert(abi.encodeWithSelector(DividendHarvester.UnexpectedCallback.selector, address(pool)));
        harvester.uniswapV3SwapCallback(0, 1, "");
    }

    /// @dev Across position sizes, LTVs, dividend steps and pool prices within the floor: the sale never exceeds the
    ///      dividend collateral, the LTV never rises, the share count held at m0 is kept, and the debt falls by exactly
    ///      what was repaid.
    function testFuzz_harvest_invariants(uint256 collateral, uint256 ltvBps, uint256 stepBps, uint256 poolDiscountBps)
        public
    {
        collateral = bound(collateral, 1e8, 1000e8);
        ltvBps = bound(ltvBps, 500, 6000);
        stepBps = bound(stepBps, 1, 500);
        poolDiscountBps = bound(poolDiscountBps, 0, 99);

        address who = makeAddr("fuzz");
        aapl.mint(who, collateral);
        uint256 value = collateral * uint256(PRICE) / 1e10;
        uint256 borrow = value * ltvBps / 10_000;
        vm.assume(borrow > 0);
        vm.startPrank(who);
        aapl.approve(MORPHO_ADDR, type(uint256).max);
        MORPHO.supplyCollateral(params, collateral, who, "");
        MORPHO.borrow(params, borrow, 0, who, who);
        MORPHO.setAuthorization(address(harvester), true);
        harvester.enroll(id, 0, DividendHarvester.Mode.HARVEST);
        vm.stopPrank();
        vm.prank(owner);
        pool.setPrice36(PRICE36 * (10_000 - poolDiscountBps) / 10_000);

        uint256 m1 = ONE + ONE * stepBps / 10_000;
        _dividend(m1);
        DividendHarvester.Preview memory p = harvester.preview(who, id);
        if (p.standing != DividendHarvester.Standing.READY) return; // too small to harvest
        uint256 debtBefore = _debt(who);
        (uint256 repaid, uint256 sold) = _harvest(who);

        assertLe(sold, p.dividendRaw, "sold <= dividend collateral");
        assertEq(_debt(who), debtBefore - repaid, "debt down by exactly the repayment");
        assertEq(_collateral(who), collateral - sold);
        assertLe(_debt(who) * collateral, debtBefore * _collateral(who), "LTV never rises");
        assertGe(_collateral(who) * m1, collateral * ONE, "the share count held at m0 is kept");
        assertEq(aapl.balanceOf(address(harvester)), 0);
        assertEq(usdc.balanceOf(address(harvester)), 0);
    }
}
