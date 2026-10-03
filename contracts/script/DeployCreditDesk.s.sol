// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {IPolicyRegistry} from "base-std/interfaces/IPolicyRegistry.sol";
import {IEligibility} from "../src/interfaces/IEligibility.sol";
import {SessionGate} from "../src/oracle/SessionGate.sol";
import {CreditDesk} from "../src/desk/CreditDesk.sol";

/// @notice Deploys the CreditDesk and, in the same run, registers the session-safe market, creates
///         the first partner and sets that partner's ticker policy for the market's collateral.
///
///   GATE=<SessionGate> KEEPER=<keeper> COLLATERAL=<stock> ORACLE=<SessionGuard> \
///     base-forge script script/DeployCreditDesk.s.sol --tc DeployCreditDesk \
///     --rpc-url base_sepolia --broadcast --verify --private-key "$KEY"
///
/// Needs an RPC: `registerMarket` reads the market from Morpho, so without one the script stops
/// with `NoRpc`. The broadcaster becomes the desk owner (`Ownable2Step`, nothing to accept) and,
/// unless PARTNER_ADMIN says otherwise, the partner admin, which is what lets the ticker policy be
/// set in the same run (`setTickerPolicy` is partner-admin only; with another admin it is skipped
/// and logged). The policy registry defaults to Base's precompile whenever B20 enforcement is on.
///
/// | Env | Default |
/// | --- | --- |
/// | `GATE`, `KEEPER`, `COLLATERAL`, `ORACLE` | required |
/// | `MORPHO` | `0xBBBB…FFCb` (same on Base and Base Sepolia) |
/// | `IRM`, `LLTV` | AdaptiveCurveIrm, `0.625e18` |
/// | `LOAN_TOKEN` | USDC on 8453 and 84532, required elsewhere |
/// | `ENFORCE_B20` | `true` on 8453 and 84532, `false` elsewhere |
/// | `POLICY_REGISTRY` | the precompile when enforcing, zero otherwise |
/// | `PARTNER_ID` (a name of up to 32 bytes, see `partnerIdOf`) | `boundline-app` |
/// | `PARTNER_ADMIN`, `PARTNER_SIGNER`, `PARTNER_EXPOSURE_CAP` | broadcaster, none, `1_000e6` |
/// | `MAX_LTV_WAD`, `MIN_DRAW`, `MAX_DRAW`, `TICKER_EXPOSURE_CAP` | `0.5e18`, `1e6`, `100e6`, `500e6` |
contract DeployCreditDesk is Script {
    using MarketParamsLib for MarketParams;

    address public constant MORPHO_DEFAULT = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address public constant ADAPTIVE_CURVE_IRM = 0x46415998764C29aB2a25CbeA6254146D50D22687;
    address public constant POLICY_REGISTRY_PRECOMPILE = 0x8453000000000000000000000000000000000002;
    address public constant USDC_MAINNET = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant USDC_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    uint256 public constant DEFAULT_LLTV = 0.625e18;
    string public constant DEFAULT_PARTNER = "boundline-app";
    uint128 public constant DEFAULT_PARTNER_CAP = 1_000e6;
    uint64 public constant DEFAULT_MAX_LTV_WAD = 0.5e18;
    uint128 public constant DEFAULT_MIN_DRAW = 1e6;
    uint128 public constant DEFAULT_MAX_DRAW = 100e6;
    uint128 public constant DEFAULT_TICKER_CAP = 500e6;

    struct Config {
        address morpho;
        address gate;
        address policyRegistry;
        bool enforceB20;
        address keeper;
        MarketParams params;
        string partnerName;
        bytes32 partnerId;
        address partnerAdmin; // zero means the deployer
        address partnerSigner;
        uint128 partnerCap;
        uint64 maxLtvWad;
        uint128 minDraw;
        uint128 maxDraw;
        uint128 tickerCap;
    }

    struct Deployed {
        CreditDesk desk;
        Id id;
        bytes32 partnerId;
        address partnerAdmin;
        bool tickerPolicySet;
    }

    error NoRpc(string hint);
    error MissingEnv(string name, string hint);
    error BadPartnerName(string name);
    error MarketMissing(bytes32 id);
    error GateMismatch(address oracle, address oracleGate, address gate);
    error LtvNotBelowLltv(uint64 maxLtvWad, uint256 lltv);

    function run() external returns (CreditDesk desk, Id id, bytes32 partnerId) {
        Config memory c = _config();
        vm.startBroadcast();
        Deployed memory d = _deploy(c, msg.sender);
        vm.stopBroadcast();
        _print(c, d);
        return (d.desk, d.id, d.partnerId);
    }

    /// @notice Partner ids are the UTF-8 bytes of the name, left-aligned and zero-padded to 32
    ///         bytes, the same encoding Solidity gives a `bytes32` string literal, so
    ///         `"boundline-app"` is `0x626f756e646c696e652d617070` followed by zeros.
    function partnerIdOf(string memory name) public pure returns (bytes32 out) {
        bytes memory b = bytes(name);
        if (b.length == 0 || b.length > 32) revert BadPartnerName(name);
        for (uint256 i = 0; i < b.length; ++i) {
            out |= bytes32(b[i]) >> (8 * i);
        }
    }

    // ================================================================= logic

    /// @dev `deployer` is the account the desk sees as msg.sender: the broadcaster in a script,
    ///      the calling harness in a test. It becomes the desk owner and the default partner admin.
    function _deploy(Config memory c, address deployer) internal returns (Deployed memory d) {
        if (c.morpho.code.length == 0) {
            revert NoRpc("Morpho has no code in this EVM: pass --rpc-url base_sepolia or base (there is no local Morpho)");
        }
        d.id = c.params.id();
        if (IMorpho(c.morpho).idToMarketParams(d.id).lltv == 0) revert MarketMissing(Id.unwrap(d.id));
        address oracleGate = _gateOf(c.params.oracle);
        if (oracleGate != c.gate) revert GateMismatch(c.params.oracle, oracleGate, c.gate);
        if (uint256(c.maxLtvWad) >= c.params.lltv) revert LtvNotBelowLltv(c.maxLtvWad, c.params.lltv);
        d.partnerId = c.partnerId;
        d.partnerAdmin = c.partnerAdmin == address(0) ? deployer : c.partnerAdmin;

        d.desk = new CreditDesk(
            deployer, IMorpho(c.morpho), SessionGate(c.gate), IPolicyRegistry(c.policyRegistry), c.enforceB20, c.keeper
        );
        d.desk.registerMarket(c.params);
        d.desk.createPartner(c.partnerId, d.partnerAdmin, c.partnerSigner, IEligibility(address(0)), c.partnerCap);
        if (d.partnerAdmin == deployer) {
            d.desk.setTickerPolicy(
                c.partnerId, c.params.collateralToken, true, c.maxLtvWad, c.minDraw, c.maxDraw, c.tickerCap
            );
            d.tickerPolicySet = true;
        }
    }

    function _gateOf(address oracle) internal view returns (address) {
        (bool ok, bytes memory data) = oracle.staticcall(abi.encodeWithSignature("GATE()"));
        if (!ok || data.length < 32) return address(0);
        return abi.decode(data, (address));
    }

    function _config() internal view returns (Config memory c) {
        c.morpho = vm.envOr("MORPHO", MORPHO_DEFAULT);
        c.gate = vm.envOr("GATE", address(0));
        if (c.gate == address(0)) revert MissingEnv("GATE", "the SessionGate the market's SessionGuard is bound to");
        c.keeper = vm.envOr("KEEPER", address(0));
        if (c.keeper == address(0)) revert MissingEnv("KEEPER", "the account that may hold and release lines");
        c.enforceB20 = vm.envOr("ENFORCE_B20", block.chainid == 8453 || block.chainid == 84_532);
        c.policyRegistry = vm.envOr("POLICY_REGISTRY", c.enforceB20 ? POLICY_REGISTRY_PRECOMPILE : address(0));

        address collateral = vm.envOr("COLLATERAL", address(0));
        if (collateral == address(0)) revert MissingEnv("COLLATERAL", "the tokenized stock of the market to register");
        address oracle = vm.envOr("ORACLE", address(0));
        if (oracle == address(0)) revert MissingEnv("ORACLE", "the market's SessionGuard");
        c.params = MarketParams({
            loanToken: _loanToken(),
            collateralToken: collateral,
            oracle: oracle,
            irm: vm.envOr("IRM", ADAPTIVE_CURVE_IRM),
            lltv: vm.envOr("LLTV", DEFAULT_LLTV)
        });

        c.partnerName = vm.envOr("PARTNER_ID", DEFAULT_PARTNER);
        c.partnerId = partnerIdOf(c.partnerName);
        c.partnerAdmin = vm.envOr("PARTNER_ADMIN", address(0));
        c.partnerSigner = vm.envOr("PARTNER_SIGNER", address(0));
        c.partnerCap = uint128(vm.envOr("PARTNER_EXPOSURE_CAP", uint256(DEFAULT_PARTNER_CAP)));
        c.maxLtvWad = uint64(vm.envOr("MAX_LTV_WAD", uint256(DEFAULT_MAX_LTV_WAD)));
        c.minDraw = uint128(vm.envOr("MIN_DRAW", uint256(DEFAULT_MIN_DRAW)));
        c.maxDraw = uint128(vm.envOr("MAX_DRAW", uint256(DEFAULT_MAX_DRAW)));
        c.tickerCap = uint128(vm.envOr("TICKER_EXPOSURE_CAP", uint256(DEFAULT_TICKER_CAP)));
    }

    function _loanToken() internal view returns (address) {
        if (block.chainid == 8453) return USDC_MAINNET;
        if (block.chainid == 84_532) return USDC_SEPOLIA;
        address loan = vm.envOr("LOAN_TOKEN", address(0));
        if (loan == address(0)) revert MissingEnv("LOAN_TOKEN", "USDC is known only on 8453 and 84532");
        return loan;
    }

    function _print(Config memory c, Deployed memory d) internal view {
        console.log("{");
        console.log('  "chainId": %s,', block.chainid);
        console.log('  "creditDesk": "%s",', address(d.desk));
        console.log('  "owner": "%s", "keeper": "%s",', d.desk.owner(), c.keeper);
        console.log('  "gate": "%s", "policyRegistry": "%s", "enforceB20Policies": %s,', c.gate, c.policyRegistry, vm.toString(c.enforceB20));
        console.log('  "market": {');
        console.log('    "id": "%s",', vm.toString(Id.unwrap(d.id)));
        console.log('    "loanToken": "%s", "collateralToken": "%s",', c.params.loanToken, c.params.collateralToken);
        console.log('    "oracle": "%s", "irm": "%s", "lltv": %s', c.params.oracle, c.params.irm, c.params.lltv);
        console.log("  },");
        console.log('  "partner": {');
        console.log('    "id": "%s", "name": "%s",', vm.toString(d.partnerId), c.partnerName);
        console.log('    "admin": "%s", "signer": "%s", "exposureCap": %s', d.partnerAdmin, c.partnerSigner, uint256(c.partnerCap));
        console.log("  },");
        console.log('  "tickerPolicy": {');
        console.log('    "set": %s, "collateral": "%s", "maxLtvWad": %s,', vm.toString(d.tickerPolicySet), c.params.collateralToken, uint256(c.maxLtvWad));
        console.log('    "minDraw": %s, "maxDraw": %s, "exposureCap": %s', uint256(c.minDraw), uint256(c.maxDraw), uint256(c.tickerCap));
        console.log("  }");
        console.log("}");
        if (!d.tickerPolicySet) {
            console.log("ticker policy not set: PARTNER_ADMIN %s is not the broadcaster and must call setTickerPolicy", d.partnerAdmin);
        }
    }
}
