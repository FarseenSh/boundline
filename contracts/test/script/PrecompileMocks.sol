// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IActivationRegistry} from "base-std/interfaces/IActivationRegistry.sol";
import {IB20Factory} from "base-std/interfaces/IB20Factory.sol";
import {StdPrecompiles} from "base-std/StdPrecompiles.sol";
import {ActivationRegistryFeatureList} from "base-std-test/lib/mocks/ActivationRegistryFeatureList.sol";
import {MockActivationRegistry} from "base-std-test/lib/mocks/MockActivationRegistry.sol";
import {MockB20Factory} from "base-std-test/lib/mocks/MockB20Factory.sol";
import {MockPolicyRegistry} from "base-std-test/lib/mocks/MockPolicyRegistry.sol";

/// @notice Makes Base's precompile surface (B20 factory, policy registry, activation registry)
///         usable from scripts and tests in either world:
///         - under Base's Foundry build (`base-forge`, base-anvil) the precompiles are live and
///           cannot be etched, so they are used as they are;
///         - under stock forge the addresses are empty, so base-std's reference mocks are
///           etched, mirroring base-std's BaseTest.setUp.
///         Detection is behavioural (does the address answer), not a code-size check, because a
///         native precompile reports zero code.
library PrecompileMocks {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error CannotEtchPrecompiles();

    /// @notice True when something answers at the activation registry address.
    function present() internal view returns (bool) {
        (bool ok, bytes memory ret) =
            StdPrecompiles.ACTIVATION_REGISTRY_ADDRESS.staticcall(abi.encodeCall(IActivationRegistry.admin, ()));
        return ok && ret.length >= 32;
    }

    /// @notice True when the B20 factory itself answers (live precompile or an earlier etch).
    function factoryLive() internal view returns (bool) {
        (bool ok, bytes memory ret) =
            StdPrecompiles.B20_FACTORY_ADDRESS.staticcall(abi.encodeCall(IB20Factory.isB20, (address(0))));
        return ok && ret.length >= 32;
    }

    /// @notice Use the live precompiles when present, otherwise etch the mocks. Either way every
    ///         B20 feature is activated afterwards.
    /// @return live True when the real precompiles are in use.
    function ensure() internal returns (bool live) {
        if (present() || factoryLive()) {
            activateIfNeeded();
            return true;
        }
        if (!tryEtch()) revert CannotEtchPrecompiles();
        activateIfNeeded();
        return false;
    }

    /// @notice Etch the three mocks and activate every B20 feature. Reverts where etching is
    ///         impossible (Base's Foundry build reserves the precompile addresses).
    function etch() internal {
        if (!tryEtch()) revert CannotEtchPrecompiles();
        activateIfNeeded();
    }

    /// @notice Etch the three mocks, reporting failure instead of reverting.
    function tryEtch() internal returns (bool) {
        return _etch(StdPrecompiles.B20_FACTORY_ADDRESS, type(MockB20Factory).runtimeCode)
            && _etch(StdPrecompiles.POLICY_REGISTRY_ADDRESS, type(MockPolicyRegistry).runtimeCode)
            && _etch(StdPrecompiles.ACTIVATION_REGISTRY_ADDRESS, type(MockActivationRegistry).runtimeCode);
    }

    /// @notice Activate B20_ASSET, B20_STABLECOIN and POLICY_REGISTRY as the registry admin when
    ///         any of them is inactive (base-anvil's docs disagree on the default).
    function activateIfNeeded() internal {
        IActivationRegistry reg = StdPrecompiles.ACTIVATION_REGISTRY;
        bytes32[3] memory features = [
            ActivationRegistryFeatureList.B20_ASSET,
            ActivationRegistryFeatureList.B20_STABLECOIN,
            ActivationRegistryFeatureList.POLICY_REGISTRY
        ];
        bool allActive = true;
        for (uint256 i = 0; i < features.length; ++i) {
            if (!reg.isActivated(features[i])) allActive = false;
        }
        if (allActive) return;
        vm.startPrank(reg.admin());
        for (uint256 i = 0; i < features.length; ++i) {
            if (!reg.isActivated(features[i])) reg.activate(features[i]);
        }
        vm.stopPrank();
    }

    /// @dev Low-level call to the cheatcode so a refusal (live precompile) is a boolean, not a revert.
    function _etch(address target, bytes memory code) private returns (bool ok) {
        (ok,) = address(vm).call(abi.encodeCall(Vm.etch, (target, code)));
    }
}
