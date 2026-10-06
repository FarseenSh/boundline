// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMarketCalendar} from "../interfaces/IMarketCalendar.sol";
import {IEligibility} from "../interfaces/IEligibility.sol";
import {SessionGate} from "../oracle/SessionGate.sol";
import {IAaveSpoke, ITakerPositionManager, IGiverPositionManager} from "./interfaces/IAaveV4.sol";
import {AaveTypes as T} from "./AaveTypes.sol";
import {AaveDeskLib} from "./AaveDeskLib.sol";
import {AaveEnrolment} from "./AaveEnrolment.sol";

/// @title AaveDesk
/// @notice Partner-scoped lines of credit against tokenized stocks on Aave V4 (the Base Equities Hub
///         through its MAG7 spoke), self-custody mode: the position belongs to the user, who approves
///         Aave's own activated position managers (Taker, Giver) on the spoke and grants this desk a
///         bounded borrow allowance on the Taker. The desk draws through the Taker and forwards every
///         unit to the line owner in the same call; it withdraws collateral the same way; repay goes
///         through the Giver and anyone may fund it at any hour. The desk is never a position manager
///         and never holds a user's funds between transactions. Aave's own collateral factor stays the
///         hard backstop if a user ever bypasses the desk.
///
///         Aave V4 prices collateral at `latestAnswer()` of the raw Chainlink proxies with no session,
///         staleness or issuer-pause check, so the desk reads Boundline's `SessionGate` first and
///         refuses a draw with a reason code while Wall Street is closed, the feed is held, the
///         OracleRegistry has paused the token or the issuer paused transfers; the record shows the
///         venue's own health beside Boundline's. Every state change emits an obligation event with a
///         decision hash. Pricing and venue logic live in `AaveDeskLib` (external library, DELEGATECALL).
contract AaveDesk is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeCast for uint256;

    // ---------------------------------------------------------------- types

    struct ReserveInfo {
        address underlying;
        uint8 decimals;
        bool enabled;
    }

    // ---------------------------------------------------------------- constants, immutables

    bytes32 public constant LINE_AUTHORIZATION_TYPEHASH =
        keccak256("LineAuthorization(bytes32 partnerId,address user,uint256 reserveId,uint256 nonce,uint256 deadline)");
    uint256 public constant REPAY_ALL = type(uint256).max;
    uint256 internal constant WAD = 1e18;

    IAaveSpoke public immutable SPOKE;
    ITakerPositionManager public immutable TAKER;
    IGiverPositionManager public immutable GIVER;
    SessionGate public immutable GATE;
    /// @notice The loan reserve on the spoke (7 = USDC on the Base MAG7 spoke) and its underlying.
    uint256 public immutable LOAN_RESERVE_ID;
    IERC20 public immutable LOAN_TOKEN;

    // ---------------------------------------------------------------- storage

    address public keeper;
    bool public paused;
    uint256 public lineCount;
    uint256 private _decisionNonce;

    mapping(uint256 => ReserveInfo) private _reserves;
    mapping(bytes32 => T.Partner) private _partners;
    mapping(bytes32 => mapping(uint256 => T.ReservePolicy)) private _policies;
    mapping(uint256 => T.Line) private _lines;
    mapping(bytes32 => mapping(address => mapping(uint256 => uint256))) public lineOf;
    mapping(address => uint256) public nonces;

    // ---------------------------------------------------------------- events

    event KeeperSet(address indexed keeper);
    event PausedSet(bool paused);
    event ReserveEnabled(uint256 indexed reserveId, address indexed underlying, uint8 decimals, bool enabled);
    event PartnerCreated(bytes32 indexed partnerId, address indexed admin, address signer, uint128 exposureCap);
    event PartnerUpdated(bytes32 indexed partnerId, uint32 policyVersion);
    event ReservePolicySet(
        bytes32 indexed partnerId,
        uint256 indexed reserveId,
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
        uint256 reserveId,
        uint32 policyVersion,
        bytes32 decisionHash
    );
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
    error Refused(T.Reason reason);
    error ManagerNotActive(address manager);
    error SpokeNotRegistered(address manager);
    error ReserveNotCollateral(uint256 reserveId);
    error ReserveNotEnabled(uint256 reserveId);
    error ReserveAlreadyEnabled(uint256 reserveId);
    error GateHasNoFeed(address token);
    error PartnerExists(bytes32 partnerId);
    error UnknownPartner(bytes32 partnerId);
    error BadLtv(uint64 maxLtvWad, uint256 collateralFactorWad);
    error BadDrawBounds(uint128 minDraw, uint128 maxDraw);
    error LineExists(uint256 lineId);
    error UnknownLine(uint256 lineId);
    error BadAuthorization();
    error AuthorizationExpired(uint256 deadline);
    error DebtOutstanding(uint256 debt);
    error NothingToRepay();
    error DrawMismatch(uint256 requested, uint256 borrowed);
    error ZeroAmount();
    /// @dev Raised inside `AaveDeskLib`'s token transfers and bubbled up unchanged.
    error SafeERC20FailedOperation(address token);

    // ---------------------------------------------------------------- constructor

    constructor(
        address initialOwner,
        IAaveSpoke spoke,
        ITakerPositionManager taker,
        IGiverPositionManager giver,
        SessionGate gate,
        uint256 loanReserveId,
        address initialKeeper
    ) Ownable(initialOwner) EIP712("Boundline AaveDesk", "1") {
        if (
            address(spoke) == address(0) || address(taker) == address(0) || address(giver) == address(0)
                || address(gate) == address(0)
        ) revert ZeroAddress();
        if (!spoke.isPositionManagerActive(address(taker))) revert ManagerNotActive(address(taker));
        if (!spoke.isPositionManagerActive(address(giver))) revert ManagerNotActive(address(giver));
        if (!taker.isSpokeRegistered(address(spoke))) revert SpokeNotRegistered(address(taker));
        if (!giver.isSpokeRegistered(address(spoke))) revert SpokeNotRegistered(address(giver));
        SPOKE = spoke;
        TAKER = taker;
        GIVER = giver;
        GATE = gate;
        LOAN_RESERVE_ID = loanReserveId;
        LOAN_TOKEN = IERC20(spoke.getReserve(loanReserveId).underlying);
        keeper = initialKeeper;
    }

    // ---------------------------------------------------------------- owner

    function setKeeper(address newKeeper) external onlyOwner {
        keeper = newKeeper;
        emit KeeperSet(newKeeper);
    }

    /// @notice Pausing stops openLine, draw and withdrawCollateral. Repay always works.
    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    /// @notice Enable a collateral reserve of the spoke for lines. It must carry a collateral factor
    ///         and its underlying must have a feed on the gate.
    function enableReserve(uint256 reserveId) external onlyOwner {
        if (_reserves[reserveId].underlying != address(0)) revert ReserveAlreadyEnabled(reserveId);
        IAaveSpoke.Reserve memory r = SPOKE.getReserve(reserveId);
        if (AaveDeskLib.collateralFactorWad(SPOKE, reserveId) == 0) revert ReserveNotCollateral(reserveId);
        if (address(GATE.feedOf(r.underlying).feed) == address(0)) revert GateHasNoFeed(r.underlying);
        _reserves[reserveId] = ReserveInfo({underlying: r.underlying, decimals: r.decimals, enabled: true});
        emit ReserveEnabled(reserveId, r.underlying, r.decimals, true);
    }

    function setReserveEnabled(uint256 reserveId, bool enabled) external onlyOwner {
        ReserveInfo storage info = _reserves[reserveId];
        if (info.underlying == address(0)) revert ReserveNotEnabled(reserveId);
        info.enabled = enabled;
        emit ReserveEnabled(reserveId, info.underlying, info.decimals, enabled);
    }

    function createPartner(
        bytes32 partnerId,
        address admin,
        address signer,
        IEligibility eligibility,
        uint128 exposureCap
    ) external onlyOwner {
        if (admin == address(0)) revert ZeroAddress();
        if (_partners[partnerId].admin != address(0)) revert PartnerExists(partnerId);
        _partners[partnerId] = T.Partner({
            admin: admin,
            signer: signer,
            eligibility: eligibility,
            active: true,
            policyVersion: 1,
            exposureCap: exposureCap,
            exposure: 0
        });
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
        bool active,
        uint128 exposureCap
    ) external onlyPartnerAdmin(partnerId) {
        T.Partner storage p = _partners[partnerId];
        p.signer = signer;
        p.eligibility = eligibility;
        p.active = active;
        p.exposureCap = exposureCap;
        p.policyVersion += 1;
        emit PartnerUpdated(partnerId, p.policyVersion);
    }

    /// @notice Per-reserve policy. `maxLtvWad` must be strictly below the reserve's collateral
    ///         factor, so the policy always bites before the venue does.
    function setReservePolicy(
        bytes32 partnerId,
        uint256 reserveId,
        bool allowed,
        uint64 maxLtvWad,
        uint128 minDraw,
        uint128 maxDraw,
        uint128 exposureCap
    ) external onlyPartnerAdmin(partnerId) {
        if (_reserves[reserveId].underlying == address(0)) revert ReserveNotEnabled(reserveId);
        uint256 cf = AaveDeskLib.collateralFactorWad(SPOKE, reserveId);
        if (maxLtvWad == 0 || uint256(maxLtvWad) >= cf) revert BadLtv(maxLtvWad, cf);
        if (maxDraw != 0 && minDraw > maxDraw) revert BadDrawBounds(minDraw, maxDraw);
        T.ReservePolicy storage t = _policies[partnerId][reserveId];
        t.allowed = allowed;
        t.maxLtvWad = maxLtvWad;
        t.minDraw = minDraw;
        t.maxDraw = maxDraw;
        t.exposureCap = exposureCap;
        T.Partner storage p = _partners[partnerId];
        p.policyVersion += 1;
        emit ReservePolicySet(partnerId, reserveId, allowed, maxLtvWad, minDraw, maxDraw, exposureCap, p.policyVersion);
    }

    // ---------------------------------------------------------------- keeper

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    function hold(uint256 lineId, bytes32 reason) external onlyKeeper {
        T.Line storage l = _line(lineId);
        if (l.status != T.LineStatus.OPEN) revert Refused(T.Reason.LINE_NOT_OPEN);
        l.status = T.LineStatus.HELD;
        l.holdReason = reason;
        emit LineHeld(lineId, reason, _decide(lineId, "HOLD", 0, 0));
    }

    function release(uint256 lineId) external onlyKeeper {
        T.Line storage l = _line(lineId);
        if (l.status != T.LineStatus.HELD) revert Refused(T.Reason.LINE_NOT_OPEN);
        l.status = T.LineStatus.OPEN;
        l.holdReason = bytes32(0);
        emit LineReleased(lineId, _decide(lineId, "RELEASE", 0, 0));
    }

    // ---------------------------------------------------------------- user

    /// @notice Open a line for `msg.sender` under `partnerId` on collateral `reserveId`. When the
    ///         partner has a signer, `signature` is the partner's EIP-712 LineAuthorization over the
    ///         caller's current nonce and `deadline`. The user's Aave position is untouched: collateral
    ///         is whatever they supplied on the spoke themselves.
    function openLine(bytes32 partnerId, uint256 reserveId, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 lineId)
    {
        if (paused) revert Refused(T.Reason.DESK_PAUSED);
        T.Partner storage p = _partners[partnerId];
        if (p.admin == address(0)) revert UnknownPartner(partnerId);
        if (!p.active) revert Refused(T.Reason.PARTNER_INACTIVE);
        ReserveInfo storage info = _reserves[reserveId];
        if (info.underlying == address(0)) revert ReserveNotEnabled(reserveId);
        if (!info.enabled) revert Refused(T.Reason.MARKET_DISABLED);
        if (!_policies[partnerId][reserveId].allowed) revert Refused(T.Reason.TICKER_NOT_ALLOWED);
        if (!AaveDeskLib.eligible(p, partnerId, msg.sender)) revert Refused(T.Reason.NOT_ELIGIBLE);
        if (lineOf[partnerId][msg.sender][reserveId] != 0) revert LineExists(lineOf[partnerId][msg.sender][reserveId]);

        if (p.signer != address(0)) {
            if (block.timestamp > deadline) revert AuthorizationExpired(deadline);
            bytes32 digest = _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        LINE_AUTHORIZATION_TYPEHASH, partnerId, msg.sender, reserveId, nonces[msg.sender]++, deadline
                    )
                )
            );
            if (!AaveDeskLib.isValidSignature(p.signer, digest, signature)) revert BadAuthorization();
        }

        lineId = ++lineCount;
        T.Line storage l = _lines[lineId];
        l.partnerId = partnerId;
        l.user = msg.sender;
        l.reserveId = reserveId.toUint32();
        l.collateral = info.underlying;
        l.policyVersion = p.policyVersion;
        l.status = T.LineStatus.OPEN;
        l.openedAt = uint64(block.timestamp);
        lineOf[partnerId][msg.sender][reserveId] = lineId;

        bytes32 h = _decide(lineId, "OPEN", 0, 0);
        emit LineOpened(lineId, partnerId, msg.sender, reserveId, p.policyVersion, h);
    }

    /// @notice Draw `amount` USDC to the line owner through the Taker. Refused with a reason code when
    ///         the session, the feed, the issuer, the venue, the policy or the capacity says no.
    function draw(uint256 lineId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        T.Line storage l = _line(lineId);
        if (msg.sender != l.user) revert NotLineOwner();
        T.Quote memory q = _quote(l, amount);
        if (q.reason != T.Reason.NONE) revert Refused(q.reason);

        AaveDeskLib.draw(_venue(), l, amount);

        uint128 a = amount.toUint128();
        l.drawnPrincipal += a;
        _partners[l.partnerId].exposure += a;
        _policies[l.partnerId][l.reserveId].exposure += a;

        bytes32 h = _decide(lineId, "DRAW", amount, q.price8);
        emit Drawn(lineId, amount, q.price8, q.session, h);
    }

    /// @notice Repay from `msg.sender`'s USDC onto the line owner's Aave position through the Giver.
    ///         Anyone may repay (the user, the partner, a keeper, the ProtectionVault). Works at any
    ///         hour: the Giver reads no oracle. Pass REPAY_ALL to clear the whole USDC debt.
    function repay(uint256 lineId, uint256 amount) external nonReentrant returns (uint256 repaid) {
        if (amount == 0) revert ZeroAmount();
        T.Line storage l = _line(lineId);
        bool full;
        (repaid, full) = AaveDeskLib.repay(_venue(), l, msg.sender, amount);

        uint128 principalDown = uint128(Math.min(repaid, l.drawnPrincipal));
        l.drawnPrincipal -= principalDown;
        T.Partner storage p = _partners[l.partnerId];
        p.exposure -= uint128(Math.min(principalDown, p.exposure));
        T.ReservePolicy storage t = _policies[l.partnerId][l.reserveId];
        t.exposure -= uint128(Math.min(principalDown, t.exposure));

        bytes32 h = _decide(lineId, "REPAY", repaid, 0);
        emit Repaid(lineId, msg.sender, repaid, full, h);
    }

    /// @notice Withdraw collateral to the line owner through the Taker. Session-gated like a draw, and
    ///         the line must stay within the policy LTV afterwards (Aave checks its own factor too).
    function withdrawCollateral(uint256 lineId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        T.Line storage l = _line(lineId);
        if (msg.sender != l.user) revert NotLineOwner();
        T.Quote memory q = _quote(l, 0);
        if (q.reason != T.Reason.NONE) revert Refused(q.reason);
        AaveDeskLib.withdrawCollateral(_venue(), l, q, amount);
        bytes32 h = _decide(lineId, "WITHDRAW_COLLATERAL", amount, q.price8);
        emit CollateralWithdrawn(lineId, amount, q.price8, q.session, h);
    }

    /// @notice Close a line whose desk principal is repaid. The user's Aave position is untouched.
    function closeLine(uint256 lineId) external nonReentrant {
        T.Line storage l = _line(lineId);
        if (msg.sender != l.user) revert NotLineOwner();
        if (l.status == T.LineStatus.CLOSED) revert Refused(T.Reason.LINE_NOT_OPEN);
        if (l.drawnPrincipal != 0) revert DebtOutstanding(l.drawnPrincipal);
        l.status = T.LineStatus.CLOSED;
        lineOf[l.partnerId][l.user][l.reserveId] = 0;
        bytes32 h = _decide(lineId, "CLOSE", 0, 0);
        emit LineClosed(lineId, h);
    }

    // ---------------------------------------------------------------- views

    function quote(uint256 lineId, uint256 amount) external view returns (T.Quote memory) {
        return _quote(_line(lineId), amount);
    }

    function capacity(uint256 lineId) external view returns (T.Quote memory) {
        return _quote(_line(lineId), 0);
    }

    function line(uint256 lineId) external view returns (T.Line memory) {
        return _line(lineId);
    }

    function partner(bytes32 partnerId) external view returns (T.Partner memory) {
        return _partners[partnerId];
    }

    function reservePolicy(bytes32 partnerId, uint256 reserveId) external view returns (T.ReservePolicy memory) {
        return _policies[partnerId][reserveId];
    }

    function reserve(uint256 reserveId) external view returns (ReserveInfo memory) {
        return _reserves[reserveId];
    }

    /// @notice The obligation status the record shows right now.
    function obligationStatus(uint256 lineId) external view returns (T.ObligationStatus) {
        return AaveDeskLib.obligationStatus(_venue(), _lines[lineId]);
    }

    /// @notice The calls a user batches to enrol: approve the Taker and the Giver on the spoke, grant
    ///         this desk a borrow allowance, and optionally grant `vault` a withdraw allowance on the
    ///         collateral reserve for Monday recovery. Signature variants are in `AaveEnrolment`.
    function enrolmentCalls(uint256 reserveId, uint256 borrowCap, address vault, uint256 withdrawCap)
        external
        view
        returns (AaveEnrolment.Call[] memory)
    {
        return AaveEnrolment.batch(
            address(SPOKE),
            address(TAKER),
            address(GIVER),
            address(this),
            vault,
            LOAN_RESERVE_ID,
            reserveId,
            borrowCap,
            vault == address(0) ? 0 : withdrawCap
        );
    }

    /// @notice Whether `user` has done each enrolment step for this desk.
    function enrolment(address user, uint256 reserveId)
        external
        view
        returns (bool takerApproved, bool giverApproved, uint256 borrowAllowance, uint256 withdrawAllowance)
    {
        takerApproved = SPOKE.isPositionManager(user, address(TAKER));
        giverApproved = SPOKE.isPositionManager(user, address(GIVER));
        borrowAllowance = TAKER.borrowAllowance(address(SPOKE), LOAN_RESERVE_ID, user, address(this));
        withdrawAllowance = TAKER.withdrawAllowance(address(SPOKE), reserveId, user, address(this));
    }

    function lineAuthorizationDigest(
        bytes32 partnerId,
        address user,
        uint256 reserveId,
        uint256 nonce,
        uint256 deadline
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(LINE_AUTHORIZATION_TYPEHASH, partnerId, user, reserveId, nonce, deadline))
        );
    }

    // ---------------------------------------------------------------- internals

    function _line(uint256 lineId) internal view returns (T.Line storage l) {
        l = _lines[lineId];
        if (l.status == T.LineStatus.NONE) revert UnknownLine(lineId);
    }

    function _quote(T.Line storage l, uint256 amount) internal view returns (T.Quote memory) {
        ReserveInfo storage info = _reserves[l.reserveId];
        return AaveDeskLib.quote(
            _venue(),
            l,
            _partners[l.partnerId],
            _policies[l.partnerId][l.reserveId],
            info.decimals,
            info.enabled,
            amount
        );
    }

    function _venue() internal view returns (AaveDeskLib.Venue memory) {
        return AaveDeskLib.Venue(SPOKE, TAKER, GIVER, GATE, LOAN_TOKEN, LOAN_RESERVE_ID, paused);
    }

    function _decide(uint256 lineId, bytes32 action, uint256 amount, uint256 price8) internal returns (bytes32 h) {
        h = keccak256(
            abi.encode(block.chainid, address(this), lineId, action, amount, price8, block.timestamp, ++_decisionNonce)
        );
        emit Decision(lineId, action, h, amount, price8);
    }
}
