// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAaveSpoke, IAaveHub} from "./interfaces/IAaveV4.sol";
import {AaveTypes as T} from "./AaveTypes.sol";

/// @title AaveVenue
/// @notice The venue's own switches as Boundline reads them, shared by `AaveDeskLib` and `ProtectionVault`
///         (internal functions, inlined: nothing to link). Aave V4 has two layers of them:
///           - the hub's `SpokeConfig` per asset and spoke (`active`, `halted`): the switch the Base Security
///             Council threw on 24 Sep 2026. `Hub` checks it on add, remove, draw and restore, so a halted spoke
///             can neither lend, nor take a repay, nor let a withdrawal or a liquidation through;
///           - the spoke's `ReserveConfig` per reserve (`paused`, `frozen`): paused stops every action on that
///             reserve, frozen stops new supply and borrowing of it only (repay, withdraw, liquidation go on).
///         The spoke's `getReserve(id)` names the hub and the asset id, so nothing about the hub is configured.
library AaveVenue {
    /// @notice Whether the hub lets `spoke` act on `reserveId`'s asset (`active && !halted`), and whether the
    ///         hub could be read at all. Raw words are decoded so an odd answer cannot revert the caller.
    function hubState(IAaveSpoke spoke, uint256 reserveId) internal view returns (bool readable, bool live) {
        IAaveSpoke.Reserve memory r = spoke.getReserve(reserveId);
        (bool ok, bytes memory data) =
            r.hub.staticcall(abi.encodeCall(IAaveHub.getSpokeConfig, (uint256(r.assetId), address(spoke))));
        if (!ok || data.length < 160) return (false, false);
        (,,, uint256 active, uint256 halted) = abi.decode(data, (uint256, uint256, uint256, uint256, uint256));
        return (true, active != 0 && halted == 0);
    }

    /// @notice What the venue refuses for a repay or a withdrawal on `reserveId` before anything moves:
    ///         VENUE_HALTED when the hub has halted or deactivated the spoke for the asset, VENUE_PAUSED when the
    ///         spoke paused the reserve, NONE otherwise (a frozen reserve still repays and withdraws). An
    ///         unreadable hub refuses only when `failClosed` (risky actions); a repay leaves it to the venue.
    function settleReason(IAaveSpoke spoke, uint256 reserveId, bool failClosed) internal view returns (T.Reason) {
        (bool readable, bool live) = hubState(spoke, reserveId);
        if (readable ? !live : failClosed) return T.Reason.VENUE_HALTED;
        if (spoke.getReserveConfig(reserveId).paused) return T.Reason.VENUE_PAUSED;
        return T.Reason.NONE;
    }
}
