// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {IPolicyRegistry} from "base-std/interfaces/IPolicyRegistry.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {ICLPool} from "../src/interfaces/ICLPool.sol";
import {IEligibility} from "../src/interfaces/IEligibility.sol";
import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {IPriceGate} from "../src/interfaces/IPriceGate.sol";
import {MarketCalendar} from "../src/calendar/MarketCalendar.sol";
import {SessionGate} from "../src/oracle/SessionGate.sol";
import {SessionGuard} from "../src/oracle/SessionGuard.sol";
import {ShadowGuard} from "../src/oracle/ShadowGuard.sol";
import {CreditDesk} from "../src/desk/CreditDesk.sol";
import {ICLSwapPool} from "../src/protection/interfaces/ICLSwapPool.sol";
import {Protector} from "../src/protection/Protector.sol";
import {IPreLiquidation, PreLiquidationParams} from "../src/protection/vendor/interfaces/IPreLiquidation.sol";
import {IPreLiquidationFactory} from "../src/protection/vendor/interfaces/IPreLiquidationFactory.sol";
import {AaveDesk} from "../src/aave/AaveDesk.sol";
import {AaveDeskLib} from "../src/aave/AaveDeskLib.sol";
import {ProtectionVault} from "../src/aave/ProtectionVault.sol";
import {IAaveSpoke, ITakerPositionManager, IGiverPositionManager} from "../src/aave/interfaces/IAaveV4.sol";
import {BoundlineReserve} from "../src/reserve/BoundlineReserve.sol";
import {DeskProtectionVault} from "../src/reserve/DeskProtectionVault.sol";
import {LocalPayoutRouter} from "../src/payout/LocalPayoutRouter.sol";
import {DividendHarvester} from "../src/harvest/DividendHarvester.sol";
import {DeployOracles} from "./DeployOracles.s.sol";

/// @notice The whole Boundline footprint on Base mainnet in one ordered run, composed from the per-component
///         scripts (DeployOracles.runMainnet, CreateSessionSafeMarket, DeployCreditDesk, the mainnet half of
///         protected mode, DeployAave, DeployReserve, DeployPayout) plus the DividendHarvester, followed by the
///         post-deploy checks. Driven by `script/deploy-mainnet.sh`, which keeps a state file so a re-run reuses
///         everything already deployed (every address below can be passed in and is then not redeployed; every
///         wiring call checks the chain first). `forge script --resume` covers a broadcast that stopped midway.
///
///   Phases: (1) MarketCalendar (2026), SessionGate on the real OracleRegistry with the ten Coinbase feeds,
///   SessionGuard and ShadowGuard for AAPLc and NVDAc (the stocks with a 24/7 Aerodrome pool); (2) the session-safe
///   AAPLc/USDC Morpho market (SessionGuard oracle, AdaptiveCurveIrm, 62.5%), seeded only with `SEED_USDC`;
///   (3) CreditDesk with B20 enforcement, the market registered, partner and ticker policy; (4) Protector with
///   routes to the real pools and pre-liquidations on Morpho's official factory for the Steakhouse AAPLc and NVDAc
///   markets and the session-safe market, each priced by its stock's ShadowGuard; (5) AaveDesk and ProtectionVault
///   on the MAG7 spoke (AAPLc collateral, USDC loan); (6) BoundlineReserve funding both protection vaults, the
///   desk's protection vault registered; (7) LocalPayoutRouter; (8) DividendHarvester with the same routes;
///   (9) ownership offered to `FINAL_OWNER` when set.
///
///   KEEPER=<mainnet keeper> forge script script/DeployMainnet.s.sol --tc DeployMainnet --rpc-url base \
///     --broadcast --verify --slow --private-key "$MAINNET_DEPLOYER_KEY"
///
/// | Env | Default |
/// | --- | --- |
/// | `KEEPER` | required: the keeper Worker's mainnet signer (Protector, desks, vaults, harvester) |
/// | `FINAL_OWNER` | none (the broadcaster keeps ownership) |
/// | `PARTNER_ID`, `PARTNER_ADMIN` | `boundline-app`, the broadcaster |
/// | `SEED_USDC`, `RESERVE_DEPOSIT`, `RESERVE_ALLOCATE` | 0, 0, 0 (USDC moves only when asked) |
/// | `DESK_ADVANCE_CAP`, `AAVE_ADVANCE_CAP`, `ADVANCE_FEE_BPS` | `25e6`, `25e6`, `100` |
/// | `MIN_ETH` | `0.002 ether` (the preflight's floor on the broadcaster's balance) |
/// | `CALENDAR`, `GATE`, `GUARD_AAPLC`, `GUARD_NVDAC`, `SHADOW_AAPLC`, `SHADOW_NVDAC`, `DESK`, `PROTECTOR`, `PRELIQ_STEAKHOUSE_AAPLC`, `PRELIQ_STEAKHOUSE_NVDAC`, `PRELIQ_SAFE_AAPLC`, `AAVE_DESK`, `AAVE_VAULT`, `RESERVE`, `DESK_VAULT`, `PAYOUT_ROUTER`, `HARVESTER` | reuse instead of deploying |
contract DeployMainnet is DeployOracles {
    using MarketParamsLib for MarketParams;

    address public constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address public constant ADAPTIVE_CURVE_IRM = 0x46415998764C29aB2a25CbeA6254146D50D22687;
    address public constant POLICY_REGISTRY = 0x8453000000000000000000000000000000000002;
    address public constant PRELIQ_FACTORY = 0x8cd16b62E170Ee0bA83D80e1F80E6085367e2aef;
    address public constant AAVE_SPOKE = 0x17905Db0e4A3514467539956c084180616AE7B8D;
    address public constant AAVE_TAKER = 0x8481204E528735aF2F3391AD98f36E757A56D695;
    address public constant AAVE_GIVER = 0x9E81c2fDE4E34CAB3AB1667ca3c932dBAED95F08;
    address public constant AAPLC = 0xb200000000000000000000C2e324d24d7eEcd1fb;
    address public constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    /// @dev Steakhouse AAPLc/USDC and NVDAc/USDC (MorphoChainlinkOracleV2, 62.5%), the live B20 markets.
    bytes32 public constant STEAKHOUSE_AAPLC = 0xae1a30486234bf7e7ac166c7c03d9bc5f2cd8a39be2c48e73c665ac7148c3c28;
    bytes32 public constant STEAKHOUSE_NVDAC = 0xb4b42dd66cef25614b94510a910d54b2c148e7621d22b4271566724beda63d13;
    uint256 public constant LLTV = 0.625e18;
    uint256 public constant AAVE_LOAN_RESERVE = 7; // USDC
    uint256 public constant AAVE_COLLATERAL_RESERVE = 0; // AAPLc
    string public constant DEFAULT_PARTNER = "boundline-app";

    struct Config {
        address keeper;
        address finalOwner;
        string partnerName;
        bytes32 partnerId;
        address partnerAdmin; // zero means the broadcaster
        uint256 seedUsdc;
        uint256 reserveDeposit;
        uint256 reserveAllocate;
        uint256 deskAdvanceCap;
        uint256 aaveAdvanceCap;
        uint16 advanceFeeBps;
        uint256 minEth;
    }

    struct Footprint {
        address calendar;
        address gate;
        address guardAapl;
        address guardNvda;
        address shadowAapl;
        address shadowNvda;
        bytes32 safeMarketId;
        address desk;
        address protector;
        address preliqSteakAapl;
        address preliqSteakNvda;
        address preliqSafeAapl;
        address aaveDesk;
        address aaveVault;
        address reserve;
        address deskVault;
        address payoutRouter;
        address harvester;
    }

    error WrongChain(uint256 chainId);
    error Preflight(string what);
    error BadPartnerName(string name);

    // ================================================================= entry points

    function run() external returns (Footprint memory d) {
        Config memory c = _config();
        d = _existing();
        _preflight(c);
        vm.startBroadcast();
        address deployer = msg.sender;
        if (c.partnerAdmin == address(0)) c.partnerAdmin = deployer;
        _oracles(d, deployer);
        _market(c, d, deployer);
        _desk(c, d, deployer);
        _protection(c, d, deployer);
        _aave(c, d, deployer);
        _capital(c, d, deployer);
        _payout(d);
        _harvest(c, d, deployer);
        if (c.finalOwner != address(0) && c.finalOwner != deployer) _offerOwnership(d, c.finalOwner);
        vm.stopBroadcast();
        _print(d, c.keeper, deployer);
        (uint256 passed, uint256 failed) = _check(c, d, deployer);
        console.log("post-deploy checks: %s passed, %s failed", passed, failed);
    }

    /// @notice Re-run the post-deploy checks against a live deployment (every address passed by env, as the state
    ///         file exports them). Read-only.
    function check() external view returns (uint256 passed, uint256 failed) {
        Config memory c = _config();
        Footprint memory d = _existing();
        address owner = vm.envOr("OWNER", address(0));
        (passed, failed) = _check(c, d, owner);
        console.log("post-deploy checks: %s passed, %s failed", passed, failed);
    }

    /// @notice Partner ids are the UTF-8 bytes of the name, left-aligned and zero-padded to 32 bytes.
    function partnerIdOf(string memory name) public pure returns (bytes32 out) {
        bytes memory b = bytes(name);
        if (b.length == 0 || b.length > 32) revert BadPartnerName(name);
        for (uint256 i = 0; i < b.length; ++i) {
            out |= bytes32(b[i]) >> (8 * i);
        }
    }

    /// @notice The pre-liquidation parameters every Boundline market uses (62.5% LLTV): the band 58% to 62.5%,
    ///         close factor 100% at both ends (the keeper sizes each action), incentive 1% to 2%.
    function preLiquidationParams(address shadow) public pure returns (PreLiquidationParams memory) {
        return PreLiquidationParams({
            preLltv: 0.58e18,
            preLCF1: 1e18,
            preLCF2: 1e18,
            preLIF1: 1.01e18,
            preLIF2: 1.02e18,
            preLiquidationOracle: shadow
        });
    }

    function safeMarketParams(address guard) public pure returns (MarketParams memory) {
        return MarketParams({
            loanToken: USDC_MAINNET, collateralToken: AAPLC, oracle: guard, irm: ADAPTIVE_CURVE_IRM, lltv: LLTV
        });
    }

    // ================================================================= preflight

    function _preflight(Config memory c) internal view {
        if (block.chainid != 8453) revert WrongChain(block.chainid);
        if (c.keeper == address(0)) revert Preflight("KEEPER is required: the keeper Worker's mainnet signer");
        if (MORPHO.code.length == 0) revert Preflight("Morpho has no code: pass --rpc-url base");
        if (!IMorpho(MORPHO).isIrmEnabled(ADAPTIVE_CURVE_IRM)) revert Preflight("AdaptiveCurveIrm not enabled");
        if (!IMorpho(MORPHO).isLltvEnabled(LLTV)) revert Preflight("LLTV 62.5% not enabled on Morpho");
        MainnetToken[] memory tokens = mainnetTokens();
        for (uint256 i = 0; i < tokens.length; ++i) {
            if (tokens[i].feed.code.length == 0) revert FeedHasNoCode(tokens[i].symbol, tokens[i].feed);
            if (tokens[i].pool != address(0) && tokens[i].pool.code.length == 0) {
                revert PoolHasNoCode(tokens[i].symbol, tokens[i].pool);
            }
        }
        if (address(IPreLiquidationFactory(PRELIQ_FACTORY).MORPHO()) != MORPHO) {
            revert Preflight("PreLiquidationFactory does not point at Morpho");
        }
        _expectMarket(STEAKHOUSE_AAPLC, AAPLC);
        _expectMarket(STEAKHOUSE_NVDAC, NVDAC);
        IAaveSpoke spoke = IAaveSpoke(AAVE_SPOKE);
        if (!spoke.isPositionManagerActive(AAVE_TAKER) || !spoke.isPositionManagerActive(AAVE_GIVER)) {
            revert Preflight("Aave Taker or Giver not active on the MAG7 spoke");
        }
        if (
            !ITakerPositionManager(AAVE_TAKER).isSpokeRegistered(AAVE_SPOKE)
                || !IGiverPositionManager(AAVE_GIVER).isSpokeRegistered(AAVE_SPOKE)
        ) revert Preflight("MAG7 spoke not registered on the Taker or the Giver");
        if (!spoke.getReserveConfig(AAVE_LOAN_RESERVE).borrowable) {
            revert Preflight("Aave USDC reserve not borrowable");
        }
        if (AaveDeskLib.collateralFactorWad(spoke, AAVE_COLLATERAL_RESERVE) == 0) {
            revert Preflight("Aave AAPLc reserve has no collateral factor");
        }
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) && msg.sender.balance < c.minEth) {
            revert Preflight("the broadcaster holds less ETH than MIN_ETH");
        }
    }

    function _expectMarket(bytes32 id, address collateral) internal view {
        MarketParams memory mp = IMorpho(MORPHO).idToMarketParams(Id.wrap(id));
        if (mp.collateralToken != collateral || mp.loanToken != USDC_MAINNET || mp.lltv != LLTV) {
            revert Preflight("a Steakhouse market is not what the plan records");
        }
    }

    // ================================================================= phases

    function _oracles(Footprint memory d, address deployer) internal {
        MainnetToken[] memory tokens = mainnetTokens();
        if (d.calendar == address(0)) d.calendar = address(_calendar(deployer));
        if (d.gate == address(0)) {
            d.gate = address(
                new SessionGate(deployer, MarketCalendar(d.calendar), IOracleRegistry(ORACLE_REGISTRY_MAINNET))
            );
        }
        SessionGate gate = SessionGate(d.gate);
        for (uint256 i = 0; i < tokens.length; ++i) {
            if (address(gate.feedOf(tokens[i].token).feed) == address(0)) {
                gate.setFeed(tokens[i].token, IAggregatorV3(tokens[i].feed), 0, 0);
            }
        }
        if (d.guardAapl == address(0)) d.guardAapl = address(new SessionGuard(gate, AAPLC, 8, USDC_MAINNET, 6, 0));
        if (d.guardNvda == address(0)) d.guardNvda = address(new SessionGuard(gate, NVDAC, 8, USDC_MAINNET, 6, 0));
        if (d.shadowAapl == address(0)) {
            d.shadowAapl = address(
                new ShadowGuard(deployer, gate, AAPLC, 8, USDC_MAINNET, 6, ICLPool(AERODROME_AAPLC_USDC), TWAP_WINDOW)
            );
        }
        if (d.shadowNvda == address(0)) {
            d.shadowNvda = address(
                new ShadowGuard(deployer, gate, NVDAC, 8, USDC_MAINNET, 6, ICLPool(AERODROME_NVDAC_USDC), TWAP_WINDOW)
            );
        }
    }

    function _market(Config memory c, Footprint memory d, address deployer) internal {
        MarketParams memory mp = safeMarketParams(d.guardAapl);
        d.safeMarketId = Id.unwrap(mp.id());
        if (IMorpho(MORPHO).idToMarketParams(mp.id()).lltv == 0) IMorpho(MORPHO).createMarket(mp);
        if (c.seedUsdc != 0) {
            IERC20(USDC_MAINNET).approve(MORPHO, c.seedUsdc);
            IMorpho(MORPHO).supply(mp, c.seedUsdc, 0, deployer, "");
        }
    }

    function _desk(Config memory c, Footprint memory d, address deployer) internal {
        if (d.desk == address(0)) {
            d.desk = address(
                new CreditDesk(
                    deployer, IMorpho(MORPHO), SessionGate(d.gate), IPolicyRegistry(POLICY_REGISTRY), true, c.keeper
                )
            );
        }
        CreditDesk desk = CreditDesk(d.desk);
        MarketParams memory mp = safeMarketParams(d.guardAapl);
        if (desk.market(mp.id()).params.oracle == address(0)) desk.registerMarket(mp);
        if (desk.partner(c.partnerId).admin == address(0)) {
            desk.createPartner(c.partnerId, c.partnerAdmin, address(0), IEligibility(address(0)), 1000e6);
        }
        if (c.partnerAdmin == deployer && !desk.tickerPolicy(c.partnerId, AAPLC).allowed) {
            desk.setTickerPolicy(c.partnerId, AAPLC, true, 0.5e18, 1e6, 100e6, 500e6);
        }
    }

    function _protection(Config memory c, Footprint memory d, address deployer) internal {
        if (d.protector == address(0)) d.protector = address(new Protector(deployer, IMorpho(MORPHO), c.keeper));
        Protector protector = Protector(d.protector);
        (ICLSwapPool aaplRoute,) = protector.routes(AAPLC);
        if (address(aaplRoute) != AERODROME_AAPLC_USDC) protector.setRoute(AAPLC, ICLSwapPool(AERODROME_AAPLC_USDC));
        (ICLSwapPool nvdaRoute,) = protector.routes(NVDAC);
        if (address(nvdaRoute) != AERODROME_NVDAC_USDC) protector.setRoute(NVDAC, ICLSwapPool(AERODROME_NVDAC_USDC));
        IPreLiquidationFactory factory = IPreLiquidationFactory(PRELIQ_FACTORY);
        if (d.preliqSteakAapl == address(0)) {
            d.preliqSteakAapl =
                address(factory.createPreLiquidation(Id.wrap(STEAKHOUSE_AAPLC), preLiquidationParams(d.shadowAapl)));
        }
        if (d.preliqSteakNvda == address(0)) {
            d.preliqSteakNvda =
                address(factory.createPreLiquidation(Id.wrap(STEAKHOUSE_NVDAC), preLiquidationParams(d.shadowNvda)));
        }
        if (d.preliqSafeAapl == address(0)) {
            d.preliqSafeAapl =
                address(factory.createPreLiquidation(Id.wrap(d.safeMarketId), preLiquidationParams(d.shadowAapl)));
        }
    }

    function _aave(Config memory c, Footprint memory d, address deployer) internal {
        IAaveSpoke spoke = IAaveSpoke(AAVE_SPOKE);
        if (d.aaveDesk == address(0)) {
            d.aaveDesk = address(
                new AaveDesk(
                    deployer,
                    spoke,
                    ITakerPositionManager(AAVE_TAKER),
                    IGiverPositionManager(AAVE_GIVER),
                    SessionGate(d.gate),
                    AAVE_LOAN_RESERVE,
                    c.keeper
                )
            );
        }
        bool freshVault = d.aaveVault == address(0);
        if (freshVault) {
            d.aaveVault = address(
                new ProtectionVault(
                    deployer,
                    spoke,
                    ITakerPositionManager(AAVE_TAKER),
                    IGiverPositionManager(AAVE_GIVER),
                    SessionGate(d.gate),
                    AAVE_LOAN_RESERVE,
                    c.keeper
                )
            );
        }
        AaveDesk desk = AaveDesk(d.aaveDesk);
        ProtectionVault vault = ProtectionVault(d.aaveVault);
        if (desk.reserve(AAVE_COLLATERAL_RESERVE).underlying == address(0)) {
            desk.enableReserve(AAVE_COLLATERAL_RESERVE);
        }
        if (desk.partner(c.partnerId).admin == address(0)) {
            desk.createPartner(c.partnerId, c.partnerAdmin, address(0), IEligibility(address(0)), 1000e6);
        }
        if (vault.partnerAdmin(c.partnerId) != c.partnerAdmin) vault.setPartnerAdmin(c.partnerId, c.partnerAdmin);
        if (freshVault) vault.setAdvanceTerms(c.aaveAdvanceCap, c.advanceFeeBps);
        if (c.partnerAdmin == deployer && !desk.reservePolicy(c.partnerId, AAVE_COLLATERAL_RESERVE).allowed) {
            desk.setReservePolicy(c.partnerId, AAVE_COLLATERAL_RESERVE, true, 0.5e18, 1e6, 100e6, 500e6);
        }
    }

    function _capital(Config memory c, Footprint memory d, address deployer) internal {
        if (d.reserve == address(0)) {
            d.reserve = address(new BoundlineReserve(deployer, IERC20(USDC_MAINNET), deployer, 3600, 8000));
        }
        bool freshVault = d.deskVault == address(0);
        if (freshVault) {
            d.deskVault = address(new DeskProtectionVault(deployer, CreditDesk(d.desk), IERC20(USDC_MAINNET), c.keeper));
        }
        BoundlineReserve reserve = BoundlineReserve(d.reserve);
        DeskProtectionVault deskVault = DeskProtectionVault(d.deskVault);
        ProtectionVault aaveVault = ProtectionVault(d.aaveVault);
        if (freshVault) deskVault.setAdvanceTerms(c.deskAdvanceCap, c.advanceFeeBps);
        if (deskVault.funder() != d.reserve) deskVault.setFunder(d.reserve);
        if (deskVault.partnerAdmin(c.partnerId) != c.partnerAdmin) {
            deskVault.setPartnerAdmin(c.partnerId, c.partnerAdmin);
        }
        if (aaveVault.funder() != d.reserve) aaveVault.setFunder(d.reserve);
        if (!reserve.isSink(d.deskVault)) reserve.addSink(d.deskVault);
        if (!reserve.isSink(d.aaveVault)) reserve.addSink(d.aaveVault);
        if (CreditDesk(d.desk).protectionVault() != d.deskVault) CreditDesk(d.desk).setProtectionVault(d.deskVault);
        if (c.reserveDeposit != 0) {
            IERC20(USDC_MAINNET).approve(d.reserve, c.reserveDeposit);
            reserve.deposit(c.reserveDeposit, deployer);
        }
        if (c.reserveAllocate != 0) reserve.allocate(d.deskVault, c.reserveAllocate);
    }

    function _payout(Footprint memory d) internal {
        if (d.payoutRouter == address(0)) d.payoutRouter = address(new LocalPayoutRouter(IPriceGate(d.gate)));
    }

    function _harvest(Config memory c, Footprint memory d, address deployer) internal {
        if (d.harvester == address(0)) {
            d.harvester = address(
                new DividendHarvester(deployer, IMorpho(MORPHO), IPriceGate(d.gate), CreditDesk(d.desk), c.keeper)
            );
        }
        DividendHarvester h = DividendHarvester(d.harvester);
        (ICLSwapPool aaplRoute,) = h.routes(AAPLC);
        if (address(aaplRoute) != AERODROME_AAPLC_USDC) h.setRoute(AAPLC, ICLSwapPool(AERODROME_AAPLC_USDC));
        (ICLSwapPool nvdaRoute,) = h.routes(NVDAC);
        if (address(nvdaRoute) != AERODROME_NVDAC_USDC) h.setRoute(NVDAC, ICLSwapPool(AERODROME_NVDAC_USDC));
    }

    /// @dev Two-step everywhere: FINAL_OWNER must call acceptOwnership() on each of these.
    function _offerOwnership(Footprint memory d, address finalOwner) internal {
        address[10] memory owned = [
            d.calendar,
            d.gate,
            d.shadowAapl,
            d.shadowNvda,
            d.desk,
            d.protector,
            d.aaveDesk,
            d.aaveVault,
            d.reserve,
            d.deskVault
        ];
        for (uint256 i = 0; i < owned.length; ++i) {
            if (Ownable2Step(owned[i]).owner() != finalOwner) Ownable2Step(owned[i]).transferOwnership(finalOwner);
        }
        if (Ownable2Step(d.harvester).owner() != finalOwner) Ownable2Step(d.harvester).transferOwnership(finalOwner);
        console.log("ownership offered to %s: it must call acceptOwnership() on the eleven owned contracts", finalOwner);
    }

    // ================================================================= checks

    struct Tally {
        uint256 passed;
        uint256 failed;
    }

    function _check(Config memory c, Footprint memory d, address owner)
        internal
        view
        returns (uint256 passed, uint256 failed)
    {
        Tally memory t;
        _checkOracles(t, d);
        _checkMarketAndDesk(t, c, d, owner);
        _checkProtection(t, c, d);
        _checkAaveAndCapital(t, c, d);
        _checkPayoutAndHarvest(t, c, d);
        return (t.passed, t.failed);
    }

    function _expect(Tally memory t, bool ok, string memory what) internal pure {
        if (ok) {
            ++t.passed;
            console.log("PASS %s", what);
        } else {
            ++t.failed;
            console.log("FAIL %s", what);
        }
    }

    function _checkOracles(Tally memory t, Footprint memory d) internal view {
        SessionGate gate = SessionGate(d.gate);
        _expect(t, address(gate.CALENDAR()) == d.calendar, "gate reads the deployed calendar");
        _expect(t, address(gate.REGISTRY()) == ORACLE_REGISTRY_MAINNET, "gate reads the Coinbase OracleRegistry");
        MainnetToken[] memory tokens = mainnetTokens();
        uint256 bound;
        for (uint256 i = 0; i < tokens.length; ++i) {
            if (address(gate.feedOf(tokens[i].token).feed) == tokens[i].feed) ++bound;
        }
        _expect(t, bound == tokens.length, "all ten Coinbase feeds bound on the gate");
        _expect(t, MarketCalendar(d.calendar).isYearLoaded(2026), "calendar has 2026 loaded");
        _expect(t, SessionGuard(d.guardAapl).COLLATERAL() == AAPLC, "AAPLc SessionGuard");
        _expect(t, SessionGuard(d.guardNvda).COLLATERAL() == NVDAC, "NVDAc SessionGuard");
        _expect(
            t,
            address(ShadowGuard(d.shadowAapl).POOL()) == AERODROME_AAPLC_USDC,
            "AAPLc ShadowGuard on the Aerodrome pool"
        );
        _expect(
            t,
            address(ShadowGuard(d.shadowNvda).POOL()) == AERODROME_NVDAC_USDC,
            "NVDAc ShadowGuard on the Aerodrome pool"
        );
        // Session-dependent: printed, not counted.
        IPriceGate.Verdict memory v = gate.check(AAPLC);
        console.log(
            "INFO AAPLc gate state %s (0 OPEN, 1 MARKET_CLOSED, 2 FEED_PAUSED...), session %s",
            uint256(v.state),
            uint256(v.session)
        );
        if (v.state == IPriceGate.GateState.OPEN) {
            _expect(
                t, IOracle(d.guardAapl).price() == uint256(v.answer) * 1e26, "AAPLc SessionGuard prices the fresh feed"
            );
            _expect(
                t,
                IOracle(d.shadowAapl).price() == uint256(v.answer) * 1e26,
                "AAPLc ShadowGuard prices the feed in session"
            );
        }
    }

    function _checkMarketAndDesk(Tally memory t, Config memory c, Footprint memory d, address owner) internal view {
        MarketParams memory mp = IMorpho(MORPHO).idToMarketParams(Id.wrap(d.safeMarketId));
        _expect(
            t,
            mp.oracle == d.guardAapl && mp.collateralToken == AAPLC && mp.lltv == LLTV,
            "session-safe AAPLc market on Morpho"
        );
        CreditDesk desk = CreditDesk(d.desk);
        _expect(
            t, address(desk.GATE()) == d.gate && desk.ENFORCE_B20_POLICIES(), "desk on the gate, B20 enforcement on"
        );
        _expect(t, desk.market(Id.wrap(d.safeMarketId)).enabled, "desk registered the session-safe market");
        _expect(t, desk.partner(c.partnerId).active, "desk partner active");
        _expect(t, desk.tickerPolicy(c.partnerId, AAPLC).allowed, "desk AAPLc ticker policy allowed");
        _expect(t, desk.keeper() == c.keeper, "desk keeper is KEEPER");
        _expect(t, desk.protectionVault() == d.deskVault, "desk protection vault registered");
        if (owner != address(0)) _expect(t, desk.owner() == owner, "desk owner");
    }

    function _checkProtection(Tally memory t, Config memory c, Footprint memory d) internal view {
        Protector protector = Protector(d.protector);
        _expect(t, protector.keeper() == c.keeper, "Protector keeper is KEEPER");
        (ICLSwapPool aaplRoute,) = protector.routes(AAPLC);
        (ICLSwapPool nvdaRoute,) = protector.routes(NVDAC);
        _expect(
            t,
            address(aaplRoute) == AERODROME_AAPLC_USDC && address(nvdaRoute) == AERODROME_NVDAC_USDC,
            "Protector routes"
        );
        _checkPreLiq(t, d.preliqSteakAapl, STEAKHOUSE_AAPLC, d.shadowAapl, "Steakhouse AAPLc pre-liquidation");
        _checkPreLiq(t, d.preliqSteakNvda, STEAKHOUSE_NVDAC, d.shadowNvda, "Steakhouse NVDAc pre-liquidation");
        _checkPreLiq(t, d.preliqSafeAapl, d.safeMarketId, d.shadowAapl, "session-safe AAPLc pre-liquidation");
    }

    function _checkPreLiq(Tally memory t, address preLiq, bytes32 id, address shadow, string memory what)
        internal
        view
    {
        (bool ok, bytes memory data) =
            PRELIQ_FACTORY.staticcall(abi.encodeWithSignature("isPreLiquidation(address)", preLiq));
        bool onFactory = ok && data.length >= 32 && abi.decode(data, (bool));
        IPreLiquidation p = IPreLiquidation(preLiq);
        _expect(
            t,
            onFactory && Id.unwrap(p.ID()) == id && address(p.MORPHO()) == MORPHO
                && p.preLiquidationParams().preLiquidationOracle == shadow
                && p.preLiquidationParams().preLltv == 0.58e18,
            what
        );
    }

    function _checkAaveAndCapital(Tally memory t, Config memory c, Footprint memory d) internal view {
        AaveDesk aave = AaveDesk(d.aaveDesk);
        _expect(t, aave.reserve(AAVE_COLLATERAL_RESERVE).underlying == AAPLC, "AaveDesk AAPLc reserve enabled");
        _expect(t, aave.partner(c.partnerId).active, "AaveDesk partner active");
        _expect(t, aave.reservePolicy(c.partnerId, AAVE_COLLATERAL_RESERVE).allowed, "AaveDesk AAPLc reserve policy");
        BoundlineReserve reserve = BoundlineReserve(d.reserve);
        _expect(t, reserve.isSink(d.deskVault) && reserve.isSink(d.aaveVault), "Reserve funds both protection vaults");
        _expect(t, DeskProtectionVault(d.deskVault).funder() == d.reserve, "desk vault funder is the Reserve");
        _expect(t, ProtectionVault(d.aaveVault).funder() == d.reserve, "Aave vault funder is the Reserve");
        _expect(
            t,
            DeskProtectionVault(d.deskVault).keeper() == c.keeper && ProtectionVault(d.aaveVault).keeper() == c.keeper,
            "vault keepers are KEEPER"
        );
    }

    function _checkPayoutAndHarvest(Tally memory t, Config memory c, Footprint memory d) internal view {
        _expect(t, address(LocalPayoutRouter(d.payoutRouter).GATE()) == d.gate, "payout router on the gate");
        DividendHarvester h = DividendHarvester(d.harvester);
        _expect(
            t, address(h.GATE()) == d.gate && address(h.DESK()) == d.desk && h.keeper() == c.keeper, "harvester wiring"
        );
        (ICLSwapPool aaplRoute,) = h.routes(AAPLC);
        (ICLSwapPool nvdaRoute,) = h.routes(NVDAC);
        _expect(
            t,
            address(aaplRoute) == AERODROME_AAPLC_USDC && address(nvdaRoute) == AERODROME_NVDAC_USDC,
            "harvester routes"
        );
    }

    // ================================================================= config and output

    function _config() internal view returns (Config memory c) {
        c.keeper = vm.envOr("KEEPER", address(0));
        c.finalOwner = vm.envOr("FINAL_OWNER", address(0));
        c.partnerName = vm.envOr("PARTNER_ID", DEFAULT_PARTNER);
        c.partnerId = partnerIdOf(c.partnerName);
        c.partnerAdmin = vm.envOr("PARTNER_ADMIN", address(0));
        c.seedUsdc = vm.envOr("SEED_USDC", uint256(0));
        c.reserveDeposit = vm.envOr("RESERVE_DEPOSIT", uint256(0));
        c.reserveAllocate = vm.envOr("RESERVE_ALLOCATE", uint256(0));
        c.deskAdvanceCap = vm.envOr("DESK_ADVANCE_CAP", uint256(25e6));
        c.aaveAdvanceCap = vm.envOr("AAVE_ADVANCE_CAP", uint256(25e6));
        c.advanceFeeBps = uint16(vm.envOr("ADVANCE_FEE_BPS", uint256(100)));
        c.minEth = vm.envOr("MIN_ETH", uint256(0.002 ether));
    }

    function _existing() internal view returns (Footprint memory d) {
        d.calendar = vm.envOr("CALENDAR", address(0));
        d.gate = vm.envOr("GATE", address(0));
        d.guardAapl = vm.envOr("GUARD_AAPLC", address(0));
        d.guardNvda = vm.envOr("GUARD_NVDAC", address(0));
        d.shadowAapl = vm.envOr("SHADOW_AAPLC", address(0));
        d.shadowNvda = vm.envOr("SHADOW_NVDAC", address(0));
        d.desk = vm.envOr("DESK", address(0));
        d.protector = vm.envOr("PROTECTOR", address(0));
        d.preliqSteakAapl = vm.envOr("PRELIQ_STEAKHOUSE_AAPLC", address(0));
        d.preliqSteakNvda = vm.envOr("PRELIQ_STEAKHOUSE_NVDAC", address(0));
        d.preliqSafeAapl = vm.envOr("PRELIQ_SAFE_AAPLC", address(0));
        d.aaveDesk = vm.envOr("AAVE_DESK", address(0));
        d.aaveVault = vm.envOr("AAVE_VAULT", address(0));
        d.reserve = vm.envOr("RESERVE", address(0));
        d.deskVault = vm.envOr("DESK_VAULT", address(0));
        d.payoutRouter = vm.envOr("PAYOUT_ROUTER", address(0));
        d.harvester = vm.envOr("HARVESTER", address(0));
        if (d.guardAapl != address(0)) d.safeMarketId = Id.unwrap(safeMarketParams(d.guardAapl).id());
    }

    /// @dev One JSON object between the markers; `deploy-mainnet.sh` cuts it out into the state file.
    function _print(Footprint memory d, address keeper, address owner) internal view {
        console.log("BOUNDLINE-STATE-BEGIN");
        console.log("{");
        console.log('  "chainId": %s,', block.chainid);
        console.log('  "KEEPER": "%s",', keeper);
        console.log('  "OWNER": "%s",', owner);
        console.log('  "CALENDAR": "%s",', d.calendar);
        console.log('  "GATE": "%s",', d.gate);
        console.log('  "GUARD_AAPLC": "%s",', d.guardAapl);
        console.log('  "GUARD_NVDAC": "%s",', d.guardNvda);
        console.log('  "SHADOW_AAPLC": "%s",', d.shadowAapl);
        console.log('  "SHADOW_NVDAC": "%s",', d.shadowNvda);
        console.log('  "SAFE_MARKET_ID": "%s",', vm.toString(d.safeMarketId));
        console.log('  "DESK": "%s",', d.desk);
        console.log('  "PROTECTOR": "%s",', d.protector);
        console.log('  "PRELIQ_STEAKHOUSE_AAPLC": "%s",', d.preliqSteakAapl);
        console.log('  "PRELIQ_STEAKHOUSE_NVDAC": "%s",', d.preliqSteakNvda);
        console.log('  "PRELIQ_SAFE_AAPLC": "%s",', d.preliqSafeAapl);
        console.log('  "AAVE_DESK": "%s",', d.aaveDesk);
        console.log('  "AAVE_VAULT": "%s",', d.aaveVault);
        console.log('  "RESERVE": "%s",', d.reserve);
        console.log('  "DESK_VAULT": "%s",', d.deskVault);
        console.log('  "PAYOUT_ROUTER": "%s",', d.payoutRouter);
        console.log('  "HARVESTER": "%s"', d.harvester);
        console.log("}");
        console.log("BOUNDLINE-STATE-END");
    }
}
