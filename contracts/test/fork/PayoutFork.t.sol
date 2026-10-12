// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IOracleRegistry} from "../../src/interfaces/IOracleRegistry.sol";
import {IPriceGate} from "../../src/interfaces/IPriceGate.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {ICLPool} from "../../src/interfaces/ICLPool.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {LocalPayoutRouter} from "../../src/payout/LocalPayoutRouter.sol";

/// @notice The local-money leg on the real Aerodrome EURC/USDC Slipstream pool, on a Base mainnet fork
///         (BASE_RPC_URL): 10 USDC become EURC at the pool's own price, the session check reads the real
///         AAPLc feed through a SessionGate bound to the real OracleRegistry, and a Saturday is refused.
///         Stock forge is enough: nothing here moves a B20 token.
contract PayoutForkTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant EURC = 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42;
    address constant AAPLC = 0xb200000000000000000000C2e324d24d7eEcd1fb;
    IAggregatorV3 constant FEED = IAggregatorV3(0x787f13dEa48Db0897CbCDD985de77809D837F988);
    IOracleRegistry constant REGISTRY = IOracleRegistry(0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD);
    /// @dev Aerodrome Slipstream EURC/USDC (token0 EURC, token1 USDC, tickSpacing 50), about $1.7M on 26 Sep 2026.
    ICLPool constant POOL = ICLPool(0xE846373C1a92B167b4E9cd5d8E4d6B1Db9E90EC7);
    /// @dev A USDC-rich contract on Base (the Aerodrome AAPLc/USDC pool) the test borrows 10 USDC from.
    address constant USDC_SOURCE = 0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0;
    uint256 constant T_SAT = 1_791_640_800; // Sat 2026-10-10 10:00 ET

    address owner = makeAddr("owner");
    address user = makeAddr("user");

    SessionGate gate;
    LocalPayoutRouter router;
    /// @dev Whether the gate reports AAPLc OPEN at the fork's own timestamp; decided in setUp so the in-session
    ///      test can skip itself as its first statement (vm.skip must come first).
    bool inSession;

    function setUp() public {
        string memory url = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        assertEq(POOL.token0(), EURC, "pool token0 is EURC");
        assertEq(POOL.token1(), USDC, "pool token1 is USDC");

        MarketCalendar cal = new MarketCalendar(owner);
        vm.prank(owner);
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        gate = new SessionGate(owner, cal, REGISTRY);
        vm.prank(owner);
        gate.setFeed(AAPLC, FEED, 0, 0);
        router = new LocalPayoutRouter(gate);

        vm.prank(USDC_SOURCE);
        IERC20(USDC).transfer(user, 10e6);
        vm.prank(user);
        IERC20(USDC).approve(address(router), type(uint256).max);
        inSession = gate.check(AAPLC).state == IPriceGate.GateState.OPEN;
    }

    /// @dev EURC the pool's spot price pays for `usdcIn`, before the fee: usdc/eurc = (sqrtP / 2^96)^2.
    function _spotEurcFor(uint256 usdcIn) internal view returns (uint256) {
        (uint160 sqrtP,,,,,) = POOL.slot0();
        return Math.mulDiv(usdcIn, 1 << 192, uint256(sqrtP) * uint256(sqrtP));
    }

    function _params(uint256 amountIn, uint256 minOut, address gateToken)
        internal
        view
        returns (LocalPayoutRouter.PayoutParams memory)
    {
        return LocalPayoutRouter.PayoutParams({
            kind: LocalPayoutRouter.PoolKind.CL,
            pool: address(POOL),
            tokenIn: USDC,
            tokenOut: EURC,
            amountIn: amountIn,
            minOut: minOut,
            to: user,
            deadline: block.timestamp + 600,
            gateToken: gateToken
        });
    }

    function test_tenUsdcBecomeEurcOnTheRealPool() public {
        uint256 spot = _spotEurcFor(10e6);
        assertGt(spot, 8e6, "about 0.89 EURC per USDC");
        assertLt(spot, 10e6);
        uint256 minOut = spot * 99 / 100; // the pool's fee is 76 hundredths of a bip; 1% covers it and the tick walk
        vm.prank(user);
        uint256 out = router.payout(_params(10e6, minOut, address(0)));
        assertGe(out, minOut);
        assertLe(out, spot);
        assertEq(IERC20(EURC).balanceOf(user), out);
        assertEq(IERC20(USDC).balanceOf(user), 0);
        assertEq(IERC20(USDC).balanceOf(address(router)), 0);
        assertEq(IERC20(EURC).balanceOf(address(router)), 0);
        assertEq(router.payoutCount(user), 1);
        emit log_named_uint("usdc in", 10e6);
        emit log_named_uint("eurc out", out);
        emit log_named_uint("spot eurc (no fee)", spot);
    }

    /// @dev Skips outside US session hours, and under stock forge whenever the registry read needs a precompile.
    function test_inSessionPayoutPassesTheGate() public {
        vm.skip(!inSession);
        uint256 spot = _spotEurcFor(10e6);
        vm.prank(user);
        uint256 out = router.payout(_params(10e6, spot * 99 / 100, AAPLC));
        assertGt(out, 0);
    }

    function test_saturdayIsRefusedWithTheGateToken() public {
        vm.warp(T_SAT);
        assertEq(uint256(gate.check(AAPLC).state), uint256(IPriceGate.GateState.MARKET_CLOSED));
        LocalPayoutRouter.PayoutParams memory p = _params(10e6, 0, AAPLC);
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(LocalPayoutRouter.SessionClosed.selector, IPriceGate.GateState.MARKET_CLOSED)
        );
        router.payout(p);
        assertEq(IERC20(USDC).balanceOf(user), 10e6, "nothing moved");
    }

    function test_slippageBoundHolds() public {
        uint256 spot = _spotEurcFor(10e6);
        LocalPayoutRouter.PayoutParams memory p = _params(10e6, spot * 105 / 100, address(0));
        vm.prank(user);
        vm.expectPartialRevert(LocalPayoutRouter.SlippageExceeded.selector);
        router.payout(p);
    }
}
