// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
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
import {DeskProtectionVault} from "../../src/reserve/DeskProtectionVault.sol";

/// @dev Drives the vault with bounded random actions over three lines (one per user) and one partner, on
///      the etched Morpho. Time only moves forward in small steps, so the market stays in session and the
///      recovery path is exercised; protection runs whatever the session.
contract DeskVaultHandler is Test {
    DeskProtectionVault public vault;
    CreditDesk public desk;
    IMorpho public morpho;
    MockB20 public usdc;
    MockB20 public aapl;
    TestPriceFeed public feed;
    Id public id;
    address public owner;
    address public keeper;
    address public partnerAdmin;
    bytes32 public constant PARTNER = "boundline";
    address[3] public users;
    uint256[3] public lines;
    uint256 public protects;
    uint256 public advances;
    uint256 public recoveries;
    uint256 public settlements;

    constructor(
        DeskProtectionVault vault_,
        CreditDesk desk_,
        IMorpho morpho_,
        MockB20 usdc_,
        MockB20 aapl_,
        TestPriceFeed feed_,
        Id id_,
        address owner_,
        address keeper_,
        address partnerAdmin_,
        address[3] memory users_,
        uint256[3] memory lines_
    ) {
        vault = vault_;
        desk = desk_;
        morpho = morpho_;
        usdc = usdc_;
        aapl = aapl_;
        feed = feed_;
        id = id_;
        owner = owner_;
        keeper = keeper_;
        partnerAdmin = partnerAdmin_;
        users = users_;
        lines = lines_;
    }

    function _pick(uint256 seed) internal view returns (address u, uint256 lineId) {
        return (users[seed % 3], lines[seed % 3]);
    }

    function pass(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 600));
    }

    function deposit(uint256 seed, uint256 amount) external {
        (address u,) = _pick(seed);
        amount = bound(amount, 1, 500e6);
        usdc.mint(u, amount);
        vm.startPrank(u);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function withdraw(uint256 seed, uint256 amount) external {
        (address u,) = _pick(seed);
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

    function protect(uint256 seed, uint256 amount) external {
        (, uint256 lineId) = _pick(seed);
        amount = bound(amount, 1, 400e6);
        if (vault.debtOf(lineId) == 0) return;
        DeskProtectionVault.Funding memory f = vault.previewProtect(lineId, amount);
        vm.prank(keeper);
        try vault.protect(lineId, amount) returns (uint256, DeskProtectionVault.Funding memory got) {
            protects += 1;
            if (got.fromAdvance != 0) advances += 1;
        } catch {
            // the keeper asked for more than the ladder covers; the preview said so
            assertGt(f.shortfall, 0, "protect may only fail on a shortfall");
        }
    }

    function repayAdvance(uint256 seed, uint256 amount) external {
        (address u, uint256 lineId) = _pick(seed);
        DeskProtectionVault.Advance memory a = vault.advanceOf(lineId);
        if (a.outstanding == 0 && a.feeOutstanding == 0) return;
        amount = bound(amount, 1, uint256(a.outstanding) + a.feeOutstanding + 5e6);
        usdc.mint(u, amount);
        vm.startPrank(u);
        usdc.approve(address(vault), amount);
        vault.repayAdvance(lineId, amount);
        vm.stopPrank();
        settlements += 1;
    }

    function recover(uint256 seed, uint256 amount) external {
        (, uint256 lineId) = _pick(seed);
        if (vault.advanceOf(lineId).outstanding == 0) return;
        amount = bound(amount, 1, 0.5e8);
        vm.prank(owner);
        feed.setAnswer(33_366_495_000);
        vm.prank(keeper);
        try vault.recover(lineId, amount) {
            recoveries += 1;
        } catch {}
    }

    function returnCollateral(uint256 seed, uint256 amount) external {
        (, uint256 lineId) = _pick(seed);
        uint256 held = vault.heldCollateral(lineId);
        if (held == 0) return;
        amount = bound(amount, 1, held);
        vm.prank(keeper);
        vault.returnCollateral(lineId, amount);
    }
}

contract DeskProtectionVaultInvariantTest is Test {
    using MarketParamsLib for MarketParams;

    address constant MORPHO_ADDR = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    IMorpho constant MORPHO = IMorpho(MORPHO_ADDR);
    uint256 constant LLTV = 0.625e18;
    bytes32 constant PARTNER = "boundline";
    int256 constant PRICE = 33_366_495_000;
    uint256 constant T_REGULAR = 1_790_877_600; // Thu 2026-10-01 14:00 ET
    uint256 constant DRAW = 1000e6;

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address partnerAdmin = makeAddr("partnerAdmin");
    address supplier = makeAddr("supplier");
    address[3] users = [makeAddr("u1"), makeAddr("u2"), makeAddr("u3")];
    uint256[3] lines;
    uint256[3] sharesAtStart;

    MockB20 usdc;
    MockB20 aapl;
    TestPriceFeed feed;
    CreditDesk desk;
    DeskProtectionVault vault;
    DeskVaultHandler handler;
    MarketParams params;
    Id id;

    function setUp() public {
        vm.warp(T_REGULAR);
        bytes memory code = vm.parseBytes(vm.readFile("test/fixtures/morpho-blue-8453.runtime.hex"));
        vm.etch(MORPHO_ADDR, code);
        vm.store(MORPHO_ADDR, bytes32(0), bytes32(uint256(uint160(owner))));
        IrmMock irm = new IrmMock();
        vm.startPrank(owner);
        MORPHO.enableIrm(address(irm));
        MORPHO.enableLltv(LLTV);
        vm.stopPrank();

        usdc = new MockB20("USD Coin", "USDC", 6);
        aapl = new MockB20("Coinbase Wrapped AAPL", "AAPLc", 8);
        MarketCalendar cal = new MarketCalendar(owner);
        vm.prank(owner);
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        MirrorOracleRegistry registry = new MirrorOracleRegistry(owner);
        feed = new TestPriceFeed(owner, 8, "Coinbase AAPL", PRICE);
        SessionGate gate = new SessionGate(owner, cal, registry);
        vm.prank(owner);
        gate.setFeed(address(aapl), feed, 0, 0);
        SessionGuard guard = new SessionGuard(gate, address(aapl), 8, address(usdc), 6, 0);
        params = MarketParams({
            loanToken: address(usdc),
            collateralToken: address(aapl),
            oracle: address(guard),
            irm: address(irm),
            lltv: LLTV
        });
        id = params.id();
        MORPHO.createMarket(params);
        usdc.mint(supplier, 10_000_000e6);
        vm.startPrank(supplier);
        usdc.approve(MORPHO_ADDR, type(uint256).max);
        MORPHO.supply(params, 10_000_000e6, 0, supplier, "");
        vm.stopPrank();

        desk = new CreditDesk(owner, MORPHO, gate, IPolicyRegistry(address(0)), false, keeper);
        vm.startPrank(owner);
        desk.registerMarket(params);
        desk.createPartner(PARTNER, partnerAdmin, address(0), IEligibility(address(0)), 100_000e6);
        vm.stopPrank();
        vm.prank(partnerAdmin);
        desk.setTickerPolicy(PARTNER, address(aapl), true, 0.5e18, 10e6, 5000e6, 50_000e6);

        vault = new DeskProtectionVault(owner, desk, IERC20(address(usdc)), keeper);
        vm.startPrank(owner);
        vault.setPartnerAdmin(PARTNER, partnerAdmin);
        vault.setAdvanceTerms(300e6, 50);
        desk.setProtectionVault(address(vault));
        vm.stopPrank();

        for (uint256 i = 0; i < 3; ++i) {
            address u = users[i];
            aapl.mint(u, 10e8);
            vm.startPrank(u);
            aapl.approve(address(desk), type(uint256).max);
            MORPHO.setAuthorization(address(desk), true);
            lines[i] = desk.openLine(PARTNER, id, 0, "");
            desk.addCollateral(lines[i], 10e8);
            desk.draw(lines[i], DRAW);
            vm.stopPrank();
            sharesAtStart[i] = MORPHO.position(id, u).borrowShares;
        }

        handler =
            new DeskVaultHandler(vault, desk, MORPHO, usdc, aapl, feed, id, owner, keeper, partnerAdmin, users, lines);
        targetContract(address(handler));
    }

    function invariant_usdcHeldEqualsLedger() public view {
        uint256 ledger = vault.advanceLiquidity() + vault.feesCollected() + vault.partnerBalance(PARTNER);
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
            DeskProtectionVault.Advance memory a = vault.advanceOf(lines[i]);
            sumOutstanding += a.outstanding;
            sumAdvanced += a.totalAdvanced;
            sumSettled += a.totalSettled;
            assertEq(uint256(a.totalAdvanced), uint256(a.totalSettled) + a.outstanding, "per line");
        }
        assertEq(sumOutstanding, vault.totalOutstanding());
        assertEq(sumAdvanced, vault.totalAdvanced());
        assertEq(sumSettled, vault.totalSettled());
    }

    function invariant_perLineCapHolds() public view {
        for (uint256 i = 0; i < 3; ++i) {
            assertLe(vault.advanceOf(lines[i]).outstanding, vault.advanceCapPerLine());
        }
    }

    function invariant_heldCollateralIsBacked() public view {
        uint256 held;
        for (uint256 i = 0; i < 3; ++i) {
            held += vault.heldCollateral(lines[i]);
        }
        assertEq(aapl.balanceOf(address(vault)), held, "every share the vault holds is attributed to a line");
        for (uint256 i = 0; i < 3; ++i) {
            assertEq(
                aapl.balanceOf(users[i]) + MORPHO.position(id, users[i]).collateral + vault.heldCollateral(lines[i]),
                10e8,
                "a user's shares are on the position, with the user or held for the line"
            );
        }
    }

    function invariant_protectionNeverRaisesDebt() public view {
        for (uint256 i = 0; i < 3; ++i) {
            // Shares only fall through repays; interest accrues on assets, never on shares.
            assertLe(MORPHO.position(id, users[i]).borrowShares, sharesAtStart[i], "the vault only lowers debt");
            assertLe(desk.line(lines[i]).drawnPrincipal, DRAW);
        }
    }

    function invariant_theDesksExposureFollowsItsLines() public view {
        uint256 principal;
        for (uint256 i = 0; i < 3; ++i) {
            principal += desk.line(lines[i]).drawnPrincipal;
        }
        assertEq(desk.partner(PARTNER).exposure, principal, "partner exposure == sum of drawn principal");
        assertEq(desk.tickerPolicy(PARTNER, address(aapl)).exposure, principal);
    }
}
