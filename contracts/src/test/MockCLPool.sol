// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICLPool} from "../interfaces/ICLPool.sol";

/// @title MockCLPool
/// @notice Aerodrome Slipstream pool stand-in for unit tests: the owner-less setters script
///         `slot0` and the tick cumulatives `observe` returns, so a TWAP consumer can be
///         tested against exact averages, a missing observation and the real pool's `OLD`.
contract MockCLPool is ICLPool {
    error MissingObservation(uint32 secondsAgo);
    error OLD();

    address public immutable token0;
    address public immutable token1;
    int24 public immutable tickSpacing;

    uint160 private _sqrtPriceX96;
    int24 private _tick;
    uint16 private _observationCardinality = 1;
    uint128 private _liquidity;
    bool private _observeReverts;

    mapping(uint32 secondsAgo => int56 tickCumulative) private _cumulative;
    mapping(uint32 secondsAgo => bool set) private _hasCumulative;

    constructor(address token0_, address token1_, int24 tickSpacing_) {
        token0 = token0_;
        token1 = token1_;
        tickSpacing = tickSpacing_;
    }

    // ------------------------------------------------------------ setters (test only)

    function setSlot0(uint160 sqrtPriceX96, int24 tick) external {
        _sqrtPriceX96 = sqrtPriceX96;
        _tick = tick;
    }

    function setLiquidity(uint128 liquidity_) external {
        _liquidity = liquidity_;
    }

    function setObservationCardinality(uint16 cardinality) external {
        _observationCardinality = cardinality;
    }

    /// @notice Store the tick cumulative `observe` returns for `secondsAgo`.
    function setCumulative(uint32 secondsAgo, int56 tickCumulative) external {
        _cumulative[secondsAgo] = tickCumulative;
        _hasCumulative[secondsAgo] = true;
    }

    /// @notice Script a window whose time-weighted average tick is exactly `averageTick`:
    ///         cumulative 0 at `window` seconds ago and `averageTick * window` now.
    function setAverageTick(uint32 window, int24 averageTick) external {
        _cumulative[window] = 0;
        _hasCumulative[window] = true;
        _cumulative[0] = int56(averageTick) * int56(uint56(window));
        _hasCumulative[0] = true;
    }

    /// @notice Make `observe` revert `OLD()` like a pool whose history is too short.
    function setObserveReverts(bool reverts) external {
        _observeReverts = reverts;
    }

    // ------------------------------------------------------------ ICLPool

    function liquidity() external view returns (uint128) {
        return _liquidity;
    }

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            bool unlocked
        )
    {
        return (_sqrtPriceX96, _tick, 0, _observationCardinality, _observationCardinality, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        if (_observeReverts) revert OLD();
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; ++i) {
            uint32 secondsAgo = secondsAgos[i];
            if (!_hasCumulative[secondsAgo]) revert MissingObservation(secondsAgo);
            tickCumulatives[i] = _cumulative[secondsAgo];
        }
    }
}
