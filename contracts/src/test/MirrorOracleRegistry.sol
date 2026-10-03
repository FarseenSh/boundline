// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IOracleRegistry} from "../interfaces/IOracleRegistry.sol";

/// @title MirrorOracleRegistry
/// @notice Base Sepolia stand-in for Coinbase's mainnet OracleRegistry, with the same
///         `getOracleParams(token) -> (multiplier, paused)` read. A token that was never
///         configured answers (1e18, false), i.e. unpaused at a 1.0 multiplier, so the
///         default state matches every live Coinbase token today.
contract MirrorOracleRegistry is IOracleRegistry, Ownable {
    struct Params {
        uint256 multiplier;
        bool paused;
        bool configured;
    }

    uint256 public constant DEFAULT_MULTIPLIER = 1e18;

    mapping(address token => Params) private _params;

    event OraclePausedSet(address indexed token, bool paused);
    event MultiplierSet(address indexed token, uint256 multiplier);

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ------------------------------------------------------------ owner

    function setOracleParams(address token, uint256 multiplier, bool paused) external onlyOwner {
        _params[token] = Params({multiplier: multiplier, paused: paused, configured: true});
        emit MultiplierSet(token, multiplier);
        emit OraclePausedSet(token, paused);
    }

    function setPaused(address token, bool paused) external onlyOwner {
        Params storage p = _ensure(token);
        p.paused = paused;
        emit OraclePausedSet(token, paused);
    }

    function setMultiplier(address token, uint256 multiplier) external onlyOwner {
        Params storage p = _ensure(token);
        p.multiplier = multiplier;
        emit MultiplierSet(token, multiplier);
    }

    // ------------------------------------------------------------ views

    function getOracleParams(address token) external view returns (uint256 multiplier, bool paused) {
        Params memory p = _params[token];
        if (!p.configured) return (DEFAULT_MULTIPLIER, false);
        return (p.multiplier, p.paused);
    }

    function isConfigured(address token) external view returns (bool) {
        return _params[token].configured;
    }

    // ------------------------------------------------------------ internal

    function _ensure(address token) internal returns (Params storage p) {
        p = _params[token];
        if (!p.configured) {
            p.multiplier = DEFAULT_MULTIPLIER;
            p.configured = true;
        }
    }
}
