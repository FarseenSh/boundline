// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Coinbase OracleRegistry on Base mainnet (0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD).
///         `paused` is the issuer's "do not price this token" flag; `multiplier` is the
///         corporate-action multiplier (1e18 = 1.0).
interface IOracleRegistry {
    function getOracleParams(address token) external view returns (uint256 multiplier, bool paused);
}
