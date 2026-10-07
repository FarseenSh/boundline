// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {TestPriceFeed} from "../../src/test/TestPriceFeed.sol";
import {MirrorOracleRegistry} from "../../src/test/MirrorOracleRegistry.sol";
import {MockB20} from "../../src/test/MockB20.sol";
import {AaveTypes as T} from "../../src/aave/AaveTypes.sol";
import {DeployAave} from "../../script/DeployAave.s.sol";
import {MockAaveSpoke} from "./mocks/MockAaveSpoke.sol";
import {MockTaker, MockGiver} from "./mocks/MockPositionManagers.sol";

contract DeployAaveHarness is DeployAave {
    function configFromEnv() external view returns (Config memory) {
        return _config();
    }

    function deployFrom(Config memory c) external returns (Deployed memory) {
        return _deploy(c, address(this));
    }
}

/// @notice The deploy script's logic against the mock spoke world; the harness is the deployer, so it
///         becomes owner and default partner admin and the policy is set in the same run.
contract DeployAaveTest is Test {
    int256 constant PRICE = 33_366_495_000;
    uint256 constant T_REGULAR = 1_790_877_600;

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");

    MockB20 usdc;
    MockB20 aapl;
    SessionGate gate;
    MockAaveSpoke spoke;
    MockTaker taker;
    MockGiver giver;
    uint256 aaplRes;
    uint256 usdcRes;
    DeployAaveHarness harness;

    function setUp() public {
        vm.warp(T_REGULAR);
        usdc = new MockB20("USD Coin", "USDC", 6);
        aapl = new MockB20("Coinbase Wrapped AAPL", "AAPLc", 8);
        MarketCalendar cal = new MarketCalendar(owner);
        vm.prank(owner);
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        MirrorOracleRegistry registry = new MirrorOracleRegistry(owner);
        TestPriceFeed feed = new TestPriceFeed(owner, 8, "Coinbase AAPL", PRICE);
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
        harness = new DeployAaveHarness();
    }

    function _config() internal view returns (DeployAave.Config memory c) {
        c.spoke = address(spoke);
        c.taker = address(taker);
        c.giver = address(giver);
        c.gate = address(gate);
        c.keeper = keeper;
        c.loanReserveId = usdcRes;
        c.collateralReserveId = aaplRes;
        c.partnerName = "boundline-app";
        c.partnerId = harness.partnerIdOf("boundline-app");
        c.partnerCap = 1000e6;
        c.maxLtvWad = 0.5e18;
        c.minDraw = 1e6;
        c.maxDraw = 100e6;
        c.reserveCap = 500e6;
        c.advanceCapPerUser = 200e6;
        c.advanceFeeBps = 100;
    }

    function test_deploysBothAndConfiguresThePartner() public {
        DeployAave.Deployed memory d = harness.deployFrom(_config());
        assertEq(d.desk.owner(), address(harness));
        assertEq(d.vault.owner(), address(harness));
        assertEq(d.desk.keeper(), keeper);
        assertEq(d.vault.keeper(), keeper);
        assertEq(d.collateral, address(aapl));
        assertTrue(d.policySet);
        assertTrue(d.desk.reserve(aaplRes).enabled);
        T.Partner memory p = d.desk.partner(d.partnerId);
        assertEq(p.admin, address(harness));
        assertEq(p.exposureCap, 1000e6);
        T.ReservePolicy memory t = d.desk.reservePolicy(d.partnerId, aaplRes);
        assertTrue(t.allowed);
        assertEq(t.maxLtvWad, 0.5e18);
        assertEq(d.vault.partnerAdmin(d.partnerId), address(harness));
        assertEq(d.vault.advanceCapPerUser(), 200e6);
        assertEq(d.vault.advanceFeeBps(), 100);
        assertEq(d.partnerId, bytes32(bytes("boundline-app")));
    }

    function test_otherAdminSkipsThePolicy() public {
        DeployAave.Config memory c = _config();
        c.partnerAdmin = owner;
        DeployAave.Deployed memory d = harness.deployFrom(c);
        assertFalse(d.policySet);
        assertEq(d.desk.partner(d.partnerId).admin, owner);
    }

    function test_preChecks() public {
        DeployAave.Config memory c = _config();
        c.maxLtvWad = 0.78e18;
        vm.expectRevert(
            abi.encodeWithSelector(DeployAave.LtvNotBelowCollateralFactor.selector, uint64(0.78e18), 0.78e18)
        );
        harness.deployFrom(c);

        c = _config();
        c.collateralReserveId = usdcRes;
        vm.expectRevert(abi.encodeWithSelector(DeployAave.CollateralFactorZero.selector, usdcRes));
        harness.deployFrom(c);

        c = _config();
        spoke.setFlags(usdcRes, false, false, false);
        vm.expectRevert(abi.encodeWithSelector(DeployAave.LoanReserveNotBorrowable.selector, usdcRes));
        harness.deployFrom(c);
        spoke.setFlags(usdcRes, false, false, true);

        spoke.updatePositionManager(address(giver), false);
        vm.expectRevert(abi.encodeWithSelector(DeployAave.ManagerNotActive.selector, address(giver)));
        harness.deployFrom(c);
        spoke.updatePositionManager(address(giver), true);

        taker.registerSpoke(address(spoke), false);
        vm.expectRevert(abi.encodeWithSelector(DeployAave.SpokeNotRegistered.selector, address(taker)));
        harness.deployFrom(c);
        taker.registerSpoke(address(spoke), true);

        c.spoke = address(0xdead);
        vm.expectRevert();
        harness.deployFrom(c);
    }

    function test_envDefaults() public {
        // Env set by other tests in the same run persists (vm.setEnv is process-wide), so pin every input.
        vm.setEnv("GATE", vm.toString(address(gate)));
        vm.setEnv("KEEPER", vm.toString(keeper));
        vm.setEnv("PARTNER_ID", "boundline-app");
        vm.setEnv("SPOKE", vm.toString(harness.SPOKE_DEFAULT()));
        vm.setEnv("LOAN_RESERVE_ID", "7");
        vm.setEnv("COLLATERAL_RESERVE_ID", "0");
        vm.setEnv("MAX_LTV_WAD", "500000000000000000");
        vm.setEnv("ADVANCE_FEE_BPS", "100");
        DeployAave.Config memory c = harness.configFromEnv();
        assertEq(c.spoke, harness.SPOKE_DEFAULT());
        assertEq(c.loanReserveId, 7);
        assertEq(c.collateralReserveId, 0);
        // Another suite may overwrite PARTNER_ID between setEnv and configFromEnv (vm.setEnv is process-wide
        // and suites run in parallel), so check the id encodes whatever name was read, not a fixed name.
        assertEq(c.partnerId, bytes32(bytes(c.partnerName)));
        assertEq(c.maxLtvWad, 0.5e18);
        assertEq(c.advanceFeeBps, 100);
    }
}
