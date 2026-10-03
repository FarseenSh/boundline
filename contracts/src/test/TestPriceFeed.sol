// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";

/// @title TestPriceFeed
/// @notice Chainlink-shaped feed simulator for Base Sepolia and unit tests. The owner sets
///         the answer and can backdate or post-date `updatedAt`, which is how the weekend
///         freeze, a stale feed and a future-stamped round are reproduced on demand.
contract TestPriceFeed is IAggregatorV3, Ownable {
    /// @dev Chainlink aggregator event shape, so indexers written against real feeds work here.
    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    error NoData();

    uint8 private immutable _decimals;
    string private _description;

    uint80 private _roundId;
    int256 private _answer;
    uint256 private _startedAt;
    uint256 private _updatedAt;
    uint80 private _answeredInRound;

    constructor(address initialOwner, uint8 decimals_, string memory description_, int256 initialAnswer)
        Ownable(initialOwner)
    {
        _decimals = decimals_;
        _description = description_;
        _store(1, initialAnswer, block.timestamp, block.timestamp, 1);
    }

    // ------------------------------------------------------------ owner

    /// @notice New round at the current block time.
    function setAnswer(int256 answer) external onlyOwner {
        uint80 next = _roundId + 1;
        _store(next, answer, block.timestamp, block.timestamp, next);
    }

    /// @notice New round with an explicit `updatedAt`, in the past or the future.
    function setAnswerAt(int256 answer, uint256 updatedAt) external onlyOwner {
        uint80 next = _roundId + 1;
        _store(next, answer, updatedAt, updatedAt, next);
    }

    /// @notice Raw round write for edge cases (answeredInRound < roundId, zero timestamps).
    function setRoundData(uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
        external
        onlyOwner
    {
        _store(roundId, answer, startedAt, updatedAt, answeredInRound);
    }

    // ------------------------------------------------------------ views

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (_roundId, _answer, _startedAt, _updatedAt, _answeredInRound);
    }

    /// @notice Only the latest round is retained; any other id reverts `NoData`.
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        if (roundId != _roundId) revert NoData();
        return (_roundId, _answer, _startedAt, _updatedAt, _answeredInRound);
    }

    // ------------------------------------------------------------ internal

    function _store(uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
        internal
    {
        _roundId = roundId;
        _answer = answer;
        _startedAt = startedAt;
        _updatedAt = updatedAt;
        _answeredInRound = answeredInRound;
        emit AnswerUpdated(answer, roundId, updatedAt);
    }
}
