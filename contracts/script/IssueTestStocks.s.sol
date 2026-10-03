// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IB20Factory} from "base-std/interfaces/IB20Factory.sol";
import {IPolicyRegistry} from "base-std/interfaces/IPolicyRegistry.sol";
import {StdPrecompiles} from "base-std/StdPrecompiles.sol";
import {B20Constants} from "base-std/lib/B20Constants.sol";
import {B20FactoryLib} from "base-std/lib/B20FactoryLib.sol";
import {PrecompileMocks} from "../test/script/PrecompileMocks.sol";

/// @notice Pure encoders for a Boundline test stock, kept separate so tests can pin them.
library TestStockLib {
    /// @dev Deterministic per symbol; the token address derives from (ASSET, broadcaster, salt).
    function salt(string memory symbol) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("boundline/test-stock/", symbol, "/v1"));
    }

    /// @notice The factory initCalls, in the order the factory requires:
    ///         role grants (MINT, BURN, PAUSE, UNPAUSE, METADATA, OPERATOR, then SEIZE, which the
    ///         base-std bundle does not carry), supply cap, policies (MINT_RECEIVER is enforced
    ///         even for factory mints, so it is bound before the mint), then batchMint last.
    function initCalls(
        address admin,
        uint256 supplyCap,
        uint64 holdersAllowlistId,
        uint64 blocklistId,
        address[] memory recipients,
        uint256[] memory amounts
    ) internal pure returns (bytes[] memory) {
        bytes[] memory roles = B20FactoryLib.buildRoleGrants(
            B20FactoryLib.B20AssetRoleHolders({
                minter: admin,
                burner: admin,
                burnBlocker: address(0),
                pauser: admin,
                unpauser: admin,
                metadataAdmin: admin,
                operator: admin
            })
        );
        bytes[] memory rest = new bytes[](6);
        rest[0] = B20FactoryLib.encodeGrantRole(B20Constants.SEIZE_ROLE, admin);
        rest[1] = B20FactoryLib.encodeUpdateSupplyCap(supplyCap);
        rest[2] = B20FactoryLib.encodeUpdatePolicy(B20Constants.MINT_RECEIVER_POLICY, holdersAllowlistId);
        rest[3] = B20FactoryLib.encodeUpdatePolicy(B20Constants.TRANSFER_SENDER_POLICY, blocklistId);
        rest[4] = B20FactoryLib.encodeUpdatePolicy(B20Constants.TRANSFER_RECEIVER_POLICY, blocklistId);
        rest[5] = B20FactoryLib.encodeBatchMint(recipients, amounts);
        return B20FactoryLib.concat(roles, rest);
    }
}

/// @notice Issues Boundline's test stocks on Base Sepolia through the B20 factory precompile
///         (post-Cobalt), and wires the policies Morpho and the desk need.
///
///   issue all:   base-forge script script/IssueTestStocks.s.sol --rpc-url base_sepolia --broadcast
///   issue one:   ... --sig "issue(string)" AAPLt
///   wire venues: ... --sig "wire(address,address[])" <token> "[<morpho>,<desk>,<keeper>]"
///   local:       ETCH_MOCKS=true forge script script/IssueTestStocks.s.sol
///
/// Stock forge cannot execute the precompiles, even against an RPC (they have no bytecode), so a
/// network run needs Base's Foundry build (`base-forge`). ETCH_MOCKS=true etches base-std's
/// reference mocks for a keyless local simulation and is refused during a broadcast.
///
/// Per symbol: an ALLOWLIST of intended holders (broadcaster + MINT_TO) bound to MINT_RECEIVER,
/// an empty BLOCKLIST bound to TRANSFER_SENDER and TRANSFER_RECEIVER, the asset itself (8
/// decimals, admin = broadcaster, roles to the broadcaster, supply cap, batchMint), and the
/// predicted versus actual address. `wire` adds the venues to the holders allowlist, binds
/// INTERSECT(blocklist, allowlist) to TRANSFER_RECEIVER and lists the venues on SEIZE_EXEMPT.
contract IssueTestStocks is Script {
    struct Issued {
        string symbol;
        address predicted;
        address token;
        uint64 holdersAllowlistId;
        uint64 blocklistId;
    }

    uint256 public constant DEFAULT_MINT = 1000e8;
    uint256 public constant DEFAULT_SUPPLY_CAP = 1_000_000e8;

    error PrecompilesMissing(string hint);
    error EtchMocksDuringBroadcast();
    error CompositePoliciesUnavailable(string hint);

    // ================================================================= entry points

    function run() external returns (Issued[] memory out) {
        _precompilesOrMocks();
        string[] memory defaults = new string[](3);
        defaults[0] = "AAPLt";
        defaults[1] = "NVDAt";
        defaults[2] = "TSLAt";
        string[] memory symbols = vm.envOr("TEST_STOCK_SYMBOLS", ",", defaults);
        (address[] memory mintTo, uint256 mintAmount, uint256 cap) = _mintConfig();

        vm.startBroadcast();
        out = new Issued[](symbols.length);
        for (uint256 i = 0; i < symbols.length; ++i) {
            out[i] = _issue(msg.sender, symbols[i], mintTo, mintAmount, cap);
        }
        vm.stopBroadcast();
        _print(out);
    }

    function issue(string calldata symbol) external returns (Issued memory out) {
        _precompilesOrMocks();
        (address[] memory mintTo, uint256 mintAmount, uint256 cap) = _mintConfig();
        vm.startBroadcast();
        out = _issue(msg.sender, symbol, mintTo, mintAmount, cap);
        vm.stopBroadcast();
        Issued[] memory one = new Issued[](1);
        one[0] = out;
        _print(one);
    }

    function wire(address token, address[] calldata venues)
        external
        returns (uint64 compositeId, uint64 seizeExemptId)
    {
        _precompilesOrMocks();
        vm.startBroadcast();
        (compositeId, seizeExemptId) = _wire(msg.sender, token, venues);
        vm.stopBroadcast();
        console.log("{");
        console.log('  "token": "%s",', token);
        console.log('  "transferReceiverPolicy": %s,', uint256(compositeId));
        console.log('  "seizeExemptPolicy": %s', uint256(seizeExemptId));
        console.log("}");
    }

    // ================================================================= logic

    /// @dev `admin` must be the account the precompiles see as msg.sender (the broadcaster in a
    ///      script, the calling contract in a test), because the token address derives from it.
    function _issue(address admin, string memory symbol, address[] memory extraHolders, uint256 mintAmount, uint256 cap)
        internal
        returns (Issued memory r)
    {
        r.symbol = symbol;
        address[] memory holders = new address[](extraHolders.length + 1);
        holders[0] = admin;
        for (uint256 i = 0; i < extraHolders.length; ++i) {
            holders[i + 1] = extraHolders[i];
        }
        uint256[] memory amounts = new uint256[](holders.length);
        for (uint256 i = 0; i < holders.length; ++i) {
            amounts[i] = mintAmount;
        }

        // Tx 1 and 2: the policies must exist before createB20; updatePolicy reverts for unknown ids.
        r.holdersAllowlistId = StdPrecompiles.POLICY_REGISTRY
        .createPolicyWithAccounts(admin, IPolicyRegistry.PolicyType.ALLOWLIST, holders);
        r.blocklistId = StdPrecompiles.POLICY_REGISTRY.createPolicy(admin, IPolicyRegistry.PolicyType.BLOCKLIST);

        // Tx 3: the token.
        bytes32 salt = TestStockLib.salt(symbol);
        r.predicted = StdPrecompiles.B20_FACTORY.getB20Address(IB20Factory.B20Variant.ASSET, admin, salt);
        r.token = StdPrecompiles.B20_FACTORY
            .createB20(
                IB20Factory.B20Variant.ASSET,
                salt,
                B20FactoryLib.encodeAssetCreateParams(string.concat("Boundline test ", symbol), symbol, admin, 8),
                TestStockLib.initCalls(admin, cap, r.holdersAllowlistId, r.blocklistId, holders, amounts)
            );
    }

    /// @dev Reuses the holders allowlist bound to MINT_RECEIVER at issue time when it is one of
    ///      ours; otherwise creates a fresh allowlist with the admin on it. Same for the blocklist.
    function _wire(address admin, address token, address[] memory venues)
        internal
        returns (uint64 compositeId, uint64 seizeExemptId)
    {
        if (!PrecompileMocks.compositePoliciesSupported()) {
            revert CompositePoliciesUnavailable("this policy registry predates Cobalt (base-forge v1.1.0 is a Beryl build): use a nightly or a Cobalt chain");
        }
        IB20 t = IB20(token);
        IPolicyRegistry reg = StdPrecompiles.POLICY_REGISTRY;

        uint64 allowlistId = t.policyId(B20Constants.MINT_RECEIVER_POLICY);
        if (!_isOurs(reg, allowlistId, IPolicyRegistry.PolicyType.ALLOWLIST, admin)) {
            address[] memory seed = new address[](1);
            seed[0] = admin;
            allowlistId = reg.createPolicyWithAccounts(admin, IPolicyRegistry.PolicyType.ALLOWLIST, seed);
        }
        reg.updateAllowlist(allowlistId, true, venues);

        uint64 blocklistId = t.policyId(B20Constants.TRANSFER_RECEIVER_POLICY);
        if (!_isOurs(reg, blocklistId, IPolicyRegistry.PolicyType.BLOCKLIST, admin)) {
            blocklistId = reg.createPolicy(admin, IPolicyRegistry.PolicyType.BLOCKLIST);
        }

        uint64[] memory children = new uint64[](2);
        children[0] = blocklistId;
        children[1] = allowlistId;
        compositeId = reg.createCompositePolicy(admin, IPolicyRegistry.PolicyType.INTERSECT, children);
        t.updatePolicy(B20Constants.TRANSFER_RECEIVER_POLICY, compositeId);

        seizeExemptId = reg.createPolicyWithAccounts(admin, IPolicyRegistry.PolicyType.ALLOWLIST, venues);
        t.updatePolicy(B20Constants.SEIZE_EXEMPT_POLICY, seizeExemptId);
    }

    function _isOurs(IPolicyRegistry reg, uint64 id, IPolicyRegistry.PolicyType kind, address admin)
        internal
        view
        returns (bool)
    {
        if (id == 0) return false; // ALWAYS_ALLOW sentinel
        if (uint8(id >> 56) != uint8(kind)) return false;
        return reg.policyExists(id) && reg.policyAdmin(id) == admin;
    }

    // ================================================================= helpers

    function _mintConfig() internal view returns (address[] memory mintTo, uint256 mintAmount, uint256 cap) {
        mintTo = vm.envOr("MINT_TO", ",", new address[](0));
        mintAmount = vm.envOr("TEST_STOCK_MINT", DEFAULT_MINT);
        cap = vm.envOr("TEST_STOCK_SUPPLY_CAP", DEFAULT_SUPPLY_CAP);
    }

    function _precompilesOrMocks() internal {
        if (vm.envOr("ETCH_MOCKS", false)) {
            if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
                revert EtchMocksDuringBroadcast();
            }
            if (PrecompileMocks.ensure()) {
                console.log("ETCH_MOCKS: the precompiles are live in this EVM; nothing etched");
            } else {
                console.log("ETCH_MOCKS: base-std reference precompiles etched for a keyless local simulation");
            }
            return;
        }
        if (!PrecompileMocks.present()) {
            revert PrecompilesMissing("no precompiles in this EVM: run with base-forge against --rpc-url base_sepolia, or ETCH_MOCKS=true locally");
        }
    }

    function _print(Issued[] memory out) internal pure {
        console.log("{");
        for (uint256 i = 0; i < out.length; ++i) {
            console.log('  "%s": {', out[i].symbol);
            console.log('    "predicted": "%s", "token": "%s",', out[i].predicted, out[i].token);
            console.log(
                '    "holdersAllowlistId": %s, "blocklistId": %s',
                uint256(out[i].holdersAllowlistId),
                uint256(out[i].blocklistId)
            );
            console.log(i + 1 < out.length ? "  }," : "  }");
        }
        console.log("}");
    }
}
