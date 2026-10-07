// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAdvanceSink} from "./IAdvanceSink.sol";

/// @title BoundlineReserve
/// @notice The capital side of protection: an ERC-4626 vault over USDC whose deposits fund the bounded
///         advances the protection vaults make on Saturdays (`ProtectionVault` on Aave V4,
///         `DeskProtectionVault` on the CreditDesk). The manager places idle USDC into registered sinks
///         (`allocate`), takes free liquidity back (`recall`) and pulls in the advance fees the sinks
///         earned (`harvest`), which is the vault's yield. Capital placed in a sink stays an asset of the
///         vault whether it sits idle there or is advanced and outstanding: an advance is bounded by the
///         distance from grace to LLTV on the collateral and settled in the next open session, so the
///         vault's risk is a Monday gap beyond that buffer, which the owner books with `writeDown`.
///
///         Two limits protect depositors from each other. The utilisation cap bounds what may be placed
///         in sinks against the vault's assets, so a share of the book is always idle. The cooldown makes
///         a redemption a two-step act: `requestRedeem` starts the clock, and `redeem`/`withdraw` honour
///         only shares requested at least `cooldownSeconds` ago, capped by the idle USDC on hand.
contract BoundlineReserve is ERC4626, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    struct RedeemRequest {
        uint192 shares;
        uint64 requestedAt;
    }

    uint256 public constant MAX_UTILISATION_BPS = 9000;
    uint256 internal constant BPS = 10_000;

    address public manager;
    uint64 public cooldownSeconds;
    uint16 public utilisationCapBps;
    /// @notice USDC placed in sinks and not yet recalled or written down; an asset of the vault.
    uint256 public totalAllocated;
    uint256 public totalWrittenDown;
    uint256 public totalHarvested;
    mapping(address => uint256) public allocated;
    mapping(address => bool) public isSink;
    address[] private _sinks;
    mapping(address => RedeemRequest) private _requests;

    event ManagerSet(address indexed manager);
    event CooldownSet(uint64 cooldownSeconds);
    event UtilisationCapSet(uint16 utilisationCapBps);
    event SinkAdded(address indexed sink);
    event SinkRemoved(address indexed sink);
    event Allocated(address indexed sink, uint256 amount, uint256 allocatedAfter);
    event Recalled(address indexed sink, uint256 amount, uint256 allocatedAfter);
    event Harvested(address indexed sink, uint256 amount);
    event WrittenDown(address indexed sink, uint256 amount, uint256 allocatedAfter);
    event RedeemRequested(address indexed owner, uint256 shares, uint64 requestedAt);
    event RedeemRequestCancelled(address indexed owner, uint256 shares);

    error ZeroAddress();
    error ZeroAmount();
    error NotManager();
    error UnknownSink(address sink);
    error SinkExists(address sink);
    error SinkStillAllocated(address sink, uint256 allocated);
    error NotAContract(address sink);
    error UtilisationCapTooHigh(uint16 utilisationCapBps);
    error InsufficientIdle(uint256 idle, uint256 requested);
    error UtilisationCapExceeded(uint256 allocatedAfter, uint256 cap);
    error RecallExceedsAllocation(uint256 allocated, uint256 requested);
    error WriteDownExceedsAllocation(uint256 allocated, uint256 requested);
    error InsufficientShares(uint256 balance, uint256 requested);
    error NoRedeemRequest(address owner);
    error RedeemNotMatured(uint256 maturesAt);
    error RedeemExceedsRequest(uint256 requested, uint256 shares);

    constructor(
        address initialOwner,
        IERC20 usdc,
        address initialManager,
        uint64 initialCooldownSeconds,
        uint16 initialUtilisationCapBps
    ) ERC20("Boundline Reserve USDC", "blUSDC") ERC4626(usdc) Ownable(initialOwner) {
        if (address(usdc) == address(0)) revert ZeroAddress();
        if (initialUtilisationCapBps > MAX_UTILISATION_BPS) revert UtilisationCapTooHigh(initialUtilisationCapBps);
        manager = initialManager;
        cooldownSeconds = initialCooldownSeconds;
        utilisationCapBps = initialUtilisationCapBps;
    }

    // ---------------------------------------------------------------- owner

    function setManager(address newManager) external onlyOwner {
        manager = newManager;
        emit ManagerSet(newManager);
    }

    function setCooldown(uint64 newCooldownSeconds) external onlyOwner {
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSet(newCooldownSeconds);
    }

    function setUtilisationCap(uint16 newUtilisationCapBps) external onlyOwner {
        if (newUtilisationCapBps > MAX_UTILISATION_BPS) revert UtilisationCapTooHigh(newUtilisationCapBps);
        utilisationCapBps = newUtilisationCapBps;
        emit UtilisationCapSet(newUtilisationCapBps);
    }

    function addSink(address sink) external onlyOwner {
        if (sink == address(0)) revert ZeroAddress();
        if (sink.code.length == 0) revert NotAContract(sink);
        if (isSink[sink]) revert SinkExists(sink);
        isSink[sink] = true;
        _sinks.push(sink);
        emit SinkAdded(sink);
    }

    /// @notice A sink can only be dropped once nothing of the vault's is placed in it.
    function removeSink(address sink) external onlyOwner {
        if (!isSink[sink]) revert UnknownSink(sink);
        if (allocated[sink] != 0) revert SinkStillAllocated(sink, allocated[sink]);
        isSink[sink] = false;
        uint256 n = _sinks.length;
        for (uint256 i = 0; i < n; ++i) {
            if (_sinks[i] == sink) {
                _sinks[i] = _sinks[n - 1];
                _sinks.pop();
                break;
            }
        }
        emit SinkRemoved(sink);
    }

    /// @notice Book a realised loss on a placement: an advance the sink could not recover. Only ever
    ///         lowers `allocated`, so the share price falls exactly by the loss and never by more.
    function writeDown(address sink, uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        uint256 a = allocated[sink];
        if (amount > a) revert WriteDownExceedsAllocation(a, amount);
        allocated[sink] = a - amount;
        totalAllocated -= amount;
        totalWrittenDown += amount;
        emit WrittenDown(sink, amount, a - amount);
    }

    // ---------------------------------------------------------------- manager

    modifier onlyManager() {
        if (msg.sender != manager && msg.sender != owner()) revert NotManager();
        _;
    }

    /// @notice Place idle USDC in a sink as advance liquidity, within the utilisation cap.
    function allocate(address sink, uint256 amount) external onlyManager nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!isSink[sink]) revert UnknownSink(sink);
        uint256 idle = idleAssets();
        if (amount > idle) revert InsufficientIdle(idle, amount);
        uint256 after_ = totalAllocated + amount;
        uint256 cap = Math.mulDiv(totalAssets(), utilisationCapBps, BPS);
        if (after_ > cap) revert UtilisationCapExceeded(after_, cap);
        allocated[sink] += amount;
        totalAllocated = after_;
        IERC20(asset()).forceApprove(sink, amount);
        IAdvanceSink(sink).fundAdvances(amount);
        IERC20(asset()).forceApprove(sink, 0);
        emit Allocated(sink, amount, allocated[sink]);
    }

    /// @notice Take free liquidity back from a sink (the sink refuses what is advanced and outstanding).
    function recall(address sink, uint256 amount) external onlyManager nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!isSink[sink]) revert UnknownSink(sink);
        uint256 a = allocated[sink];
        if (amount > a) revert RecallExceedsAllocation(a, amount);
        allocated[sink] = a - amount;
        totalAllocated -= amount;
        uint256 before = IERC20(asset()).balanceOf(address(this));
        IAdvanceSink(sink).defundAdvances(amount, address(this));
        if (IERC20(asset()).balanceOf(address(this)) - before != amount) revert InsufficientIdle(0, amount);
        emit Recalled(sink, amount, a - amount);
    }

    /// @notice Pull in the advance fees a sink collected: the vault's yield, raising the share price.
    function harvest(address sink) external onlyManager nonReentrant returns (uint256 amount) {
        if (!isSink[sink]) revert UnknownSink(sink);
        uint256 before = IERC20(asset()).balanceOf(address(this));
        IAdvanceSink(sink).collectFees(address(this));
        amount = IERC20(asset()).balanceOf(address(this)) - before;
        totalHarvested += amount;
        emit Harvested(sink, amount);
    }

    // ---------------------------------------------------------------- redemptions

    /// @notice Start the cooldown on `shares`. A new request replaces the old one and restarts the clock.
    function requestRedeem(uint256 shares) external {
        if (shares == 0) revert ZeroAmount();
        uint256 bal = balanceOf(msg.sender);
        if (shares > bal) revert InsufficientShares(bal, shares);
        _requests[msg.sender] = RedeemRequest(shares.toUint192(), uint64(block.timestamp));
        emit RedeemRequested(msg.sender, shares, uint64(block.timestamp));
    }

    function cancelRedeemRequest() external {
        RedeemRequest memory r = _requests[msg.sender];
        if (r.shares == 0) revert NoRedeemRequest(msg.sender);
        delete _requests[msg.sender];
        emit RedeemRequestCancelled(msg.sender, r.shares);
    }

    // ---------------------------------------------------------------- views

    /// @notice USDC on hand, the only money a redemption can be paid from.
    function idleAssets() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /// @notice Idle USDC plus everything placed in sinks, net of write-downs.
    function totalAssets() public view override returns (uint256) {
        return idleAssets() + totalAllocated;
    }

    function utilisationBps() external view returns (uint256) {
        uint256 total = totalAssets();
        return total == 0 ? 0 : Math.mulDiv(totalAllocated, BPS, total);
    }

    function sinks() external view returns (address[] memory) {
        return _sinks;
    }

    function redeemRequest(address owner) external view returns (RedeemRequest memory) {
        return _requests[owner];
    }

    /// @notice Shares whose cooldown has run, still held by `owner`.
    function maturedShares(address owner) public view returns (uint256) {
        RedeemRequest memory r = _requests[owner];
        if (r.shares == 0 || block.timestamp < uint256(r.requestedAt) + cooldownSeconds) return 0;
        return Math.min(uint256(r.shares), balanceOf(owner));
    }

    /// @notice Matured shares, capped by what the idle USDC can pay.
    function maxRedeem(address owner) public view override returns (uint256) {
        return Math.min(maturedShares(owner), _convertToShares(idleAssets(), Math.Rounding.Floor));
    }

    // ---------------------------------------------------------------- internals

    /// @dev Every redemption consumes the matured request; ERC-4626's `maxRedeem`/`maxWithdraw` checks run first.
    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        RedeemRequest storage r = _requests[owner];
        if (r.shares == 0) revert NoRedeemRequest(owner);
        uint256 maturesAt = uint256(r.requestedAt) + cooldownSeconds;
        if (block.timestamp < maturesAt) revert RedeemNotMatured(maturesAt);
        if (shares > r.shares) revert RedeemExceedsRequest(r.shares, shares);
        r.shares -= shares.toUint192();
        if (r.shares == 0) delete _requests[owner];
        super._withdraw(caller, receiver, owner, assets, shares);
    }
}
