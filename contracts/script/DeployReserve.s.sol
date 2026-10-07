// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CreditDesk} from "../src/desk/CreditDesk.sol";
import {BoundlineReserve} from "../src/reserve/BoundlineReserve.sol";
import {DeskProtectionVault} from "../src/reserve/DeskProtectionVault.sol";

/// @notice Deploys the Boundline Reserve (ERC-4626 over USDC) and the DeskProtectionVault over an existing
///         CreditDesk, wires the two (the vault's funder is the Reserve, the vault is a registered sink),
///         names the partner admin, and optionally seeds the book: a first deposit into the Reserve by the
///         broadcaster and a first allocation of advance liquidity into the vault.
///
///   DESK=<CreditDesk> forge script script/DeployReserve.s.sol --tc DeployReserve \
///     --rpc-url base_sepolia --broadcast --verify --private-key "$KEY"
///
/// Needs an RPC: the vault reads `MORPHO()` and `GATE()` from the desk in its constructor, so without one
/// the script stops with `NoRpc`. The broadcaster becomes owner of both contracts and, by default, the
/// Reserve's manager, the vault's keeper and the partner admin. `SET_DESK_VAULT=true` additionally calls
/// `desk.setProtectionVault(vault)` (desk owner only; a desk deployed before 7 Oct 2026 has no such
/// function, so it defaults to false and the main session wires it at the freeze redeploy).
///
/// | Env | Default |
/// | --- | --- |
/// | `DESK` | required |
/// | `USDC` | USDC on 8453 and 84532, required elsewhere |
/// | `KEEPER`, `MANAGER`, `PARTNER_ADMIN` | the broadcaster |
/// | `COOLDOWN_SECONDS`, `UTILISATION_CAP_BPS` | `3600`, `8000` |
/// | `ADVANCE_FEE_BPS`, `ADVANCE_CAP_PER_LINE` | `100`, `2e6` |
/// | `PARTNER_ID` (a name of up to 32 bytes, see `partnerIdOf`) | `boundline-app` |
/// | `RESERVE_DEPOSIT`, `RESERVE_ALLOCATE` | `2e6`, `1e6` (zero skips the step) |
/// | `SET_DESK_VAULT` | `false` |
contract DeployReserve is Script {
    address public constant USDC_MAINNET = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant USDC_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    string public constant DEFAULT_PARTNER = "boundline-app";
    uint64 public constant DEFAULT_COOLDOWN = 3600;
    uint16 public constant DEFAULT_UTILISATION_CAP_BPS = 8000;
    uint16 public constant DEFAULT_ADVANCE_FEE_BPS = 100;
    uint256 public constant DEFAULT_ADVANCE_CAP_PER_LINE = 2e6;
    uint256 public constant DEFAULT_RESERVE_DEPOSIT = 2e6;
    uint256 public constant DEFAULT_RESERVE_ALLOCATE = 1e6;

    struct Config {
        address desk;
        address usdc;
        address keeper; // zero means the deployer
        address manager; // zero means the deployer
        uint64 cooldownSeconds;
        uint16 utilisationCapBps;
        uint16 advanceFeeBps;
        uint256 advanceCapPerLine;
        string partnerName;
        bytes32 partnerId;
        address partnerAdmin; // zero means the deployer
        uint256 reserveDeposit;
        uint256 reserveAllocate;
        bool setDeskVault;
    }

    struct Deployed {
        BoundlineReserve reserve;
        DeskProtectionVault vault;
        address keeper;
        address manager;
        address partnerAdmin;
        uint256 sharesMinted;
        uint256 allocatedAmount;
        bool deskVaultSet;
    }

    error NoRpc(string hint);
    error MissingEnv(string name, string hint);
    error BadPartnerName(string name);
    error AllocationExceedsDeposit(uint256 allocate, uint256 deposit);

    function run() external returns (BoundlineReserve reserve, DeskProtectionVault vault) {
        Config memory c = _config();
        vm.startBroadcast();
        Deployed memory d = _deploy(c, msg.sender);
        vm.stopBroadcast();
        _print(c, d);
        return (d.reserve, d.vault);
    }

    /// @notice Same encoding as `DeployCreditDesk.partnerIdOf`: the UTF-8 bytes left-aligned in a bytes32.
    function partnerIdOf(string memory name) public pure returns (bytes32 out) {
        bytes memory b = bytes(name);
        if (b.length == 0 || b.length > 32) revert BadPartnerName(name);
        for (uint256 i = 0; i < b.length; ++i) {
            out |= bytes32(b[i]) >> (8 * i);
        }
    }

    // ================================================================= logic

    /// @dev `deployer` is the account the contracts see as msg.sender: the broadcaster in a script, the
    ///      calling harness in a test. It becomes owner of both and fills every zero default.
    function _deploy(Config memory c, address deployer) internal returns (Deployed memory d) {
        if (c.desk.code.length == 0) {
            revert NoRpc("the desk has no code in this EVM: pass --rpc-url base_sepolia or base");
        }
        if (c.reserveAllocate > c.reserveDeposit) revert AllocationExceedsDeposit(c.reserveAllocate, c.reserveDeposit);
        CreditDesk desk = CreditDesk(c.desk);
        IERC20 usdc = IERC20(c.usdc);
        d.keeper = c.keeper == address(0) ? deployer : c.keeper;
        d.manager = c.manager == address(0) ? deployer : c.manager;
        d.partnerAdmin = c.partnerAdmin == address(0) ? deployer : c.partnerAdmin;

        d.reserve = new BoundlineReserve(deployer, usdc, d.manager, c.cooldownSeconds, c.utilisationCapBps);
        d.vault = new DeskProtectionVault(deployer, desk, usdc, d.keeper);
        d.vault.setAdvanceTerms(c.advanceCapPerLine, c.advanceFeeBps);
        d.vault.setFunder(address(d.reserve));
        d.vault.setPartnerAdmin(c.partnerId, d.partnerAdmin);
        d.reserve.addSink(address(d.vault));
        if (c.setDeskVault) {
            desk.setProtectionVault(address(d.vault));
            d.deskVaultSet = true;
        }
        if (c.reserveDeposit != 0) {
            usdc.approve(address(d.reserve), c.reserveDeposit);
            d.sharesMinted = d.reserve.deposit(c.reserveDeposit, deployer);
        }
        if (c.reserveAllocate != 0) {
            d.reserve.allocate(address(d.vault), c.reserveAllocate);
            d.allocatedAmount = c.reserveAllocate;
        }
    }

    function _config() internal view returns (Config memory c) {
        c.desk = vm.envOr("DESK", address(0));
        if (c.desk == address(0)) revert MissingEnv("DESK", "the CreditDesk the vault protects lines on");
        c.usdc = _usdc();
        c.keeper = vm.envOr("KEEPER", address(0));
        c.manager = vm.envOr("MANAGER", address(0));
        c.cooldownSeconds = uint64(vm.envOr("COOLDOWN_SECONDS", uint256(DEFAULT_COOLDOWN)));
        c.utilisationCapBps = uint16(vm.envOr("UTILISATION_CAP_BPS", uint256(DEFAULT_UTILISATION_CAP_BPS)));
        c.advanceFeeBps = uint16(vm.envOr("ADVANCE_FEE_BPS", uint256(DEFAULT_ADVANCE_FEE_BPS)));
        c.advanceCapPerLine = vm.envOr("ADVANCE_CAP_PER_LINE", DEFAULT_ADVANCE_CAP_PER_LINE);
        c.partnerName = vm.envOr("PARTNER_ID", DEFAULT_PARTNER);
        c.partnerId = partnerIdOf(c.partnerName);
        c.partnerAdmin = vm.envOr("PARTNER_ADMIN", address(0));
        c.reserveDeposit = vm.envOr("RESERVE_DEPOSIT", DEFAULT_RESERVE_DEPOSIT);
        c.reserveAllocate = vm.envOr("RESERVE_ALLOCATE", DEFAULT_RESERVE_ALLOCATE);
        c.setDeskVault = vm.envOr("SET_DESK_VAULT", false);
    }

    function _usdc() internal view returns (address) {
        if (block.chainid == 8453) return USDC_MAINNET;
        if (block.chainid == 84_532) return USDC_SEPOLIA;
        address usdc = vm.envOr("USDC", address(0));
        if (usdc == address(0)) revert MissingEnv("USDC", "USDC is known only on 8453 and 84532");
        return usdc;
    }

    function _print(Config memory c, Deployed memory d) internal view {
        console.log("{");
        console.log('  "chainId": %s,', block.chainid);
        console.log('  "reserve": "%s",', address(d.reserve));
        console.log('  "deskProtectionVault": "%s",', address(d.vault));
        console.log('  "desk": "%s", "usdc": "%s",', c.desk, c.usdc);
        console.log('  "owner": "%s", "manager": "%s", "keeper": "%s",', d.reserve.owner(), d.manager, d.keeper);
        console.log(
            '  "cooldownSeconds": %s, "utilisationCapBps": %s,',
            uint256(c.cooldownSeconds),
            uint256(c.utilisationCapBps)
        );
        console.log('  "advanceFeeBps": %s, "advanceCapPerLine": %s,', uint256(c.advanceFeeBps), c.advanceCapPerLine);
        console.log('  "partner": { "id": "%s", "name": "%s",', vm.toString(c.partnerId), c.partnerName);
        console.log('    "admin": "%s" },', d.partnerAdmin);
        console.log('  "seed": { "deposited": %s, "sharesMinted": %s,', c.reserveDeposit, d.sharesMinted);
        console.log('    "allocated": %s },', d.allocatedAmount);
        console.log('  "deskProtectionVaultSet": %s', vm.toString(d.deskVaultSet));
        console.log("}");
        if (!d.deskVaultSet) {
            console.log("desk.setProtectionVault not called: run it as the desk owner once the desk has the function");
        }
    }
}
