// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICLPool} from "../../interfaces/ICLPool.sol";

/// @notice The Aerodrome Slipstream (Uniswap v3 shape) pool surface the Protector trades on: the read
///         surface ShadowGuard already uses plus `swap`. Swapping against the pool directly, instead
///         of through a router, means the collateral is sold on the very pool whose time-weighted
///         price priced the pre-liquidation, and no router address has to match the pool's factory
///         (Base has Slipstream pools under more than one CLFactory).
interface ICLSwapPool is ICLPool {
    /// @param recipient Receives the output token.
    /// @param zeroForOne Sell token0 for token1 when true, token1 for token0 when false.
    /// @param amountSpecified Positive for an exact input, negative for an exact output.
    /// @param sqrtPriceLimitX96 Price limit; pass MIN_SQRT_RATIO + 1 or MAX_SQRT_RATIO - 1 for none.
    /// @param data Forwarded to `uniswapV3SwapCallback` on the caller, which must pay the owed token.
    /// @return amount0 Positive when the pool received token0, negative when it paid it out.
    /// @return amount1 Same for token1.
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @notice The callback a Slipstream pool makes to the swap caller (Uniswap v3 name, kept by Aerodrome).
interface IUniswapV3SwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}
