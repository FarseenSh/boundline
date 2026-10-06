// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAaveSpoke, ITakerPositionManager} from "../../../src/aave/interfaces/IAaveV4.sol";

/// @notice The Taker as deployed on Base, minus intents: allowances per (spoke, reserve, owner, spender),
///         consumed unless infinite; `borrowOnBehalfOf` and `withdrawOnBehalfOf` call the spoke and pay
///         the caller. The spoke must list the Taker as an active manager approved by the user.
contract MockTaker {
    using SafeERC20 for IERC20;

    mapping(address => bool) public registered;
    mapping(address => mapping(uint256 => mapping(address => mapping(address => uint256)))) internal _borrow;
    mapping(address => mapping(uint256 => mapping(address => mapping(address => uint256)))) internal _withdraw;

    error SpokeNotRegistered();
    error InsufficientWithdrawAllowance(uint256 allowance, uint256 required);
    error InsufficientBorrowAllowance(uint256 allowance, uint256 required);
    error Unsupported();

    event BorrowApproval(
        address indexed spoke, uint256 indexed reserveId, address indexed owner, address spender, uint256 amount
    );
    event WithdrawApproval(
        address indexed spoke, uint256 indexed reserveId, address indexed owner, address spender, uint256 amount
    );

    modifier onlyRegisteredSpoke(address spoke) {
        if (!registered[spoke]) revert SpokeNotRegistered();
        _;
    }

    function registerSpoke(address spoke, bool on) external {
        registered[spoke] = on;
    }

    function isSpokeRegistered(address spoke) external view returns (bool) {
        return registered[spoke];
    }

    function approveBorrow(address spoke, uint256 reserveId, address spender, uint256 amount)
        external
        onlyRegisteredSpoke(spoke)
    {
        _borrow[spoke][reserveId][msg.sender][spender] = amount;
        emit BorrowApproval(spoke, reserveId, msg.sender, spender, amount);
    }

    function approveWithdraw(address spoke, uint256 reserveId, address spender, uint256 amount)
        external
        onlyRegisteredSpoke(spoke)
    {
        _withdraw[spoke][reserveId][msg.sender][spender] = amount;
        emit WithdrawApproval(spoke, reserveId, msg.sender, spender, amount);
    }

    function approveBorrowWithSig(ITakerPositionManager.BorrowPermit calldata, bytes calldata) external pure {
        revert Unsupported();
    }

    function approveWithdrawWithSig(ITakerPositionManager.WithdrawPermit calldata, bytes calldata) external pure {
        revert Unsupported();
    }

    function borrowOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        onlyRegisteredSpoke(spoke)
        returns (uint256, uint256)
    {
        uint256 allowance = _borrow[spoke][reserveId][onBehalfOf][msg.sender];
        if (allowance < amount) revert InsufficientBorrowAllowance(allowance, amount);
        IERC20 underlying = IERC20(IAaveSpoke(spoke).getReserve(reserveId).underlying);
        (uint256 shares, uint256 borrowed) = IAaveSpoke(spoke).borrow(reserveId, amount, onBehalfOf);
        if (allowance != type(uint256).max) _borrow[spoke][reserveId][onBehalfOf][msg.sender] = allowance - borrowed;
        underlying.safeTransfer(msg.sender, borrowed);
        return (shares, borrowed);
    }

    function withdrawOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        onlyRegisteredSpoke(spoke)
        returns (uint256, uint256)
    {
        uint256 allowance = _withdraw[spoke][reserveId][onBehalfOf][msg.sender];
        if (allowance < amount) revert InsufficientWithdrawAllowance(allowance, amount);
        IERC20 underlying = IERC20(IAaveSpoke(spoke).getReserve(reserveId).underlying);
        (uint256 shares, uint256 withdrawn) = IAaveSpoke(spoke).withdraw(reserveId, amount, onBehalfOf);
        if (allowance != type(uint256).max) {
            _withdraw[spoke][reserveId][onBehalfOf][msg.sender] =
                allowance - (withdrawn > allowance ? allowance : withdrawn);
        }
        underlying.safeTransfer(msg.sender, withdrawn);
        return (shares, withdrawn);
    }

    function borrowAllowance(address spoke, uint256 reserveId, address owner, address spender)
        external
        view
        returns (uint256)
    {
        return _borrow[spoke][reserveId][owner][spender];
    }

    function withdrawAllowance(address spoke, uint256 reserveId, address owner, address spender)
        external
        view
        returns (uint256)
    {
        return _withdraw[spoke][reserveId][owner][spender];
    }

    function nonces(address, uint192) external pure returns (uint256) {
        return 0;
    }

    function DOMAIN_SEPARATOR() external pure returns (bytes32) {
        return bytes32(0);
    }

    function BORROW_PERMIT_TYPEHASH() external pure returns (bytes32) {
        return 0x14236ea048da65ffb52a9b32a2c840f24ab374cc31f65faeb7877d22ceca144e;
    }

    function WITHDRAW_PERMIT_TYPEHASH() external pure returns (bytes32) {
        return 0x9e6642fd4c06a4c1a5e201f1e41c6b7892fcf06859c796b054c510b80e2a0a3f;
    }
}

/// @notice The Giver as deployed on Base: pulls the asset from the caller, caps a repay at the user's
///         debt, refuses `type(uint256).max`, and supplies or repays on the spoke for the user.
contract MockGiver {
    using SafeERC20 for IERC20;

    mapping(address => bool) public registered;

    error SpokeNotRegistered();
    error RepayOnBehalfMaxUintNotAllowed();

    event RepayOnBehalfOf(
        address indexed spoke,
        address indexed caller,
        address indexed onBehalfOf,
        uint256 reserveId,
        uint256 repaidShares,
        uint256 repaidAmount
    );

    modifier onlyRegisteredSpoke(address spoke) {
        if (!registered[spoke]) revert SpokeNotRegistered();
        _;
    }

    function registerSpoke(address spoke, bool on) external {
        registered[spoke] = on;
    }

    function isSpokeRegistered(address spoke) external view returns (bool) {
        return registered[spoke];
    }

    function supplyOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        onlyRegisteredSpoke(spoke)
        returns (uint256, uint256)
    {
        IERC20 underlying = IERC20(IAaveSpoke(spoke).getReserve(reserveId).underlying);
        underlying.safeTransferFrom(msg.sender, address(this), amount);
        underlying.forceApprove(spoke, amount);
        return IAaveSpoke(spoke).supply(reserveId, amount, onBehalfOf);
    }

    function repayOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        onlyRegisteredSpoke(spoke)
        returns (uint256, uint256)
    {
        if (amount == type(uint256).max) revert RepayOnBehalfMaxUintNotAllowed();
        IERC20 underlying = IERC20(IAaveSpoke(spoke).getReserve(reserveId).underlying);
        uint256 owed = IAaveSpoke(spoke).getUserTotalDebt(reserveId, onBehalfOf);
        uint256 pay = amount > owed ? owed : amount;
        underlying.safeTransferFrom(msg.sender, address(this), pay);
        underlying.forceApprove(spoke, pay);
        (uint256 shares, uint256 repaid) = IAaveSpoke(spoke).repay(reserveId, pay, onBehalfOf);
        emit RepayOnBehalfOf(spoke, msg.sender, onBehalfOf, reserveId, shares, repaid);
        return (shares, repaid);
    }
}
