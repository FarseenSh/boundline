// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {MarketCalendar} from "../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../src/calendar/Nyse2026.sol";
import {SessionGate} from "../src/oracle/SessionGate.sol";
import {SessionGuard} from "../src/oracle/SessionGuard.sol";

/// @notice Creates the session-safe Morpho Blue market: USDC loan, a tokenized stock as
///         collateral, a SessionGuard as the oracle, the AdaptiveCurveIrm, 62.5% LLTV.
///         `createMarket` is permissionless; the market is empty and holds no securities.
///
///   forge script script/CreateSessionSafeMarket.s.sol --rpc-url base \
///       COLLATERAL=0xb200...C2e3 ORACLE=<SessionGuard>            (or DEPLOY_ORACLE=true FEED=<proxy>)
///   forge script script/CreateSessionSafeMarket.s.sol --sig "seed()" --rpc-url base SEED_USDC=300000000
///
/// Needs an RPC: Morpho lives on chain. Without one the script stops with `NoRpc`.
contract CreateSessionSafeMarket is Script {
    using MarketParamsLib for MarketParams;

    IMorpho public constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    address public constant ADAPTIVE_CURVE_IRM = 0x46415998764C29aB2a25CbeA6254146D50D22687;
    address public constant USDC_MAINNET = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant USDC_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address public constant ORACLE_REGISTRY_MAINNET = 0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD;
    uint256 public constant DEFAULT_LLTV = 0.625e18;

    error NoRpc(string hint);
    error MissingEnv(string name, string hint);
    error IrmNotEnabled(address irm);
    error LltvNotEnabled(uint256 lltv);
    error MarketExists(bytes32 id);
    error MarketMissing(bytes32 id);

    function run() external returns (Id id, MarketParams memory params) {
        _requireMorpho();
        address loan = _loanToken();
        address collateral = vm.envOr("COLLATERAL", address(0));
        if (collateral == address(0)) revert MissingEnv("COLLATERAL", "the tokenized stock, e.g. AAPLc");
        uint256 lltv = vm.envOr("LLTV", DEFAULT_LLTV);
        address oracle = vm.envOr("ORACLE", address(0));

        vm.startBroadcast();
        if (oracle == address(0)) {
            if (!vm.envOr("DEPLOY_ORACLE", false)) {
                revert MissingEnv("ORACLE", "a SessionGuard address, or DEPLOY_ORACLE=true with FEED=<Chainlink proxy>");
            }
            oracle = _deployGuard(msg.sender, collateral, loan);
        }
        if (!MORPHO.isIrmEnabled(ADAPTIVE_CURVE_IRM)) revert IrmNotEnabled(ADAPTIVE_CURVE_IRM);
        if (!MORPHO.isLltvEnabled(lltv)) revert LltvNotEnabled(lltv);

        params = MarketParams({
            loanToken: loan, collateralToken: collateral, oracle: oracle, irm: ADAPTIVE_CURVE_IRM, lltv: lltv
        });
        id = params.id();
        if (MORPHO.idToMarketParams(id).lltv != 0) revert MarketExists(Id.unwrap(id));
        MORPHO.createMarket(params);
        vm.stopBroadcast();

        console.log("{");
        console.log('  "chainId": %s,', block.chainid);
        console.log('  "marketId": "%s",', vm.toString(Id.unwrap(id)));
        console.log('  "loanToken": "%s", "collateralToken": "%s",', loan, collateral);
        console.log('  "oracle": "%s", "irm": "%s",', oracle, ADAPTIVE_CURVE_IRM);
        console.log('  "lltv": %s', lltv);
        console.log("}");
    }

    /// @notice Supplies SEED_USDC (6 decimals) to the market identified by the same env as `run`.
    function seed() external returns (uint256 supplied) {
        _requireMorpho();
        uint256 amount = vm.envOr("SEED_USDC", uint256(0));
        if (amount == 0) revert MissingEnv("SEED_USDC", "amount in USDC base units, e.g. 300000000 for $300");
        address loan = _loanToken();
        address collateral = vm.envOr("COLLATERAL", address(0));
        address oracle = vm.envOr("ORACLE", address(0));
        if (collateral == address(0) || oracle == address(0)) {
            revert MissingEnv("COLLATERAL/ORACLE", "the market's params");
        }
        MarketParams memory params = MarketParams({
            loanToken: loan,
            collateralToken: collateral,
            oracle: oracle,
            irm: ADAPTIVE_CURVE_IRM,
            lltv: vm.envOr("LLTV", DEFAULT_LLTV)
        });
        Id id = params.id();
        if (MORPHO.idToMarketParams(id).lltv == 0) revert MarketMissing(Id.unwrap(id));

        vm.startBroadcast();
        IERC20(loan).approve(address(MORPHO), amount);
        (supplied,) = MORPHO.supply(params, amount, 0, msg.sender, "");
        vm.stopBroadcast();
        console.log("supplied %s USDC base units to market %s", supplied, vm.toString(Id.unwrap(id)));
    }

    /// @dev Deploys calendar (2026 loaded) + gate (real registry on mainnet, env REGISTRY elsewhere)
    ///      + a SessionGuard for `collateral`, so a single run can both prove and create.
    function _deployGuard(address deployer, address collateral, address loan) internal returns (address) {
        address feed = vm.envOr("FEED", address(0));
        if (feed == address(0)) revert MissingEnv("FEED", "the Chainlink proxy for the collateral");
        address registry = block.chainid == 8453 ? ORACLE_REGISTRY_MAINNET : vm.envOr("REGISTRY", address(0));
        if (registry == address(0)) revert MissingEnv("REGISTRY", "a MirrorOracleRegistry on this network");
        MarketCalendar calendar = new MarketCalendar(deployer);
        calendar.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        SessionGate gate = new SessionGate(deployer, calendar, IOracleRegistry(registry));
        gate.setFeed(collateral, IAggregatorV3(feed), 0, 0);
        SessionGuard guard = new SessionGuard(gate, collateral, 8, loan, 6, 0);
        console.log("deployed calendar %s, gate %s, guard %s", address(calendar), address(gate), address(guard));
        return address(guard);
    }

    function _requireMorpho() internal view {
        if (address(MORPHO).code.length == 0) {
            revert NoRpc("Morpho has no code in this EVM: pass --rpc-url base or base_sepolia (there is no local Morpho)");
        }
    }

    function _loanToken() internal view returns (address) {
        if (block.chainid == 8453) return USDC_MAINNET;
        if (block.chainid == 84_532) return USDC_SEPOLIA;
        address loan = vm.envOr("LOAN_TOKEN", address(0));
        if (loan == address(0)) revert MissingEnv("LOAN_TOKEN", "USDC is known only on 8453 and 84532");
        return loan;
    }
}
