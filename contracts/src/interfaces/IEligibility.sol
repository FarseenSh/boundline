// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Partner-pluggable eligibility hook: a Base Verify consumer on Sepolia, a partner
///         attestation registry, or any allowlist. A hook that reverts is treated as "not eligible".
interface IEligibility {
    function isEligible(bytes32 partnerId, address user) external view returns (bool);
}
