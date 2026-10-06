// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The subset of Aave V4 (aave/aave-v4 v0.5.11) that Boundline calls, copied signature for
///         signature from `src/spoke/interfaces/ISpoke.sol`, `src/position-manager/interfaces/
///         ITakerPositionManager.sol`, `IGiverPositionManager.sol` and `src/spoke/interfaces/
///         IPriceOracle.sol`. Kept local because the upstream files import by `src/...` path and
///         the contracts pin solc 0.8.28. Every selector below was exercised against the live Base
///         deployment (MAG7 spoke 0x1790…7B8D, Taker 0x8481…D695, Giver 0x9E81…F08) on 6 Oct 2026.
///         User-defined value types upstream (`ReserveFlags`, `IHubBase`) are their underlying ABI
///         types here, so struct encodings are identical.
interface IAaveSpoke {
    struct PositionManagerUpdate {
        address positionManager;
        bool approve;
    }

    struct SetUserPositionManagers {
        address onBehalfOf;
        PositionManagerUpdate[] updates;
        uint256 nonce;
        uint256 deadline;
    }

    struct Reserve {
        address underlying;
        address hub;
        uint16 assetId;
        uint8 decimals;
        uint24 collateralRisk;
        uint8 flags;
        uint32 dynamicConfigKey;
    }

    struct ReserveConfig {
        uint24 collateralRisk;
        bool paused;
        bool frozen;
        bool borrowable;
        bool receiveSharesEnabled;
    }

    struct DynamicReserveConfig {
        uint16 collateralFactor; // BPS
        uint32 maxLiquidationBonus; // BPS, 100_00 = no bonus
        uint16 liquidationFee; // BPS
    }

    struct UserPosition {
        uint120 drawnShares;
        uint120 premiumShares;
        int200 premiumOffsetRay;
        uint120 suppliedShares;
        uint32 dynamicConfigKey;
    }

    struct UserAccountData {
        uint256 riskPremium; // BPS
        uint256 avgCollateralFactor; // WAD
        uint256 healthFactor; // WAD, type(uint256).max without debt
        uint256 totalCollateralValue; // oracle units (8 decimals on Base)
        uint256 totalDebtValueRay; // oracle units scaled by 1e27
        uint256 activeCollateralCount;
        uint256 borrowCount;
    }

    event Supply(
        uint256 indexed reserveId,
        address indexed caller,
        address indexed user,
        uint256 suppliedShares,
        uint256 suppliedAmount
    );
    event Withdraw(
        uint256 indexed reserveId,
        address indexed caller,
        address indexed user,
        uint256 withdrawnShares,
        uint256 withdrawnAmount
    );
    event Borrow(
        uint256 indexed reserveId,
        address indexed caller,
        address indexed user,
        uint256 drawnShares,
        uint256 drawnAmount
    );
    event SetUserPositionManager(address indexed user, address indexed positionManager, bool approve);

    error HealthFactorBelowThreshold();
    error ReserveNotBorrowable();
    error ReservePaused();
    error ReserveFrozen();
    error Unauthorized();

    function supply(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    function borrow(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    function repay(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf) external;
    function setUserPositionManager(address positionManager, bool approve) external;
    function setUserPositionManagersWithSig(SetUserPositionManagers calldata params, bytes calldata signature) external;
    function renouncePositionManagerRole(address user) external;

    function getReserveCount() external view returns (uint256);
    function getReserve(uint256 reserveId) external view returns (Reserve memory);
    function getReserveConfig(uint256 reserveId) external view returns (ReserveConfig memory);
    function getDynamicReserveConfig(uint256 reserveId, uint32 dynamicConfigKey)
        external
        view
        returns (DynamicReserveConfig memory);
    function getReserveTotalDebt(uint256 reserveId) external view returns (uint256);
    function getReserveSuppliedAssets(uint256 reserveId) external view returns (uint256);
    function getUserReserveStatus(uint256 reserveId, address user) external view returns (bool, bool);
    function getUserSuppliedAssets(uint256 reserveId, address user) external view returns (uint256);
    function getUserTotalDebt(uint256 reserveId, address user) external view returns (uint256);
    function getUserPosition(uint256 reserveId, address user) external view returns (UserPosition memory);
    function getUserAccountData(address user) external view returns (UserAccountData memory);
    function isPositionManagerActive(address positionManager) external view returns (bool);
    function isPositionManager(address user, address positionManager) external view returns (bool);
    function nonces(address owner, uint192 key) external view returns (uint256 keyNonce);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function SET_USER_POSITION_MANAGERS_TYPEHASH() external view returns (bytes32);
    function ORACLE() external view returns (address);
}

/// @notice Aave's activated "Taker" position manager: borrows and withdraws on behalf of a user who
///         approved it on the spoke and granted the caller an allowance. Both actions pay the caller.
interface ITakerPositionManager {
    struct WithdrawPermit {
        address spoke;
        uint256 reserveId;
        address owner;
        address spender;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    struct BorrowPermit {
        address spoke;
        uint256 reserveId;
        address owner;
        address spender;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    event BorrowApproval(
        address indexed spoke, uint256 indexed reserveId, address indexed owner, address spender, uint256 amount
    );
    event WithdrawApproval(
        address indexed spoke, uint256 indexed reserveId, address indexed owner, address spender, uint256 amount
    );

    error InsufficientWithdrawAllowance(uint256 allowance, uint256 required);
    error InsufficientBorrowAllowance(uint256 allowance, uint256 required);
    error SpokeNotRegistered();

    function approveWithdraw(address spoke, uint256 reserveId, address spender, uint256 amount) external;
    function approveWithdrawWithSig(WithdrawPermit calldata params, bytes calldata signature) external;
    function approveBorrow(address spoke, uint256 reserveId, address spender, uint256 amount) external;
    function approveBorrowWithSig(BorrowPermit calldata params, bytes calldata signature) external;
    function withdrawOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        returns (uint256, uint256);
    function borrowOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        returns (uint256, uint256);
    function withdrawAllowance(address spoke, uint256 reserveId, address owner, address spender)
        external
        view
        returns (uint256);
    function borrowAllowance(address spoke, uint256 reserveId, address owner, address spender)
        external
        view
        returns (uint256);
    function isSpokeRegistered(address spoke) external view returns (bool);
    function nonces(address owner, uint192 key) external view returns (uint256 keyNonce);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function BORROW_PERMIT_TYPEHASH() external view returns (bytes32);
    function WITHDRAW_PERMIT_TYPEHASH() external view returns (bytes32);
}

/// @notice Aave's activated "Giver" position manager: supplies and repays on behalf of a user who
///         approved it on the spoke. `repayOnBehalfOf` pulls the asset from the caller, caps the
///         amount at the user's debt and refuses `type(uint256).max`. Anyone may call it.
interface IGiverPositionManager {
    event RepayOnBehalfOf(
        address indexed spoke,
        address indexed caller,
        address indexed onBehalfOf,
        uint256 reserveId,
        uint256 repaidShares,
        uint256 repaidAmount
    );

    error RepayOnBehalfMaxUintNotAllowed();
    error SpokeNotRegistered();

    function supplyOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        returns (uint256, uint256);
    function repayOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        returns (uint256, uint256);
    function isSpokeRegistered(address spoke) external view returns (bool);
}

/// @notice The spoke's price oracle (`IPriceOracle`): reserve prices in `decimals()` (8 on Base).
interface IAavePriceOracle {
    function decimals() external view returns (uint8);
    function getReservePrice(uint256 reserveId) external view returns (uint256);
}
