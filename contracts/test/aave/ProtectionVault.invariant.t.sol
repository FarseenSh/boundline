// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
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

/// @dev Drives the vault with bounded random actions from three users and one partner.
contract VaultHandler is Test {
    ProtectionVault public vault;
    MockAaveSpoke public spoke;
    MockB20 public usdc;
    MockB20 public aapl;
    TestPriceFeed public feed;
    address public owner;
    address public keeper;
    address public partnerAdmin;
    bytes32 public constant PARTNER = "boundline";
    address[3] public users;
    uint256 public aaplRes;
    uint256 public usdcRes;
    uint256 public protects;
    uint256 public advances;
    uint256 public recoveries;
    uint256 public halts;
    mapping(address => uint256) public accrued;

    constructor(
        ProtectionVault vault_,
        MockAaveSpoke spoke_,
        MockB20 usdc_,
        MockB20 aapl_,
        TestPriceFeed feed_,
        address owner_,
        address keeper_,
        address partnerAdmin_,
        address[3] memory users_,
        uint256 aaplRes_,
        uint256 usdcRes_
    ) {
        vault = vault_;
        spoke = spoke_;
        usdc = usdc_;
        aapl = aapl_;
        feed = feed_;
        owner = owner_;
        keeper = keeper_;
        partnerAdmin = partnerAdmin_;
        users = users_;
        aaplRes = aaplRes_;
        usdcRes = usdcRes_;
    }

    function _user(uint256 seed) internal view returns (address) {
        return users[seed % 3];
    }

    function deposit(uint256 seed, uint256 amount) external {
        address u = _user(seed);
        amount = bound(amount, 1, 500e6);
        usdc.mint(u, amount);
        vm.startPrank(u);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function withdraw(uint256 seed, uint256 amount) external {
        address u = _user(seed);
        uint256 bal = vault.userBalance(u);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(u);
        vault.withdraw(amount);
    }

    function depositPartner(uint256 amount) external {
        amount = bound(amount, 1, 500e6);
        usdc.mint(partnerAdmin, amount);
        vm.startPrank(partnerAdmin);
        usdc.approve(address(vault), amount);
        vault.depositForPartner(PARTNER, amount);
        vm.stopPrank();
    }

    function withdrawPartner(uint256 amount) external {
        uint256 bal = vault.partnerBalance(PARTNER);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(partnerAdmin);
        vault.withdrawPartner(PARTNER, amount, partnerAdmin);
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 1, 2000e6);
        usdc.mint(owner, amount);
        vm.startPrank(owner);
        usdc.approve(address(vault), amount);
        vault.fundAdvances(amount);
        vm.stopPrank();
    }

    function defund(uint256 amount) external {
        uint256 free = vault.advanceLiquidity();
        if (free == 0) return;
        amount = bound(amount, 1, free);
        vm.prank(owner);
        vault.defundAdvances(amount, owner);
    }

    function accrue(uint256 seed, uint256 amount) external {
        amount = bound(amount, 0, 20e6);
        spoke.accrue(usdcRes, _user(seed), amount);
        accrued[_user(seed)] += amount;
    }

    function protect(uint256 seed, uint256 amount) external {
        address u = _user(seed);
        amount = bound(amount, 1, 400e6);
        ProtectionVault.Funding memory f = vault.previewProtect(u, PARTNER, amount);
        if (spoke.debt(usdcRes, u) == 0) return;
        vm.prank(keeper);
        try vault.protect(u, PARTNER, amount) returns (uint256, ProtectionVault.Funding memory got) {
            protects += 1;
            if (got.fromAdvance != 0) advances += 1;
        } catch {
            // the keeper asked for more than the ladder covers (the preview said so), or the venue refuses repays
            assertTrue(
                f.shortfall > 0 || vault.venueReason(usdcRes) != T.Reason.NONE,
                "protect may only fail on a shortfall or a venue switch"
            );
        }
    }

    /// @dev Aave's own switch flips during the run: the hub halts USDC's or AAPLc's asset, or lifts it. Protection,
    ///      recovery and settlement must keep every identity through it.
    function switchHub(uint256 seed) external {
        uint256 asset = seed % 2 == 0 ? usdcRes : aaplRes;
        bool halt = (seed >> 1) % 2 == 0;
        spoke.setHubHalted(asset, halt);
        if (halt) halts += 1;
    }

    function repayAdvance(uint256 seed, uint256 amount) external {
        address u = _user(seed);
        ProtectionVault.Advance memory a = vault.advanceOf(u);
        if (a.outstanding == 0 && a.feeOutstanding == 0) return;
        amount = bound(amount, 1, uint256(a.outstanding) + a.feeOutstanding + 5e6);
        usdc.mint(u, amount);
        vm.startPrank(u);
        usdc.approve(address(vault), amount);
        vault.repayAdvance(u, amount);
        vm.stopPrank();
    }

    function recover(uint256 seed, uint256 amount) external {
        address u = _user(seed);
        if (vault.advanceOf(u).outstanding == 0) return;
        amount = bound(amount, 1, 0.5e8);
        vm.prank(owner);
        feed.setAnswer(33_366_495_000);
        vm.prank(keeper);
        try vault.recover(u, aaplRes, amount) {
            recoveries += 1;
        } catch {}
    }

    function returnCollateral(uint256 seed, uint256 amount) external {
        address u = _user(seed);
        uint256 held = vault.heldCollateral(u, address(aapl));
        if (held == 0) return;
        amount = bound(amount, 1, held);
        vm.prank(keeper);
        vault.returnCollateral(u, address(aapl), amount);
    }
}

contract ProtectionVaultInvariantTest is Test {
    uint256 constant T_REGULAR = 1_790_877_600;
    int256 constant PRICE = 33_366_495_000;

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address partnerAdmin = makeAddr("partnerAdmin");
    address[3] users = [makeAddr("u1"), makeAddr("u2"), makeAddr("u3")];

    MockB20 usdc;
    MockB20 aapl;
    MockAaveSpoke spoke;
    MockTaker taker;
    MockGiver giver;
    ProtectionVault vault;
    VaultHandler handler;
    uint256 aaplRes;
    uint256 usdcRes;

    function setUp() public {
        vm.warp(T_REGULAR);
        usdc = new MockB20("USD Coin", "USDC", 6);
        aapl = new MockB20("Coinbase Wrapped AAPL", "AAPLc", 8);
        MarketCalendar cal = new MarketCalendar(owner);
        vm.prank(owner);
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        MirrorOracleRegistry registry = new MirrorOracleRegistry(owner);
        TestPriceFeed feed = new TestPriceFeed(owner, 8, "Coinbase AAPL", PRICE);
        SessionGate gate = new SessionGate(owner, cal, registry);
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
        usdc.mint(address(spoke), 10_000_000e6);

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
        vault.setPartnerAdmin("boundline", partnerAdmin);
        vault.setAdvanceTerms(300e6, 50);
        vm.stopPrank();

        for (uint256 i = 0; i < 3; ++i) {
            address u = users[i];
            aapl.mint(u, 10e8);
            vm.startPrank(u);
            aapl.approve(address(spoke), type(uint256).max);
            spoke.supply(aaplRes, 10e8, u);
            spoke.borrow(usdcRes, 1000e6, u);
            spoke.setUserPositionManager(address(giver), true);
            spoke.setUserPositionManager(address(taker), true);
            taker.approveWithdraw(address(spoke), aaplRes, address(vault), 3e8);
            vm.stopPrank();
        }

        handler = new VaultHandler(vault, spoke, usdc, aapl, feed, owner, keeper, partnerAdmin, users, aaplRes, usdcRes);
        targetContract(address(handler));
    }

    function invariant_usdcHeldEqualsLedger() public view {
        uint256 ledger = vault.advanceLiquidity() + vault.feesCollected() + vault.partnerBalance("boundline");
        for (uint256 i = 0; i < 3; ++i) {
            ledger += vault.userBalance(users[i]);
        }
        assertEq(usdc.balanceOf(address(vault)), ledger, "USDC held == user + partner reserves + free advances + fees");
    }

    function invariant_advancedEqualsSettledPlusOutstanding() public view {
        assertEq(vault.totalAdvanced(), vault.totalSettled() + vault.totalOutstanding());
        uint256 sumOutstanding;
        uint256 sumAdvanced;
        uint256 sumSettled;
        for (uint256 i = 0; i < 3; ++i) {
            ProtectionVault.Advance memory a = vault.advanceOf(users[i]);
            sumOutstanding += a.outstanding;
            sumAdvanced += a.totalAdvanced;
            sumSettled += a.totalSettled;
            assertEq(uint256(a.totalAdvanced), uint256(a.totalSettled) + a.outstanding, "per user");
        }
        assertEq(sumOutstanding, vault.totalOutstanding());
        assertEq(sumAdvanced, vault.totalAdvanced());
        assertEq(sumSettled, vault.totalSettled());
    }

    function invariant_perUserCapHolds() public view {
        for (uint256 i = 0; i < 3; ++i) {
            assertLe(vault.advanceOf(users[i]).outstanding, vault.advanceCapPerUser());
        }
    }

    function invariant_heldCollateralIsBacked() public view {
        uint256 held;
        for (uint256 i = 0; i < 3; ++i) {
            held += vault.heldCollateral(users[i], address(aapl));
        }
        assertEq(aapl.balanceOf(address(vault)), held, "every share the vault holds is attributed to a user");
    }

    function invariant_protectionNeverRaisesDebt() public view {
        for (uint256 i = 0; i < 3; ++i) {
            // Debt only ever rises through the mock's `accrue` (interest), never through the vault.
            assertLe(spoke.debt(usdcRes, users[i]), 1000e6 + handler.accrued(users[i]), "the vault only lowers debt");
        }
    }
}
