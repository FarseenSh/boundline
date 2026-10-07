// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMorpho} from "morpho-blue/interfaces/IMorpho.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IPriceGate} from "../interfaces/IPriceGate.sol";
import {SessionGate} from "../oracle/SessionGate.sol";
import {CreditDesk} from "../desk/CreditDesk.sol";
import {IAdvanceSink} from "./IAdvanceSink.sol";

/// @title DeskProtectionVault
/// @notice Seven-day-a-week protection for CreditDesk lines on Morpho: the `ProtectionVault`'s shape over
///         the desk's self-custody lines. A protective repay is the one action that is safe on a held
///         price: the desk's `repay` is callable by anyone, Morpho's `repay` reads no oracle, and it can
///         only help the borrower. The keeper calls `protect` when the shadow health (the 24/7 DEX price)
///         crosses the grace line, and the vault pays for it down the funding ladder:
///           1. the user's own USDC reserve in this vault,
///           2. the partner's reserve,
///           3. a bounded vault advance (funded by the Boundline Reserve), recorded against the line and
///              settled later: by anyone in USDC (`repayAdvance`), or from collateral the vault recovers
///              through the desk in the next open session (`recover`, which runs the desk's keeper-only
///              `recoverCollateral` under the user's existing Morpho authorisation of the desk) and sells
///              at that session's fresh price.
///         Nothing is advanced unsecured: an advance needs a recovery route, and the desk's recovery is
///         session-gated and policy-bound (the line must stay within its policy LTV afterwards).
///
///         Five-way conservation, kept by every function and checked by the invariant suite:
///         USDC held == user reserves + partner reserves + free advance liquidity + collected fees;
///         advanced == settled + outstanding, per line and in total; per-line outstanding never exceeds
///         the cap; recovered collateral is held per line and only returned to that line's owner.
contract DeskProtectionVault is Ownable2Step, ReentrancyGuard, IAdvanceSink {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using MorphoBalancesLib for IMorpho;

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

    CreditDesk public immutable DESK;
    IMorpho public immutable MORPHO;
    SessionGate public immutable GATE;
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
    /// @notice USDC the vault owns and may advance; placed by the owner or the funder.
    uint256 public advanceLiquidity;
    uint256 public advanceCapPerLine;
    uint16 public advanceFeeBps;
    uint256 public feesCollected;
    uint256 public totalOutstanding;
    uint256 public totalAdvanced;
    uint256 public totalSettled;
    mapping(uint256 => Advance) private _advances;
    /// @notice Collateral recovered through the desk and held for the line until it is sold or returned.
    mapping(uint256 => uint256) public heldCollateral;

    // ---------------------------------------------------------------- events

    event KeeperSet(address indexed keeper);
    event FunderSet(address indexed funder);
    event PausedSet(bool paused);
    event PartnerAdminSet(bytes32 indexed partnerId, address indexed admin);
    event AdvanceTermsSet(uint256 capPerLine, uint16 feeBps);
    event UserDeposited(address indexed user, address indexed from, uint256 amount);
    event UserWithdrawn(address indexed user, uint256 amount);
    event PartnerDeposited(bytes32 indexed partnerId, address indexed from, uint256 amount);
    event PartnerWithdrawn(bytes32 indexed partnerId, address indexed to, uint256 amount);
    event AdvancesFunded(address indexed from, uint256 amount);
    event AdvancesDefunded(address indexed to, uint256 amount);
    event FeesCollected(address indexed to, uint256 amount);
    event Protected(
        uint256 indexed lineId,
        address indexed user,
        bytes32 indexed partnerId,
        uint256 repaid,
        uint256 fromUser,
        uint256 fromPartner,
        uint256 fromAdvance,
        uint256 debtBefore,
        uint256 debtAfter,
        bytes32 decisionHash
    );
    event AdvanceSettled(
        uint256 indexed lineId,
        address indexed payer,
        uint256 principal,
        uint256 fee,
        uint256 outstandingAfter,
        bytes32 decisionHash
    );
    event CollateralRecovered(
        uint256 indexed lineId,
        address indexed user,
        address token,
        uint256 amount,
        uint256 price8,
        bytes32 decisionHash
    );
    event CollateralReturned(
        uint256 indexed lineId, address indexed user, address token, uint256 amount, bytes32 decisionHash
    );
    event Decision(uint256 indexed lineId, bytes32 indexed action, bytes32 decisionHash, uint256 amount);

    // ---------------------------------------------------------------- errors

    error ZeroAddress();
    error ZeroAmount();
    error NotKeeper();
    error NotFunder();
    error NotPartnerAdmin();
    error Paused();
    error LineNotOpen(uint256 lineId);
    error LoanTokenMismatch(address loanToken);
    error NothingToProtect(uint256 lineId);
    error InsufficientBalance(uint256 balance, uint256 requested);
    error AdvanceCapExceeded(uint256 outstanding, uint256 requested, uint256 cap);
    error NoAdvanceOutstanding(uint256 lineId);
    error FeeTooHigh(uint16 feeBps);
    error Refused(CreditDesk.Reason reason);
    error NotTheDeskVault(address registered);

    // ---------------------------------------------------------------- constructor

    constructor(address initialOwner, CreditDesk desk, IERC20 usdc, address initialKeeper) Ownable(initialOwner) {
        if (address(desk) == address(0) || address(usdc) == address(0)) revert ZeroAddress();
        DESK = desk;
        MORPHO = desk.MORPHO();
        GATE = desk.GATE();
        USDC = usdc;
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

    function setAdvanceTerms(uint256 capPerLine, uint16 feeBps) external onlyOwner {
        if (feeBps > MAX_ADVANCE_FEE_BPS) revert FeeTooHigh(feeBps);
        advanceCapPerLine = capPerLine;
        advanceFeeBps = feeBps;
        emit AdvanceTermsSet(capPerLine, feeBps);
    }

    // ---------------------------------------------------------------- funder (the Reserve)

    modifier onlyFunder() {
        if (msg.sender != owner() && msg.sender != funder) revert NotFunder();
        _;
    }

    /// @notice USDC the vault may advance, from the owner or the funder. Only free liquidity (not yet
    ///         advanced) can be taken back.
    function fundAdvances(uint256 amount) external onlyFunder {
        if (amount == 0) revert ZeroAmount();
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        advanceLiquidity += amount;
        emit AdvancesFunded(msg.sender, amount);
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

    /// @notice Repay up to `amount` of the line's USDC debt through the desk, funded down the ladder.
    ///         Works at any hour. Returns what was actually repaid (a full repay is settled by shares).
    function protect(uint256 lineId, uint256 amount)
        external
        onlyKeeper
        nonReentrant
        returns (uint256 repaid, Funding memory f)
    {
        if (amount == 0) revert ZeroAmount();
        CreditDesk.Line memory l = DESK.line(lineId);
        if (l.status == CreditDesk.LineStatus.CLOSED) revert LineNotOpen(lineId);
        CreditDesk.MarketConfig memory m = DESK.market(l.marketId);
        if (m.params.loanToken != address(USDC)) revert LoanTokenMismatch(m.params.loanToken);
        uint256 debtBefore = MORPHO.expectedBorrowAssets(m.params, l.user);
        if (debtBefore == 0) revert NothingToProtect(lineId);
        uint256 want = Math.min(amount, debtBefore);

        f = previewProtect(lineId, want);
        if (f.shortfall != 0) {
            if (paused && f.fromAdvance == 0) revert Paused();
            revert AdvanceCapExceeded(
                _advances[lineId].outstanding, want - f.fromUser - f.fromPartner, advanceCapPerLine
            );
        }
        if (paused && f.fromAdvance != 0) revert Paused();

        userBalance[l.user] -= f.fromUser;
        partnerBalance[l.partnerId] -= f.fromPartner;
        advanceLiquidity -= f.fromAdvance;

        USDC.forceApprove(address(DESK), want);
        repaid = DESK.repay(lineId, want);
        USDC.forceApprove(address(DESK), 0);

        // Anything the desk left unpulled goes back up the ladder: advance first, then partner, then user.
        uint256 unused = want - repaid;
        if (unused != 0) {
            uint256 back = Math.min(unused, f.fromAdvance);
            f.fromAdvance -= back;
            advanceLiquidity += back;
            unused -= back;
            back = Math.min(unused, f.fromPartner);
            f.fromPartner -= back;
            partnerBalance[l.partnerId] += back;
            unused -= back;
            f.fromUser -= unused;
            userBalance[l.user] += unused;
        }
        if (f.fromAdvance != 0) _recordAdvance(lineId, f.fromAdvance);

        uint256 debtAfter = MORPHO.expectedBorrowAssets(m.params, l.user);
        bytes32 h = _decide(lineId, "PROTECT", repaid);
        emit Protected(
            lineId, l.user, l.partnerId, repaid, f.fromUser, f.fromPartner, f.fromAdvance, debtBefore, debtAfter, h
        );
    }

    /// @notice Recover collateral for an outstanding advance through the desk, into this vault, only in an
    ///         open session with a fresh feed (the sale that settles the advance happens at that price,
    ///         never at a held one). The desk must have registered this vault as its protection vault, and
    ///         it re-checks the session and the line's policy LTV itself.
    function recover(uint256 lineId, uint256 amount) external onlyKeeper nonReentrant returns (uint256 withdrawn) {
        if (paused) revert Paused();
        if (amount == 0) revert ZeroAmount();
        if (_advances[lineId].outstanding == 0) revert NoAdvanceOutstanding(lineId);
        address registered = DESK.protectionVault();
        if (registered != address(this)) revert NotTheDeskVault(registered);
        CreditDesk.Line memory l = DESK.line(lineId);
        IPriceGate.Verdict memory v = GATE.check(l.collateral);
        if (v.state != IPriceGate.GateState.OPEN) revert Refused(_gateReason(v.state));
        uint256 before = IERC20(l.collateral).balanceOf(address(this));
        DESK.recoverCollateral(lineId, amount);
        withdrawn = IERC20(l.collateral).balanceOf(address(this)) - before;
        heldCollateral[lineId] += withdrawn;
        bytes32 h = _decide(lineId, "RECOVER", withdrawn);
        emit CollateralRecovered(lineId, l.user, l.collateral, withdrawn, uint256(v.answer), h);
    }

    /// @notice Give recovered collateral back to the line's owner (after the advance is settled, or when
    ///         the keeper recovered more than the sale needed).
    function returnCollateral(uint256 lineId, uint256 amount) external onlyKeeper nonReentrant {
        uint256 held = heldCollateral[lineId];
        if (amount == 0) revert ZeroAmount();
        if (amount > held) revert InsufficientBalance(held, amount);
        CreditDesk.Line memory l = DESK.line(lineId);
        heldCollateral[lineId] = held - amount;
        IERC20(l.collateral).safeTransfer(l.user, amount);
        emit CollateralReturned(lineId, l.user, l.collateral, amount, _decide(lineId, "RETURN_COLLATERAL", amount));
    }

    // ---------------------------------------------------------------- settlement

    /// @notice Settle a line's advance in USDC: principal first, then the fee. Anyone may pay (the user,
    ///         the partner, the keeper after selling recovered collateral). Overpayment is not pulled.
    function repayAdvance(uint256 lineId, uint256 amount)
        external
        nonReentrant
        returns (uint256 principal, uint256 fee)
    {
        Advance storage a = _advances[lineId];
        if (amount == 0) revert ZeroAmount();
        if (a.outstanding == 0 && a.feeOutstanding == 0) revert NoAdvanceOutstanding(lineId);
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
            lineId, msg.sender, principal, fee, a.outstanding, _decide(lineId, "SETTLE_ADVANCE", principal + fee)
        );
    }

    // ---------------------------------------------------------------- views

    /// @notice How `amount` would be funded right now. `shortfall` is what the ladder cannot cover.
    function previewProtect(uint256 lineId, uint256 amount) public view returns (Funding memory f) {
        CreditDesk.Line memory l = DESK.line(lineId);
        f.fromUser = Math.min(amount, userBalance[l.user]);
        uint256 rest = amount - f.fromUser;
        f.fromPartner = Math.min(rest, partnerBalance[l.partnerId]);
        rest -= f.fromPartner;
        if (rest != 0) {
            uint256 room = advanceLiquidity;
            uint256 outstanding = _advances[lineId].outstanding;
            if (advanceCapPerLine != 0) {
                room = Math.min(room, advanceCapPerLine > outstanding ? advanceCapPerLine - outstanding : 0);
            }
            f.fromAdvance = Math.min(rest, room);
            rest -= f.fromAdvance;
        }
        f.shortfall = rest;
    }

    function advanceOf(uint256 lineId) external view returns (Advance memory) {
        return _advances[lineId];
    }

    /// @notice The line's debt on Morpho right now (interest accrued), the number `protect` works from.
    function debtOf(uint256 lineId) external view returns (uint256) {
        CreditDesk.Line memory l = DESK.line(lineId);
        return MORPHO.expectedBorrowAssets(DESK.market(l.marketId).params, l.user);
    }

    // ---------------------------------------------------------------- internals

    function _depositFor(address user, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        userBalance[user] += amount;
        emit UserDeposited(user, msg.sender, amount);
    }

    function _recordAdvance(uint256 lineId, uint256 amount) internal {
        Advance storage a = _advances[lineId];
        uint256 fee = Math.mulDiv(amount, advanceFeeBps, BPS);
        a.outstanding += amount.toUint128();
        a.feeOutstanding += fee.toUint128();
        a.totalAdvanced += amount.toUint128();
        a.lastAdvanceAt = uint64(block.timestamp);
        totalOutstanding += amount;
        totalAdvanced += amount;
    }

    function _gateReason(IPriceGate.GateState s) internal pure returns (CreditDesk.Reason) {
        if (s == IPriceGate.GateState.MARKET_CLOSED) return CreditDesk.Reason.MARKET_CLOSED;
        if (s == IPriceGate.GateState.FEED_PAUSED) return CreditDesk.Reason.FEED_PAUSED;
        if (s == IPriceGate.GateState.TRANSFER_PAUSED) return CreditDesk.Reason.TRANSFER_PAUSED;
        if (s == IPriceGate.GateState.FEED_STALE) return CreditDesk.Reason.FEED_STALE;
        if (s == IPriceGate.GateState.FEED_INVALID) return CreditDesk.Reason.FEED_INVALID;
        return CreditDesk.Reason.UNKNOWN_TOKEN;
    }

    function _decide(uint256 lineId, bytes32 action, uint256 amount) internal returns (bytes32 h) {
        h = keccak256(
            abi.encode(block.chainid, address(this), lineId, action, amount, block.timestamp, ++_decisionNonce)
        );
        emit Decision(lineId, action, h, amount);
    }
}
