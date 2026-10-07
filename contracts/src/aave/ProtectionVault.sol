// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceGate} from "../interfaces/IPriceGate.sol";
import {SessionGate} from "../oracle/SessionGate.sol";
import {IAaveSpoke, ITakerPositionManager, IGiverPositionManager} from "./interfaces/IAaveV4.sol";
import {AaveTypes as T} from "./AaveTypes.sol";
import {IAdvanceSink} from "../reserve/IAdvanceSink.sol";

/// @title ProtectionVault
/// @notice Seven-day-a-week protection for Aave V4 positions. A protective repay is the one action that
///         is safe on a held price: Aave's Giver `repayOnBehalfOf` reads no oracle, is callable by anyone
///         once the user approved the Giver on the spoke, and can only help the borrower. The keeper
///         calls `protect` when the shadow health (the 24/7 DEX price) or a scenario stress crosses the
///         grace line, and the vault pays for it down a funding ladder:
///           1. the user's own USDC reserve in this vault,
///           2. the partner's reserve,
///           3. a bounded vault advance, recorded against the user and settled later: by the user in
///              USDC (`repayAdvance`), or from collateral the vault recovers through the Taker in the
///              next open session (`recover`, which needs the user's `approveWithdraw`) and sells there.
///         Nothing is ever advanced unsecured to a stranger: an advance needs a recovery route, which
///         is why `recover` is session-gated by the SessionGate (a sale at a held price is refused).
///
///         Five-way conservation, kept by every function and checked by the invariant suite:
///         USDC held == user reserves + partner reserves + free advance liquidity + collected fees;
///         advanced == settled + outstanding, per user and in total; per-user outstanding never exceeds
///         the cap; recovered collateral is held per user and only returned or sold for that user.
contract ProtectionVault is Ownable2Step, ReentrancyGuard, IAdvanceSink {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ---------------------------------------------------------------- types

    struct Advance {
        uint128 outstanding; // principal advanced and not yet settled
        uint128 feeOutstanding; // advance fee accrued and not yet paid
        uint128 totalAdvanced;
        uint128 totalSettled;
        uint64 lastAdvanceAt;
        uint64 lastSettledAt;
    }

    struct Funding {
        uint256 fromUser;
        uint256 fromPartner;
        uint256 fromAdvance;
        uint256 shortfall; // only in previews: what the ladder cannot cover
    }

    // ---------------------------------------------------------------- constants, immutables

    uint256 public constant MAX_ADVANCE_FEE_BPS = 500;
    uint256 internal constant BPS = 10_000;

    IAaveSpoke public immutable SPOKE;
    ITakerPositionManager public immutable TAKER;
    IGiverPositionManager public immutable GIVER;
    SessionGate public immutable GATE;
    uint256 public immutable LOAN_RESERVE_ID;
    IERC20 public immutable USDC;

    // ---------------------------------------------------------------- storage

    address public keeper;
    /// @notice The Boundline Reserve (or any funder) allowed to place, recall and harvest advance liquidity.
    address public funder;
    bool public paused;
    uint256 private _decisionNonce;

    mapping(address => uint256) public userBalance;
    mapping(bytes32 => uint256) public partnerBalance;
    mapping(bytes32 => address) public partnerAdmin;
    /// @notice USDC the vault owns and may advance; funded by the owner (the Boundline Reserve).
    uint256 public advanceLiquidity;
    uint256 public advanceCapPerUser;
    uint16 public advanceFeeBps;
    uint256 public feesCollected;
    uint256 public totalOutstanding;
    uint256 public totalAdvanced;
    uint256 public totalSettled;
    mapping(address => Advance) private _advances;
    /// @notice Collateral recovered through the Taker and held for the user until it is sold or returned.
    mapping(address => mapping(address => uint256)) public heldCollateral;

    // ---------------------------------------------------------------- events

    event KeeperSet(address indexed keeper);
    event FunderSet(address indexed funder);
    event PausedSet(bool paused);
    event PartnerAdminSet(bytes32 indexed partnerId, address indexed admin);
    event AdvanceTermsSet(uint256 capPerUser, uint16 feeBps);
    event UserDeposited(address indexed user, address indexed from, uint256 amount);
    event UserWithdrawn(address indexed user, uint256 amount);
    event PartnerDeposited(bytes32 indexed partnerId, address indexed from, uint256 amount);
    event PartnerWithdrawn(bytes32 indexed partnerId, address indexed to, uint256 amount);
    event AdvancesFunded(uint256 amount);
    event AdvancesDefunded(address indexed to, uint256 amount);
    event FeesCollected(address indexed to, uint256 amount);
    event Protected(
        address indexed user,
        bytes32 indexed partnerId,
        uint256 repaid,
        uint256 fromUser,
        uint256 fromPartner,
        uint256 fromAdvance,
        uint256 healthBefore,
        uint256 healthAfter,
        bytes32 decisionHash
    );
    event AdvanceSettled(
        address indexed user,
        address indexed payer,
        uint256 principal,
        uint256 fee,
        uint256 outstandingAfter,
        bytes32 decisionHash
    );
    event CollateralRecovered(
        address indexed user,
        uint256 indexed reserveId,
        address token,
        uint256 amount,
        uint256 price8,
        bytes32 decisionHash
    );
    event CollateralReturned(address indexed user, address indexed token, uint256 amount, bytes32 decisionHash);
    event Decision(address indexed user, bytes32 indexed action, bytes32 decisionHash, uint256 amount);

    // ---------------------------------------------------------------- errors

    error ZeroAddress();
    error ZeroAmount();
    error NotKeeper();
    error NotFunder();
    error NotPartnerAdmin();
    error Paused();
    error ManagerNotActive(address manager);
    error SpokeNotRegistered(address manager);
    error NotEnrolled(address user, address manager);
    error NothingToProtect(address user);
    error InsufficientBalance(uint256 balance, uint256 requested);
    error InsufficientAdvanceLiquidity(uint256 available, uint256 requested);
    error AdvanceCapExceeded(uint256 outstanding, uint256 requested, uint256 cap);
    error NoAdvanceOutstanding(address user);
    error FeeTooHigh(uint16 feeBps);
    error Refused(T.Reason reason);
    error InsufficientWithdrawAllowance(uint256 allowance, uint256 requested);

    // ---------------------------------------------------------------- constructor

    constructor(
        address initialOwner,
        IAaveSpoke spoke,
        ITakerPositionManager taker,
        IGiverPositionManager giver,
        SessionGate gate,
        uint256 loanReserveId,
        address initialKeeper
    ) Ownable(initialOwner) {
        if (
            address(spoke) == address(0) || address(taker) == address(0) || address(giver) == address(0)
                || address(gate) == address(0)
        ) revert ZeroAddress();
        if (!spoke.isPositionManagerActive(address(giver))) revert ManagerNotActive(address(giver));
        if (!spoke.isPositionManagerActive(address(taker))) revert ManagerNotActive(address(taker));
        if (!giver.isSpokeRegistered(address(spoke))) revert SpokeNotRegistered(address(giver));
        if (!taker.isSpokeRegistered(address(spoke))) revert SpokeNotRegistered(address(taker));
        SPOKE = spoke;
        TAKER = taker;
        GIVER = giver;
        GATE = gate;
        LOAN_RESERVE_ID = loanReserveId;
        USDC = IERC20(spoke.getReserve(loanReserveId).underlying);
        keeper = initialKeeper;
    }

    // ---------------------------------------------------------------- owner

    function setKeeper(address newKeeper) external onlyOwner {
        keeper = newKeeper;
        emit KeeperSet(newKeeper);
    }

    /// @notice The funder shares the owner's rights over advance liquidity and fees, nothing else.
    function setFunder(address newFunder) external onlyOwner {
        funder = newFunder;
        emit FunderSet(newFunder);
    }

    modifier onlyFunder() {
        if (msg.sender != owner() && msg.sender != funder) revert NotFunder();
        _;
    }

    /// @notice Pausing stops new advances and recoveries. Deposits, withdrawals and protection funded
    ///         from the user's or the partner's own reserve keep working.
    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    function setPartnerAdmin(bytes32 partnerId, address admin) external onlyOwner {
        partnerAdmin[partnerId] = admin;
        emit PartnerAdminSet(partnerId, admin);
    }

    function setAdvanceTerms(uint256 capPerUser, uint16 feeBps) external onlyOwner {
        if (feeBps > MAX_ADVANCE_FEE_BPS) revert FeeTooHigh(feeBps);
        advanceCapPerUser = capPerUser;
        advanceFeeBps = feeBps;
        emit AdvanceTermsSet(capPerUser, feeBps);
    }

    /// @notice USDC the vault may advance, from the owner or the funder (the Boundline Reserve). Only free
    ///         liquidity (not yet advanced) can be taken back.
    function fundAdvances(uint256 amount) external onlyFunder {
        if (amount == 0) revert ZeroAmount();
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        advanceLiquidity += amount;
        emit AdvancesFunded(amount);
    }

    function defundAdvances(uint256 amount, address to) external onlyFunder nonReentrant {
        if (amount > advanceLiquidity) revert InsufficientBalance(advanceLiquidity, amount);
        advanceLiquidity -= amount;
        USDC.safeTransfer(to, amount);
        emit AdvancesDefunded(to, amount);
    }

    function collectFees(address to) external onlyFunder nonReentrant {
        uint256 amount = feesCollected;
        feesCollected = 0;
        USDC.safeTransfer(to, amount);
        emit FeesCollected(to, amount);
    }

    // ---------------------------------------------------------------- reserves

    function deposit(uint256 amount) external {
        _depositFor(msg.sender, amount);
    }

    /// @notice Anyone may fund a user's protection reserve (a partner topping up, a keeper, a friend).
    function depositFor(address user, uint256 amount) external {
        if (user == address(0)) revert ZeroAddress();
        _depositFor(user, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        uint256 bal = userBalance[msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (amount > bal) revert InsufficientBalance(bal, amount);
        userBalance[msg.sender] = bal - amount;
        USDC.safeTransfer(msg.sender, amount);
        emit UserWithdrawn(msg.sender, amount);
    }

    function depositForPartner(bytes32 partnerId, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (partnerAdmin[partnerId] == address(0)) revert NotPartnerAdmin();
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        partnerBalance[partnerId] += amount;
        emit PartnerDeposited(partnerId, msg.sender, amount);
    }

    function withdrawPartner(bytes32 partnerId, uint256 amount, address to) external nonReentrant {
        if (partnerAdmin[partnerId] != msg.sender) revert NotPartnerAdmin();
        uint256 bal = partnerBalance[partnerId];
        if (amount == 0) revert ZeroAmount();
        if (amount > bal) revert InsufficientBalance(bal, amount);
        partnerBalance[partnerId] = bal - amount;
        USDC.safeTransfer(to, amount);
        emit PartnerWithdrawn(partnerId, to, amount);
    }

    // ---------------------------------------------------------------- keeper

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    /// @notice Repay up to `amount` of the user's USDC debt on the spoke through the Giver, funded down
    ///         the ladder. Works at any hour. Returns what was actually repaid (the Giver caps at debt).
    function protect(address user, bytes32 partnerId, uint256 amount)
        external
        onlyKeeper
        nonReentrant
        returns (uint256 repaid, Funding memory f)
    {
        if (amount == 0) revert ZeroAmount();
        if (!SPOKE.isPositionManager(user, address(GIVER))) revert NotEnrolled(user, address(GIVER));
        uint256 debt = SPOKE.getUserTotalDebt(LOAN_RESERVE_ID, user);
        if (debt == 0) revert NothingToProtect(user);
        uint256 want = Math.min(amount, debt);
        uint256 healthBefore = SPOKE.getUserAccountData(user).healthFactor;

        f = previewProtect(user, partnerId, want);
        if (f.shortfall != 0) {
            if (paused && f.fromAdvance == 0) revert Paused();
            revert AdvanceCapExceeded(_advances[user].outstanding, want - f.fromUser - f.fromPartner, advanceCapPerUser);
        }
        if (paused && f.fromAdvance != 0) revert Paused();

        userBalance[user] -= f.fromUser;
        partnerBalance[partnerId] -= f.fromPartner;
        advanceLiquidity -= f.fromAdvance;

        USDC.forceApprove(address(GIVER), want);
        (, repaid) = GIVER.repayOnBehalfOf(address(SPOKE), LOAN_RESERVE_ID, want, user);
        USDC.forceApprove(address(GIVER), 0);

        // Anything the Giver left unpulled goes back up the ladder: advance first, then partner, then user.
        uint256 unused = want - repaid;
        if (unused != 0) {
            uint256 back = Math.min(unused, f.fromAdvance);
            f.fromAdvance -= back;
            advanceLiquidity += back;
            unused -= back;
            back = Math.min(unused, f.fromPartner);
            f.fromPartner -= back;
            partnerBalance[partnerId] += back;
            unused -= back;
            f.fromUser -= unused;
            userBalance[user] += unused;
        }
        if (f.fromAdvance != 0) _recordAdvance(user, f.fromAdvance);

        uint256 healthAfter = SPOKE.getUserAccountData(user).healthFactor;
        bytes32 h = _decide(user, "PROTECT", repaid);
        emit Protected(user, partnerId, repaid, f.fromUser, f.fromPartner, f.fromAdvance, healthBefore, healthAfter, h);
    }

    /// @notice Recover collateral for an outstanding advance through the Taker, into this vault, only in
    ///         an open session with a fresh feed (the sale that settles the advance happens at that
    ///         price, never at a held one). Needs the user's `approveWithdraw` on the Taker.
    function recover(address user, uint256 reserveId, uint256 amount)
        external
        onlyKeeper
        nonReentrant
        returns (uint256 withdrawn)
    {
        if (paused) revert Paused();
        if (amount == 0) revert ZeroAmount();
        if (_advances[user].outstanding == 0) revert NoAdvanceOutstanding(user);
        address token = SPOKE.getReserve(reserveId).underlying;
        IPriceGate.Verdict memory v = GATE.check(token);
        if (v.state != IPriceGate.GateState.OPEN) revert Refused(_gateReason(v.state));
        uint256 allowance = TAKER.withdrawAllowance(address(SPOKE), reserveId, user, address(this));
        if (allowance < amount) revert InsufficientWithdrawAllowance(allowance, amount);
        (, withdrawn) = TAKER.withdrawOnBehalfOf(address(SPOKE), reserveId, amount, user);
        heldCollateral[user][token] += withdrawn;
        bytes32 h = _decide(user, "RECOVER", withdrawn);
        emit CollateralRecovered(user, reserveId, token, withdrawn, uint256(v.answer), h);
    }

    /// @notice Give recovered collateral back to its owner (after the advance is settled, or when the
    ///         keeper recovered more than the sale needed).
    function returnCollateral(address user, address token, uint256 amount) external onlyKeeper nonReentrant {
        uint256 held = heldCollateral[user][token];
        if (amount == 0) revert ZeroAmount();
        if (amount > held) revert InsufficientBalance(held, amount);
        heldCollateral[user][token] = held - amount;
        IERC20(token).safeTransfer(user, amount);
        emit CollateralReturned(user, token, amount, _decide(user, "RETURN_COLLATERAL", amount));
    }

    // ---------------------------------------------------------------- settlement

    /// @notice Settle a user's advance in USDC: principal first, then the fee. Anyone may pay (the user,
    ///         the partner, the keeper after selling recovered collateral). Overpayment is not pulled.
    function repayAdvance(address user, uint256 amount) external nonReentrant returns (uint256 principal, uint256 fee) {
        Advance storage a = _advances[user];
        if (amount == 0) revert ZeroAmount();
        if (a.outstanding == 0 && a.feeOutstanding == 0) revert NoAdvanceOutstanding(user);
        principal = Math.min(amount, a.outstanding);
        fee = Math.min(amount - principal, a.feeOutstanding);
        USDC.safeTransferFrom(msg.sender, address(this), principal + fee);
        a.outstanding -= principal.toUint128();
        a.feeOutstanding -= fee.toUint128();
        a.totalSettled += principal.toUint128();
        a.lastSettledAt = uint64(block.timestamp);
        totalOutstanding -= principal;
        totalSettled += principal;
        advanceLiquidity += principal;
        feesCollected += fee;
        emit AdvanceSettled(
            user, msg.sender, principal, fee, a.outstanding, _decide(user, "SETTLE_ADVANCE", principal + fee)
        );
    }

    // ---------------------------------------------------------------- views

    /// @notice How `amount` would be funded right now. `shortfall` is what the ladder cannot cover.
    function previewProtect(address user, bytes32 partnerId, uint256 amount) public view returns (Funding memory f) {
        f.fromUser = Math.min(amount, userBalance[user]);
        uint256 rest = amount - f.fromUser;
        f.fromPartner = Math.min(rest, partnerBalance[partnerId]);
        rest -= f.fromPartner;
        if (rest != 0) {
            uint256 room = advanceLiquidity;
            uint256 outstanding = _advances[user].outstanding;
            if (advanceCapPerUser != 0) {
                room = Math.min(room, advanceCapPerUser > outstanding ? advanceCapPerUser - outstanding : 0);
            }
            f.fromAdvance = Math.min(rest, room);
            rest -= f.fromAdvance;
        }
        f.shortfall = rest;
    }

    function advanceOf(address user) external view returns (Advance memory) {
        return _advances[user];
    }

    /// @notice Which managers the user has approved, and how much collateral this vault may recover.
    function enrolment(address user, uint256 reserveId)
        external
        view
        returns (bool giverApproved, bool takerApproved, uint256 withdrawAllowance)
    {
        giverApproved = SPOKE.isPositionManager(user, address(GIVER));
        takerApproved = SPOKE.isPositionManager(user, address(TAKER));
        withdrawAllowance = TAKER.withdrawAllowance(address(SPOKE), reserveId, user, address(this));
    }

    // ---------------------------------------------------------------- internals

    function _depositFor(address user, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        userBalance[user] += amount;
        emit UserDeposited(user, msg.sender, amount);
    }

    function _recordAdvance(address user, uint256 amount) internal {
        Advance storage a = _advances[user];
        uint256 fee = Math.mulDiv(amount, advanceFeeBps, BPS);
        a.outstanding += amount.toUint128();
        a.feeOutstanding += fee.toUint128();
        a.totalAdvanced += amount.toUint128();
        a.lastAdvanceAt = uint64(block.timestamp);
        totalOutstanding += amount;
        totalAdvanced += amount;
    }

    function _gateReason(IPriceGate.GateState s) internal pure returns (T.Reason) {
        if (s == IPriceGate.GateState.MARKET_CLOSED) return T.Reason.MARKET_CLOSED;
        if (s == IPriceGate.GateState.FEED_PAUSED) return T.Reason.FEED_PAUSED;
        if (s == IPriceGate.GateState.TRANSFER_PAUSED) return T.Reason.TRANSFER_PAUSED;
        if (s == IPriceGate.GateState.FEED_STALE) return T.Reason.FEED_STALE;
        if (s == IPriceGate.GateState.FEED_INVALID) return T.Reason.FEED_INVALID;
        return T.Reason.UNKNOWN_TOKEN;
    }

    function _decide(address user, bytes32 action, uint256 amount) internal returns (bytes32 h) {
        h = keccak256(abi.encode(block.chainid, address(this), user, action, amount, block.timestamp, ++_decisionNonce));
        emit Decision(user, action, h, amount);
    }
}
