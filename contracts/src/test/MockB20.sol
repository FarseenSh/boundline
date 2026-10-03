// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IB20} from "base-std/interfaces/IB20.sol";

/// @title MockB20
/// @notice Minimal ERC20-like stand-in for a Coinbase B20 asset in unit tests. Not a B20 and
///         not backed by the precompiles: it only reproduces the surface Boundline's gates read
///         (`isPaused(TRANSFER)`, `pausedFeatures`, the ERC-8056 multiplier getters) and
///         refuses transfers while TRANSFER is paused, as the real token does.
contract MockB20 {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event PauseSet(IB20.PausableFeature indexed feature, bool paused);
    event UIMultiplierSet(uint256 current, uint256 next, uint256 effectiveAt);

    error TransferPaused();
    error InsufficientBalance(address from, uint256 balance, uint256 needed);
    error InsufficientAllowance(address spender, uint256 allowance, uint256 needed);

    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;

    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    mapping(IB20.PausableFeature feature => bool paused) private _paused;

    uint256 private _uiMultiplier = 1e18;
    uint256 private _newUIMultiplier = 1e18;
    uint256 private _effectiveAt;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    // ------------------------------------------------------------ supply (test token: open)

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    // ------------------------------------------------------------ ERC20

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance(msg.sender, allowed, amount);
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    // ------------------------------------------------------------ pause surface

    function setPaused(IB20.PausableFeature feature, bool paused) external {
        _paused[feature] = paused;
        emit PauseSet(feature, paused);
    }

    function isPaused(IB20.PausableFeature feature) external view returns (bool) {
        return _paused[feature];
    }

    function pausedFeatures() external view returns (IB20.PausableFeature[] memory features) {
        uint256 count;
        for (uint8 i = 0; i < 4; ++i) {
            if (_paused[IB20.PausableFeature(i)]) ++count;
        }
        features = new IB20.PausableFeature[](count);
        uint256 j;
        for (uint8 i = 0; i < 4; ++i) {
            if (_paused[IB20.PausableFeature(i)]) features[j++] = IB20.PausableFeature(i);
        }
    }

    // ------------------------------------------------------------ ERC-8056 multiplier surface

    function uiMultiplier() external view returns (uint256) {
        return _uiMultiplier;
    }

    function newUIMultiplier() external view returns (uint256) {
        return _newUIMultiplier;
    }

    function effectiveAt() external view returns (uint256) {
        return _effectiveAt;
    }

    function setUIMultiplier(uint256 current, uint256 next, uint256 effectiveAt_) external {
        _uiMultiplier = current;
        _newUIMultiplier = next;
        _effectiveAt = effectiveAt_;
        emit UIMultiplierSet(current, next, effectiveAt_);
    }

    // ------------------------------------------------------------ internal

    function _transfer(address from, address to, uint256 amount) internal {
        if (_paused[IB20.PausableFeature.TRANSFER]) revert TransferPaused();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance(from, balance, amount);
        balanceOf[from] = balance - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
