// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMorpho, MarketParams, Id, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IScaledUIAmount, IScaledUIAmountNewUIMultiplier} from "base-std/interfaces/IERC8056.sol";
import {IPolicyRegistry} from "base-std/interfaces/IPolicyRegistry.sol";
import {B20Constants} from "base-std/lib/B20Constants.sol";
import {IPriceGate} from "../interfaces/IPriceGate.sol";
import {IEligibility} from "../interfaces/IEligibility.sol";
import {SessionGate} from "../oracle/SessionGate.sol";
import {CreditDesk as T} from "./CreditDesk.sol";

/// @title CreditDeskLib
/// @notice The desk's pricing and venue logic as an external library. Every function runs under
///         DELEGATECALL, so transfers, approvals and Morpho calls still happen as the desk and reverts
///         bubble up unchanged. Split out of `CreditDesk` so the desk stays under the EIP-170 runtime
///         size limit at the project's optimizer setting.
library CreditDeskLib {
    using SafeERC20 for IERC20;
    using MorphoBalancesLib for IMorpho;

    /// @dev The desk's immutables and pause flag, passed by value on every call.
    struct Venue {
        IMorpho morpho;
        SessionGate gate;
        IPolicyRegistry policyRegistry;
        bool enforceB20Policies;
        bool paused;
    }

    uint256 internal constant WAD = 1e18;
    uint256 internal constant CORPORATE_ACTION_HORIZON = 7 days;
    uint256 internal constant REPAY_ALL = type(uint256).max;

    /// @dev Same signatures as the desk's errors, so a revert from here decodes as the desk's.
    error Refused(T.Reason reason);
    error UnknownMarket(Id id);
    error OracleNotSessionGuard(address oracle);
    error NothingToRepay();
    error PolicyForbids(bytes32 scope, address account);

    // ---------------------------------------------------------------- market

    /// @dev Fills `m` for a market that exists on Morpho and whose oracle is a SessionGuard bound to the
    ///      desk's gate, and approves Morpho for both tokens.
    function registerMarket(Venue memory v, T.MarketConfig storage m, MarketParams calldata params, Id id) external {
        if (v.morpho.idToMarketParams(id).lltv == 0) revert UnknownMarket(id);
        if (!isSessionGuard(params.oracle, v.gate)) revert OracleNotSessionGuard(params.oracle);
        m.params = params;
        m.collateralDecimals = IERC20Metadata(params.collateralToken).decimals();
        m.loanDecimals = IERC20Metadata(params.loanToken).decimals();
        m.enabled = true;
        IERC20(params.collateralToken).forceApprove(address(v.morpho), type(uint256).max);
        IERC20(params.loanToken).forceApprove(address(v.morpho), type(uint256).max);
    }

    function isSessionGuard(address oracle, SessionGate gate) internal view returns (bool) {
        (bool ok, bytes memory data) = oracle.staticcall(abi.encodeWithSignature("GATE()"));
        return ok && data.length >= 32 && abi.decode(data, (address)) == address(gate);
    }

    // ---------------------------------------------------------------- venue actions, run as the desk

    function addCollateral(Venue memory v, T.Line storage l, T.MarketConfig storage m, address from, uint256 amount)
        external
    {
        preflight(v, l.collateral, from, address(this));
        preflight(v, l.collateral, address(this), address(v.morpho));
        IERC20(l.collateral).safeTransferFrom(from, address(this), amount);
        v.morpho.supplyCollateral(m.params, amount, l.user, "");
    }

    function borrow(Venue memory v, T.Line storage l, T.MarketConfig storage m, uint256 amount) external {
        v.morpho.borrow(m.params, amount, 0, l.user, l.user); // receiver is the position owner, always
    }

    /// @dev `debt` is the position's shares converted up at the accrued totals, which is exactly what
    ///      Morpho charges for repaying those shares, so a full repay pulls `debt` and nothing more.
    function repay(Venue memory v, T.Line storage l, T.MarketConfig storage m, address from, uint256 amount)
        external
        returns (uint256 repaid, bool full)
    {
        Position memory pos = v.morpho.position(l.marketId, l.user);
        if (pos.borrowShares == 0) revert NothingToRepay();
        uint256 debt = v.morpho.expectedBorrowAssets(m.params, l.user);
        full = amount == REPAY_ALL || amount >= debt;
        uint256 pull = full ? debt : amount;
        IERC20(m.params.loanToken).safeTransferFrom(from, address(this), pull);
        if (full) {
            (repaid,) = v.morpho.repay(m.params, 0, pos.borrowShares, l.user, "");
            if (pull > repaid) IERC20(m.params.loanToken).safeTransfer(from, pull - repaid);
        } else {
            (repaid,) = v.morpho.repay(m.params, amount, 0, l.user, "");
        }
    }

    /// @dev Post-withdraw check against the policy LTV, not only the venue LLTV, then the withdrawal to
    ///      `receiver`: the position owner on the user's own path, the registered protection vault on the
    ///      keeper's recovery path. The desk never passes anything else.
    function withdrawCollateral(
        Venue memory v,
        T.Line storage l,
        T.MarketConfig storage m,
        T.Quote memory q,
        uint256 amount,
        address receiver
    ) external {
        if (amount > q.collateralRaw) revert Refused(T.Reason.INSUFFICIENT_CAPACITY);
        uint256 remainingValue = Math.mulDiv(q.collateralValue, q.collateralRaw - amount, q.collateralRaw);
        if (Math.mulDiv(remainingValue, q.effectiveMaxLtvWad, WAD) < q.debt) {
            revert Refused(T.Reason.INSUFFICIENT_CAPACITY);
        }
        preflight(v, l.collateral, address(v.morpho), receiver);
        v.morpho.withdrawCollateral(m.params, amount, l.user, receiver);
    }

    function expectedDebt(IMorpho morpho, T.MarketConfig storage m, address user) external view returns (uint256) {
        return morpho.expectedBorrowAssets(m.params, user);
    }

    function isValidSignature(address signer, bytes32 digest, bytes calldata signature) external view returns (bool) {
        return SignatureChecker.isValidSignatureNow(signer, digest, signature);
    }

    // ---------------------------------------------------------------- views

    function obligationStatus(SessionGate gate, T.Line storage l) external view returns (T.ObligationStatus) {
        if (l.status == T.LineStatus.NONE) return T.ObligationStatus.NONE;
        if (l.status == T.LineStatus.CLOSED) return T.ObligationStatus.CLOSED;
        if (l.status == T.LineStatus.HELD) return T.ObligationStatus.HOLD_KEEPER;
        IPriceGate.Verdict memory v = gate.check(l.collateral);
        if (v.state == IPriceGate.GateState.OPEN) return T.ObligationStatus.OPEN;
        if (v.state == IPriceGate.GateState.MARKET_CLOSED) return T.ObligationStatus.HOLD_SESSION;
        if (v.state == IPriceGate.GateState.FEED_PAUSED) return T.ObligationStatus.HOLD_ISSUER;
        if (v.state == IPriceGate.GateState.TRANSFER_PAUSED) return T.ObligationStatus.HOLD_TRANSFER;
        return T.ObligationStatus.HOLD_FEED;
    }

    function quote(
        Venue memory v,
        T.Line storage l,
        T.MarketConfig storage m,
        T.Partner storage p,
        T.TickerPolicy storage t,
        uint256 amount
    ) external view returns (T.Quote memory q) {
        IPriceGate.Verdict memory verdict = v.gate.check(l.collateral);
        q.session = verdict.session;
        q.collateralRaw = v.morpho.position(l.marketId, l.user).collateral;
        q.debt = v.morpho.expectedBorrowAssets(m.params, l.user);

        if (v.paused) return refuse(q, T.Reason.DESK_PAUSED);
        if (l.status == T.LineStatus.HELD) return refuse(q, T.Reason.LINE_HELD);
        if (l.status != T.LineStatus.OPEN) return refuse(q, T.Reason.LINE_NOT_OPEN);
        if (!p.active) return refuse(q, T.Reason.PARTNER_INACTIVE);
        if (!m.enabled) return refuse(q, T.Reason.MARKET_DISABLED);
        if (!t.allowed) return refuse(q, T.Reason.TICKER_NOT_ALLOWED);
        if (verdict.state != IPriceGate.GateState.OPEN) return refuse(q, gateReason(verdict.state));
        if (!eligible(p, l.partnerId, l.user)) return refuse(q, T.Reason.NOT_ELIGIBLE);

        q.price8 = scaleTo8(uint256(verdict.answer), v.gate.feedOf(l.collateral).feedDecimals);
        // value in loan units = raw * price8 * 10^loanDec / (10^8 * 10^collDec)
        q.collateralValue = Math.mulDiv(
            q.collateralRaw * q.price8, 10 ** uint256(m.loanDecimals), 10 ** (8 + uint256(m.collateralDecimals))
        );
        (uint256 num, uint256 den) = corporateActionRatio(l.collateral);
        if (num < den) {
            q.collateralValue = Math.mulDiv(q.collateralValue, num, den);
            q.corporateActionHaircut = true;
        }
        q.effectiveMaxLtvWad = Math.min(uint256(t.maxLtvWad), m.params.lltv);
        q.maxDebt = Math.mulDiv(q.collateralValue, q.effectiveMaxLtvWad, WAD);
        q.available = q.maxDebt > q.debt ? q.maxDebt - q.debt : 0;

        if (amount != 0) {
            if (t.minDraw != 0 && amount < t.minDraw) return refuse(q, T.Reason.BELOW_MIN_DRAW);
            if (t.maxDraw != 0 && amount > t.maxDraw) return refuse(q, T.Reason.ABOVE_MAX_DRAW);
            if (p.exposureCap != 0 && uint256(p.exposure) + amount > p.exposureCap) {
                return refuse(q, T.Reason.PARTNER_CAP);
            }
            if (t.exposureCap != 0 && uint256(t.exposure) + amount > t.exposureCap) {
                return refuse(q, T.Reason.TICKER_CAP);
            }
            if (amount > q.available) return refuse(q, T.Reason.INSUFFICIENT_CAPACITY);
        }
        if (!v.morpho.isAuthorized(l.user, address(this))) return refuse(q, T.Reason.NOT_AUTHORIZED_ON_VENUE);
    }

    // ---------------------------------------------------------------- internals

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

    function eligible(T.Partner storage p, bytes32 partnerId, address user) internal view returns (bool) {
        if (address(p.eligibility) == address(0)) return true;
        (bool ok, bytes memory data) =
            address(p.eligibility).staticcall(abi.encodeCall(IEligibility.isEligible, (partnerId, user)));
        return ok && data.length >= 32 && abi.decode(data, (bool));
    }

    /// @dev A scheduled multiplier that lowers the UI balance inside the horizon shrinks capacity by
    ///      its ratio. Reads are optional: a token without ERC-8056 reads keeps full capacity.
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

    /// @dev B20 preflight: refuse before Morpho's SafeTransferLib masks a PolicyForbids revert.
    function preflight(Venue memory v, address token, address from, address to) internal view {
        if (!v.enforceB20Policies) return;
        uint64 senderPolicy = IB20(token).policyId(B20Constants.TRANSFER_SENDER_POLICY);
        if (senderPolicy != 0 && !v.policyRegistry.isAuthorized(senderPolicy, from)) {
            revert PolicyForbids(B20Constants.TRANSFER_SENDER_POLICY, from);
        }
        uint64 receiverPolicy = IB20(token).policyId(B20Constants.TRANSFER_RECEIVER_POLICY);
        if (receiverPolicy != 0 && !v.policyRegistry.isAuthorized(receiverPolicy, to)) {
            revert PolicyForbids(B20Constants.TRANSFER_RECEIVER_POLICY, to);
        }
    }

    function scaleTo8(uint256 answer, uint8 decimals) internal pure returns (uint256) {
        if (decimals == 8) return answer;
        if (decimals > 8) return answer / (10 ** (decimals - 8));
        return answer * (10 ** (8 - decimals));
    }
}
