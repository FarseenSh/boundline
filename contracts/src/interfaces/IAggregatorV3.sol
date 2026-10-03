// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Chainlink AggregatorV3 read surface. The Coinbase tokenized-stock feeds
///         on Base expose this through their proxies (8 decimals, total-return).
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
