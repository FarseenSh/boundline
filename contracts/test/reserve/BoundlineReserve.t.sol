// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {MockB20} from "../../src/test/MockB20.sol";
import {BoundlineReserve} from "../../src/reserve/BoundlineReserve.sol";
import {IAdvanceSink} from "../../src/reserve/IAdvanceSink.sol";

/// @dev A sink with the vault's accounting shape and a knob that turns liquidity into an outstanding
///      advance (`advance`) or into fees (`earn`), so the Reserve's cap, recall and harvest paths are exercised.
contract MockSink is IAdvanceSink {
    MockB20 public usdc;
    uint256 public advanceLiquidity;
    uint256 public totalOutstanding;
    uint256 public feesCollected;

    constructor(MockB20 usdc_) {
        usdc = usdc_;
    }

    function fundAdvances(uint256 amount) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        advanceLiquidity += amount;
    }

    function defundAdvances(uint256 amount, address to) external {
        require(amount <= advanceLiquidity, "sink: not free");
        advanceLiquidity -= amount;
        usdc.transfer(to, amount);
    }

    function collectFees(address to) external {
        uint256 a = feesCollected;
        feesCollected = 0;
        usdc.transfer(to, a);
    }

    /// @dev An advance leaves the sink: the money is with a borrower's venue until settled.
    function advance(uint256 amount) external {
        advanceLiquidity -= amount;
        totalOutstanding += amount;
        usdc.transfer(address(0xdead), amount);
    }

    function settle(uint256 amount, uint256 fee) external {
        usdc.mint(address(this), amount + fee);
        totalOutstanding -= amount;
        advanceLiquidity += amount;
        feesCollected += fee;
    }

    function earn(uint256 fee) external {
        usdc.mint(address(this), fee);
        feesCollected += fee;
    }
}

contract BoundlineReserveTest is Test {
    uint256 constant T0 = 1_790_877_600; // Thu 2026-10-01 14:00 ET
    uint64 constant COOLDOWN = 1 hours;
    uint16 constant CAP_BPS = 8000;

    address owner = makeAddr("owner");
    address manager = makeAddr("manager");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address stranger = makeAddr("stranger");

    MockB20 usdc;
    BoundlineReserve reserve;
    MockSink sink;
    MockSink sink2;

    function setUp() public {
        vm.warp(T0);
        usdc = new MockB20("USD Coin", "USDC", 6);
        reserve = new BoundlineReserve(owner, IERC20(address(usdc)), manager, COOLDOWN, CAP_BPS);
        sink = new MockSink(usdc);
        sink2 = new MockSink(usdc);
        vm.startPrank(owner);
        reserve.addSink(address(sink));
        reserve.addSink(address(sink2));
        vm.stopPrank();
        usdc.mint(alice, 10_000e6);
        usdc.mint(bob, 10_000e6);
        vm.prank(alice);
        usdc.approve(address(reserve), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(reserve), type(uint256).max);
    }

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        vm.prank(who);
        shares = reserve.deposit(amount, who);
    }

    // ------------------------------------------------------------ shape

    function test_metadata() public view {
        assertEq(reserve.asset(), address(usdc));
        assertEq(reserve.decimals(), 6);
        assertEq(reserve.name(), "Boundline Reserve USDC");
        assertEq(reserve.symbol(), "blUSDC");
        assertEq(reserve.owner(), owner);
        assertEq(reserve.manager(), manager);
        assertEq(reserve.cooldownSeconds(), COOLDOWN);
        assertEq(reserve.utilisationCapBps(), CAP_BPS);
        assertEq(reserve.sinks().length, 2);
        assertEq(reserve.totalAssets(), 0);
    }

    function test_constructorRefusesACapAboveTheMaximum() public {
        vm.expectRevert(abi.encodeWithSelector(BoundlineReserve.UtilisationCapTooHigh.selector, uint16(9001)));
        new BoundlineReserve(owner, IERC20(address(usdc)), manager, COOLDOWN, 9001);
        vm.expectRevert(BoundlineReserve.ZeroAddress.selector);
        new BoundlineReserve(owner, IERC20(address(0)), manager, COOLDOWN, CAP_BPS);
    }

    function test_ownerSetters() public {
        vm.startPrank(owner);
        reserve.setManager(stranger);
        reserve.setCooldown(2 days);
        reserve.setUtilisationCap(9000);
        vm.expectRevert(abi.encodeWithSelector(BoundlineReserve.UtilisationCapTooHigh.selector, uint16(9001)));
        reserve.setUtilisationCap(9001);
        vm.stopPrank();
        assertEq(reserve.manager(), stranger);
        assertEq(reserve.cooldownSeconds(), 2 days);
        assertEq(reserve.utilisationCapBps(), 9000);
        vm.prank(stranger);
        vm.expectRevert();
        reserve.setManager(stranger);
    }

    function test_sinkRegistry() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(BoundlineReserve.SinkExists.selector, address(sink)));
        reserve.addSink(address(sink));
        vm.expectRevert(abi.encodeWithSelector(BoundlineReserve.NotAContract.selector, stranger));
        reserve.addSink(stranger);
        vm.expectRevert(BoundlineReserve.ZeroAddress.selector);
        reserve.addSink(address(0));
        reserve.removeSink(address(sink2));
        vm.expectRevert(abi.encodeWithSelector(BoundlineReserve.UnknownSink.selector, address(sink2)));
        reserve.removeSink(address(sink2));
        vm.stopPrank();
        assertEq(reserve.sinks().length, 1);
        assertEq(reserve.sinks()[0], address(sink));
        assertFalse(reserve.isSink(address(sink2)));

        _deposit(alice, 1000e6);
        vm.prank(manager);
        reserve.allocate(address(sink), 100e6);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(BoundlineReserve.SinkStillAllocated.selector, address(sink), 100e6));
        reserve.removeSink(address(sink));
        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(BoundlineReserve.UnknownSink.selector, address(sink2)));
        reserve.allocate(address(sink2), 1e6);
    }

    // ------------------------------------------------------------ deposits and allocation

    function test_depositMintsOneToOneAtStart() public {
        uint256 shares = _deposit(alice, 1000e6);
        assertEq(shares, 1000e6);
        assertEq(reserve.balanceOf(alice), 1000e6);
        assertEq(reserve.totalAssets(), 1000e6);
        assertEq(reserve.idleAssets(), 1000e6);
        vm.prank(bob);
        assertEq(reserve.mint(500e6, bob), 500e6);
        assertEq(reserve.totalSupply(), 1500e6);
    }

    function test_allocateMovesIdleIntoTheSinkWithinTheCap() public {
        _deposit(alice, 1000e6);
        vm.prank(manager);
        reserve.allocate(address(sink), 600e6);
        assertEq(reserve.allocated(address(sink)), 600e6);
        assertEq(reserve.totalAllocated(), 600e6);
        assertEq(reserve.idleAssets(), 400e6);
        assertEq(reserve.totalAssets(), 1000e6, "placed capital stays an asset of the vault");
        assertEq(reserve.utilisationBps(), 6000);
        assertEq(sink.advanceLiquidity(), 600e6);
        assertEq(usdc.allowance(address(reserve), address(sink)), 0, "approval is cleared after the pull");

        // 600 + 201 > 80% of 1000
        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(BoundlineReserve.UtilisationCapExceeded.selector, 801e6, 800e6));
        reserve.allocate(address(sink2), 201e6);
        vm.prank(manager);
        reserve.allocate(address(sink2), 200e6);
        assertEq(reserve.utilisationBps(), 8000);

        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(BoundlineReserve.InsufficientIdle.selector, 200e6, 201e6));
        reserve.allocate(address(sink), 201e6);
        vm.prank(manager);
        vm.expectRevert(BoundlineReserve.ZeroAmount.selector);
        reserve.allocate(address(sink), 0);
        vm.prank(stranger);
        vm.expectRevert(BoundlineReserve.NotManager.selector);
        reserve.allocate(address(sink), 1e6);
        vm.prank(owner); // the owner may act as the manager
        vm.expectRevert(abi.encodeWithSelector(BoundlineReserve.UtilisationCapExceeded.selector, 801e6, 800e6));
        reserve.allocate(address(sink), 1e6);
    }

    function test_recallTakesFreeLiquidityBack() public {
        _deposit(alice, 1000e6);
        vm.prank(manager);
        reserve.allocate(address(sink), 600e6);
        sink.advance(400e6); // 400 is now outstanding at a venue, 200 free
        vm.prank(manager);
        vm.expectRevert("sink: not free");
        reserve.recall(address(sink), 300e6);
        vm.prank(manager);
        reserve.recall(address(sink), 200e6);
        assertEq(reserve.allocated(address(sink)), 400e6);
        assertEq(reserve.idleAssets(), 600e6);
        assertEq(reserve.totalAssets(), 1000e6);
        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(BoundlineReserve.RecallExceedsAllocation.selector, 400e6, 401e6));
        reserve.recall(address(sink), 401e6);
    }

    function test_harvestRaisesTheSharePrice() public {
        _deposit(alice, 1000e6);
        vm.prank(manager);
        reserve.allocate(address(sink), 500e6);
        sink.advance(500e6);
        sink.settle(500e6, 5e6); // the borrower settled with a 1% fee
        vm.prank(manager);
        assertEq(reserve.harvest(address(sink)), 5e6);
        assertEq(reserve.totalHarvested(), 5e6);
        assertEq(reserve.totalAssets(), 1005e6);
        assertEq(reserve.allocated(address(sink)), 500e6, "the placement is unchanged by a harvest");
        assertApproxEqAbs(reserve.convertToAssets(1000e6), 1005e6, 1, "alice's shares are worth the fee more");
        uint256 bobShares = _deposit(bob, 1005e6);
        assertApproxEqAbs(bobShares, 1000e6, 1, "a later depositor pays the higher price");
    }

    function test_writeDownLowersTheSharePriceByExactlyTheLoss() public {
        _deposit(alice, 1000e6);
        vm.prank(manager);
        reserve.allocate(address(sink), 500e6);
        sink.advance(500e6);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(BoundlineReserve.WriteDownExceedsAllocation.selector, 500e6, 501e6));
        reserve.writeDown(address(sink), 501e6);
        vm.prank(manager);
        vm.expectRevert();
        reserve.writeDown(address(sink), 50e6); // owner only
        vm.prank(owner);
        reserve.writeDown(address(sink), 50e6);
        assertEq(reserve.allocated(address(sink)), 450e6);
        assertEq(reserve.totalAllocated(), 450e6);
        assertEq(reserve.totalWrittenDown(), 50e6);
        assertEq(reserve.totalAssets(), 950e6);
        assertApproxEqAbs(reserve.convertToAssets(1000e6), 950e6, 1);
    }

    // ------------------------------------------------------------ cooldown and liquidity-capped redemptions

    function test_redeemNeedsAMaturedRequest() public {
        uint256 shares = _deposit(alice, 1000e6);
        assertEq(reserve.maxRedeem(alice), 0, "nothing is redeemable before a request");
        assertEq(reserve.maxWithdraw(alice), 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, alice, shares, 0));
        reserve.redeem(shares, alice, alice);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BoundlineReserve.InsufficientShares.selector, shares, shares + 1));
        reserve.requestRedeem(shares + 1);
        vm.prank(alice);
        reserve.requestRedeem(400e6);
        BoundlineReserve.RedeemRequest memory r = reserve.redeemRequest(alice);
        assertEq(r.shares, 400e6);
        assertEq(r.requestedAt, T0);
        assertEq(reserve.maturedShares(alice), 0);
        assertEq(reserve.maxRedeem(alice), 0, "not matured yet");

        vm.warp(T0 + COOLDOWN - 1);
        assertEq(reserve.maxRedeem(alice), 0);
        vm.warp(T0 + COOLDOWN);
        assertEq(reserve.maturedShares(alice), 400e6);
        assertEq(reserve.maxRedeem(alice), 400e6);
        assertEq(reserve.maxWithdraw(alice), 400e6);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, alice, 401e6, 400e6));
        reserve.redeem(401e6, alice, alice);
        vm.prank(alice);
        assertEq(reserve.redeem(150e6, alice, alice), 150e6);
        assertEq(reserve.redeemRequest(alice).shares, 250e6, "the request is consumed, not reset");
        vm.prank(alice);
        assertEq(reserve.withdraw(250e6, alice, alice), 250e6);
        assertEq(reserve.redeemRequest(alice).shares, 0, "a fully used request is deleted");
        assertEq(reserve.balanceOf(alice), 600e6);
        assertEq(usdc.balanceOf(alice), 9400e6);
        assertEq(reserve.maxRedeem(alice), 0);
    }

    function test_aNewRequestReplacesTheOldOneAndRestartsTheClock() public {
        _deposit(alice, 1000e6);
        vm.prank(alice);
        reserve.requestRedeem(400e6);
        vm.warp(T0 + COOLDOWN);
        vm.prank(alice);
        reserve.requestRedeem(600e6);
        assertEq(reserve.maxRedeem(alice), 0, "the clock restarted");
        vm.warp(T0 + 2 * COOLDOWN);
        assertEq(reserve.maxRedeem(alice), 600e6);
        vm.prank(alice);
        reserve.cancelRedeemRequest();
        assertEq(reserve.maxRedeem(alice), 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BoundlineReserve.NoRedeemRequest.selector, alice));
        reserve.cancelRedeemRequest();
    }

    function test_redemptionsAreCappedByIdleLiquidity() public {
        _deposit(alice, 1000e6);
        vm.prank(manager);
        reserve.allocate(address(sink), 800e6);
        vm.prank(alice);
        reserve.requestRedeem(1000e6);
        vm.warp(T0 + COOLDOWN);
        assertEq(reserve.maxRedeem(alice), 200e6, "only the idle 200 can pay a redemption");
        assertEq(reserve.maxWithdraw(alice), 200e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, alice, 201e6, 200e6));
        reserve.withdraw(201e6, alice, alice);
        vm.prank(alice);
        reserve.withdraw(200e6, alice, alice);
        assertEq(reserve.idleAssets(), 0);
        assertEq(reserve.maxRedeem(alice), 0);
        assertEq(reserve.redeemRequest(alice).shares, 800e6, "the rest of the request waits for a recall");
        vm.prank(manager);
        reserve.recall(address(sink), 300e6);
        assertEq(reserve.maxRedeem(alice), 300e6);
        assertEq(reserve.utilisationBps(), 6250, "500 placed of 800 total");
    }

    function test_maturedSharesNeverExceedTheBalance() public {
        _deposit(alice, 1000e6);
        vm.prank(alice);
        reserve.requestRedeem(1000e6);
        vm.prank(alice);
        reserve.transfer(bob, 700e6);
        vm.warp(T0 + COOLDOWN);
        assertEq(reserve.maturedShares(alice), 300e6);
        assertEq(reserve.maxRedeem(alice), 300e6);
        assertEq(reserve.maxRedeem(bob), 0, "bob holds shares but requested nothing");
    }

    function test_anApprovedSpenderRedeemsOnTheOwnersRequest() public {
        _deposit(alice, 1000e6);
        vm.prank(alice);
        reserve.requestRedeem(100e6);
        vm.prank(alice);
        reserve.approve(bob, 100e6);
        vm.warp(T0 + COOLDOWN);
        vm.prank(bob);
        reserve.redeem(100e6, bob, alice);
        assertEq(usdc.balanceOf(bob), 10_100e6);
        assertEq(reserve.balanceOf(alice), 900e6);
    }

    function testFuzz_withdrawOfMaxWithdrawAlwaysSucceeds(uint96 deposit_, uint96 alloc, uint96 fee) public {
        uint256 d = bound(deposit_, 1e6, 1_000_000e6);
        usdc.mint(alice, d);
        _deposit(alice, d);
        uint256 a = bound(alloc, 0, (d * CAP_BPS) / 10_000);
        if (a != 0) {
            vm.prank(manager);
            reserve.allocate(address(sink), a);
        }
        uint256 f = bound(fee, 0, 1000e6);
        if (f != 0) {
            sink.earn(f);
            vm.prank(manager);
            reserve.harvest(address(sink));
        }
        uint256 bal = reserve.balanceOf(alice);
        vm.prank(alice);
        reserve.requestRedeem(bal);
        vm.warp(T0 + COOLDOWN);
        uint256 maxW = reserve.maxWithdraw(alice);
        uint256 maxR = reserve.maxRedeem(alice);
        assertLe(maxW, reserve.idleAssets(), "a redemption is never promised more than the idle USDC");
        if (maxW != 0) {
            vm.prank(alice);
            uint256 shares = reserve.withdraw(maxW, alice, alice);
            assertLe(shares, maxR);
        }
    }

    function testFuzz_sharePriceOnlyFallsThroughAWriteDown(uint96 deposit_, uint96 alloc, uint96 fee) public {
        uint256 d = bound(deposit_, 1e6, 1_000_000e6);
        usdc.mint(alice, d);
        _deposit(alice, d);
        uint256 priceBefore = reserve.convertToAssets(1e6);
        uint256 a = bound(alloc, 1, (d * CAP_BPS) / 10_000);
        vm.prank(manager);
        reserve.allocate(address(sink), a);
        sink.advance(a);
        uint256 f = bound(fee, 0, a / 100);
        sink.settle(a, f);
        vm.prank(manager);
        reserve.harvest(address(sink));
        vm.prank(manager);
        reserve.recall(address(sink), a);
        assertGe(reserve.convertToAssets(1e6), priceBefore, "allocate, advance, settle, harvest, recall never lose");
    }
}
