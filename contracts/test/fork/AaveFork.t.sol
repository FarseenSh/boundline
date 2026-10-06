// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {IOracleRegistry} from "../../src/interfaces/IOracleRegistry.sol";
import {IPriceGate} from "../../src/interfaces/IPriceGate.sol";
import {IEligibility} from "../../src/interfaces/IEligibility.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {AaveDesk} from "../../src/aave/AaveDesk.sol";
import {ProtectionVault} from "../../src/aave/ProtectionVault.sol";
import {AaveTypes as T} from "../../src/aave/AaveTypes.sol";
import {AaveEnrolment} from "../../src/aave/AaveEnrolment.sol";
import {IAaveSpoke, ITakerPositionManager, IGiverPositionManager} from "../../src/aave/interfaces/IAaveV4.sol";

/// @notice Runs against a Base mainnet fork (BASE_RPC_URL) and proves the Aave V4 leg on the live
///         Equities Hub: a real MAG7 borrower (impersonated) approves Aave's own Taker and Giver and grants
///         the desk an allowance; the desk draws USDC through the Taker and forwards it; the vault repays
///         through the Giver on a Saturday; the desk refuses a weekend draw; and the signature variants of
///         the enrolment verify against the deployed Taker and spoke (typehashes, domains, keyed nonces).
///
///         The SessionGate reads the real AAPLc feed, the real OracleRegistry and the real B20 token. Stock
///         forge cannot execute the B20 precompiles on a fork, so every path that prices AAPLc (draw,
///         recovery) runs only under `base-forge` (`~/.foundry/bin/base-forge test --match-path 'test/fork/Aave*'`)
///         and is skipped with a note otherwise; the Giver repay, the weekend refusal and the signature
///         checks run under either build.
///
///         Borrower: `AAVE_FORK_BORROWER` (default 0xc9bc…ca66, who held 14.77 AAPLc against 3,943 USDC of
///         debt on 6 Oct 2026). Whoever it is, the test first repays their debt down to 30% of their AAPLc
///         value at Aave's price so a policy draw has headroom; the fork is not the chain.
contract AaveForkTest is Test {
    IAaveSpoke constant SPOKE = IAaveSpoke(0x17905Db0e4A3514467539956c084180616AE7B8D);
    ITakerPositionManager constant TAKER = ITakerPositionManager(0x8481204E528735aF2F3391AD98f36E757A56D695);
    IGiverPositionManager constant GIVER = IGiverPositionManager(0x9E81c2fDE4E34CAB3AB1667ca3c932dBAED95F08);
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant AAPLC = 0xb200000000000000000000C2e324d24d7eEcd1fb;
    address constant AAPL_FEED = 0x787f13dEa48Db0897CbCDD985de77809D837F988;
    address constant ORACLE_REGISTRY = 0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD;
    uint256 constant AAPL_RESERVE = 0;
    uint256 constant USDC_RESERVE = 7;
    bytes32 constant PARTNER = "boundline-app";
    uint256 constant T_SAT = 1_791_640_800; // Sat 2026-10-10 10:00 ET
    uint256 constant WAD = 1e18;

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address borrower;
    bool b20Live;

    MarketCalendar cal;
    SessionGate gate;
    AaveDesk desk;
    ProtectionVault vault;
    uint256 lineId;

    function setUp() public {
        string memory url = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        borrower = vm.envOr("AAVE_FORK_BORROWER", address(0xC9Bc5Cab29dC93A9D2ea16Ef38620598FAd5ca66));

        // Live facts the desk relies on.
        assertTrue(SPOKE.isPositionManagerActive(address(TAKER)), "Taker active on the MAG7 spoke");
        assertTrue(SPOKE.isPositionManagerActive(address(GIVER)), "Giver active on the MAG7 spoke");
        assertTrue(TAKER.isSpokeRegistered(address(SPOKE)), "spoke registered on the Taker");
        assertTrue(GIVER.isSpokeRegistered(address(SPOKE)), "spoke registered on the Giver");
        assertEq(SPOKE.getReserve(USDC_RESERVE).underlying, USDC, "reserve 7 is USDC");
        assertEq(SPOKE.getReserve(AAPL_RESERVE).underlying, AAPLC, "reserve 0 is AAPLc");

        (bool ok,) = AAPLC.staticcall(abi.encodeWithSignature("isPaused(uint8)", uint8(0)));
        b20Live = ok;
        if (!b20Live) {
            console.log("B20 precompiles unavailable in this build: pricing paths skip (run under base-forge)");
        }

        cal = new MarketCalendar(owner);
        vm.prank(owner);
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        gate = new SessionGate(owner, cal, IOracleRegistry(ORACLE_REGISTRY));
        vm.prank(owner);
        gate.setFeed(AAPLC, IAggregatorV3(AAPL_FEED), 0, 0);

        desk = new AaveDesk(owner, SPOKE, TAKER, GIVER, gate, USDC_RESERVE, keeper);
        vault = new ProtectionVault(owner, SPOKE, TAKER, GIVER, gate, USDC_RESERVE, keeper);
        vm.startPrank(owner);
        desk.enableReserve(AAPL_RESERVE);
        desk.createPartner(PARTNER, owner, address(0), IEligibility(address(0)), 10_000e6);
        desk.setReservePolicy(PARTNER, AAPL_RESERVE, true, 0.5e18, 1e6, 1000e6, 5000e6);
        vault.setPartnerAdmin(PARTNER, owner);
        vault.setAdvanceTerms(1000e6, 100);
        vm.stopPrank();

        // Bring the real position to headroom: repay down to 30% of the AAPLc value at Aave's own price.
        uint256 aaplSupplied = SPOKE.getUserSuppliedAssets(AAPL_RESERVE, borrower);
        assertGt(aaplSupplied, 0, "borrower holds AAPLc on the spoke");
        uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE, borrower);
        uint256 aaplValueUsdc = aaplSupplied * _aavePrice(AAPL_RESERVE) / 1e10; // 8 + 8 decimals -> 6
        uint256 target = aaplValueUsdc * 30 / 100;
        if (debt > target) {
            uint256 down = debt - target;
            deal(USDC, borrower, down);
            vm.startPrank(borrower);
            IERC20(USDC).approve(address(SPOKE), down);
            SPOKE.repay(USDC_RESERVE, down, borrower);
            vm.stopPrank();
        }

        // Enrolment, as the Base Account batch would send it.
        vm.startPrank(borrower);
        SPOKE.setUserPositionManager(address(TAKER), true);
        SPOKE.setUserPositionManager(address(GIVER), true);
        TAKER.approveBorrow(address(SPOKE), USDC_RESERVE, address(desk), 1000e6);
        TAKER.approveWithdraw(address(SPOKE), AAPL_RESERVE, address(vault), 1e8);
        IERC20(USDC).approve(address(desk), type(uint256).max);
        IERC20(USDC).approve(address(vault), type(uint256).max);
        lineId = desk.openLine(PARTNER, AAPL_RESERVE, 0, "");
        vm.stopPrank();
    }

    function _aavePrice(uint256 reserveId) internal view returns (uint256) {
        (bool ok, bytes memory data) =
            SPOKE.ORACLE().staticcall(abi.encodeWithSignature("getReservePrice(uint256)", reserveId));
        require(ok && data.length >= 32, "oracle price");
        return abi.decode(data, (uint256));
    }

    function test_fork_liveFactsAndLine() public view {
        assertEq(address(desk.LOAN_TOKEN()), USDC);
        assertEq(
            SPOKE.getDynamicReserveConfig(AAPL_RESERVE, SPOKE.getReserve(AAPL_RESERVE).dynamicConfigKey)
            .collateralFactor,
            7800
        );
        assertTrue(SPOKE.getReserveConfig(USDC_RESERVE).borrowable);
        assertTrue(SPOKE.isPositionManager(borrower, address(TAKER)));
        assertTrue(SPOKE.isPositionManager(borrower, address(GIVER)));
        (bool t, bool g, uint256 b, uint256 w) = desk.enrolment(borrower, AAPL_RESERVE);
        assertTrue(t && g);
        assertEq(b, 1000e6);
        assertEq(w, 0); // the withdraw allowance went to the vault, not the desk
        assertEq(desk.line(lineId).user, borrower);
        assertEq(desk.line(lineId).collateral, AAPLC);
    }

    /// @dev The desk draws through the live Taker and forwards the USDC; needs the B20 token readable
    ///      (gate) and an open session with a fresh feed at the fork's own timestamp.
    function test_fork_drawThroughTheLiveTaker() public {
        if (!b20Live) {
            vm.skip(true);
            return;
        }
        T.Quote memory q = desk.quote(lineId, 10e6);
        console.log("gate session / reason / available", uint256(q.session), uint256(q.reason), q.available);
        if (q.reason == T.Reason.MARKET_CLOSED || q.reason == T.Reason.FEED_STALE) {
            // The fork happened while Wall Street is closed: the refusal is the proof instead.
            vm.prank(borrower);
            vm.expectRevert(abi.encodeWithSelector(AaveDesk.Refused.selector, q.reason));
            desk.draw(lineId, 10e6);
            return;
        }
        assertEq(uint256(q.reason), uint256(T.Reason.NONE));
        assertGt(q.available, 10e6);
        assertLe(q.available, q.venueAvailable, "never more than Aave itself would lend");
        uint256 usdcBefore = IERC20(USDC).balanceOf(borrower);
        uint256 debtBefore = SPOKE.getUserTotalDebt(USDC_RESERVE, borrower);
        vm.prank(borrower);
        desk.draw(lineId, 10e6);
        assertEq(IERC20(USDC).balanceOf(borrower) - usdcBefore, 10e6, "every unit reaches the owner");
        assertEq(IERC20(USDC).balanceOf(address(desk)), 0, "the desk keeps nothing");
        assertApproxEqAbs(SPOKE.getUserTotalDebt(USDC_RESERVE, borrower) - debtBefore, 10e6, 2);
        // The Taker consumes the allowance by the measured debt delta (rounding in the hub's share maths).
        assertApproxEqAbs(TAKER.borrowAllowance(address(SPOKE), USDC_RESERVE, borrower, address(desk)), 990e6, 2);
        assertGe(SPOKE.getUserAccountData(borrower).healthFactor, WAD);
    }

    /// @dev The one action that is safe on a held price: the vault repays through the live Giver on a
    ///      Saturday, funded from the user's own reserve, then from an advance.
    function test_fork_protectThroughTheLiveGiverOnSaturday() public {
        deal(USDC, borrower, 50e6);
        vm.prank(borrower);
        vault.deposit(50e6);
        deal(USDC, owner, 500e6);
        vm.startPrank(owner);
        IERC20(USDC).approve(address(vault), 500e6);
        vault.fundAdvances(500e6);
        vm.stopPrank();

        vm.warp(T_SAT);
        uint256 debtBefore = SPOKE.getUserTotalDebt(USDC_RESERVE, borrower);
        uint256 hfBefore = SPOKE.getUserAccountData(borrower).healthFactor;
        vm.prank(keeper);
        (uint256 repaid, ProtectionVault.Funding memory f) = vault.protect(borrower, PARTNER, 80e6);
        assertEq(repaid, 80e6);
        assertEq(f.fromUser, 50e6);
        assertEq(f.fromPartner, 0);
        assertEq(f.fromAdvance, 30e6);
        uint256 debtAfter = SPOKE.getUserTotalDebt(USDC_RESERVE, borrower);
        assertApproxEqAbs(debtBefore - debtAfter, 80e6, 2);
        assertGt(SPOKE.getUserAccountData(borrower).healthFactor, hfBefore);
        assertEq(vault.advanceOf(borrower).outstanding, 30e6);
        assertEq(vault.advanceOf(borrower).feeOutstanding, 0.3e6);
        assertEq(IERC20(USDC).balanceOf(address(vault)), 470e6, "reserves spent, advance liquidity left");

        // And the weekend draw stays refused while the repay went through.
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(AaveDesk.Refused.selector, T.Reason.MARKET_CLOSED));
        desk.draw(lineId, 1e6);
        assertEq(uint256(desk.obligationStatus(lineId)), uint256(T.ObligationStatus.HOLD_SESSION));

        // Settlement by the user in USDC clears the advance and the fee.
        deal(USDC, borrower, 31e6);
        vm.prank(borrower);
        vault.repayAdvance(borrower, 31e6);
        assertEq(vault.advanceOf(borrower).outstanding, 0);
        assertEq(vault.feesCollected(), 0.3e6);
    }

    /// @dev Monday recovery: the vault withdraws collateral through the live Taker (a B20 transfer, so
    ///      base-forge only) in an open session, never on the weekend.
    function test_fork_recoverCollateralThroughTheLiveTaker() public {
        if (!b20Live) {
            vm.skip(true);
            return;
        }
        deal(USDC, owner, 500e6);
        vm.startPrank(owner);
        IERC20(USDC).approve(address(vault), 500e6);
        vault.fundAdvances(500e6);
        vm.stopPrank();
        vm.prank(keeper);
        vault.protect(borrower, PARTNER, 20e6); // all advance
        assertEq(vault.advanceOf(borrower).outstanding, 20e6);

        IPriceGate.Verdict memory v = gate.check(AAPLC);
        if (v.state != IPriceGate.GateState.OPEN) {
            vm.prank(keeper);
            vm.expectRevert();
            vault.recover(borrower, AAPL_RESERVE, 1e7);
            console.log("gate not OPEN at the fork timestamp; recovery refusal proven instead, state", uint256(v.state));
            return;
        }
        uint256 suppliedBefore = SPOKE.getUserSuppliedAssets(AAPL_RESERVE, borrower);
        vm.prank(keeper);
        uint256 withdrawn = vault.recover(borrower, AAPL_RESERVE, 1e7); // 0.1 AAPLc
        assertEq(withdrawn, 1e7);
        assertEq(IERC20(AAPLC).balanceOf(address(vault)), 1e7);
        assertEq(vault.heldCollateral(borrower, AAPLC), 1e7);
        assertApproxEqAbs(suppliedBefore - SPOKE.getUserSuppliedAssets(AAPL_RESERVE, borrower), 1e7, 1);
        vm.prank(keeper);
        vault.returnCollateral(borrower, AAPLC, 1e7);
        assertEq(IERC20(AAPLC).balanceOf(address(vault)), 0);
    }

    /// @dev A key nobody else uses. Well-known test keys (0xB0B, 0xA11CE, ...) have EIP-7702 delegations on
    ///      Base mainnet, so their addresses carry code and Aave's SignatureChecker takes the ERC-1271 path.
    function _freshKey(string memory label) internal pure returns (uint256 key, address signer) {
        key = uint256(keccak256(abi.encodePacked("boundline/aave-fork/", label)));
        signer = vm.addr(key);
    }

    /// @dev The signature variant of the borrow allowance, verified against the deployed Taker: domain
    ///      "TakerPositionManager"/"1", BorrowPermit typehash, keyed nonce. A fresh key with no position
    ///      is enough: approving is independent of holding collateral.
    function test_fork_approveBorrowWithSigMatchesTheLiveTaker() public {
        (uint256 key, address signer) = _freshKey("borrow-permit");
        assertEq(signer.code.length, 0, "an EOA without a 7702 delegation");
        ITakerPositionManager.BorrowPermit memory p = ITakerPositionManager.BorrowPermit({
            spoke: address(SPOKE),
            reserveId: USDC_RESERVE,
            owner: signer,
            spender: address(desk),
            amount: 123e6,
            nonce: TAKER.nonces(signer, 0),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, AaveEnrolment.borrowPermitDigest(TAKER, p));
        TAKER.approveBorrowWithSig(p, abi.encodePacked(r, s, v)); // relayed by anyone
        assertEq(TAKER.borrowAllowance(address(SPOKE), USDC_RESERVE, signer, address(desk)), 123e6);
        assertEq(TAKER.nonces(signer, 0), 1);
    }

    function test_fork_approveWithdrawWithSigMatchesTheLiveTaker() public {
        (uint256 key, address signer) = _freshKey("withdraw-permit");
        assertEq(signer.code.length, 0, "an EOA without a 7702 delegation");
        ITakerPositionManager.WithdrawPermit memory p = ITakerPositionManager.WithdrawPermit({
            spoke: address(SPOKE),
            reserveId: AAPL_RESERVE,
            owner: signer,
            spender: address(vault),
            amount: 5e7,
            nonce: TAKER.nonces(signer, 0),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, AaveEnrolment.withdrawPermitDigest(TAKER, p));
        TAKER.approveWithdrawWithSig(p, abi.encodePacked(r, s, v));
        assertEq(TAKER.withdrawAllowance(address(SPOKE), AAPL_RESERVE, signer, address(vault)), 5e7);
    }

    /// @dev The signature variant of the manager approvals, verified against the deployed spoke: domain
    ///      "Spoke"/"1", SetUserPositionManagers typehash with the nested PositionManagerUpdate array.
    function test_fork_setUserPositionManagersWithSigMatchesTheLiveSpoke() public {
        (uint256 key, address signer) = _freshKey("position-managers");
        assertEq(signer.code.length, 0, "an EOA without a 7702 delegation");
        IAaveSpoke.PositionManagerUpdate[] memory updates = new IAaveSpoke.PositionManagerUpdate[](2);
        updates[0] = IAaveSpoke.PositionManagerUpdate(address(TAKER), true);
        updates[1] = IAaveSpoke.PositionManagerUpdate(address(GIVER), true);
        IAaveSpoke.SetUserPositionManagers memory p = IAaveSpoke.SetUserPositionManagers({
            onBehalfOf: signer, updates: updates, nonce: SPOKE.nonces(signer, 0), deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, AaveEnrolment.setPositionManagersDigest(SPOKE, p));
        SPOKE.setUserPositionManagersWithSig(p, abi.encodePacked(r, s, v));
        assertTrue(SPOKE.isPositionManager(signer, address(TAKER)));
        assertTrue(SPOKE.isPositionManager(signer, address(GIVER)));
    }

    function test_fork_weekendDrawRefusedForEveryone() public {
        vm.warp(T_SAT);
        T.Quote memory q = desk.quote(lineId, 10e6);
        assertEq(uint256(q.reason), uint256(T.Reason.MARKET_CLOSED));
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(AaveDesk.Refused.selector, T.Reason.MARKET_CLOSED));
        desk.draw(lineId, 10e6);
    }
}
