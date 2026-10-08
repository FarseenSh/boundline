// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IScaledUIAmount, IScaledUIAmountNewUIMultiplier} from "base-std/interfaces/IERC8056.sol";
import {IPriceGate} from "../interfaces/IPriceGate.sol";
import {IEligibility} from "../interfaces/IEligibility.sol";
import {SessionGate} from "../oracle/SessionGate.sol";
import {IAaveSpoke, ITakerPositionManager, IGiverPositionManager, IAavePriceOracle} from "./interfaces/IAaveV4.sol";
import {AaveTypes as T} from "./AaveTypes.sol";
import {AaveVenue} from "./AaveVenue.sol";

/// @title AaveDeskLib
/// @notice The AaveDesk's pricing and venue logic as an external library (DELEGATECALL), the same split
///         as `CreditDeskLib`, so the desk stays under the EIP-170 size limit. Venue calls go through
///         Aave's own activated position managers: the Taker borrows and withdraws and pays the caller,
///         the Giver repays from the caller. Both are forwarded to the line owner in the same call, so
///         the desk never holds a user's money between transactions.
library AaveDeskLib {
    using SafeERC20 for IERC20;

    struct Venue {
        IAaveSpoke spoke;
        ITakerPositionManager taker;
        IGiverPositionManager giver;
        SessionGate gate;
        IERC20 usdc;
        uint256 usdcReserveId;
        bool paused;
    }

    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant CORPORATE_ACTION_HORIZON = 7 days;
    uint256 internal constant REPAY_ALL = type(uint256).max;

    /// @dev Same signatures as the desk's errors so a revert from here decodes as the desk's.
    error Refused(T.Reason reason);
    error NothingToRepay();
    error DrawMismatch(uint256 requested, uint256 borrowed);

    // ---------------------------------------------------------------- reserve facts

    /// @notice The reserve's collateral factor as a WAD, read at its latest dynamic config key (every
    ///         spoke action refreshes the user to that key).
    function collateralFactorWad(IAaveSpoke spoke, uint256 reserveId) public view returns (uint256) {
        IAaveSpoke.Reserve memory r = spoke.getReserve(reserveId);
        return uint256(spoke.getDynamicReserveConfig(reserveId, r.dynamicConfigKey).collateralFactor) * 1e14;
    }

    // ---------------------------------------------------------------- venue actions, run as the desk

    /// @dev Borrow through the Taker (USDC lands on the desk) and forward every unit to the line owner.
    function draw(Venue memory v, T.Line storage l, uint256 amount) external returns (uint256 borrowed) {
        (, borrowed) = v.taker.borrowOnBehalfOf(address(v.spoke), v.usdcReserveId, amount, l.user);
        if (borrowed != amount) revert DrawMismatch(amount, borrowed);
        v.usdc.safeTransfer(l.user, borrowed); // receiver is the position owner, always
    }

    /// @dev Repay through the Giver from `from`'s USDC. Anyone may fund it, at any hour: the Giver reads
    ///      no oracle. The Giver caps the repayment at the user's debt, so any unused part goes back.
    function repay(Venue memory v, T.Line storage l, address from, uint256 amount)
        external
        returns (uint256 repaid, bool full)
    {
        if (!v.spoke.isPositionManager(l.user, address(v.giver))) {
            revert Refused(T.Reason.NOT_AUTHORIZED_ON_VENUE);
        }
        // The venue refuses a repay while the hub halts USDC's asset or the spoke pauses the reserve: say so by
        // name. An unreadable hub is left to the venue, so a bad read never blocks the one always-safe action.
        T.Reason closed = AaveVenue.settleReason(v.spoke, v.usdcReserveId, false);
        if (closed != T.Reason.NONE) revert Refused(closed);
        uint256 debt = v.spoke.getUserTotalDebt(v.usdcReserveId, l.user);
        if (debt == 0) revert NothingToRepay();
        full = amount == REPAY_ALL || amount >= debt;
        uint256 pull = full ? debt : amount;
        v.usdc.safeTransferFrom(from, address(this), pull);
        v.usdc.forceApprove(address(v.giver), pull);
        (, repaid) = v.giver.repayOnBehalfOf(address(v.spoke), v.usdcReserveId, pull, l.user);
        v.usdc.forceApprove(address(v.giver), 0);
        if (pull > repaid) v.usdc.safeTransfer(from, pull - repaid);
    }

    /// @dev Post-withdraw check against the policy LTV (the venue checks its own factor), then the
    ///      withdrawal through the Taker; the collateral lands on the desk and is forwarded to the owner.
    function withdrawCollateral(Venue memory v, T.Line storage l, T.Quote memory q, uint256 amount)
        external
        returns (uint256 withdrawn)
    {
        if (amount > q.collateralRaw) revert Refused(T.Reason.INSUFFICIENT_CAPACITY);
        uint256 remainingValue = Math.mulDiv(q.collateralValue, q.collateralRaw - amount, q.collateralRaw);
        if (Math.mulDiv(remainingValue, q.effectiveMaxLtvWad, WAD) < q.debt) {
            revert Refused(T.Reason.INSUFFICIENT_CAPACITY);
        }
        if (v.taker.withdrawAllowance(address(v.spoke), l.reserveId, l.user, address(this)) < amount) {
            revert Refused(T.Reason.NOT_AUTHORIZED_ON_VENUE);
        }
        (, withdrawn) = v.taker.withdrawOnBehalfOf(address(v.spoke), l.reserveId, amount, l.user);
        IERC20(l.collateral).safeTransfer(l.user, withdrawn); // receiver is the position owner, always
    }

    function isValidSignature(address signer, bytes32 digest, bytes calldata signature) external view returns (bool) {
        return SignatureChecker.isValidSignatureNow(signer, digest, signature);
    }

    // ---------------------------------------------------------------- views

    function obligationStatus(Venue memory v, T.Line storage l) external view returns (T.ObligationStatus) {
        if (l.status == T.LineStatus.NONE) return T.ObligationStatus.NONE;
        if (l.status == T.LineStatus.CLOSED) return T.ObligationStatus.CLOSED;
        if (l.status == T.LineStatus.HELD) return T.ObligationStatus.HOLD_KEEPER;
        if (!hubLive(v, l.reserveId)) return T.ObligationStatus.HOLD_VENUE;
        IAaveSpoke.ReserveConfig memory c = v.spoke.getReserveConfig(l.reserveId);
        IAaveSpoke.ReserveConfig memory u = v.spoke.getReserveConfig(v.usdcReserveId);
        if (c.paused || c.frozen || u.paused || u.frozen) return T.ObligationStatus.HOLD_VENUE;
        IPriceGate.Verdict memory verdict = v.gate.check(l.collateral);
        if (verdict.state == IPriceGate.GateState.OPEN) return T.ObligationStatus.OPEN;
        if (verdict.state == IPriceGate.GateState.MARKET_CLOSED) return T.ObligationStatus.HOLD_SESSION;
        if (verdict.state == IPriceGate.GateState.FEED_PAUSED) return T.ObligationStatus.HOLD_ISSUER;
        if (verdict.state == IPriceGate.GateState.TRANSFER_PAUSED) return T.ObligationStatus.HOLD_TRANSFER;
        return T.ObligationStatus.HOLD_FEED;
    }

    /// @notice The deterministic quote: every refusal is a reason code, capacity rounds down, and the
    ///         venue's own headroom (all of the user's Aave collateral and debt at Aave's prices) caps
    ///         the policy headroom so the desk never quotes what the spoke would refuse.
    function quote(
        Venue memory v,
        T.Line storage l,
        T.Partner storage p,
        T.ReservePolicy storage t,
        uint8 collateralDecimals,
        bool reserveEnabled,
        uint256 amount
    ) external view returns (T.Quote memory q) {
        IPriceGate.Verdict memory verdict = v.gate.check(l.collateral);
        q.session = verdict.session;
        q.collateralRaw = v.spoke.getUserSuppliedAssets(l.reserveId, l.user);
        q.debt = v.spoke.getUserTotalDebt(v.usdcReserveId, l.user);

        T.Reason r = stateReason(v, l, p, t, reserveEnabled, verdict.state);
        if (r != T.Reason.NONE) return refuse(q, r);
        q.price8 = scaleTo8(uint256(verdict.answer), v.gate.feedOf(l.collateral).feedDecimals);
        r = capacityReason(v, l, t, collateralDecimals, q);
        if (r != T.Reason.NONE) return refuse(q, r);
        r = amountReason(p, t, q.available, amount);
        if (r != T.Reason.NONE) return refuse(q, r);
        r = venueAuthReason(v, l, amount);
        if (r != T.Reason.NONE) return refuse(q, r);
    }

    // ---------------------------------------------------------------- quote steps

    /// @dev Desk, line, partner, reserve and venue switches (the hub's halt first, then the spoke's pause and
    ///      freeze), then the gate, then eligibility.
    function stateReason(
        Venue memory v,
        T.Line storage l,
        T.Partner storage p,
        T.ReservePolicy storage t,
        bool reserveEnabled,
        IPriceGate.GateState state
    ) internal view returns (T.Reason) {
        if (v.paused) return T.Reason.DESK_PAUSED;
        if (l.status == T.LineStatus.HELD) return T.Reason.LINE_HELD;
        if (l.status != T.LineStatus.OPEN) return T.Reason.LINE_NOT_OPEN;
        if (!p.active) return T.Reason.PARTNER_INACTIVE;
        if (!reserveEnabled) return T.Reason.MARKET_DISABLED;
        if (!t.allowed) return T.Reason.TICKER_NOT_ALLOWED;
        if (!hubLive(v, l.reserveId)) return T.Reason.VENUE_HALTED;
        IAaveSpoke.ReserveConfig memory c = v.spoke.getReserveConfig(l.reserveId);
        IAaveSpoke.ReserveConfig memory u = v.spoke.getReserveConfig(v.usdcReserveId);
        if (c.paused || u.paused) return T.Reason.VENUE_PAUSED;
        if (c.frozen || u.frozen) return T.Reason.VENUE_FROZEN;
        if (!u.borrowable) return T.Reason.MARKET_DISABLED;
        if (state != IPriceGate.GateState.OPEN) return gateReason(state);
        if (!eligible(p, l.partnerId, l.user)) return T.Reason.NOT_ELIGIBLE;
        return T.Reason.NONE;
    }

    /// @dev Collateral value at the gate's price (less a scheduled corporate-action haircut), the policy
    ///      LTV clamped to the reserve's collateral factor, and the venue's own headroom.
    function capacityReason(
        Venue memory v,
        T.Line storage l,
        T.ReservePolicy storage t,
        uint8 collateralDecimals,
        T.Quote memory q
    ) internal view returns (T.Reason) {
        if (q.collateralRaw == 0) return T.Reason.NO_COLLATERAL;
        (bool usingAsCollateral,) = v.spoke.getUserReserveStatus(l.reserveId, l.user);
        if (!usingAsCollateral) return T.Reason.COLLATERAL_DISABLED;

        // value in USDC units = raw * price8 * 10^6 / (10^8 * 10^collateralDecimals)
        q.collateralValue = Math.mulDiv(q.collateralRaw * q.price8, 1e6, 10 ** (8 + uint256(collateralDecimals)));
        (uint256 num, uint256 den) = corporateActionRatio(l.collateral);
        if (num < den) {
            q.collateralValue = Math.mulDiv(q.collateralValue, num, den);
            q.corporateActionHaircut = true;
        }
        q.effectiveMaxLtvWad = Math.min(uint256(t.maxLtvWad), collateralFactorWad(v.spoke, l.reserveId));
        q.maxDebt = Math.mulDiv(q.collateralValue, q.effectiveMaxLtvWad, WAD);
        uint256 policyAvailable = q.maxDebt > q.debt ? q.maxDebt - q.debt : 0;

        IAaveSpoke.UserAccountData memory ad = v.spoke.getUserAccountData(l.user);
        q.venueHealthFactor = ad.healthFactor;
        if (ad.totalDebtValueRay != 0 && ad.healthFactor <= WAD) return T.Reason.VENUE_UNHEALTHY;
        q.venueAvailable = venueHeadroom(v, ad);
        q.available = Math.min(policyAvailable, q.venueAvailable);
        return T.Reason.NONE;
    }

    /// @dev Draw bounds and exposure caps for a non-zero amount.
    function amountReason(T.Partner storage p, T.ReservePolicy storage t, uint256 available, uint256 amount)
        internal
        view
        returns (T.Reason)
    {
        if (amount == 0) return T.Reason.NONE;
        if (t.minDraw != 0 && amount < t.minDraw) return T.Reason.BELOW_MIN_DRAW;
        if (t.maxDraw != 0 && amount > t.maxDraw) return T.Reason.ABOVE_MAX_DRAW;
        if (p.exposureCap != 0 && uint256(p.exposure) + amount > p.exposureCap) return T.Reason.PARTNER_CAP;
        if (t.exposureCap != 0 && uint256(t.exposure) + amount > t.exposureCap) return T.Reason.TICKER_CAP;
        if (amount > available) return T.Reason.INSUFFICIENT_CAPACITY;
        return T.Reason.NONE;
    }

    /// @dev The user must have approved the Taker on the spoke and granted this desk a borrow allowance
    ///      that covers the draw (at least one unit for a capacity query).
    function venueAuthReason(Venue memory v, T.Line storage l, uint256 amount) internal view returns (T.Reason) {
        if (!v.spoke.isPositionManager(l.user, address(v.taker))) return T.Reason.NOT_AUTHORIZED_ON_VENUE;
        uint256 allowance = v.taker.borrowAllowance(address(v.spoke), v.usdcReserveId, l.user, address(this));
        if (allowance < Math.max(amount, 1)) return T.Reason.NOT_AUTHORIZED_ON_VENUE;
        return T.Reason.NONE;
    }

    // ---------------------------------------------------------------- internals

    /// @dev The hub lets the spoke act on both the collateral's asset and USDC's (`active && !halted` in the hub's
    ///      `SpokeConfig`). Fail closed: a hub that cannot be read counts as halted for anything that lends.
    function hubLive(Venue memory v, uint256 collateralReserveId) internal view returns (bool) {
        (bool readable, bool live) = AaveVenue.hubState(v.spoke, collateralReserveId);
        if (!readable || !live) return false;
        (readable, live) = AaveVenue.hubState(v.spoke, v.usdcReserveId);
        return readable && live;
    }

    /// @dev What Aave alone would still lend: collateral value x average collateral factor minus debt,
    ///      in oracle units, converted to USDC units at the oracle's USDC price. Fails closed to zero
    ///      when the oracle cannot price USDC.
    function venueHeadroom(Venue memory v, IAaveSpoke.UserAccountData memory ad) internal view returns (uint256) {
        uint256 capacityValue = Math.mulDiv(ad.totalCollateralValue, ad.avgCollateralFactor, WAD);
        uint256 debtValue = Math.ceilDiv(ad.totalDebtValueRay, RAY);
        if (capacityValue <= debtValue) return 0;
        (bool ok, bytes memory data) = address(v.spoke).staticcall(abi.encodeCall(IAaveSpoke.ORACLE, ()));
        if (!ok || data.length < 32) return 0;
        address oracle = abi.decode(data, (address));
        (ok, data) = oracle.staticcall(abi.encodeCall(IAavePriceOracle.getReservePrice, (v.usdcReserveId)));
        if (!ok || data.length < 32) return 0;
        uint256 usdcPrice = abi.decode(data, (uint256));
        if (usdcPrice == 0) return 0;
        (ok, data) = oracle.staticcall(abi.encodeCall(IAavePriceOracle.decimals, ()));
        uint8 oracleDecimals = ok && data.length >= 32 ? abi.decode(data, (uint8)) : 8;
        // headroom (oracle units) / (USDC price in oracle units per whole USDC) * 1e6
        return Math.mulDiv(
            capacityValue - debtValue, 1e6 * 10 ** uint256(oracleDecimals), usdcPrice * 10 ** uint256(oracleDecimals)
        );
    }

    function refuse(T.Quote memory q, T.Reason r) internal pure returns (T.Quote memory) {
        q.reason = r;
        return q;
    }

    function gateReason(IPriceGate.GateState s) internal pure returns (T.Reason) {
        if (s == IPriceGate.GateState.MARKET_CLOSED) return T.Reason.MARKET_CLOSED;
        if (s == IPriceGate.GateState.FEED_PAUSED) return T.Reason.FEED_PAUSED;
        if (s == IPriceGate.GateState.TRANSFER_PAUSED) return T.Reason.TRANSFER_PAUSED;
        if (s == IPriceGate.GateState.FEED_STALE) return T.Reason.FEED_STALE;
        if (s == IPriceGate.GateState.FEED_INVALID) return T.Reason.FEED_INVALID;
        return T.Reason.UNKNOWN_TOKEN;
    }

    function eligible(T.Partner storage p, bytes32 partnerId, address user) public view returns (bool) {
        if (address(p.eligibility) == address(0)) return true;
        (bool ok, bytes memory data) =
            address(p.eligibility).staticcall(abi.encodeCall(IEligibility.isEligible, (partnerId, user)));
        return ok && data.length >= 32 && abi.decode(data, (bool));
    }

    /// @dev A scheduled multiplier that lowers the UI balance inside the horizon shrinks capacity by its
    ///      ratio (ERC-8056 reads are optional: a token without them keeps full capacity).
    function corporateActionRatio(address token) internal view returns (uint256 num, uint256 den) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeCall(IScaledUIAmountNewUIMultiplier.effectiveAt, ()));
        if (!ok || data.length < 32) return (1, 1);
        uint256 effectiveAt = abi.decode(data, (uint256));
        if (
            effectiveAt == 0 || effectiveAt <= block.timestamp
                || effectiveAt > block.timestamp + CORPORATE_ACTION_HORIZON
        ) {
            return (1, 1);
        }
        (bool ok1, bytes memory d1) = token.staticcall(abi.encodeCall(IScaledUIAmount.uiMultiplier, ()));
        (bool ok2, bytes memory d2) =
            token.staticcall(abi.encodeCall(IScaledUIAmountNewUIMultiplier.newUIMultiplier, ()));
        if (!ok1 || !ok2 || d1.length < 32 || d2.length < 32) return (1, 1);
        uint256 current = abi.decode(d1, (uint256));
        uint256 next = abi.decode(d2, (uint256));
        if (current == 0 || next == 0) return (1, 1);
        return (next, current);
    }

    function scaleTo8(uint256 answer, uint8 decimals) internal pure returns (uint256) {
        if (decimals == 8) return answer;
        if (decimals > 8) return answer / (10 ** (decimals - 8));
        return answer * (10 ** (8 - decimals));
    }
}
