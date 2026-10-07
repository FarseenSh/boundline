// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IrmMock} from "morpho-blue/mocks/IrmMock.sol";
import {IPolicyRegistry} from "base-std/interfaces/IPolicyRegistry.sol";
import {IEligibility} from "../../src/interfaces/IEligibility.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {SessionGuard} from "../../src/oracle/SessionGuard.sol";
import {CreditDesk} from "../../src/desk/CreditDesk.sol";
import {TestPriceFeed} from "../../src/test/TestPriceFeed.sol";
import {MirrorOracleRegistry} from "../../src/test/MirrorOracleRegistry.sol";
import {MockB20} from "../../src/test/MockB20.sol";
import {BoundlineReserve} from "../../src/reserve/BoundlineReserve.sol";
import {DeskProtectionVault} from "../../src/reserve/DeskProtectionVault.sol";

/// @notice DeskProtectionVault over the CreditDesk on the real Morpho Blue bytecode (etched from Base
///         mainnet, the world `test/CreditDesk.t.sol` builds): the funding ladder on a Saturday, refunds,
///         caps, settlement, Monday recovery through the desk, and the Reserve as the funder.
contract DeskProtectionVaultTest is Test {
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    address constant MORPHO_ADDR = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    IMorpho constant MORPHO = IMorpho(MORPHO_ADDR);
    uint256 constant LLTV = 0.625e18;
    bytes32 constant PARTNER = "boundline";
    int256 constant PRICE = 33_366_495_000; // $333.66495
    uint256 constant T_REGULAR = 1_790_877_600; // Thu 2026-10-01 14:00 ET
    uint256 constant T_SAT = 1_791_024_480; // Sat 2026-10-03 06:48 ET
    uint256 constant T_MON = 1_791_208_800; // Mon 2026-10-05 10:00 ET

    address owner = makeAddr("owner");
    address partnerAdmin = makeAddr("partnerAdmin");
    address keeper = makeAddr("keeper");
    address user = makeAddr("user");
    address supplier = makeAddr("supplier");
    address stranger = makeAddr("stranger");
    address alice = makeAddr("alice"); // a Reserve depositor

    IrmMock irm;
    MockB20 usdc;
    MockB20 aapl;
    MarketCalendar cal;
    MirrorOracleRegistry registry;
    TestPriceFeed feed;
    SessionGate gate;
    SessionGuard guard;
    CreditDesk desk;
    DeskProtectionVault vault;
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
        desk.draw(lineId, 1000e6); // 10 AAPLc, 1,000 USDC of debt, in session
        vm.stopPrank();

        vault = new DeskProtectionVault(owner, desk, IERC20(address(usdc)), keeper);
        vm.startPrank(owner);
        vault.setPartnerAdmin(PARTNER, partnerAdmin);
        vault.setAdvanceTerms(500e6, 100); // 1% advance fee, 500 USDC per line
        desk.setProtectionVault(address(vault));
        vm.stopPrank();

        usdc.mint(owner, 100_000e6);
        usdc.mint(partnerAdmin, 100_000e6);
        usdc.mint(stranger, 100_000e6);
        vm.prank(owner);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(partnerAdmin);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(stranger);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(user);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _fresh() internal {
        vm.prank(owner);
        feed.setAnswer(PRICE);
    }

    function _saturday() internal {
        _fresh();
        vm.warp(T_SAT);
    }

    function _monday() internal {
        vm.warp(T_MON);
        _fresh();
    }

    function _conserved() internal view {
        assertEq(
            usdc.balanceOf(address(vault)),
            vault.userBalance(user) + vault.userBalance(stranger) + vault.partnerBalance(PARTNER)
                + vault.advanceLiquidity() + vault.feesCollected(),
            "USDC held == reserves + free advances + fees"
        );
        assertEq(
            vault.totalAdvanced(), vault.totalSettled() + vault.totalOutstanding(), "advanced == settled + outstanding"
        );
        assertEq(aapl.balanceOf(address(vault)), vault.heldCollateral(lineId), "held collateral is attributed");
    }

    function _debt() internal view returns (uint256) {
        return MORPHO.expectedBorrowAssets(params, user);
    }

    // ------------------------------------------------------------ shape

    function test_shape() public view {
        assertEq(address(vault.DESK()), address(desk));
        assertEq(address(vault.MORPHO()), MORPHO_ADDR);
        assertEq(address(vault.GATE()), address(gate));
        assertEq(address(vault.USDC()), address(usdc));
        assertEq(vault.keeper(), keeper);
        assertEq(vault.advanceCapPerLine(), 500e6);
        assertEq(vault.advanceFeeBps(), 100);
        assertEq(vault.debtOf(lineId), 1000e6);
        assertEq(desk.protectionVault(), address(vault));
    }

    function test_constructorChecks() public {
        vm.expectRevert(DeskProtectionVault.ZeroAddress.selector);
        new DeskProtectionVault(owner, CreditDesk(address(0)), IERC20(address(usdc)), keeper);
        vm.expectRevert(DeskProtectionVault.ZeroAddress.selector);
        new DeskProtectionVault(owner, desk, IERC20(address(0)), keeper);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(DeskProtectionVault.FeeTooHigh.selector, uint16(501)));
        vault.setAdvanceTerms(1e6, 501);
    }

    // ------------------------------------------------------------ reserves and funding

    function test_depositsAndWithdrawals() public {
        vm.prank(user);
        vault.deposit(100e6);
        vm.prank(stranger);
        vault.depositFor(user, 50e6);
        assertEq(vault.userBalance(user), 150e6);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(DeskProtectionVault.InsufficientBalance.selector, 150e6, 151e6));
        vault.withdraw(151e6);
        vm.prank(user);
        vault.withdraw(150e6);
        assertEq(vault.userBalance(user), 0);

        vm.prank(stranger);
        vault.depositForPartner(PARTNER, 300e6);
        vm.prank(stranger);
        vm.expectRevert(DeskProtectionVault.NotPartnerAdmin.selector);
        vault.withdrawPartner(PARTNER, 1e6, stranger);
        vm.prank(partnerAdmin);
        vault.withdrawPartner(PARTNER, 300e6, partnerAdmin);
        assertEq(vault.partnerBalance(PARTNER), 0);
        vm.prank(stranger);
        vm.expectRevert(DeskProtectionVault.NotPartnerAdmin.selector);
        vault.depositForPartner("unknown", 1e6);
        _conserved();
    }

    function test_fundingIsForTheOwnerOrTheFunder() public {
        vm.prank(stranger);
        vm.expectRevert(DeskProtectionVault.NotFunder.selector);
        vault.fundAdvances(1e6);
        vm.startPrank(owner);
        vault.fundAdvances(1000e6);
        vm.expectRevert(abi.encodeWithSelector(DeskProtectionVault.InsufficientBalance.selector, 1000e6, 1001e6));
        vault.defundAdvances(1001e6, owner);
        vault.defundAdvances(400e6, owner);
        vault.setFunder(stranger);
        vm.stopPrank();
        vm.startPrank(stranger);
        vault.fundAdvances(100e6);
        vault.defundAdvances(100e6, stranger);
        vault.collectFees(stranger);
        vm.stopPrank();
        assertEq(vault.advanceLiquidity(), 600e6);
        _conserved();
    }

    // ------------------------------------------------------------ protect

    function test_protect_walksTheLadderOnTheWeekend() public {
        vm.prank(user);
        vault.deposit(50e6);
        vm.prank(partnerAdmin);
        vault.depositForPartner(PARTNER, 30e6);
        vm.prank(owner);
        vault.fundAdvances(1000e6);
        _saturday();
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(CreditDesk.ObligationStatus.HOLD_SESSION));
        uint256 debtBefore = _debt();

        DeskProtectionVault.Funding memory p = vault.previewProtect(lineId, 100e6);
        assertEq(p.fromUser, 50e6);
        assertEq(p.fromPartner, 30e6);
        assertEq(p.fromAdvance, 20e6);
        assertEq(p.shortfall, 0);

        vm.prank(keeper);
        (uint256 repaid, DeskProtectionVault.Funding memory f) = vault.protect(lineId, 100e6);
        assertEq(repaid, 100e6, "a partial repay on a held price is exact");
        assertEq(f.fromUser, 50e6);
        assertEq(f.fromPartner, 30e6);
        assertEq(f.fromAdvance, 20e6);
        assertEq(vault.userBalance(user), 0);
        assertEq(vault.partnerBalance(PARTNER), 0);
        assertEq(vault.advanceLiquidity(), 980e6);
        assertEq(_debt(), debtBefore - 100e6);
        assertEq(desk.line(lineId).drawnPrincipal, 900e6, "the desk's own record follows the repay");
        assertEq(desk.partner(PARTNER).exposure, 900e6);

        DeskProtectionVault.Advance memory a = vault.advanceOf(lineId);
        assertEq(a.outstanding, 20e6);
        assertEq(a.feeOutstanding, 0.2e6);
        assertEq(a.totalAdvanced, 20e6);
        assertEq(a.lastAdvanceAt, T_SAT);
        assertEq(vault.totalOutstanding(), 20e6);
        _conserved();
    }

    function test_protect_fullRepayIsSettledByShares() public {
        vm.prank(owner);
        vault.fundAdvances(5000e6);
        vm.prank(owner);
        vault.setAdvanceTerms(5000e6, 100);
        vm.warp(T_REGULAR + 30 days); // let interest accrue so debt != principal
        uint256 debt = _debt();
        assertGt(debt, 1000e6);
        vm.prank(keeper);
        (uint256 repaid, DeskProtectionVault.Funding memory f) = vault.protect(lineId, type(uint256).max);
        assertEq(repaid, debt, "capped at the debt, settled by shares");
        assertEq(f.fromAdvance, debt);
        assertEq(MORPHO.position(id, user).borrowShares, 0);
        assertEq(desk.line(lineId).drawnPrincipal, 0);
        assertEq(vault.advanceLiquidity(), 5000e6 - debt);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DeskProtectionVault.NothingToProtect.selector, lineId));
        vault.protect(lineId, 1e6);
        _conserved();
    }

    function test_protect_refusals() public {
        vm.prank(stranger);
        vm.expectRevert(DeskProtectionVault.NotKeeper.selector);
        vault.protect(lineId, 1e6);
        vm.prank(keeper);
        vm.expectRevert(DeskProtectionVault.ZeroAmount.selector);
        vault.protect(lineId, 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.UnknownLine.selector, 99));
        vault.protect(99, 1e6);

        // no reserves, no advance liquidity: the ladder has nothing
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DeskProtectionVault.AdvanceCapExceeded.selector, 0, 100e6, 500e6));
        vault.protect(lineId, 100e6);

        // above the per-line cap
        vm.prank(owner);
        vault.fundAdvances(10_000e6);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DeskProtectionVault.AdvanceCapExceeded.selector, 0, 600e6, 500e6));
        vault.protect(lineId, 600e6);

        // paused: an advance is refused, the user's own reserve still protects
        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(DeskProtectionVault.Paused.selector);
        vault.protect(lineId, 100e6);
        vm.prank(user);
        vault.deposit(100e6);
        vm.prank(keeper);
        (uint256 repaid,) = vault.protect(lineId, 100e6);
        assertEq(repaid, 100e6);
        vm.prank(owner);
        vault.setPaused(false);

        // a closed line is refused before anything else
        vm.startPrank(user);
        desk.repay(lineId, type(uint256).max);
        desk.closeLine(lineId);
        vm.stopPrank();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DeskProtectionVault.LineNotOpen.selector, lineId));
        vault.protect(lineId, 1e6);
        _conserved();
    }

    function test_protect_onAHeldLineStillWorks() public {
        vm.prank(keeper);
        desk.hold(lineId, "shadow HF below grace");
        vm.prank(owner);
        vault.fundAdvances(1000e6);
        _saturday();
        vm.prank(keeper);
        (uint256 repaid,) = vault.protect(lineId, 100e6);
        assertEq(repaid, 100e6, "a keeper hold stops draws, never a protective repay");
    }

    // ------------------------------------------------------------ settlement

    function test_repayAdvance_principalThenFee() public {
        vm.prank(owner);
        vault.fundAdvances(1000e6);
        _saturday();
        vm.prank(keeper);
        vault.protect(lineId, 200e6); // 200 advanced, 2 of fee
        _conserved();

        usdc.mint(user, 1000e6);
        vm.prank(user);
        (uint256 p1, uint256 f1) = vault.repayAdvance(lineId, 150e6);
        assertEq(p1, 150e6);
        assertEq(f1, 0);
        vm.prank(stranger); // anyone may settle
        (uint256 p2, uint256 f2) = vault.repayAdvance(lineId, 100e6);
        assertEq(p2, 50e6, "principal first");
        assertEq(f2, 2e6, "then the fee, never more than owed");
        DeskProtectionVault.Advance memory a = vault.advanceOf(lineId);
        assertEq(a.outstanding, 0);
        assertEq(a.feeOutstanding, 0);
        assertEq(a.totalSettled, 200e6);
        assertEq(a.lastSettledAt, T_SAT);
        assertEq(vault.feesCollected(), 2e6);
        assertEq(vault.advanceLiquidity(), 1000e6);
        assertEq(vault.totalOutstanding(), 0);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(DeskProtectionVault.NoAdvanceOutstanding.selector, lineId));
        vault.repayAdvance(lineId, 1e6);
        vm.prank(owner);
        vault.collectFees(owner);
        assertEq(vault.feesCollected(), 0);
        _conserved();
    }

    // ------------------------------------------------------------ recovery through the desk

    function test_recover_waitsForAnOpenSession() public {
        vm.prank(owner);
        vault.fundAdvances(1000e6);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DeskProtectionVault.NoAdvanceOutstanding.selector, lineId));
        vault.recover(lineId, 1e8);
        _saturday();
        vm.prank(keeper);
        vault.protect(lineId, 200e6);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DeskProtectionVault.Refused.selector, CreditDesk.Reason.MARKET_CLOSED));
        vault.recover(lineId, 1e8);
        vm.prank(stranger);
        vm.expectRevert(DeskProtectionVault.NotKeeper.selector);
        vault.recover(lineId, 1e8);

        _monday();
        vm.prank(keeper);
        uint256 withdrawn = vault.recover(lineId, 1e8);
        assertEq(withdrawn, 1e8);
        assertEq(vault.heldCollateral(lineId), 1e8);
        assertEq(aapl.balanceOf(address(vault)), 1e8);
        assertEq(MORPHO.position(id, user).collateral, 9e8, "taken from the user's own position");
        assertEq(aapl.balanceOf(user), 0, "nothing went to the user on the way");
        _conserved();

        // the policy LTV bounds how much may leave: 9 shares left at $333.66 x 50% = $1,501 >= ~$800 of debt;
        // taking 7 more would leave 2 shares ($667 x 50% = $333) under the debt
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(DeskProtectionVault.Refused.selector, CreditDesk.Reason.INSUFFICIENT_CAPACITY)
        );
        vault.recover(lineId, 7e8);

        vm.prank(keeper);
        vault.returnCollateral(lineId, 0.4e8);
        assertEq(aapl.balanceOf(user), 0.4e8, "returned to the line's owner");
        assertEq(vault.heldCollateral(lineId), 0.6e8);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DeskProtectionVault.InsufficientBalance.selector, 0.6e8, 1e8));
        vault.returnCollateral(lineId, 1e8);
        _conserved();
    }

    function test_recover_needsTheDeskRegistrationAndTheDeskRefusesEveryoneElse() public {
        vm.prank(owner);
        vault.fundAdvances(1000e6);
        _saturday();
        vm.prank(keeper);
        vault.protect(lineId, 200e6);
        _monday();

        vm.prank(stranger);
        vm.expectRevert(CreditDesk.NotProtectionVault.selector);
        desk.recoverCollateral(lineId, 1e8);
        vm.prank(keeper); // even the desk's own keeper: only the registered vault may receive collateral
        vm.expectRevert(CreditDesk.NotProtectionVault.selector);
        desk.recoverCollateral(lineId, 1e8);

        vm.prank(owner);
        desk.setProtectionVault(address(0));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DeskProtectionVault.NotTheDeskVault.selector, address(0)));
        vault.recover(lineId, 1e8);
        vm.prank(stranger);
        vm.expectRevert(CreditDesk.NotProtectionVault.selector);
        desk.recoverCollateral(lineId, 1e8);

        vm.prank(owner);
        desk.setProtectionVault(address(vault));
        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(DeskProtectionVault.Paused.selector);
        vault.recover(lineId, 1e8);
        vm.prank(owner);
        vault.setPaused(false);

        vm.prank(user);
        MORPHO.setAuthorization(address(desk), false);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(DeskProtectionVault.Refused.selector, CreditDesk.Reason.NOT_AUTHORIZED_ON_VENUE)
        );
        vault.recover(lineId, 1e8);
        vm.prank(user);
        MORPHO.setAuthorization(address(desk), true);

        vm.prank(keeper);
        assertEq(vault.recover(lineId, 1e8), 1e8);
        _conserved();
    }

    function test_theOwnersOwnWithdrawalStillPaysTheOwner() public {
        vm.prank(user);
        desk.withdrawCollateral(lineId, 1e8);
        assertEq(aapl.balanceOf(user), 1e8);
        assertEq(aapl.balanceOf(address(vault)), 0);
    }

    // ------------------------------------------------------------ the Reserve as the funder

    function test_reserveFundsAdvancesAndHarvestsTheFee() public {
        BoundlineReserve reserve = new BoundlineReserve(owner, IERC20(address(usdc)), owner, 1 hours, 8000);
        vm.startPrank(owner);
        reserve.addSink(address(vault));
        vault.setFunder(address(reserve));
        vm.stopPrank();
        usdc.mint(alice, 1000e6);
        vm.startPrank(alice);
        usdc.approve(address(reserve), 1000e6);
        reserve.deposit(1000e6, alice);
        vm.stopPrank();
        vm.prank(owner);
        reserve.allocate(address(vault), 500e6);
        assertEq(vault.advanceLiquidity(), 500e6);
        assertEq(reserve.totalAssets(), 1000e6);

        _saturday();
        vm.prank(keeper);
        vault.protect(lineId, 200e6); // the Reserve's capital protects the line on Saturday
        assertEq(vault.totalOutstanding(), 200e6);
        assertEq(reserve.totalAssets(), 1000e6, "an outstanding advance is still the Reserve's asset");

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(DeskProtectionVault.InsufficientBalance.selector, 300e6, 400e6));
        reserve.recall(address(vault), 400e6); // only free liquidity comes back

        _monday();
        usdc.mint(user, 202e6);
        vm.prank(user);
        vault.repayAdvance(lineId, 202e6); // settled with the 1% fee
        vm.prank(owner);
        assertEq(reserve.harvest(address(vault)), 2e6);
        assertEq(reserve.totalAssets(), 1002e6, "the fee is the depositors' yield");
        vm.prank(owner);
        reserve.recall(address(vault), 500e6);
        assertEq(reserve.idleAssets(), 1002e6);
        assertEq(vault.advanceLiquidity(), 0);
        _conserved();
    }
}
