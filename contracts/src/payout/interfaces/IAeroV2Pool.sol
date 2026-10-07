// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The Aerodrome v2 (Velodrome-style) pool surface the payout router trades on: the quote view and the
///         transfer-then-swap entry point. Both recorded local-money pools on Base mainnet (EURC/USDC
///         0xE846…0EC7 and cNGN/ZARP 0x4D39…3A46) turned out to be Slipstream CL pools on 7 Oct 2026, so this
///         path is kept for the v2 pools a partner may route to; it is exercised by `MockV2Pool` in the tests.
interface IAeroV2Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function stable() external view returns (bool);
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}
