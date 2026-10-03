// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {IrmMock} from "morpho-blue/mocks/IrmMock.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {SessionGuard} from "../../src/oracle/SessionGuard.sol";
import {CreditDesk} from "../../src/desk/CreditDesk.sol";
import {TestPriceFeed} from "../../src/test/TestPriceFeed.sol";
import {MirrorOracleRegistry} from "../../src/test/MirrorOracleRegistry.sol";
import {MockB20} from "../../src/test/MockB20.sol";
import {DeployCreditDesk} from "../../script/DeployCreditDesk.s.sol";

/// @dev Exposes the script's logic without broadcast; the desk sees the harness as the deployer,
///      so the harness becomes the owner and the default partner admin.
contract DeployCreditDeskHarness is DeployCreditDesk {
    function configFromEnv() external view returns (Config memory) {
        return _config();
    }

    function deployFrom(Config memory c) external returns (Deployed memory) {
        return _deploy(c, address(this));
    }
}

/// @notice The deploy script against the real Morpho Blue bytecode (etched from Base mainnet),
///         the same world `test/CreditDesk.t.sol` builds.
contract DeployCreditDeskTest is Test {
    using MarketParamsLib for MarketParams;

    address constant MORPHO_ADDR = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    IMorpho constant MORPHO = IMorpho(MORPHO_ADDR);
    uint256 constant LLTV = 0.625e18;
    int256 constant PRICE = 33_366_495_000; // $333.66495
    uint256 constant T_REGULAR = 1_790_877_600; // Thu 2026-10-01 14:00 ET

    address keeper = makeAddr("keeper");
    address other = makeAddr("otherAdmin");

    IrmMock irm;
    MockB20 usdc;
    MockB20 aapl;
    MarketCalendar cal;
    MirrorOracleRegistry registry;
    TestPriceFeed feed;
    SessionGate gate;
    SessionGuard guard;
    MarketParams params;
    Id id;
    DeployCreditDeskHarness harness;

    function setUp() public {
        vm.warp(T_REGULAR);
        bytes memory code = vm.parseBytes(vm.readFile("test/fixtures/morpho-blue-8453.runtime.hex"));
        vm.etch(MORPHO_ADDR, code);
        vm.store(MORPHO_ADDR, bytes32(0), bytes32(uint256(uint160(address(this))))); // Morpho.owner
        irm = new IrmMock();
        MORPHO.enableIrm(address(irm));
        MORPHO.enableLltv(LLTV);

        usdc = new MockB20("USD Coin", "USDC", 6);
        aapl = new MockB20("Coinbase Wrapped AAPL", "AAPLc", 8);
        cal = new MarketCalendar(address(this));
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        registry = new MirrorOracleRegistry(address(this));
        feed = new TestPriceFeed(address(this), 8, "Coinbase AAPL", PRICE);
        gate = new SessionGate(address(this), cal, registry);
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

        harness = new DeployCreditDeskHarness();
    }

    function _config() internal view returns (DeployCreditDesk.Config memory c) {
        c.morpho = MORPHO_ADDR;
        c.gate = address(gate);
        c.policyRegistry = address(0);
        c.enforceB20 = false;
        c.keeper = keeper;
        c.params = params;
        c.partnerName = "boundline-app";
        c.partnerId = harness.partnerIdOf("boundline-app");
        c.partnerAdmin = address(0);
        c.partnerSigner = address(0);
        c.partnerCap = 1_000e6;
        c.maxLtvWad = 0.5e18;
        c.minDraw = 1e6;
        c.maxDraw = 100e6;
        c.tickerCap = 500e6;
    }

    function test_deploy_registersMarketPartnerAndPolicy() public {
        DeployCreditDesk.Deployed memory d = harness.deployFrom(_config());
        CreditDesk desk = d.desk;

        assertEq(desk.owner(), address(harness), "owner is the deployer");
        assertEq(desk.keeper(), keeper, "keeper");
        assertEq(address(desk.GATE()), address(gate), "gate");
        assertEq(address(desk.MORPHO()), MORPHO_ADDR, "morpho");
        assertFalse(desk.ENFORCE_B20_POLICIES(), "no enforcement on a local chain");
        assertEq(Id.unwrap(d.id), Id.unwrap(id), "market id");

        CreditDesk.MarketConfig memory m = desk.market(id);
        assertTrue(m.enabled, "market enabled");
        assertEq(m.params.oracle, address(guard));
        assertEq(m.params.collateralToken, address(aapl));
        assertEq(m.params.loanToken, address(usdc));
        assertEq(m.params.lltv, LLTV);
        assertEq(uint256(m.collateralDecimals), 8);
        assertEq(uint256(m.loanDecimals), 6);
        assertEq(aapl.allowance(address(desk), MORPHO_ADDR), type(uint256).max, "collateral approved to Morpho");
        assertEq(usdc.allowance(address(desk), MORPHO_ADDR), type(uint256).max, "loan token approved to Morpho");

        assertEq(d.partnerId, bytes32("boundline-app"), "partner id encoding");
        assertEq(d.partnerAdmin, address(harness), "default admin is the deployer");
        CreditDesk.Partner memory p = desk.partner(d.partnerId);
        assertEq(p.admin, address(harness));
        assertEq(p.signer, address(0));
        assertEq(address(p.eligibility), address(0));
        assertTrue(p.active);
        assertEq(uint256(p.exposureCap), 1_000e6);
        assertEq(uint256(p.policyVersion), 2, "createPartner then setTickerPolicy");

        assertTrue(d.tickerPolicySet);
        CreditDesk.TickerPolicy memory t = desk.tickerPolicy(d.partnerId, address(aapl));
        assertTrue(t.allowed);
        assertEq(uint256(t.maxLtvWad), 0.5e18);
        assertEq(uint256(t.minDraw), 1e6);
        assertEq(uint256(t.maxDraw), 100e6);
        assertEq(uint256(t.exposureCap), 500e6);
        assertEq(uint256(t.exposure), 0);
    }

    function test_deploy_otherAdmin_skipsTickerPolicy() public {
        DeployCreditDesk.Config memory c = _config();
        c.partnerAdmin = other;
        DeployCreditDesk.Deployed memory d = harness.deployFrom(c);

        assertFalse(d.tickerPolicySet, "the script cannot act for another admin");
        assertEq(d.partnerAdmin, other);
        assertEq(d.desk.partner(d.partnerId).admin, other);
        assertFalse(d.desk.tickerPolicy(d.partnerId, address(aapl)).allowed);

        vm.prank(other);
        d.desk.setTickerPolicy(d.partnerId, address(aapl), true, 0.4e18, 1e6, 10e6, 100e6);
        assertTrue(d.desk.tickerPolicy(d.partnerId, address(aapl)).allowed, "the admin sets it afterwards");
    }

    function test_deploy_revertsOnGateMismatch() public {
        SessionGate otherGate = new SessionGate(address(this), cal, registry);
        DeployCreditDesk.Config memory c = _config();
        c.gate = address(otherGate);
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployCreditDesk.GateMismatch.selector, address(guard), address(gate), address(otherGate)
            )
        );
        harness.deployFrom(c);
    }

    function test_deploy_revertsWhenOracleIsNotASessionGuard() public {
        MarketParams memory p2 = params;
        p2.oracle = address(feed); // a feed has no GATE()
        MORPHO.createMarket(p2);
        DeployCreditDesk.Config memory c = _config();
        c.params = p2;
        vm.expectRevert(
            abi.encodeWithSelector(DeployCreditDesk.GateMismatch.selector, address(feed), address(0), address(gate))
        );
        harness.deployFrom(c);
    }

    function test_deploy_revertsWhenMarketMissing() public {
        DeployCreditDesk.Config memory c = _config();
        c.params.lltv = 0.5e18; // never created on Morpho
        Id missing = c.params.id();
        vm.expectRevert(abi.encodeWithSelector(DeployCreditDesk.MarketMissing.selector, Id.unwrap(missing)));
        harness.deployFrom(c);
    }

    function test_deploy_revertsWhenLtvNotBelowLltv() public {
        DeployCreditDesk.Config memory c = _config();
        c.maxLtvWad = uint64(LLTV);
        vm.expectRevert(
            abi.encodeWithSelector(DeployCreditDesk.LtvNotBelowLltv.selector, uint64(LLTV), LLTV)
        );
        harness.deployFrom(c);
    }

    function test_deploy_revertsWithoutMorpho() public {
        DeployCreditDesk.Config memory c = _config();
        c.morpho = makeAddr("nothing-here");
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployCreditDesk.NoRpc.selector,
                "Morpho has no code in this EVM: pass --rpc-url base_sepolia or base (there is no local Morpho)"
            )
        );
        harness.deployFrom(c);
    }

    function test_partnerIdOf_matchesStringLiterals() public {
        assertEq(harness.partnerIdOf("boundline-app"), bytes32("boundline-app"));
        assertEq(harness.partnerIdOf("a"), bytes32("a"));
        assertEq(
            harness.partnerIdOf("0123456789abcdef0123456789abcdef"), bytes32("0123456789abcdef0123456789abcdef")
        );
        vm.expectRevert(abi.encodeWithSelector(DeployCreditDesk.BadPartnerName.selector, ""));
        harness.partnerIdOf("");
        vm.expectRevert(
            abi.encodeWithSelector(DeployCreditDesk.BadPartnerName.selector, "0123456789abcdef0123456789abcdef0")
        );
        harness.partnerIdOf("0123456789abcdef0123456789abcdef0");
    }

    /// @dev The only test that touches the process environment, so parallel tests cannot race it.
    function test_config_readsEnvAndDefaults() public {
        vm.setEnv("GATE", vm.toString(address(gate)));
        vm.setEnv("KEEPER", vm.toString(keeper));
        vm.setEnv("COLLATERAL", vm.toString(address(aapl)));
        vm.setEnv("ORACLE", vm.toString(address(guard)));
        vm.setEnv("LOAN_TOKEN", vm.toString(address(usdc)));
        vm.setEnv("IRM", vm.toString(address(irm)));
        vm.setEnv("PARTNER_ID", "acme");
        vm.setEnv("MAX_LTV_WAD", "400000000000000000");

        DeployCreditDesk.Config memory c = harness.configFromEnv();
        assertEq(c.morpho, MORPHO_ADDR, "default Morpho");
        assertEq(c.gate, address(gate));
        assertEq(c.keeper, keeper);
        assertFalse(c.enforceB20, "chain 31337 does not enforce by default");
        assertEq(c.policyRegistry, address(0), "no registry when not enforcing");
        assertEq(c.params.loanToken, address(usdc));
        assertEq(c.params.collateralToken, address(aapl));
        assertEq(c.params.oracle, address(guard));
        assertEq(c.params.irm, address(irm));
        assertEq(c.params.lltv, 0.625e18, "default LLTV");
        assertEq(c.partnerName, "acme");
        assertEq(c.partnerId, bytes32("acme"));
        assertEq(c.partnerAdmin, address(0));
        assertEq(c.partnerSigner, address(0));
        assertEq(uint256(c.partnerCap), 1_000e6);
        assertEq(uint256(c.maxLtvWad), 0.4e18);
        assertEq(uint256(c.minDraw), 1e6);
        assertEq(uint256(c.maxDraw), 100e6);
        assertEq(uint256(c.tickerCap), 500e6);

        DeployCreditDesk.Deployed memory d = harness.deployFrom(c);
        assertEq(uint256(d.desk.tickerPolicy(d.partnerId, address(aapl)).maxLtvWad), 0.4e18, "env policy applied");
    }
}
