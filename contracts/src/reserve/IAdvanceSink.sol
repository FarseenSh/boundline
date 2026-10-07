// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IAdvanceSink
/// @notice What the Boundline Reserve needs from a vault it funds: a way to place USDC as advance
///         liquidity, take free liquidity back, collect the advance fees the vault earned, and read
///         how much of the placement is idle, outstanding or earned. `ProtectionVault` (Aave V4) and
///         `DeskProtectionVault` (the CreditDesk on Morpho) implement it.
interface IAdvanceSink {
    /// @notice Pull `amount` of USDC from the caller as advance liquidity. Owner or funder only.
    function fundAdvances(uint256 amount) external;
    /// @notice Send `amount` of free (not advanced) liquidity to `to`. Owner or funder only.
    function defundAdvances(uint256 amount, address to) external;
    /// @notice Send every collected advance fee to `to`. Owner or funder only.
    function collectFees(address to) external;

    function advanceLiquidity() external view returns (uint256);
    function totalOutstanding() external view returns (uint256);
    function feesCollected() external view returns (uint256);
}
