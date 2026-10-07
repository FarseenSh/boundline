// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IMarketCalendar} from "../../src/interfaces/IMarketCalendar.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {TestPriceFeed} from "../../src/test/TestPriceFeed.sol";
import {MirrorOracleRegistry} from "../../src/test/MirrorOracleRegistry.sol";
import {MockB20} from "../../src/test/MockB20.sol";
import {ProtectionVault} from "../../src/aave/ProtectionVault.sol";
import {AaveTypes as T} from "../../src/aave/AaveTypes.sol";
import {IAaveSpoke, ITakerPositionManager, IGiverPositionManager} from "../../src/aave/interfaces/IAaveV4.sol";
import {MockAaveSpoke} from "./mocks/MockAaveSpoke.sol";
import {MockTaker, MockGiver} from "./mocks/MockPositionManagers.sol";

/// @notice ProtectionVault against the mock spoke and managers: the funding ladder, refunds, caps,
///         the weekend (repay works, recovery waits for an open session), settlement and conservation.
contract ProtectionVaultTest is Test {
    bytes32 constant PARTNER = "boundline";
    int256 constant PRICE = 33_366_495_000;
    uint256 constant T_REGULAR = 1_790_877_600; // Thu 2026-10-01 14:00 ET
    uint256 constant T_SAT = 1_791_024_480; // Sat 2026-10-03 06:48 ET

    address owner = makeAddr("owner");
    address partnerAdmin = makeAddr("partnerAdmin");
    address keeper = makeAddr("keeper");
    address user = makeAddr("user");
    address stranger = makeAddr("stranger");

    MockB20 usdc;
    MockB20 aapl;
    MarketCalendar cal;
    MirrorOracleRegistry registry;
    TestPriceFeed feed;
    SessionGate gate;
    MockAaveSpoke spoke;
    MockTaker taker;
    MockGiver giver;
    ProtectionVault vault;
    uint256 aaplRes;
    uint256 usdcRes;

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
        aaplRes = spoke.addReserve(address(aapl), 8, 7800, false, uint256(PRICE));
        usdcRes = spoke.addReserve(address(usdc), 6, 0, true, 1e8);
        taker = new MockTaker();
        giver = new MockGiver();
        taker.registerSpoke(address(spoke), true);
        giver.registerSpoke(address(spoke), true);
        spoke.updatePositionManager(address(taker), true);
        spoke.updatePositionManager(address(giver), true);
        usdc.mint(address(spoke), 1_000_000e6);

        vault = new ProtectionVault(
            owner,
            IAaveSpoke(address(spoke)),
            ITakerPositionManager(address(taker)),
            IGiverPositionManager(address(giver)),
            gate,
            usdcRes,
            keeper
        );
        vm.startPrank(owner);
        vault.setPartnerAdmin(PARTNER, partnerAdmin);
        vault.setAdvanceTerms(500e6, 100); // 1% advance fee, 500 USDC per user
        vm.stopPrank();

        // The user's own Aave position: 10 AAPLc, 1,000 USDC of debt, both managers approved, recovery allowance.
        aapl.mint(user, 10e8);
        vm.startPrank(user);
        aapl.approve(address(spoke), type(uint256).max);
        spoke.supply(aaplRes, 10e8, user);
        spoke.borrow(usdcRes, 1000e6, user);
        spoke.setUserPositionManager(address(giver), true);
        spoke.setUserPositionManager(address(taker), true);
        taker.approveWithdraw(address(spoke), aaplRes, address(vault), 5e8);
        usdc.approve(address(vault), type(uint256).max);
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
    }

    // ------------------------------------------------------------ reserves

    function test_depositsAndWithdrawals() public {
        vm.prank(user);
        vault.deposit(100e6);
        vm.prank(stranger);
        vault.depositFor(user, 50e6);
        assertEq(vault.userBalance(user), 150e6);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ProtectionVault.InsufficientBalance.selector, 150e6, 151e6));
        vault.withdraw(151e6);
        vm.prank(user);
        vault.withdraw(150e6);
        assertEq(vault.userBalance(user), 0);

        vm.prank(stranger);
        vault.depositForPartner(PARTNER, 300e6);
        vm.prank(stranger);
        vm.expectRevert(ProtectionVault.NotPartnerAdmin.selector);
        vault.withdrawPartner(PARTNER, 1e6, stranger);
        vm.prank(partnerAdmin);
        vault.withdrawPartner(PARTNER, 300e6, partnerAdmin);
        assertEq(vault.partnerBalance(PARTNER), 0);
        vm.prank(stranger);
        vm.expectRevert(ProtectionVault.NotPartnerAdmin.selector);
        vault.depositForPartner("unknown", 1e6);
        _conserved();
    }

    function test_fundAndDefundAdvances() public {
        vm.startPrank(owner);
        vault.fundAdvances(1000e6);
        assertEq(vault.advanceLiquidity(), 1000e6);
        vm.expectRevert(abi.encodeWithSelector(ProtectionVault.InsufficientBalance.selector, 1000e6, 1001e6));
        vault.defundAdvances(1001e6, owner);
        vault.defundAdvances(400e6, owner);
        vm.stopPrank();
        assertEq(vault.advanceLiquidity(), 600e6);
        vm.prank(stranger);
        vm.expectRevert();
        vault.fundAdvances(1e6);
        _conserved();
    }

    function test_funderSharesTheOwnersRightsOverAdvancesAndFees() public {
        vm.prank(stranger);
        vm.expectRevert(ProtectionVault.NotFunder.selector);
        vault.fundAdvances(1e6);
        vm.prank(owner);
        vault.setFunder(stranger);
        assertEq(vault.funder(), stranger);
        vm.startPrank(stranger);
        vault.fundAdvances(300e6);
        assertEq(vault.advanceLiquidity(), 300e6);
        vault.defundAdvances(100e6, stranger);
        vault.collectFees(stranger);
        vm.stopPrank();
        assertEq(vault.advanceLiquidity(), 200e6);
        vm.prank(user);
        vm.expectRevert(ProtectionVault.NotFunder.selector);
        vault.defundAdvances(1e6, user);
        vm.prank(user);
        vm.expectRevert(ProtectionVault.NotFunder.selector);
        vault.collectFees(user);
        vm.prank(user);
        vm.expectRevert();
        vault.setFunder(user); // owner only
        _conserved();
    }

    // ------------------------------------------------------------ protect

    function test_protect_walksTheLadderOnTheWeekend() public {
        vm.prank(user);
        vault.deposit(100e6);
        vm.prank(partnerAdmin);
        vault.depositForPartner(PARTNER, 100e6);
        vm.prank(owner);
        vault.fundAdvances(1000e6);

        vm.warp(T_SAT); // repay is always open
        uint256 hfBefore = spoke.getUserAccountData(user).healthFactor;
        vm.prank(keeper);
        (uint256 repaid, ProtectionVault.Funding memory f) = vault.protect(user, PARTNER, 250e6);
        assertEq(repaid, 250e6);
        assertEq(f.fromUser, 100e6);
        assertEq(f.fromPartner, 100e6);
        assertEq(f.fromAdvance, 50e6);
        assertEq(spoke.debt(usdcRes, user), 750e6);
        assertGt(spoke.getUserAccountData(user).healthFactor, hfBefore);
        assertEq(vault.userBalance(user), 0);
        assertEq(vault.partnerBalance(PARTNER), 0);
        assertEq(vault.advanceLiquidity(), 950e6);
        ProtectionVault.Advance memory a = vault.advanceOf(user);
        assertEq(a.outstanding, 50e6);
        assertEq(a.feeOutstanding, 0.5e6);
        assertEq(a.totalAdvanced, 50e6);
        assertEq(vault.totalOutstanding(), 50e6);
        _conserved();
    }

    function test_protect_refundsUnusedUpTheLadder() public {
        // Debt is 1,000; the keeper asks for 1,500 funded user 400 + partner 400 + advance 200 -> the Giver
        // only takes 1,000, so 200 advance goes back first, then 300 of the partner's.
        vm.prank(user);
        vault.deposit(400e6);
        vm.prank(partnerAdmin);
        vault.depositForPartner(PARTNER, 400e6);
        vm.prank(owner);
        vault.fundAdvances(1000e6);
        vm.prank(keeper);
        (uint256 repaid, ProtectionVault.Funding memory f) = vault.protect(user, PARTNER, 1500e6);
        assertEq(repaid, 1000e6);
        assertEq(f.fromUser, 400e6);
        assertEq(f.fromPartner, 400e6);
        assertEq(f.fromAdvance, 200e6);
        assertEq(vault.advanceLiquidity(), 800e6);
        assertEq(vault.advanceOf(user).outstanding, 200e6);
        _conserved();
    }

    function test_protect_capAndPause() public {
        vm.prank(owner);
        vault.fundAdvances(10_000e6);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ProtectionVault.AdvanceCapExceeded.selector, 0, 600e6, 500e6));
        vault.protect(user, PARTNER, 600e6);
        ProtectionVault.Funding memory p = vault.previewProtect(user, PARTNER, 600e6);
        assertEq(p.fromAdvance, 500e6);
        assertEq(p.shortfall, 100e6);

        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(ProtectionVault.Paused.selector);
        vault.protect(user, PARTNER, 100e6);
        // A user-funded repay still runs while paused.
        vm.prank(user);
        vault.deposit(100e6);
        vm.prank(keeper);
        (uint256 repaid,) = vault.protect(user, PARTNER, 100e6);
        assertEq(repaid, 100e6);
        _conserved();
    }

    function test_protect_requiresGiverApprovalAndDebt() public {
        vm.prank(user);
        vault.deposit(100e6);
        vm.prank(user);
        spoke.setUserPositionManager(address(giver), false);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ProtectionVault.NotEnrolled.selector, user, address(giver)));
        vault.protect(user, PARTNER, 10e6);
        vm.prank(user);
        spoke.setUserPositionManager(address(giver), true);
        vm.prank(stranger);
        vm.expectRevert(ProtectionVault.NotKeeper.selector);
        vault.protect(user, PARTNER, 10e6);
        vm.prank(user);
        vault.deposit(900e6);
        vm.prank(keeper);
        vault.protect(user, PARTNER, 1000e6); // clears the debt from the user's own reserve
        assertEq(spoke.debt(usdcRes, user), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ProtectionVault.NothingToProtect.selector, user));
        vault.protect(user, PARTNER, 1e6);
    }

    // ------------------------------------------------------------ settlement and recovery

    function test_repayAdvance_principalThenFee() public {
        vm.prank(owner);
        vault.fundAdvances(1000e6);
        vm.prank(keeper);
        vault.protect(user, PARTNER, 200e6); // all advance: 200 + 2 fee
        vm.prank(stranger);
        (uint256 principal, uint256 fee) = vault.repayAdvance(user, 150e6);
        assertEq(principal, 150e6);
        assertEq(fee, 0);
        vm.prank(user);
        (principal, fee) = vault.repayAdvance(user, 1000e6); // over-asks: only 50 + 2 pulled
        assertEq(principal, 50e6);
        assertEq(fee, 2e6);
        ProtectionVault.Advance memory a = vault.advanceOf(user);
        assertEq(a.outstanding, 0);
        assertEq(a.feeOutstanding, 0);
        assertEq(a.totalSettled, 200e6);
        assertEq(vault.feesCollected(), 2e6);
        assertEq(vault.advanceLiquidity(), 1000e6);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ProtectionVault.NoAdvanceOutstanding.selector, user));
        vault.repayAdvance(user, 1e6);
        vm.prank(owner);
        vault.collectFees(owner);
        assertEq(vault.feesCollected(), 0);
        _conserved();
    }

    function test_recover_waitsForAnOpenSession() public {
        vm.prank(owner);
        vault.fundAdvances(1000e6);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ProtectionVault.NoAdvanceOutstanding.selector, user));
        vault.recover(user, aaplRes, 1e8);

        vm.warp(T_SAT);
        vm.prank(keeper);
        vault.protect(user, PARTNER, 200e6); // Saturday advance
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ProtectionVault.Refused.selector, T.Reason.MARKET_CLOSED));
        vault.recover(user, aaplRes, 1e8);

        vm.warp(1_791_208_800); // Monday 10:00 ET
        vm.prank(owner);
        feed.setAnswer(PRICE);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ProtectionVault.InsufficientWithdrawAllowance.selector, 5e8, 6e8));
        vault.recover(user, aaplRes, 6e8);
        vm.prank(keeper);
        uint256 withdrawn = vault.recover(user, aaplRes, 1e8);
        assertEq(withdrawn, 1e8);
        assertEq(aapl.balanceOf(address(vault)), 1e8);
        assertEq(vault.heldCollateral(user, address(aapl)), 1e8);
        assertEq(spoke.supplied(aaplRes, user), 9e8);

        vm.prank(keeper);
        vault.returnCollateral(user, address(aapl), 0.4e8);
        assertEq(aapl.balanceOf(user), 0.4e8);
        assertEq(vault.heldCollateral(user, address(aapl)), 0.6e8);
        _conserved();
    }

    function test_recover_pausedOrStaleFeedRefused() public {
        vm.prank(owner);
        vault.fundAdvances(1000e6);
        vm.prank(keeper);
        vault.protect(user, PARTNER, 200e6);
        vm.prank(owner);
        feed.setAnswerAt(PRICE, block.timestamp - 27 hours);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ProtectionVault.Refused.selector, T.Reason.FEED_STALE));
        vault.recover(user, aaplRes, 1e8);
        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(ProtectionVault.Paused.selector);
        vault.recover(user, aaplRes, 1e8);
    }

    function test_constructor_checksManagers() public {
        spoke.updatePositionManager(address(giver), false);
        vm.expectRevert(abi.encodeWithSelector(ProtectionVault.ManagerNotActive.selector, address(giver)));
        new ProtectionVault(
            owner,
            IAaveSpoke(address(spoke)),
            ITakerPositionManager(address(taker)),
            IGiverPositionManager(address(giver)),
            gate,
            usdcRes,
            keeper
        );
    }

    function test_advanceTerms_feeCap() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ProtectionVault.FeeTooHigh.selector, uint16(501)));
        vault.setAdvanceTerms(1e6, 501);
    }
}
