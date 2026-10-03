// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {ICLPool} from "../interfaces/ICLPool.sol";
import {IPriceGate} from "../interfaces/IPriceGate.sol";
import {TickMath} from "../libraries/TickMath.sol";
import {SessionGate} from "./SessionGate.sol";

/// @title ShadowGuard
/// @notice The pre-liquidation oracle. In session it returns the fresh Chainlink price; while the
///         feed is held (weekend, holiday, or a stale feed) it returns the Aerodrome Slipstream
///         time-weighted average price less a haircut, so a gentle, partial pre-liquidation can
///         run on Saturday at the price the market actually shows instead of waiting for the
///         Sunday 20:00 ET reopen when the position has already gapped through LLTV.
///
///         ShadowGuard is never a market oracle: no draw is ever priced on it. It refuses when the
///         issuer has paused the token or its feed, when the feed is invalid, or when the DEX
///         price has moved further from the last feed value than `maxDeviationBps` allows.
///
/// @dev Price scale is Morpho's: loan raw units per collateral raw unit, times 1e36. The pool
///      prices raw units directly, so the TWAP path needs no decimals adjustment; the feed path
///      uses the same scale as SessionGuard.
contract ShadowGuard is IOracle, Ownable2Step {
    enum Source {
        FEED,
        TWAP
    }

    SessionGate public immutable GATE;
    address public immutable COLLATERAL;
    address public immutable LOAN_TOKEN;
    uint256 public immutable SCALE;
    ICLPool public immutable POOL;
    bool public immutable COLLATERAL_IS_TOKEN1;
    uint32 public immutable TWAP_WINDOW;

    uint16 public constant MAX_HAIRCUT_BPS = 1000;
    uint16 public constant MIN_DEVIATION_BPS = 1000;
    uint16 public constant MAX_DEVIATION_BPS = 5000;
    uint32 public constant MIN_TWAP_WINDOW = 5 minutes;
    uint32 public constant MAX_TWAP_WINDOW = 1 days;

    /// @notice Haircut applied to the TWAP path, in bps. Default 200.
    uint16 public haircutBps;
    /// @notice Largest allowed distance between the TWAP and the last feed value, in bps. Default 3000.
    uint16 public maxDeviationBps;

    event HaircutSet(uint16 bps);
    event MaxDeviationSet(uint16 bps);

    error ZeroAddress();
    error PoolMismatch(address token0, address token1);
    error BadWindow(uint32 window);
    error HaircutTooLarge(uint16 bps);
    error DeviationOutOfRange(uint16 bps);
    error ScaleUnderflow();
    error ShadowUnavailable(IPriceGate.GateState state, bool registryPaused, bool transferPaused);
    error ShadowDeviation(uint256 twap36, uint256 feed36, uint16 maxDeviationBps);

    constructor(
        address initialOwner,
        SessionGate gate,
        address collateral,
        uint8 collateralDecimals,
        address loanToken,
        uint8 loanDecimals,
        ICLPool pool,
        uint32 twapWindow
    ) Ownable(initialOwner) {
        if (address(gate) == address(0) || collateral == address(0) || loanToken == address(0)) {
            revert ZeroAddress();
        }
        if (address(pool) == address(0)) revert ZeroAddress();
        if (twapWindow < MIN_TWAP_WINDOW || twapWindow > MAX_TWAP_WINDOW) revert BadWindow(twapWindow);
        if (36 + uint256(loanDecimals) < 8 + uint256(collateralDecimals)) revert ScaleUnderflow();

        address t0 = pool.token0();
        address t1 = pool.token1();
        if (t0 == loanToken && t1 == collateral) {
            COLLATERAL_IS_TOKEN1 = true;
        } else if (t0 == collateral && t1 == loanToken) {
            COLLATERAL_IS_TOKEN1 = false;
        } else {
            revert PoolMismatch(t0, t1);
        }

        GATE = gate;
        COLLATERAL = collateral;
        LOAN_TOKEN = loanToken;
        SCALE = 10 ** (36 + uint256(loanDecimals) - 8 - uint256(collateralDecimals));
        POOL = pool;
        TWAP_WINDOW = twapWindow;
        haircutBps = 200;
        maxDeviationBps = 3000;
    }

    // ---------------------------------------------------------------- owner

    function setHaircut(uint16 bps) external onlyOwner {
        if (bps > MAX_HAIRCUT_BPS) revert HaircutTooLarge(bps);
        haircutBps = bps;
        emit HaircutSet(bps);
    }

    function setMaxDeviation(uint16 bps) external onlyOwner {
        if (bps < MIN_DEVIATION_BPS || bps > MAX_DEVIATION_BPS) revert DeviationOutOfRange(bps);
        maxDeviationBps = bps;
        emit MaxDeviationSet(bps);
    }

    // ---------------------------------------------------------------- oracle

    /// @inheritdoc IOracle
    function price() external view returns (uint256) {
        (uint256 p,,) = shadowPrice();
        return p;
    }

    /// @notice The price `price()` would return, where it came from, and the gate's verdict.
    ///         Reverts for the same reasons `price()` does.
    function shadowPrice() public view returns (uint256 price36, Source source, IPriceGate.Verdict memory v) {
        v = GATE.check(COLLATERAL);
        if (v.state == IPriceGate.GateState.OPEN) {
            return (uint256(v.answer) * SCALE, Source.FEED, v);
        }
        bool heldFeed = v.state == IPriceGate.GateState.MARKET_CLOSED || v.state == IPriceGate.GateState.FEED_STALE;
        if (!heldFeed || v.registryPaused || v.transferPaused || v.answer <= 0) {
            revert ShadowUnavailable(v.state, v.registryPaused, v.transferPaused);
        }
        uint256 twap36 = twapPrice36();
        uint256 feed36 = uint256(v.answer) * SCALE;
        uint256 distance = twap36 > feed36 ? twap36 - feed36 : feed36 - twap36;
        if (distance * 10_000 > feed36 * uint256(maxDeviationBps)) {
            revert ShadowDeviation(twap36, feed36, maxDeviationBps);
        }
        price36 = (twap36 * (10_000 - uint256(haircutBps))) / 10_000;
        source = Source.TWAP;
    }

    /// @notice Raw `TWAP_WINDOW` time-weighted average price from the pool, Morpho-scaled, no haircut.
    function twapPrice36() public view returns (uint256) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = TWAP_WINDOW;
        secondsAgos[1] = 0;
        (int56[] memory cumulatives,) = POOL.observe(secondsAgos);
        int56 delta = cumulatives[1] - cumulatives[0];
        int56 window = int56(uint56(TWAP_WINDOW));
        int24 averageTick = int24(delta / window);
        if (delta < 0 && delta % window != 0) averageTick--; // round toward negative infinity
        return _priceFromTick(averageTick);
    }

    /// @dev Quote 1e36 raw units of collateral in raw units of loan token at `tick`, following
    ///      Uniswap's OracleLibrary.getQuoteAtTick arithmetic.
    function _priceFromTick(int24 tick) internal view returns (uint256) {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            return
                COLLATERAL_IS_TOKEN1 ? Math.mulDiv(1 << 192, 1e36, ratioX192) : Math.mulDiv(ratioX192, 1e36, 1 << 192);
        }
        uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
        return COLLATERAL_IS_TOKEN1 ? Math.mulDiv(1 << 128, 1e36, ratioX128) : Math.mulDiv(ratioX128, 1e36, 1 << 128);
    }
}
