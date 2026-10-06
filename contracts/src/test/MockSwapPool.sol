// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3SwapCallback} from "../protection/interfaces/ICLSwapPool.sol";
import {MockCLPool} from "./MockCLPool.sol";

/// @title MockSwapPool
/// @notice Base Sepolia and unit-test stand-in for an Aerodrome Slipstream pool with both faces the
///         protection stack uses: `MockCLPool`'s scripted `slot0` and `observe` for ShadowGuard's TWAP,
///         plus a fixed-price `swap` with the Uniswap v3 callback protocol for the Protector's sale. The
///         owner sets `price36`, token0 raw units per token1 raw unit times 1e36 (Morpho's scale when the
///         collateral is token1); the pool pays the output from its own balance and checks that the
///         callback paid the input, as a real pool does.
contract MockSwapPool is MockCLPool, Ownable {
    using SafeERC20 for IERC20;

    error NoPrice();
    error ZeroAmount();
    error Unpaid(address token, uint256 expected, uint256 got);

    event PriceSet(uint256 price36);

    uint256 public price36;

    constructor(address token0_, address token1_, int24 tickSpacing_, address initialOwner)
        MockCLPool(token0_, token1_, tickSpacing_)
        Ownable(initialOwner)
    {}

    function setPrice36(uint256 p) external onlyOwner {
        price36 = p;
        emit PriceSet(p);
    }

    /// @notice Uniswap v3 `swap`: positive `amountSpecified` is an exact input, negative an exact output.
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        if (price36 == 0) revert NoPrice();
        if (amountSpecified == 0) revert ZeroAmount();
        bool exactIn = amountSpecified > 0;
        uint256 specified = exactIn ? uint256(amountSpecified) : uint256(-amountSpecified);
        uint256 amountIn;
        uint256 amountOut;
        if (zeroForOne) {
            // token0 in, token1 out: out = in / price
            if (exactIn) {
                amountIn = specified;
                amountOut = Math.mulDiv(specified, 1e36, price36);
            } else {
                amountOut = specified;
                amountIn = Math.mulDiv(specified, price36, 1e36, Math.Rounding.Ceil);
            }
            amount0 = int256(amountIn);
            amount1 = -int256(amountOut);
        } else {
            // token1 in, token0 out: out = in * price
            if (exactIn) {
                amountIn = specified;
                amountOut = Math.mulDiv(specified, price36, 1e36);
            } else {
                amountOut = specified;
                amountIn = Math.mulDiv(specified, 1e36, price36, Math.Rounding.Ceil);
            }
            amount1 = int256(amountIn);
            amount0 = -int256(amountOut);
        }
        IERC20 tokenIn = IERC20(zeroForOne ? token0 : token1);
        IERC20 tokenOut = IERC20(zeroForOne ? token1 : token0);
        tokenOut.safeTransfer(recipient, amountOut);
        uint256 before = tokenIn.balanceOf(address(this));
        IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        uint256 got = tokenIn.balanceOf(address(this));
        if (got < before + amountIn) revert Unpaid(address(tokenIn), amountIn, got - before);
    }
}
