// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAaveSpoke, IAaveHub, IAavePriceOracle} from "../../../src/aave/interfaces/IAaveV4.sol";

/// @notice A small Aave V4 spoke for unit tests: reserves with a collateral factor, a price and
///         pause/frozen/borrowable flags; per-user supplied assets and debt (no interest unless
///         `accrue` is called); the position-manager rule of the real spoke (`msg.sender == onBehalfOf`
///         or an active manager the user approved); a health-factor check after borrow and withdraw;
///         and the account data shape the desk reads. It is also its own `IPriceOracle` and its own hub:
///         `getReserve` names this contract as the hub with asset id = reserve id, `getSpokeConfig` answers the
///         hub's `SpokeConfig` (active, halted), and supply, withdraw, borrow and repay refuse while the asset is
///         halted or inactive, as `Hub._validateAdd/_validateRemove/_validateDraw/_validateRestore` do.
///         Value units follow Aave: prices and `totalCollateralValue` have 8 decimals, debt value is RAY.
contract MockAaveSpoke is IAavePriceOracle {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAY = 1e27;

    struct R {
        address underlying;
        uint8 decimals;
        uint16 collateralFactorBps;
        bool borrowable;
        bool paused;
        bool frozen;
        uint256 price8;
        uint256 totalSupplied;
        uint256 totalDebt;
    }

    R[] internal _reserves;
    mapping(uint256 => mapping(address => uint256)) public supplied;
    mapping(uint256 => mapping(address => uint256)) public debt;
    mapping(address => mapping(uint256 => bool)) public collateralEnabled;
    mapping(address => bool) public managerActive;
    mapping(address => mapping(address => bool)) public managerApproved; // manager => user => approved
    // The hub face: per asset (= reserve id here), Aave's halt switch and the spoke's activation.
    mapping(uint256 => bool) public hubHalted;
    mapping(uint256 => bool) public hubInactive;
    bool public hubUnreadable; // getSpokeConfig reverts, as an upgraded or misconfigured hub might

    error HealthFactorBelowThreshold();
    error ReserveNotBorrowable();
    error ReservePaused();
    error ReserveFrozen();
    error Unauthorized();
    error Unsupported();
    error SpokeNotActive();
    error SpokeHalted();

    event SetUserPositionManager(address indexed user, address indexed positionManager, bool approve);
    event Borrow(
        uint256 indexed reserveId,
        address indexed caller,
        address indexed user,
        uint256 drawnShares,
        uint256 drawnAmount
    );

    // ------------------------------------------------------------ test knobs

    function addReserve(address underlying, uint8 decimals, uint16 collateralFactorBps, bool borrowable, uint256 price8)
        external
        returns (uint256 id)
    {
        _reserves.push(R(underlying, decimals, collateralFactorBps, borrowable, false, false, price8, 0, 0));
        return _reserves.length - 1;
    }

    function setPrice(uint256 reserveId, uint256 price8) external {
        _reserves[reserveId].price8 = price8;
    }

    function setFlags(uint256 reserveId, bool paused, bool frozen, bool borrowable) external {
        R storage r = _reserves[reserveId];
        r.paused = paused;
        r.frozen = frozen;
        r.borrowable = borrowable;
    }

    function setCollateralFactor(uint256 reserveId, uint16 bps) external {
        _reserves[reserveId].collateralFactorBps = bps;
    }

    /// @dev The hub's halt switch for an asset (the 24 Sep 2026 kind), and the spoke's activation on the hub.
    function setHubHalted(uint256 assetId, bool halted) external {
        hubHalted[assetId] = halted;
    }

    function setHubActive(uint256 assetId, bool active) external {
        hubInactive[assetId] = !active;
    }

    function setHubUnreadable(bool value) external {
        hubUnreadable = value;
    }

    /// @dev Simulates interest: adds `amount` of debt to the user without any transfer.
    function accrue(uint256 reserveId, address user, uint256 amount) external {
        debt[reserveId][user] += amount;
        _reserves[reserveId].totalDebt += amount;
    }

    function updatePositionManager(address manager, bool active) external {
        managerActive[manager] = active;
    }

    // ------------------------------------------------------------ user actions

    modifier onlyPositionManager(address onBehalfOf) {
        if (msg.sender != onBehalfOf && !_isPositionManager(onBehalfOf, msg.sender)) revert Unauthorized();
        _;
    }

    function supply(uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        onlyPositionManager(onBehalfOf)
        returns (uint256, uint256)
    {
        R storage r = _reserves[reserveId];
        _requireHubLive(reserveId);
        if (r.paused) revert ReservePaused();
        if (r.frozen) revert ReserveFrozen();
        IERC20(r.underlying).safeTransferFrom(msg.sender, address(this), amount);
        supplied[reserveId][onBehalfOf] += amount;
        r.totalSupplied += amount;
        if (r.collateralFactorBps != 0) collateralEnabled[onBehalfOf][reserveId] = true;
        return (amount, amount);
    }

    function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        onlyPositionManager(onBehalfOf)
        returns (uint256, uint256)
    {
        R storage r = _reserves[reserveId];
        _requireHubLive(reserveId);
        if (r.paused) revert ReservePaused();
        uint256 have = supplied[reserveId][onBehalfOf];
        uint256 out = amount > have ? have : amount;
        supplied[reserveId][onBehalfOf] = have - out;
        r.totalSupplied -= out;
        IERC20(r.underlying).safeTransfer(msg.sender, out);
        _requireHealthy(onBehalfOf);
        return (out, out);
    }

    function borrow(uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        onlyPositionManager(onBehalfOf)
        returns (uint256, uint256)
    {
        R storage r = _reserves[reserveId];
        _requireHubLive(reserveId);
        if (r.paused) revert ReservePaused();
        if (r.frozen) revert ReserveFrozen();
        if (!r.borrowable) revert ReserveNotBorrowable();
        debt[reserveId][onBehalfOf] += amount;
        r.totalDebt += amount;
        IERC20(r.underlying).safeTransfer(msg.sender, amount);
        _requireHealthy(onBehalfOf);
        emit Borrow(reserveId, msg.sender, onBehalfOf, amount, amount);
        return (amount, amount);
    }

    function repay(uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        onlyPositionManager(onBehalfOf)
        returns (uint256, uint256)
    {
        R storage r = _reserves[reserveId];
        _requireHubLive(reserveId);
        if (r.paused) revert ReservePaused();
        uint256 owed = debt[reserveId][onBehalfOf];
        uint256 pay = amount > owed ? owed : amount;
        IERC20(r.underlying).safeTransferFrom(msg.sender, address(this), pay);
        debt[reserveId][onBehalfOf] = owed - pay;
        r.totalDebt -= pay;
        return (pay, pay);
    }

    function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf)
        external
        onlyPositionManager(onBehalfOf)
    {
        collateralEnabled[onBehalfOf][reserveId] = usingAsCollateral;
        _requireHealthy(onBehalfOf);
    }

    function setUserPositionManager(address positionManager, bool approve) external {
        managerApproved[positionManager][msg.sender] = approve;
        emit SetUserPositionManager(msg.sender, positionManager, approve);
    }

    function setUserPositionManagersWithSig(IAaveSpoke.SetUserPositionManagers calldata, bytes calldata) external pure {
        revert Unsupported();
    }

    function renouncePositionManagerRole(address user) external {
        managerApproved[msg.sender][user] = false;
    }

    // ------------------------------------------------------------ views

    function getReserveCount() external view returns (uint256) {
        return _reserves.length;
    }

    function getReserve(uint256 reserveId) external view returns (IAaveSpoke.Reserve memory) {
        R storage r = _reserves[reserveId];
        return IAaveSpoke.Reserve(r.underlying, address(this), uint16(reserveId), r.decimals, 0, 0, 0);
    }

    function getReserveConfig(uint256 reserveId) external view returns (IAaveSpoke.ReserveConfig memory) {
        R storage r = _reserves[reserveId];
        return IAaveSpoke.ReserveConfig(0, r.paused, r.frozen, r.borrowable, true);
    }

    function getDynamicReserveConfig(uint256 reserveId, uint32)
        external
        view
        returns (IAaveSpoke.DynamicReserveConfig memory)
    {
        return IAaveSpoke.DynamicReserveConfig(_reserves[reserveId].collateralFactorBps, 10_550, 1000);
    }

    function getReserveTotalDebt(uint256 reserveId) external view returns (uint256) {
        return _reserves[reserveId].totalDebt;
    }

    function getReserveSuppliedAssets(uint256 reserveId) external view returns (uint256) {
        return _reserves[reserveId].totalSupplied;
    }

    function getUserReserveStatus(uint256 reserveId, address user) external view returns (bool, bool) {
        return (collateralEnabled[user][reserveId], debt[reserveId][user] != 0);
    }

    function getUserSuppliedAssets(uint256 reserveId, address user) external view returns (uint256) {
        return supplied[reserveId][user];
    }

    function getUserTotalDebt(uint256 reserveId, address user) external view returns (uint256) {
        return debt[reserveId][user];
    }

    function getUserPosition(uint256 reserveId, address user) external view returns (IAaveSpoke.UserPosition memory) {
        return IAaveSpoke.UserPosition(uint120(debt[reserveId][user]), 0, 0, uint120(supplied[reserveId][user]), 0);
    }

    function getUserAccountData(address user) public view returns (IAaveSpoke.UserAccountData memory d) {
        uint256 weighted; // Σ value_i × cf_i (WAD)
        for (uint256 i = 0; i < _reserves.length; ++i) {
            R storage r = _reserves[i];
            uint256 s = supplied[i][user];
            if (s != 0 && collateralEnabled[user][i] && r.collateralFactorBps != 0) {
                uint256 value = s * r.price8 / 10 ** r.decimals;
                d.totalCollateralValue += value;
                weighted += value * uint256(r.collateralFactorBps) * 1e14;
                d.activeCollateralCount += 1;
            }
            uint256 b = debt[i][user];
            if (b != 0) {
                d.totalDebtValueRay += b * r.price8 * RAY / 10 ** r.decimals;
                d.borrowCount += 1;
            }
        }
        d.avgCollateralFactor = d.totalCollateralValue == 0 ? 0 : weighted / d.totalCollateralValue;
        d.healthFactor = d.totalDebtValueRay == 0 ? type(uint256).max : weighted * RAY / d.totalDebtValueRay;
    }

    function isPositionManagerActive(address positionManager) external view returns (bool) {
        return managerActive[positionManager];
    }

    function isPositionManager(address user, address positionManager) external view returns (bool) {
        return _isPositionManager(user, positionManager);
    }

    function nonces(address, uint192) external pure returns (uint256) {
        return 0;
    }

    function DOMAIN_SEPARATOR() external pure returns (bytes32) {
        return bytes32(0);
    }

    function SET_USER_POSITION_MANAGERS_TYPEHASH() external pure returns (bytes32) {
        return 0xba01f7bf3d3674c63670ec4a78b0d56aac1ad6e8c84468920b9e61bfe0b9851a;
    }

    function ORACLE() external view returns (address) {
        return address(this);
    }

    // IPriceOracle face
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function getReservePrice(uint256 reserveId) external view returns (uint256) {
        return _reserves[reserveId].price8;
    }

    // IHub face
    function getSpokeConfig(uint256 assetId, address) external view returns (IAaveHub.SpokeConfig memory) {
        if (hubUnreadable) revert Unsupported();
        return IAaveHub.SpokeConfig(type(uint40).max, type(uint40).max, 0, !hubInactive[assetId], hubHalted[assetId]);
    }

    // ------------------------------------------------------------ internals

    function _requireHubLive(uint256 assetId) internal view {
        if (hubInactive[assetId]) revert SpokeNotActive();
        if (hubHalted[assetId]) revert SpokeHalted();
    }

    function _isPositionManager(address user, address manager) internal view returns (bool) {
        return managerActive[manager] && managerApproved[manager][user];
    }

    function _requireHealthy(address user) internal view {
        IAaveSpoke.UserAccountData memory d = getUserAccountData(user);
        if (d.totalDebtValueRay != 0 && d.healthFactor < WAD) revert HealthFactorBelowThreshold();
    }
}
