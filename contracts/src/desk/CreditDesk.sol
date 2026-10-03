// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMorpho, MarketParams, Id, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IScaledUIAmount, IScaledUIAmountNewUIMultiplier} from "base-std/interfaces/IERC8056.sol";
import {IPolicyRegistry} from "base-std/interfaces/IPolicyRegistry.sol";
import {B20Constants} from "base-std/lib/B20Constants.sol";
import {IMarketCalendar} from "../interfaces/IMarketCalendar.sol";
import {IPriceGate} from "../interfaces/IPriceGate.sol";
import {IEligibility} from "../interfaces/IEligibility.sol";
import {SessionGate} from "../oracle/SessionGate.sol";

/// @title CreditDesk
/// @notice Partner-scoped lines of credit against tokenized stocks on Morpho Blue, self-custody
///         mode: the position belongs to the user, who authorises the desk once on Morpho
///         (`setAuthorization`, or `setAuthorizationWithSig` inside a Base Account batch). The desk
///         draws and withdraws on the user's behalf under the partner's policy with the receiver
///         hardcoded to the position owner, so no code path can move a user's funds anywhere else.
///         Repay and add-collateral need no authorisation and work at any hour. The venue LLTV is the
///         hard backstop if a user ever bypasses the desk.
///
///         Every state change emits an obligation event with a decision hash. The desk only
///         operates on markets whose oracle is a `SessionGuard` bound to its own `SessionGate`, so
///         session, registry-pause, transfer-pause and staleness are enforced at the venue and
///         explained here with reason codes.
contract CreditDesk is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    // ---------------------------------------------------------------- types

    enum LineStatus {
        NONE,
        OPEN,
        HELD, // keeper hold
        CLOSED
    }

    /// @notice Obligation status as the record shows it, derived from the line and the gate.
    enum ObligationStatus {
        NONE,
        OPEN,
        HOLD_SESSION,
        HOLD_FEED,
        HOLD_ISSUER,
        HOLD_TRANSFER,
        HOLD_KEEPER,
        CLOSED
    }

    enum Reason {
        NONE,
        DESK_PAUSED,
        LINE_NOT_OPEN,
        LINE_HELD,
        PARTNER_INACTIVE,
        MARKET_DISABLED,
        MARKET_CLOSED,
        FEED_PAUSED,
        TRANSFER_PAUSED,
        FEED_STALE,
        FEED_INVALID,
        UNKNOWN_TOKEN,
        TICKER_NOT_ALLOWED,
        NOT_ELIGIBLE,
        BELOW_MIN_DRAW,
        ABOVE_MAX_DRAW,
        PARTNER_CAP,
        TICKER_CAP,
        INSUFFICIENT_CAPACITY,
        NOT_AUTHORIZED_ON_VENUE
    }

    struct Partner {
        address admin;
        address signer; // signs LineAuthorization; zero means open access
        IEligibility eligibility; // optional hook
        bool active;
        uint32 policyVersion;
        uint128 exposureCap; // loan-token units across all the partner's lines
        uint128 exposure; // outstanding drawn principal
    }

    struct TickerPolicy {
        bool allowed;
        uint64 maxLtvWad; // strictly below 1e18; clamped to the market LLTV at quote time
        uint128 minDraw;
        uint128 maxDraw;
        uint128 exposureCap;
        uint128 exposure;
    }

    struct MarketConfig {
        MarketParams params;
        uint8 collateralDecimals;
        uint8 loanDecimals;
        bool enabled;
    }

    struct Line {
        bytes32 partnerId;
        address user;
        Id marketId;
        address collateral;
        uint32 policyVersion;
        LineStatus status;
        bytes32 holdReason;
        uint64 openedAt;
        uint128 drawnPrincipal;
    }

    struct Quote {
        Reason reason;
        IMarketCalendar.Session session;
        uint256 price8; // 8-decimal USD price of one whole collateral token, 0 when the gate refuses
        uint256 collateralRaw;
        uint256 collateralValue; // loan-token units, after any corporate-action haircut
        uint256 debt; // loan-token units, interest accrued
        uint256 maxDebt;
        uint256 available;
        uint256 effectiveMaxLtvWad;
        bool corporateActionHaircut;
    }

    // ---------------------------------------------------------------- constants, immutables

    bytes32 public constant LINE_AUTHORIZATION_TYPEHASH =
        keccak256("LineAuthorization(bytes32 partnerId,address user,bytes32 marketId,uint256 nonce,uint256 deadline)");
    uint256 public constant CORPORATE_ACTION_HORIZON = 7 days;
    uint256 public constant REPAY_ALL = type(uint256).max;
    uint256 internal constant WAD = 1e18;

    IMorpho public immutable MORPHO;
    SessionGate public immutable GATE;
    IPolicyRegistry public immutable POLICY_REGISTRY;
    /// @notice True on Base mainnet and Sepolia where the B20 PolicyRegistry precompile exists.
    bool public immutable ENFORCE_B20_POLICIES;

    // ---------------------------------------------------------------- storage

    address public keeper;
    bool public paused;
    uint256 public lineCount;
    uint256 private _decisionNonce;

    mapping(Id => MarketConfig) private _markets;
    mapping(bytes32 => Partner) private _partners;
    mapping(bytes32 => mapping(address => TickerPolicy)) private _tickers;
    mapping(uint256 => Line) private _lines;
    mapping(bytes32 => mapping(address => mapping(Id => uint256))) public lineOf;
    mapping(address => uint256) public nonces;

    // ---------------------------------------------------------------- events

    event KeeperSet(address indexed keeper);
    event PausedSet(bool paused);
    event MarketRegistered(Id indexed id, address indexed collateral, address indexed loanToken, uint256 lltv);
    event MarketEnabled(Id indexed id, bool enabled);
    event PartnerCreated(bytes32 indexed partnerId, address indexed admin, address signer, uint128 exposureCap);
    event PartnerUpdated(bytes32 indexed partnerId, uint32 policyVersion);
    event TickerPolicySet(
        bytes32 indexed partnerId,
        address indexed collateral,
        bool allowed,
        uint64 maxLtvWad,
        uint128 minDraw,
        uint128 maxDraw,
        uint128 exposureCap,
        uint32 policyVersion
    );

    event LineOpened(
        uint256 indexed lineId,
        bytes32 indexed partnerId,
        address indexed user,
        Id marketId,
        uint32 policyVersion,
        bytes32 decisionHash
    );
    event CollateralAdded(uint256 indexed lineId, address indexed from, uint256 amount, bytes32 decisionHash);
    event Drawn(
        uint256 indexed lineId, uint256 amount, uint256 price8, IMarketCalendar.Session session, bytes32 decisionHash
    );
    event Repaid(uint256 indexed lineId, address indexed from, uint256 amount, bool full, bytes32 decisionHash);
    event CollateralWithdrawn(
        uint256 indexed lineId, uint256 amount, uint256 price8, IMarketCalendar.Session session, bytes32 decisionHash
    );
    event LineClosed(uint256 indexed lineId, bytes32 decisionHash);
    event LineHeld(uint256 indexed lineId, bytes32 reason, bytes32 decisionHash);
    event LineReleased(uint256 indexed lineId, bytes32 decisionHash);
    event Decision(
        uint256 indexed lineId, bytes32 indexed action, bytes32 decisionHash, uint256 amount, uint256 price8
    );

    // ---------------------------------------------------------------- errors

    error ZeroAddress();
    error NotKeeper();
    error NotPartnerAdmin();
    error NotLineOwner();
    error Refused(Reason reason);
    error UnknownMarket(Id id);
    error MarketAlreadyRegistered(Id id);
    error OracleNotSessionGuard(address oracle);
    error PartnerExists(bytes32 partnerId);
    error UnknownPartner(bytes32 partnerId);
    error BadLtv(uint64 maxLtvWad);
    error BadDrawBounds(uint128 minDraw, uint128 maxDraw);
    error LineExists(uint256 lineId);
    error UnknownLine(uint256 lineId);
    error BadAuthorization();
    error AuthorizationExpired(uint256 deadline);
    error DebtOutstanding(uint256 debt);
    error NothingToRepay();
    error PolicyForbids(bytes32 scope, address account);
    error ZeroAmount();

    // ---------------------------------------------------------------- constructor

    constructor(
        address initialOwner,
        IMorpho morpho,
        SessionGate gate,
        IPolicyRegistry policyRegistry,
        bool enforceB20Policies,
        address initialKeeper
    ) Ownable(initialOwner) EIP712("Boundline CreditDesk", "1") {
        if (address(morpho) == address(0) || address(gate) == address(0)) revert ZeroAddress();
        if (enforceB20Policies && address(policyRegistry) == address(0)) revert ZeroAddress();
        MORPHO = morpho;
        GATE = gate;
        POLICY_REGISTRY = policyRegistry;
        ENFORCE_B20_POLICIES = enforceB20Policies;
        keeper = initialKeeper;
    }

    // ---------------------------------------------------------------- owner

    function setKeeper(address newKeeper) external onlyOwner {
        keeper = newKeeper;
        emit KeeperSet(newKeeper);
    }

    /// @notice Pausing stops openLine, draw and withdrawCollateral. Repay and addCollateral always work.
    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    /// @notice Register a Morpho market the desk may operate on. The market must exist on Morpho and
    ///         its oracle must be a SessionGuard bound to this desk's SessionGate.
    function registerMarket(MarketParams calldata params) external onlyOwner {
        Id id = params.id();
        if (_markets[id].params.oracle != address(0)) revert MarketAlreadyRegistered(id);
        if (MORPHO.idToMarketParams(id).lltv == 0) revert UnknownMarket(id);
        if (!_isSessionGuard(params.oracle)) revert OracleNotSessionGuard(params.oracle);
        MarketConfig storage m = _markets[id];
        m.params = params;
        m.collateralDecimals = IERC20Metadata(params.collateralToken).decimals();
        m.loanDecimals = IERC20Metadata(params.loanToken).decimals();
        m.enabled = true;
        IERC20(params.collateralToken).forceApprove(address(MORPHO), type(uint256).max);
        IERC20(params.loanToken).forceApprove(address(MORPHO), type(uint256).max);
        emit MarketRegistered(id, params.collateralToken, params.loanToken, params.lltv);
    }

    function setMarketEnabled(Id id, bool enabled) external onlyOwner {
        if (_markets[id].params.oracle == address(0)) revert UnknownMarket(id);
        _markets[id].enabled = enabled;
        emit MarketEnabled(id, enabled);
    }

    function createPartner(
        bytes32 partnerId,
        address admin,
        address signer,
        IEligibility eligibility,
        uint128 exposureCap
    ) external onlyOwner {
        if (admin == address(0)) revert ZeroAddress();
        Partner storage p = _partners[partnerId];
        if (p.admin != address(0)) revert PartnerExists(partnerId);
        p.admin = admin;
        p.signer = signer;
        p.eligibility = eligibility;
        p.exposureCap = exposureCap;
        p.active = true;
        p.policyVersion = 1;
        emit PartnerCreated(partnerId, admin, signer, exposureCap);
    }

    // ---------------------------------------------------------------- partner admin

    modifier onlyPartnerAdmin(bytes32 partnerId) {
        if (_partners[partnerId].admin != msg.sender) revert NotPartnerAdmin();
        _;
    }

    function setPartnerConfig(
        bytes32 partnerId,
        address signer,
        IEligibility eligibility,
        uint128 exposureCap,
        bool active
    ) external onlyPartnerAdmin(partnerId) {
        Partner storage p = _partners[partnerId];
        p.signer = signer;
        p.eligibility = eligibility;
        p.exposureCap = exposureCap;
        p.active = active;
        p.policyVersion += 1;
        emit PartnerUpdated(partnerId, p.policyVersion);
    }

    /// @notice Per-ticker policy. `maxLtvWad` must be below 1e18; at quote time it is also clamped
    ///         to the market's LLTV so the desk can never lend above the venue.
    function setTickerPolicy(
        bytes32 partnerId,
        address collateral,
        bool allowed,
        uint64 maxLtvWad,
        uint128 minDraw,
        uint128 maxDraw,
        uint128 exposureCap
    ) external onlyPartnerAdmin(partnerId) {
        if (maxLtvWad == 0 || maxLtvWad >= WAD) revert BadLtv(maxLtvWad);
        if (maxDraw != 0 && minDraw > maxDraw) revert BadDrawBounds(minDraw, maxDraw);
        TickerPolicy storage t = _tickers[partnerId][collateral];
        t.allowed = allowed;
        t.maxLtvWad = maxLtvWad;
        t.minDraw = minDraw;
        t.maxDraw = maxDraw;
        t.exposureCap = exposureCap;
        Partner storage p = _partners[partnerId];
        p.policyVersion += 1;
        emit TickerPolicySet(partnerId, collateral, allowed, maxLtvWad, minDraw, maxDraw, exposureCap, p.policyVersion);
    }

    // ---------------------------------------------------------------- keeper

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    function hold(uint256 lineId, bytes32 reason) external onlyKeeper {
        Line storage l = _line(lineId);
        if (l.status != LineStatus.OPEN) revert Refused(Reason.LINE_NOT_OPEN);
        l.status = LineStatus.HELD;
        l.holdReason = reason;
        bytes32 h = _decide(lineId, "HOLD", 0, 0);
        emit LineHeld(lineId, reason, h);
    }

    function release(uint256 lineId) external onlyKeeper {
        Line storage l = _line(lineId);
        if (l.status != LineStatus.HELD) revert Refused(Reason.LINE_NOT_OPEN);
        l.status = LineStatus.OPEN;
        l.holdReason = bytes32(0);
        bytes32 h = _decide(lineId, "RELEASE", 0, 0);
        emit LineReleased(lineId, h);
    }

    // ---------------------------------------------------------------- user

    /// @notice Open a line for `msg.sender` under `partnerId` on `marketId`. When the partner has a
    ///         signer, `signature` is the partner's EIP-712 LineAuthorization over the caller's
    ///         current nonce and `deadline`.
    function openLine(bytes32 partnerId, Id marketId, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 lineId)
    {
        if (paused) revert Refused(Reason.DESK_PAUSED);
        Partner storage p = _partners[partnerId];
        if (p.admin == address(0)) revert UnknownPartner(partnerId);
        if (!p.active) revert Refused(Reason.PARTNER_INACTIVE);
        MarketConfig storage m = _markets[marketId];
        if (m.params.oracle == address(0)) revert UnknownMarket(marketId);
        if (!m.enabled) revert Refused(Reason.MARKET_DISABLED);
        if (!_tickers[partnerId][m.params.collateralToken].allowed) revert Refused(Reason.TICKER_NOT_ALLOWED);
        if (!_eligible(p, partnerId, msg.sender)) revert Refused(Reason.NOT_ELIGIBLE);
        if (lineOf[partnerId][msg.sender][marketId] != 0) revert LineExists(lineOf[partnerId][msg.sender][marketId]);

        if (p.signer != address(0)) {
            if (block.timestamp > deadline) revert AuthorizationExpired(deadline);
            bytes32 digest = _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        LINE_AUTHORIZATION_TYPEHASH,
                        partnerId,
                        msg.sender,
                        Id.unwrap(marketId),
                        nonces[msg.sender]++,
                        deadline
                    )
                )
            );
            if (!SignatureChecker.isValidSignatureNow(p.signer, digest, signature)) revert BadAuthorization();
        }

        lineId = ++lineCount;
        Line storage l = _lines[lineId];
        l.partnerId = partnerId;
        l.user = msg.sender;
        l.marketId = marketId;
        l.collateral = m.params.collateralToken;
        l.policyVersion = p.policyVersion;
        l.status = LineStatus.OPEN;
        l.openedAt = uint64(block.timestamp);
        lineOf[partnerId][msg.sender][marketId] = lineId;

        bytes32 h = _decide(lineId, "OPEN", 0, 0);
        emit LineOpened(lineId, partnerId, msg.sender, marketId, p.policyVersion, h);
    }

    /// @notice Add collateral to the user's own Morpho position. Anyone may fund it; the collateral
    ///         always lands on the line owner's position. Works at any hour.
    function addCollateral(uint256 lineId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Line storage l = _line(lineId);
        if (l.status == LineStatus.CLOSED || l.status == LineStatus.NONE) revert Refused(Reason.LINE_NOT_OPEN);
        MarketConfig storage m = _markets[l.marketId];
        _preflight(l.collateral, msg.sender, address(this));
        _preflight(l.collateral, address(this), address(MORPHO));
        IERC20(l.collateral).safeTransferFrom(msg.sender, address(this), amount);
        MORPHO.supplyCollateral(m.params, amount, l.user, "");
        bytes32 h = _decide(lineId, "ADD_COLLATERAL", amount, 0);
        emit CollateralAdded(lineId, msg.sender, amount, h);
    }

    /// @notice Draw `amount` of the loan token to the line owner. Refused with a reason code when
    ///         the session, the feed, the issuer, the policy or the capacity says no.
    function draw(uint256 lineId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Line storage l = _line(lineId);
        if (msg.sender != l.user) revert NotLineOwner();
        Quote memory q = _quote(l, amount);
        if (q.reason != Reason.NONE) revert Refused(q.reason);

        MarketConfig storage m = _markets[l.marketId];
        MORPHO.borrow(m.params, amount, 0, l.user, l.user); // receiver is the position owner, always

        uint128 a = amount.toUint128();
        l.drawnPrincipal += a;
        _partners[l.partnerId].exposure += a;
        _tickers[l.partnerId][l.collateral].exposure += a;

        bytes32 h = _decide(lineId, "DRAW", amount, q.price8);
        emit Drawn(lineId, amount, q.price8, q.session, h);
    }

    /// @notice Repay from `msg.sender`'s loan tokens onto the line owner's position. Anyone may repay
    ///         (the user, the partner, a keeper, a protection vault). Works at any hour: Morpho's
    ///         `repay` never calls the oracle. Pass REPAY_ALL to clear the debt exactly by shares.
    function repay(uint256 lineId, uint256 amount) external nonReentrant returns (uint256 repaid) {
        if (amount == 0) revert ZeroAmount();
        Line storage l = _line(lineId);
        if (l.status == LineStatus.NONE) revert UnknownLine(lineId);
        MarketConfig storage m = _markets[l.marketId];
        Position memory pos = MORPHO.position(l.marketId, l.user);
        if (pos.borrowShares == 0) revert NothingToRepay();
        uint256 debt = MORPHO.expectedBorrowAssets(m.params, l.user);
        bool full = amount == REPAY_ALL || amount >= debt;
        // `debt` is the position's shares converted up at the accrued totals, which is exactly what
        // Morpho charges for repaying those shares, so a full repay pulls `debt` and nothing more.
        uint256 pull = full ? debt : amount;
        IERC20(m.params.loanToken).safeTransferFrom(msg.sender, address(this), pull);
        if (full) {
            (repaid,) = MORPHO.repay(m.params, 0, pos.borrowShares, l.user, "");
            if (pull > repaid) IERC20(m.params.loanToken).safeTransfer(msg.sender, pull - repaid);
        } else {
            (repaid,) = MORPHO.repay(m.params, amount, 0, l.user, "");
        }

        uint128 principalDown = uint128(Math.min(repaid, l.drawnPrincipal));
        l.drawnPrincipal -= principalDown;
        Partner storage p = _partners[l.partnerId];
        p.exposure -= uint128(Math.min(principalDown, p.exposure));
        TickerPolicy storage t = _tickers[l.partnerId][l.collateral];
        t.exposure -= uint128(Math.min(principalDown, t.exposure));

        bytes32 h = _decide(lineId, "REPAY", repaid, 0);
        emit Repaid(lineId, msg.sender, repaid, full, h);
    }

    /// @notice Withdraw collateral to the line owner. Session-gated like a draw, and the line must
    ///         stay within the policy LTV afterwards.
    function withdrawCollateral(uint256 lineId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Line storage l = _line(lineId);
        if (msg.sender != l.user) revert NotLineOwner();
        Quote memory q = _quote(l, 0);
        if (q.reason != Reason.NONE) revert Refused(q.reason);
        if (amount > q.collateralRaw) revert Refused(Reason.INSUFFICIENT_CAPACITY);

        MarketConfig storage m = _markets[l.marketId];
        // post-withdraw check against the policy LTV, not only the venue LLTV
        uint256 remainingValue = Math.mulDiv(q.collateralValue, q.collateralRaw - amount, q.collateralRaw);
        if (Math.mulDiv(remainingValue, q.effectiveMaxLtvWad, WAD) < q.debt) {
            revert Refused(Reason.INSUFFICIENT_CAPACITY);
        }

        _preflight(l.collateral, address(MORPHO), l.user);
        MORPHO.withdrawCollateral(m.params, amount, l.user, l.user); // receiver is the position owner, always
        bytes32 h = _decide(lineId, "WITHDRAW_COLLATERAL", amount, q.price8);
        emit CollateralWithdrawn(lineId, amount, q.price8, q.session, h);
    }

    /// @notice Close a line with no debt. Collateral stays on the user's own position.
    function closeLine(uint256 lineId) external nonReentrant {
        Line storage l = _line(lineId);
        if (msg.sender != l.user) revert NotLineOwner();
        if (l.status == LineStatus.CLOSED) revert Refused(Reason.LINE_NOT_OPEN);
        MarketConfig storage m = _markets[l.marketId];
        uint256 debt = MORPHO.expectedBorrowAssets(m.params, l.user);
        if (debt != 0) revert DebtOutstanding(debt);
        l.status = LineStatus.CLOSED;
        lineOf[l.partnerId][l.user][l.marketId] = 0;
        bytes32 h = _decide(lineId, "CLOSE", 0, 0);
        emit LineClosed(lineId, h);
    }

    // ---------------------------------------------------------------- views

    function quote(uint256 lineId, uint256 amount) external view returns (Quote memory) {
        return _quote(_line(lineId), amount);
    }

    function capacity(uint256 lineId) external view returns (Quote memory) {
        return _quote(_line(lineId), 0);
    }

    function line(uint256 lineId) external view returns (Line memory) {
        return _line(lineId);
    }

    function partner(bytes32 partnerId) external view returns (Partner memory) {
        return _partners[partnerId];
    }

    function tickerPolicy(bytes32 partnerId, address collateral) external view returns (TickerPolicy memory) {
        return _tickers[partnerId][collateral];
    }

    function market(Id id) external view returns (MarketConfig memory) {
        return _markets[id];
    }

    /// @notice The obligation status the record shows right now.
    function obligationStatus(uint256 lineId) external view returns (ObligationStatus) {
        Line storage l = _lines[lineId];
        if (l.status == LineStatus.NONE) return ObligationStatus.NONE;
        if (l.status == LineStatus.CLOSED) return ObligationStatus.CLOSED;
        if (l.status == LineStatus.HELD) return ObligationStatus.HOLD_KEEPER;
        IPriceGate.Verdict memory v = GATE.check(l.collateral);
        if (v.state == IPriceGate.GateState.OPEN) return ObligationStatus.OPEN;
        if (v.state == IPriceGate.GateState.MARKET_CLOSED) return ObligationStatus.HOLD_SESSION;
        if (v.state == IPriceGate.GateState.FEED_PAUSED) return ObligationStatus.HOLD_ISSUER;
        if (v.state == IPriceGate.GateState.TRANSFER_PAUSED) return ObligationStatus.HOLD_TRANSFER;
        return ObligationStatus.HOLD_FEED;
    }

    function lineAuthorizationDigest(bytes32 partnerId, address user, Id marketId, uint256 nonce, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(LINE_AUTHORIZATION_TYPEHASH, partnerId, user, Id.unwrap(marketId), nonce, deadline))
        );
    }

    // ---------------------------------------------------------------- internals

    function _line(uint256 lineId) internal view returns (Line storage l) {
        l = _lines[lineId];
        if (l.status == LineStatus.NONE) revert UnknownLine(lineId);
    }

    function _quote(Line storage l, uint256 amount) internal view returns (Quote memory q) {
        MarketConfig storage m = _markets[l.marketId];
        Partner storage p = _partners[l.partnerId];
        TickerPolicy storage t = _tickers[l.partnerId][l.collateral];

        IPriceGate.Verdict memory v = GATE.check(l.collateral);
        q.session = v.session;
        q.collateralRaw = MORPHO.position(l.marketId, l.user).collateral;
        q.debt = MORPHO.expectedBorrowAssets(m.params, l.user);

        if (paused) return _refuse(q, Reason.DESK_PAUSED);
        if (l.status == LineStatus.HELD) return _refuse(q, Reason.LINE_HELD);
        if (l.status != LineStatus.OPEN) return _refuse(q, Reason.LINE_NOT_OPEN);
        if (!p.active) return _refuse(q, Reason.PARTNER_INACTIVE);
        if (!m.enabled) return _refuse(q, Reason.MARKET_DISABLED);
        if (!t.allowed) return _refuse(q, Reason.TICKER_NOT_ALLOWED);
        if (v.state != IPriceGate.GateState.OPEN) return _refuse(q, _gateReason(v.state));
        if (!_eligible(p, l.partnerId, l.user)) return _refuse(q, Reason.NOT_ELIGIBLE);

        q.price8 = _scaleTo8(uint256(v.answer), GATE.feedOf(l.collateral).feedDecimals);
        // value in loan units = raw * price8 * 10^loanDec / (10^8 * 10^collDec)
        q.collateralValue = Math.mulDiv(
            q.collateralRaw * q.price8, 10 ** uint256(m.loanDecimals), 10 ** (8 + uint256(m.collateralDecimals))
        );
        (uint256 num, uint256 den) = _corporateActionRatio(l.collateral);
        if (num < den) {
            q.collateralValue = Math.mulDiv(q.collateralValue, num, den);
            q.corporateActionHaircut = true;
        }
        q.effectiveMaxLtvWad = Math.min(uint256(t.maxLtvWad), m.params.lltv);
        q.maxDebt = Math.mulDiv(q.collateralValue, q.effectiveMaxLtvWad, WAD);
        q.available = q.maxDebt > q.debt ? q.maxDebt - q.debt : 0;

        if (amount != 0) {
            if (t.minDraw != 0 && amount < t.minDraw) return _refuse(q, Reason.BELOW_MIN_DRAW);
            if (t.maxDraw != 0 && amount > t.maxDraw) return _refuse(q, Reason.ABOVE_MAX_DRAW);
            if (p.exposureCap != 0 && uint256(p.exposure) + amount > p.exposureCap) {
                return _refuse(q, Reason.PARTNER_CAP);
            }
            if (t.exposureCap != 0 && uint256(t.exposure) + amount > t.exposureCap) {
                return _refuse(q, Reason.TICKER_CAP);
            }
            if (amount > q.available) return _refuse(q, Reason.INSUFFICIENT_CAPACITY);
        }
        if (!MORPHO.isAuthorized(l.user, address(this))) return _refuse(q, Reason.NOT_AUTHORIZED_ON_VENUE);
    }

    function _refuse(Quote memory q, Reason r) internal pure returns (Quote memory) {
        q.reason = r;
        return q;
    }

    function _gateReason(IPriceGate.GateState s) internal pure returns (Reason) {
        if (s == IPriceGate.GateState.MARKET_CLOSED) return Reason.MARKET_CLOSED;
        if (s == IPriceGate.GateState.FEED_PAUSED) return Reason.FEED_PAUSED;
        if (s == IPriceGate.GateState.TRANSFER_PAUSED) return Reason.TRANSFER_PAUSED;
        if (s == IPriceGate.GateState.FEED_STALE) return Reason.FEED_STALE;
        if (s == IPriceGate.GateState.FEED_INVALID) return Reason.FEED_INVALID;
        return Reason.UNKNOWN_TOKEN;
    }

    function _eligible(Partner storage p, bytes32 partnerId, address user) internal view returns (bool) {
        if (address(p.eligibility) == address(0)) return true;
        (bool ok, bytes memory data) =
            address(p.eligibility).staticcall(abi.encodeCall(IEligibility.isEligible, (partnerId, user)));
        return ok && data.length >= 32 && abi.decode(data, (bool));
    }

    /// @dev A scheduled multiplier that lowers the UI balance inside the horizon shrinks capacity by
    ///      its ratio. Reads are optional: a token without ERC-8056 reads keeps full capacity.
    function _corporateActionRatio(address token) internal view returns (uint256 num, uint256 den) {
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
    function _preflight(address token, address from, address to) internal view {
        if (!ENFORCE_B20_POLICIES) return;
        uint64 senderPolicy = IB20(token).policyId(B20Constants.TRANSFER_SENDER_POLICY);
        if (senderPolicy != 0 && !POLICY_REGISTRY.isAuthorized(senderPolicy, from)) {
            revert PolicyForbids(B20Constants.TRANSFER_SENDER_POLICY, from);
        }
        uint64 receiverPolicy = IB20(token).policyId(B20Constants.TRANSFER_RECEIVER_POLICY);
        if (receiverPolicy != 0 && !POLICY_REGISTRY.isAuthorized(receiverPolicy, to)) {
            revert PolicyForbids(B20Constants.TRANSFER_RECEIVER_POLICY, to);
        }
    }

    function _isSessionGuard(address oracle) internal view returns (bool) {
        (bool ok, bytes memory data) = oracle.staticcall(abi.encodeWithSignature("GATE()"));
        return ok && data.length >= 32 && abi.decode(data, (address)) == address(GATE);
    }

    function _decide(uint256 lineId, bytes32 action, uint256 amount, uint256 price8) internal returns (bytes32 h) {
        h = keccak256(
            abi.encode(block.chainid, address(this), lineId, action, amount, price8, block.timestamp, ++_decisionNonce)
        );
        emit Decision(lineId, action, h, amount, price8);
    }

    function _scaleTo8(uint256 answer, uint8 decimals) internal pure returns (uint256) {
        if (decimals == 8) return answer;
        if (decimals > 8) return answer / (10 ** (decimals - 8));
        return answer * (10 ** (8 - decimals));
    }
}
