// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {IrmMock} from "morpho-blue/mocks/IrmMock.sol";
import {IPolicyRegistry} from "base-std/interfaces/IPolicyRegistry.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {SessionGuard} from "../../src/oracle/SessionGuard.sol";
import {CreditDesk} from "../../src/desk/CreditDesk.sol";
import {TestPriceFeed} from "../../src/test/TestPriceFeed.sol";
import {MirrorOracleRegistry} from "../../src/test/MirrorOracleRegistry.sol";
import {MockB20} from "../../src/test/MockB20.sol";
import {DeployReserve} from "../../script/DeployReserve.s.sol";

/// @dev Exposes the script's logic without broadcast; the contracts see the harness as the deployer.
contract DeployReserveHarness is DeployReserve {
    function configFromEnv() external view returns (Config memory) {
        return _config();
    }

    function deployFrom(Config memory c) external returns (Deployed memory) {
        return _deploy(c, address(this));
    }
}

/// @notice The Reserve deploy script against a CreditDesk on the real Morpho Blue bytecode (etched).
contract DeployReserveTest is Test {
    using MarketParamsLib for MarketParams;

    address constant MORPHO_ADDR = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    IMorpho constant MORPHO = IMorpho(MORPHO_ADDR);
    uint256 constant LLTV = 0.625e18;
    int256 constant PRICE = 33_366_495_000;
    uint256 constant T_REGULAR = 1_790_877_600;

    address keeper = makeAddr("keeper");
    address partnerAdmin = makeAddr("partnerAdmin");
    MockB20 usdc;
    MockB20 aapl;
    CreditDesk desk;
    DeployReserveHarness harness;

    function setUp() public {
        vm.warp(T_REGULAR);
        bytes memory code = vm.parseBytes(vm.readFile("test/fixtures/morpho-blue-8453.runtime.hex"));
        vm.etch(MORPHO_ADDR, code);
        vm.store(MORPHO_ADDR, bytes32(0), bytes32(uint256(uint160(address(this)))));
        IrmMock irm = new IrmMock();
        MORPHO.enableIrm(address(irm));
        MORPHO.enableLltv(LLTV);
        usdc = new MockB20("USD Coin", "USDC", 6);
        aapl = new MockB20("Coinbase Wrapped AAPL", "AAPLc", 8);
        MarketCalendar cal = new MarketCalendar(address(this));
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        MirrorOracleRegistry registry = new MirrorOracleRegistry(address(this));
        TestPriceFeed feed = new TestPriceFeed(address(this), 8, "Coinbase AAPL", PRICE);
        SessionGate gate = new SessionGate(address(this), cal, registry);
        gate.setFeed(address(aapl), feed, 0, 0);
        SessionGuard guard = new SessionGuard(gate, address(aapl), 8, address(usdc), 6, 0);
        MarketParams memory params = MarketParams({
            loanToken: address(usdc),
            collateralToken: address(aapl),
            oracle: address(guard),
            irm: address(irm),
            lltv: LLTV
        });
        MORPHO.createMarket(params);
        harness = new DeployReserveHarness();
        // the harness is the desk owner so SET_DESK_VAULT can run
        desk = new CreditDesk(address(harness), MORPHO, gate, IPolicyRegistry(address(0)), false, keeper);
        usdc.mint(address(harness), 10e6);
    }

    function _config() internal view returns (DeployReserve.Config memory c) {
        c.desk = address(desk);
        c.usdc = address(usdc);
        c.cooldownSeconds = 3600;
        c.utilisationCapBps = 8000;
        c.advanceFeeBps = 100;
        c.advanceCapPerLine = 2e6;
        c.partnerName = "boundline-app";
        c.partnerId = harness.partnerIdOf("boundline-app");
        c.reserveDeposit = 2e6;
        c.reserveAllocate = 1e6;
    }

    function test_deploysWiresAndSeeds() public {
        DeployReserve.Config memory c = _config();
        c.keeper = keeper;
        c.partnerAdmin = partnerAdmin;
        c.setDeskVault = true;
        DeployReserve.Deployed memory d = harness.deployFrom(c);

        assertEq(d.reserve.owner(), address(harness));
        assertEq(d.reserve.manager(), address(harness), "zero manager means the deployer");
        assertEq(d.reserve.cooldownSeconds(), 3600);
        assertEq(d.reserve.utilisationCapBps(), 8000);
        assertEq(d.reserve.sinks().length, 1);
        assertEq(d.reserve.sinks()[0], address(d.vault));
        assertEq(d.vault.owner(), address(harness));
        assertEq(d.vault.keeper(), keeper);
        assertEq(d.vault.funder(), address(d.reserve));
        assertEq(d.vault.partnerAdmin(c.partnerId), partnerAdmin);
        assertEq(d.vault.advanceFeeBps(), 100);
        assertEq(d.vault.advanceCapPerLine(), 2e6);
        assertEq(address(d.vault.DESK()), address(desk));
        assertEq(desk.protectionVault(), address(d.vault));
        assertTrue(d.deskVaultSet);
        assertEq(d.sharesMinted, 2e6);
        assertEq(d.reserve.balanceOf(address(harness)), 2e6);
        assertEq(d.allocatedAmount, 1e6);
        assertEq(d.reserve.allocated(address(d.vault)), 1e6);
        assertEq(d.reserve.totalAssets(), 2e6);
        assertEq(d.reserve.idleAssets(), 1e6);
        assertEq(d.vault.advanceLiquidity(), 1e6);
        assertEq(usdc.balanceOf(address(harness)), 8e6);
    }

    function test_defaultsAndSkips() public {
        DeployReserve.Config memory c = _config();
        c.reserveDeposit = 0;
        c.reserveAllocate = 0;
        DeployReserve.Deployed memory d = harness.deployFrom(c);
        assertEq(d.vault.keeper(), address(harness));
        assertEq(d.vault.partnerAdmin(c.partnerId), address(harness));
        assertEq(desk.protectionVault(), address(0), "SET_DESK_VAULT defaults to false");
        assertFalse(d.deskVaultSet);
        assertEq(d.sharesMinted, 0);
        assertEq(d.reserve.totalAssets(), 0);
        assertEq(d.vault.advanceLiquidity(), 0);
    }

    function test_preChecks() public {
        DeployReserve.Config memory c = _config();
        c.desk = address(0xdead);
        vm.expectRevert();
        harness.deployFrom(c);
        c = _config();
        c.reserveAllocate = 3e6;
        vm.expectRevert(abi.encodeWithSelector(DeployReserve.AllocationExceedsDeposit.selector, 3e6, 2e6));
        harness.deployFrom(c);
        c = _config();
        c.utilisationCapBps = 9001;
        vm.expectRevert();
        harness.deployFrom(c);
    }

    function test_partnerIdEncoding() public view {
        assertEq(harness.partnerIdOf("boundline-app"), bytes32("boundline-app"));
        assertEq(
            harness.partnerIdOf("boundline-app"), 0x626f756e646c696e652d61707000000000000000000000000000000000000000
        );
    }

    function test_envDefaults() public {
        vm.setEnv("DESK", vm.toString(address(desk)));
        vm.setEnv("USDC", vm.toString(address(usdc)));
        vm.setEnv("COOLDOWN_SECONDS", "3600");
        vm.setEnv("UTILISATION_CAP_BPS", "8000");
        vm.setEnv("RESERVE_DEPOSIT", "2000000");
        vm.setEnv("RESERVE_ALLOCATE", "1000000");
        vm.setEnv("SET_DESK_VAULT", "false");
        DeployReserve.Config memory c = harness.configFromEnv();
        assertEq(c.desk, address(desk));
        assertEq(c.usdc, address(usdc));
        assertEq(c.cooldownSeconds, 3600);
        assertEq(c.utilisationCapBps, 8000);
        assertEq(c.reserveDeposit, 2e6);
        assertEq(c.reserveAllocate, 1e6);
        assertFalse(c.setDeskVault);
        // PARTNER_ID may be overwritten by another suite mid-test (vm.setEnv is process-wide): check the encoding
        assertEq(c.partnerId, bytes32(bytes(c.partnerName)));
    }
}
