// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IEligibility} from "../src/interfaces/IEligibility.sol";
import {SessionGate} from "../src/oracle/SessionGate.sol";
import {AaveDesk} from "../src/aave/AaveDesk.sol";
import {AaveDeskLib} from "../src/aave/AaveDeskLib.sol";
import {ProtectionVault} from "../src/aave/ProtectionVault.sol";
import {IAaveSpoke, ITakerPositionManager, IGiverPositionManager} from "../src/aave/interfaces/IAaveV4.sol";

/// @notice Deploys the AaveDesk and the ProtectionVault against Aave V4's MAG7 spoke and, in the same
///         run, enables the first collateral reserve, creates the first partner, sets that partner's
///         reserve policy and the vault's advance terms. Mainnet only: Aave V4 is not on Base Sepolia.
///
///   GATE=<SessionGate with the AAPLc feed> KEEPER=<keeper> \
///     forge script script/DeployAave.s.sol --tc DeployAave --rpc-url base            # keyless dry run
///     forge script script/DeployAave.s.sol --tc DeployAave --rpc-url base --broadcast --verify --private-key "$KEY"
///
/// Every pre-check is a named error: the spoke must have code (`NoRpc`), both managers must be active
/// on the spoke and have it registered, the loan reserve must be borrowable, the collateral reserve must
/// carry a collateral factor, the gate must have a feed for its underlying, and the policy LTV must sit
/// below the collateral factor. The broadcaster becomes the owner of both contracts and, unless
/// PARTNER_ADMIN says otherwise, the partner admin on both.
///
/// | Env | Default |
/// | --- | --- |
/// | `GATE`, `KEEPER` | required |
/// | `SPOKE`, `TAKER`, `GIVER` | the Base MAG7 spoke and managers |
/// | `LOAN_RESERVE_ID`, `COLLATERAL_RESERVE_ID` | `7` (USDC), `0` (AAPLc) |
/// | `PARTNER_ID` (a name of up to 32 bytes) | `boundline-app` |
/// | `PARTNER_ADMIN`, `PARTNER_SIGNER`, `PARTNER_EXPOSURE_CAP` | broadcaster, none, `1_000e6` |
/// | `MAX_LTV_WAD`, `MIN_DRAW`, `MAX_DRAW`, `RESERVE_EXPOSURE_CAP` | `0.5e18`, `1e6`, `100e6`, `500e6` |
/// | `ADVANCE_CAP_PER_USER`, `ADVANCE_FEE_BPS` | `200e6`, `100` |
contract DeployAave is Script {
    address public constant SPOKE_DEFAULT = 0x17905Db0e4A3514467539956c084180616AE7B8D;
    address public constant TAKER_DEFAULT = 0x8481204E528735aF2F3391AD98f36E757A56D695;
    address public constant GIVER_DEFAULT = 0x9E81c2fDE4E34CAB3AB1667ca3c932dBAED95F08;
    uint256 public constant DEFAULT_LOAN_RESERVE = 7;
    uint256 public constant DEFAULT_COLLATERAL_RESERVE = 0;
    string public constant DEFAULT_PARTNER = "boundline-app";
    uint128 public constant DEFAULT_PARTNER_CAP = 1000e6;
    uint64 public constant DEFAULT_MAX_LTV_WAD = 0.5e18;
    uint128 public constant DEFAULT_MIN_DRAW = 1e6;
    uint128 public constant DEFAULT_MAX_DRAW = 100e6;
    uint128 public constant DEFAULT_RESERVE_CAP = 500e6;
    uint256 public constant DEFAULT_ADVANCE_CAP = 200e6;
    uint16 public constant DEFAULT_ADVANCE_FEE_BPS = 100;

    struct Config {
        address spoke;
        address taker;
        address giver;
        address gate;
        address keeper;
        uint256 loanReserveId;
        uint256 collateralReserveId;
        string partnerName;
        bytes32 partnerId;
        address partnerAdmin; // zero means the deployer
        address partnerSigner;
        uint128 partnerCap;
        uint64 maxLtvWad;
        uint128 minDraw;
        uint128 maxDraw;
        uint128 reserveCap;
        uint256 advanceCapPerUser;
        uint16 advanceFeeBps;
    }

    struct Deployed {
        AaveDesk desk;
        ProtectionVault vault;
        bytes32 partnerId;
        address partnerAdmin;
        address collateral;
        bool policySet;
    }

    error NoRpc(string hint);
    error MissingEnv(string name, string hint);
    error BadPartnerName(string name);
    error ManagerNotActive(address manager);
    error SpokeNotRegistered(address manager);
    error LoanReserveNotBorrowable(uint256 reserveId);
    error CollateralFactorZero(uint256 reserveId);
    error GateHasNoFeed(address token);
    error LtvNotBelowCollateralFactor(uint64 maxLtvWad, uint256 collateralFactorWad);

    function run() external returns (AaveDesk desk, ProtectionVault vault, bytes32 partnerId) {
        Config memory c = _config();
        vm.startBroadcast();
        Deployed memory d = _deploy(c, msg.sender);
        vm.stopBroadcast();
        _print(c, d);
        return (d.desk, d.vault, d.partnerId);
    }

    /// @notice Partner ids are the UTF-8 bytes of the name, left-aligned and zero-padded to 32 bytes.
    function partnerIdOf(string memory name) public pure returns (bytes32 out) {
        bytes memory b = bytes(name);
        if (b.length == 0 || b.length > 32) revert BadPartnerName(name);
        for (uint256 i = 0; i < b.length; ++i) {
            out |= bytes32(b[i]) >> (8 * i);
        }
    }

    // ================================================================= logic

    function _deploy(Config memory c, address deployer) internal returns (Deployed memory d) {
        if (c.spoke.code.length == 0) {
            revert NoRpc("the spoke has no code in this EVM: pass --rpc-url base (Aave V4 is mainnet only)");
        }
        IAaveSpoke spoke = IAaveSpoke(c.spoke);
        if (!spoke.isPositionManagerActive(c.taker)) revert ManagerNotActive(c.taker);
        if (!spoke.isPositionManagerActive(c.giver)) revert ManagerNotActive(c.giver);
        if (!ITakerPositionManager(c.taker).isSpokeRegistered(c.spoke)) revert SpokeNotRegistered(c.taker);
        if (!IGiverPositionManager(c.giver).isSpokeRegistered(c.spoke)) revert SpokeNotRegistered(c.giver);
        if (!spoke.getReserveConfig(c.loanReserveId).borrowable) revert LoanReserveNotBorrowable(c.loanReserveId);
        uint256 cf = AaveDeskLib.collateralFactorWad(spoke, c.collateralReserveId);
        if (cf == 0) revert CollateralFactorZero(c.collateralReserveId);
        d.collateral = spoke.getReserve(c.collateralReserveId).underlying;
        if (address(SessionGate(c.gate).feedOf(d.collateral).feed) == address(0)) revert GateHasNoFeed(d.collateral);
        if (uint256(c.maxLtvWad) >= cf) revert LtvNotBelowCollateralFactor(c.maxLtvWad, cf);
        d.partnerId = c.partnerId;
        d.partnerAdmin = c.partnerAdmin == address(0) ? deployer : c.partnerAdmin;

        d.desk = new AaveDesk(
            deployer,
            spoke,
            ITakerPositionManager(c.taker),
            IGiverPositionManager(c.giver),
            SessionGate(c.gate),
            c.loanReserveId,
            c.keeper
        );
        d.vault = new ProtectionVault(
            deployer,
            spoke,
            ITakerPositionManager(c.taker),
            IGiverPositionManager(c.giver),
            SessionGate(c.gate),
            c.loanReserveId,
            c.keeper
        );
        d.desk.enableReserve(c.collateralReserveId);
        d.desk.createPartner(c.partnerId, d.partnerAdmin, c.partnerSigner, IEligibility(address(0)), c.partnerCap);
        d.vault.setPartnerAdmin(c.partnerId, d.partnerAdmin);
        d.vault.setAdvanceTerms(c.advanceCapPerUser, c.advanceFeeBps);
        if (d.partnerAdmin == deployer) {
            d.desk
                .setReservePolicy(
                    c.partnerId, c.collateralReserveId, true, c.maxLtvWad, c.minDraw, c.maxDraw, c.reserveCap
                );
            d.policySet = true;
        }
    }

    function _config() internal view returns (Config memory c) {
        c.spoke = vm.envOr("SPOKE", SPOKE_DEFAULT);
        c.taker = vm.envOr("TAKER", TAKER_DEFAULT);
        c.giver = vm.envOr("GIVER", GIVER_DEFAULT);
        c.gate = vm.envOr("GATE", address(0));
        if (c.gate == address(0)) revert MissingEnv("GATE", "the SessionGate holding the collateral's feed");
        c.keeper = vm.envOr("KEEPER", address(0));
        if (c.keeper == address(0)) revert MissingEnv("KEEPER", "the account that holds lines and runs protection");
        c.loanReserveId = vm.envOr("LOAN_RESERVE_ID", DEFAULT_LOAN_RESERVE);
        c.collateralReserveId = vm.envOr("COLLATERAL_RESERVE_ID", DEFAULT_COLLATERAL_RESERVE);
        c.partnerName = vm.envOr("PARTNER_ID", DEFAULT_PARTNER);
        c.partnerId = partnerIdOf(c.partnerName);
        c.partnerAdmin = vm.envOr("PARTNER_ADMIN", address(0));
        c.partnerSigner = vm.envOr("PARTNER_SIGNER", address(0));
        c.partnerCap = uint128(vm.envOr("PARTNER_EXPOSURE_CAP", uint256(DEFAULT_PARTNER_CAP)));
        c.maxLtvWad = uint64(vm.envOr("MAX_LTV_WAD", uint256(DEFAULT_MAX_LTV_WAD)));
        c.minDraw = uint128(vm.envOr("MIN_DRAW", uint256(DEFAULT_MIN_DRAW)));
        c.maxDraw = uint128(vm.envOr("MAX_DRAW", uint256(DEFAULT_MAX_DRAW)));
        c.reserveCap = uint128(vm.envOr("RESERVE_EXPOSURE_CAP", uint256(DEFAULT_RESERVE_CAP)));
        c.advanceCapPerUser = vm.envOr("ADVANCE_CAP_PER_USER", DEFAULT_ADVANCE_CAP);
        c.advanceFeeBps = uint16(vm.envOr("ADVANCE_FEE_BPS", uint256(DEFAULT_ADVANCE_FEE_BPS)));
    }

    function _print(Config memory c, Deployed memory d) internal view {
        console.log("{");
        console.log('  "chainId": %s,', block.chainid);
        console.log('  "aaveDesk": "%s", "protectionVault": "%s",', address(d.desk), address(d.vault));
        console.log('  "owner": "%s", "keeper": "%s",', d.desk.owner(), c.keeper);
        console.log('  "spoke": "%s", "taker": "%s", "giver": "%s",', c.spoke, c.taker, c.giver);
        console.log(
            '  "gate": "%s", "loanReserveId": %s, "collateralReserveId": %s,',
            c.gate,
            c.loanReserveId,
            c.collateralReserveId
        );
        console.log('  "collateral": "%s",', d.collateral);
        console.log('  "partner": { "id": "%s", "name": "%s",', vm.toString(d.partnerId), c.partnerName);
        console.log(
            '    "admin": "%s", "signer": "%s", "exposureCap": %s },',
            d.partnerAdmin,
            c.partnerSigner,
            uint256(c.partnerCap)
        );
        console.log('  "reservePolicy": { "set": %s, "maxLtvWad": %s,', vm.toString(d.policySet), uint256(c.maxLtvWad));
        console.log(
            '    "minDraw": %s, "maxDraw": %s, "exposureCap": %s },',
            uint256(c.minDraw),
            uint256(c.maxDraw),
            uint256(c.reserveCap)
        );
        console.log('  "advances": { "capPerUser": %s, "feeBps": %s }', c.advanceCapPerUser, uint256(c.advanceFeeBps));
        console.log("}");
        if (!d.policySet) {
            console.log(
                "reserve policy not set: PARTNER_ADMIN %s is not the broadcaster and must call setReservePolicy",
                d.partnerAdmin
            );
        }
    }
}
