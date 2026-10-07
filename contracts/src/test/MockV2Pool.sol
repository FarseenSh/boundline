// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAeroV2Pool} from "../payout/interfaces/IAeroV2Pool.sol";

/// @title MockV2Pool
/// @notice Unit-test stand-in for an Aerodrome v2 pool: a fixed rate instead of a curve, the same
///         transfer-then-`swap` protocol as the real pool (the caller sends the input first, the pool checks
///         it received at least what `getAmountOut` prices the output at, then pays the output).
///         `rate18` is token1 raw units per token0 raw unit times 1e18; `feeBps` is taken from the input.
contract MockV2Pool is IAeroV2Pool {
    using SafeERC20 for IERC20;

    error BadToken(address token);
    error InsufficientInput(uint256 expected, uint256 got);
    error ZeroOutput();

    address public immutable token0;
    address public immutable token1;
    bool public immutable stable;
    uint256 public rate18;
    uint256 public feeBps;
    uint256 private _reserve0;
    uint256 private _reserve1;

    constructor(address token0_, address token1_, bool stable_, uint256 rate18_, uint256 feeBps_) {
        token0 = token0_;
        token1 = token1_;
        stable = stable_;
        rate18 = rate18_;
        feeBps = feeBps_;
    }

    /// @notice Call after funding the pool so the balance checks start from a known baseline.
    function sync() external {
        _reserve0 = IERC20(token0).balanceOf(address(this));
        _reserve1 = IERC20(token1).balanceOf(address(this));
    }

    function getAmountOut(uint256 amountIn, address tokenIn) public view returns (uint256) {
        uint256 net = amountIn - Math.mulDiv(amountIn, feeBps, 10_000);
        if (tokenIn == token0) return Math.mulDiv(net, rate18, 1e18);
        if (tokenIn == token1) return Math.mulDiv(net, 1e18, rate18);
        revert BadToken(tokenIn);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        if (amount0Out == 0 && amount1Out == 0) revert ZeroOutput();
        uint256 bal0 = IERC20(token0).balanceOf(address(this));
        uint256 bal1 = IERC20(token1).balanceOf(address(this));
        if (amount1Out != 0) {
            // token0 came in
            uint256 got = bal0 - _reserve0;
            uint256 need = Math.mulDiv(amount1Out, 1e18, rate18, Math.Rounding.Ceil);
            need = Math.mulDiv(need, 10_000, 10_000 - feeBps, Math.Rounding.Ceil);
            if (got < need) revert InsufficientInput(need, got);
            IERC20(token1).safeTransfer(to, amount1Out);
        }
        if (amount0Out != 0) {
            uint256 got = bal1 - _reserve1;
            uint256 need = Math.mulDiv(amount0Out, rate18, 1e18, Math.Rounding.Ceil);
            need = Math.mulDiv(need, 10_000, 10_000 - feeBps, Math.Rounding.Ceil);
            if (got < need) revert InsufficientInput(need, got);
            IERC20(token0).safeTransfer(to, amount0Out);
        }
        _reserve0 = IERC20(token0).balanceOf(address(this));
        _reserve1 = IERC20(token1).balanceOf(address(this));
    }
}
