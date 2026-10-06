// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAaveSpoke, ITakerPositionManager} from "./interfaces/IAaveV4.sol";

/// @title AaveEnrolment
/// @notice The exact calls a user signs to put an Aave V4 position under Boundline management, as
///         calldata for a Base Account `wallet_sendCalls` batch, plus the EIP-712 digests of the
///         signature variants. Nothing here moves funds: the user approves Aave's own audited managers
///         (Taker, Giver) on the spoke and grants the desk and the vault bounded allowances on the
///         Taker; Boundline is never a position manager itself.
///
///         Direct batch (an EOA or a smart account sending its own calls):
///           1. spoke.setUserPositionManager(TAKER, true)
///           2. spoke.setUserPositionManager(GIVER, true)
///           3. taker.approveBorrow(spoke, USDC_RESERVE_ID, desk, borrowCap)
///           4. taker.approveWithdraw(spoke, collateralReserveId, vault, withdrawCap)   (recovery, optional)
///         Signature variants (relayed, no gas from the user):
///           - spoke.setUserPositionManagersWithSig(SetUserPositionManagers, sig), domain "Spoke"/"1",
///             typehash SET_USER_POSITION_MANAGERS_TYPEHASH (read from the spoke), keyed nonce from
///             spoke.nonces(user, key);
///           - taker.approveBorrowWithSig(BorrowPermit, sig) and approveWithdrawWithSig(WithdrawPermit, sig),
///             domain "TakerPositionManager"/"1", typehashes below, keyed nonces from taker.nonces(user, key).
///         Verified against the live Base contracts on 6 Oct 2026: both managers are active on the MAG7
///         spoke and both have the spoke registered; the typehashes below match the deployed Taker.
library AaveEnrolment {
    struct Call {
        address target;
        bytes data;
    }

    /// @dev keccak256("BorrowPermit(address spoke,uint256 reserveId,address owner,address spender,uint256 amount,uint256 nonce,uint256 deadline)")
    bytes32 internal constant BORROW_PERMIT_TYPEHASH =
        0x14236ea048da65ffb52a9b32a2c840f24ab374cc31f65faeb7877d22ceca144e;
    /// @dev keccak256("WithdrawPermit(address spoke,uint256 reserveId,address owner,address spender,uint256 amount,uint256 nonce,uint256 deadline)")
    bytes32 internal constant WITHDRAW_PERMIT_TYPEHASH =
        0x9e6642fd4c06a4c1a5e201f1e41c6b7892fcf06859c796b054c510b80e2a0a3f;
    /// @dev keccak256("SetUserPositionManagers(address onBehalfOf,PositionManagerUpdate[] updates,uint256 nonce,uint256 deadline)PositionManagerUpdate(address positionManager,bool approve)")
    ///      as the deployed MAG7 spoke reports it.
    bytes32 internal constant SET_USER_POSITION_MANAGERS_TYPEHASH =
        0xba01f7bf3d3674c63670ec4a78b0d56aac1ad6e8c84468920b9e61bfe0b9851a;
    bytes32 internal constant POSITION_MANAGER_UPDATE_TYPEHASH =
        keccak256("PositionManagerUpdate(address positionManager,bool approve)");

    /// @notice The direct enrolment batch. `withdrawCap == 0` leaves out the recovery allowance.
    function batch(
        address spoke,
        address taker,
        address giver,
        address desk,
        address vault,
        uint256 usdcReserveId,
        uint256 collateralReserveId,
        uint256 borrowCap,
        uint256 withdrawCap
    ) internal pure returns (Call[] memory calls) {
        uint256 n = withdrawCap == 0 ? 3 : 4;
        calls = new Call[](n);
        calls[0] = Call(spoke, abi.encodeCall(IAaveSpoke.setUserPositionManager, (taker, true)));
        calls[1] = Call(spoke, abi.encodeCall(IAaveSpoke.setUserPositionManager, (giver, true)));
        calls[2] =
            Call(taker, abi.encodeCall(ITakerPositionManager.approveBorrow, (spoke, usdcReserveId, desk, borrowCap)));
        if (n == 4) {
            calls[3] = Call(
                taker,
                abi.encodeCall(ITakerPositionManager.approveWithdraw, (spoke, collateralReserveId, vault, withdrawCap))
            );
        }
    }

    /// @notice EIP-712 digest the user signs for `taker.approveBorrowWithSig`.
    function borrowPermitDigest(ITakerPositionManager taker, ITakerPositionManager.BorrowPermit memory p)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(BORROW_PERMIT_TYPEHASH, p.spoke, p.reserveId, p.owner, p.spender, p.amount, p.nonce, p.deadline)
        );
        return keccak256(abi.encodePacked("\x19\x01", taker.DOMAIN_SEPARATOR(), structHash));
    }

    /// @notice EIP-712 digest the user signs for `taker.approveWithdrawWithSig`.
    function withdrawPermitDigest(ITakerPositionManager taker, ITakerPositionManager.WithdrawPermit memory p)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                WITHDRAW_PERMIT_TYPEHASH, p.spoke, p.reserveId, p.owner, p.spender, p.amount, p.nonce, p.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", taker.DOMAIN_SEPARATOR(), structHash));
    }

    /// @notice EIP-712 digest the user signs for `spoke.setUserPositionManagersWithSig` (array member
    ///         hashed per EIP-712: keccak256 of the concatenated struct hashes).
    function setPositionManagersDigest(IAaveSpoke spoke, IAaveSpoke.SetUserPositionManagers memory p)
        internal
        view
        returns (bytes32)
    {
        bytes32[] memory hashes = new bytes32[](p.updates.length);
        for (uint256 i = 0; i < p.updates.length; ++i) {
            hashes[i] = keccak256(
                abi.encode(POSITION_MANAGER_UPDATE_TYPEHASH, p.updates[i].positionManager, p.updates[i].approve)
            );
        }
        bytes32 structHash = keccak256(
            abi.encode(
                SET_USER_POSITION_MANAGERS_TYPEHASH,
                p.onBehalfOf,
                keccak256(abi.encodePacked(hashes)),
                p.nonce,
                p.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", spoke.DOMAIN_SEPARATOR(), structHash));
    }

    /// @notice Keyed nonces as Aave encodes them: the key in the top 192 bits, the sequence below.
    function keyedNonce(uint192 key, uint64 sequence) internal pure returns (uint256) {
        return (uint256(key) << 64) | sequence;
    }
}
