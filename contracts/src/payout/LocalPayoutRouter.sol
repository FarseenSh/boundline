// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPriceGate} from "../interfaces/IPriceGate.sol";
import {TickMath} from "../libraries/TickMath.sol";
import {ICLSwapPool, IUniswapV3SwapCallback} from "../protection/interfaces/ICLSwapPool.sol";
import {IAeroV2Pool} from "./interfaces/IAeroV2Pool.sol";

/// @title LocalPayoutRouter
/// @notice The local-money leg at the end of a Boundline borrow batch: the USDC a user just drew is swapped
///         into a local stablecoin (EURC, cNGN, …) on the pool the partner configured, with a slippage bound,
///         a deadline and an explicit session check, and paid to the user. The router holds nothing between
///         transactions, has no owner and no admin: every parameter comes from the caller, every output goes
///         to `to`, and any input a pool could not fill goes back to the caller in the same call.
///
///         Two pool shapes behind one entry point: an Aerodrome Slipstream (Uniswap v3 shape) pool through
///         the direct `swap` with the callback, the way the Protector sells collateral, and an Aerodrome v2
///         pool through `getAmountOut` and transfer-then-`swap`. Both recorded local-money pools on Base
///         mainnet (EURC/USDC, cNGN/ZARP) are Slipstream pools; the v2 path serves the others.
///
///         The session check is the gate's verdict on `gateToken` (the stock the user borrowed against): a
///         payout at the end of a borrow batch is in session by construction, because the draw itself was,
///         and the check makes that explicit on the sale leg as well, which is the plan's rule that any sale
///         waits for an open session and a fresh feed. `gateToken == 0` skips it (a repay-side or a partner's
///         own payout outside a borrow batch).
contract LocalPayoutRouter is IUniswapV3SwapCallback, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    enum PoolKind {
        CL, // Slipstream / Uniswap v3 shape: swap + callback
        V2 // Aerodrome v2 shape: getAmountOut + transfer-then-swap
    }

    struct PayoutParams {
        PoolKind kind;
        address pool;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;
        address to;
        uint256 deadline;
        address gateToken;
    }

    /// @notice One payout, kept per sender so a statement can list them without an indexer.
    struct Record {
        uint64 at;
        address tokenIn;
        address tokenOut;
        uint128 amountIn;
        uint128 amountOut;
        address pool;
        address to;
    }

    IPriceGate public immutable GATE;

    mapping(address sender => Record[]) private _records;

    // Call-scoped state for the Slipstream callback; transient, nothing survives the transaction.
    address private transient _activePool;
    address private transient _activeTokenIn;
    uint256 private transient _maxIn;

    event Payout(
        address indexed sender,
        address indexed to,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address pool
    );

    error ZeroAddress();
    error ZeroAmount();
    error Expired(uint256 deadline);
    error SessionClosed(IPriceGate.GateState state);
    error SlippageExceeded(uint256 amountOut, uint256 minOut);
    error PoolMismatch(address pool, address tokenIn, address tokenOut);
    error UnexpectedCallback(address caller);
    error NothingOwed();
    error Overpull(uint256 owed, uint256 maxIn);

    constructor(IPriceGate gate) {
        if (address(gate) == address(0)) revert ZeroAddress();
        GATE = gate;
    }

    // ---------------------------------------------------------------- payout

    /// @notice Pull `amountIn` of `tokenIn` from the caller, swap it on `pool`, pay at least `minOut` of
    ///         `tokenOut` to `to`. Reverts after `deadline`, and while the gate refuses `gateToken` when one
    ///         is given. Input the pool could not take is returned to the caller.
    function payout(PayoutParams calldata p) external nonReentrant returns (uint256 amountOut) {
        if (p.pool == address(0) || p.tokenIn == address(0) || p.tokenOut == address(0) || p.to == address(0)) {
            revert ZeroAddress();
        }
        if (p.amountIn == 0) revert ZeroAmount();
        if (block.timestamp > p.deadline) revert Expired(p.deadline);
        if (p.gateToken != address(0)) {
            IPriceGate.Verdict memory v = GATE.check(p.gateToken);
            if (v.state != IPriceGate.GateState.OPEN) revert SessionClosed(v.state);
        }

        // The pair is checked before any token moves, so a mis-set pool fails without pulling funds.
        bool inIsToken0 = _pairOf(p);
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), p.amountIn);
        uint256 spent;
        if (p.kind == PoolKind.CL) (spent, amountOut) = _swapCL(p, inIsToken0);
        else (spent, amountOut) = _swapV2(p, inIsToken0);
        if (amountOut < p.minOut) revert SlippageExceeded(amountOut, p.minOut);
        if (spent < p.amountIn) IERC20(p.tokenIn).safeTransfer(msg.sender, p.amountIn - spent);

        _records[msg.sender].push(
            Record({
                at: uint64(block.timestamp),
                tokenIn: p.tokenIn,
                tokenOut: p.tokenOut,
                amountIn: uint128(spent),
                amountOut: uint128(amountOut),
                pool: p.pool,
                to: p.to
            })
        );
        emit Payout(msg.sender, p.to, p.tokenIn, p.tokenOut, spent, amountOut, p.pool);
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address pool = _activePool;
        if (pool == address(0) || msg.sender != pool) revert UnexpectedCallback(msg.sender);
        bool inIsToken0 = abi.decode(data, (bool));
        int256 owed = inIsToken0 ? amount0Delta : amount1Delta;
        if (owed <= 0) revert NothingOwed();
        if (uint256(owed) > _maxIn) revert Overpull(uint256(owed), _maxIn);
        IERC20(_activeTokenIn).safeTransfer(pool, uint256(owed));
    }

    // ---------------------------------------------------------------- views

    function payoutCount(address sender) external view returns (uint256) {
        return _records[sender].length;
    }

    function payoutAt(address sender, uint256 index) external view returns (Record memory) {
        return _records[sender][index];
    }

    /// @notice Up to `limit` records from `offset`, oldest first.
    function payouts(address sender, uint256 offset, uint256 limit) external view returns (Record[] memory out) {
        Record[] storage all = _records[sender];
        if (offset >= all.length) return out;
        uint256 n = all.length - offset;
        if (n > limit) n = limit;
        out = new Record[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = all[offset + i];
        }
    }

    /// @notice What a v2 pool would pay right now; Slipstream pools are quoted off-chain from `slot0`.
    function quoteV2(address pool, address tokenIn, uint256 amountIn) external view returns (uint256) {
        return IAeroV2Pool(pool).getAmountOut(amountIn, tokenIn);
    }

    // ---------------------------------------------------------------- internals

    /// @dev True when `tokenIn` is the pool's token0 (and `tokenOut` its token1); reverts unless the pool holds
    ///      exactly this pair one way or the other. Both pool shapes expose `token0()`/`token1()`.
    function _pairOf(PayoutParams calldata p) internal view returns (bool inIsToken0) {
        address t0 = ICLSwapPool(p.pool).token0();
        address t1 = ICLSwapPool(p.pool).token1();
        if (p.tokenIn == t0 && p.tokenOut == t1) return true;
        if (p.tokenIn == t1 && p.tokenOut == t0) return false;
        revert PoolMismatch(p.pool, p.tokenIn, p.tokenOut);
    }

    function _swapCL(PayoutParams calldata p, bool zeroForOne) internal returns (uint256 spent, uint256 amountOut) {
        uint256 outBefore = IERC20(p.tokenOut).balanceOf(p.to);
        _activePool = p.pool;
        _activeTokenIn = p.tokenIn;
        _maxIn = p.amountIn;
        (int256 amount0, int256 amount1) = ICLSwapPool(p.pool).swap(
            p.to,
            zeroForOne,
            int256(p.amountIn),
            zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
            abi.encode(zeroForOne)
        );
        _activePool = address(0);
        _activeTokenIn = address(0);
        _maxIn = 0;
        int256 paid = zeroForOne ? amount0 : amount1;
        spent = paid > 0 ? uint256(paid) : 0;
        amountOut = IERC20(p.tokenOut).balanceOf(p.to) - outBefore;
    }

    function _swapV2(PayoutParams calldata p, bool inIsToken0) internal returns (uint256 spent, uint256 amountOut) {
        IAeroV2Pool pool = IAeroV2Pool(p.pool);
        uint256 quoted = pool.getAmountOut(p.amountIn, p.tokenIn);
        uint256 outBefore = IERC20(p.tokenOut).balanceOf(p.to);
        IERC20(p.tokenIn).safeTransfer(p.pool, p.amountIn);
        if (inIsToken0) pool.swap(0, quoted, p.to, "");
        else pool.swap(quoted, 0, p.to, "");
        spent = p.amountIn;
        amountOut = IERC20(p.tokenOut).balanceOf(p.to) - outBefore;
    }
}
