// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMorpho, MarketParams, Id, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {IMorphoFlashLoanCallback} from "morpho-blue/interfaces/IMorphoCallbacks.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IPriceGate} from "../interfaces/IPriceGate.sol";
import {TickMath} from "../libraries/TickMath.sol";
import {ICLSwapPool, IUniswapV3SwapCallback} from "../protection/interfaces/ICLSwapPool.sol";
import {CreditDesk} from "../desk/CreditDesk.sol";

/// @title DividendHarvester
/// @notice The self-repaying leg: each cash dividend a Coinbase tokenized stock pays (as shares, through a
///         multiplier update) repays the loan against it, in the next open session, without touching the
///         borrower's share count.
///
///         What a dividend does on chain (verified 8 Oct 2026 on Base mainnet). Coinbase converts a cash
///         dividend into shares and raises the token's multiplier; raw balances never change (ERC-8056: the UI
///         multiplier "rescales the displayed balance without minting, transferring, or rewriting any raw
///         balance"), and one token is redeemable for `multiplier` shares. Chainlink's Coinbase feeds report
///         the token's total return value, "the underlying equity's market price with a multiplier read from
///         Coinbase's on-chain oracle registry" (docs.chain.link, tokenized-equity-feeds/coinbase). On mainnet
///         `OracleRegistry.getOracleParams(token).multiplier` equals the token's own `multiplier()` (AAPLc 1.0,
///         GOOGLc 1.000377118676784179, METAc 1.000313792289598084, NVDAc 1.000537939576369481), and each moved
///         once, in a single issuer `announce` bracket: NVDAc's "Cash Dividend" (Coinbase corporate action
///         0d25ab63…92da) is tx 0x7aef5d12…5ddcd in block 52,041,960 (1 Oct 2026 16:47:47 UTC), 1.0 →
///         1.000537939576369481, effective at once.
///
///         So a venue that values `raw balance × feed` (MorphoChainlinkOracleV2, the Aave V4 spoke, Boundline's
///         SessionGuard) already counts every dividend; applying the multiplier to the feed again is the double
///         count v1 made, and nothing here does it. There is no hidden collateral to discover. What a borrower
///         gives up by leaving the dividend reinvested is the cash a normal share would have paid out. The
///         dividend-equivalent collateral since a base multiplier `m0` is therefore
///
///             dividendRaw = raw × (m1 − m0) / m1,
///
///         the tokens whose value equals the dividend at the current price. Selling them leaves `raw × m0 / m1`
///         tokens, which are worth exactly the `raw × m0` shares held at `m0`: the borrower keeps their share
///         count and the dividend is swept into the loan, as a cash dividend applied to debt would be.
///
///         Splits move the multiplier too (Chainlink: the registry pauses, the action executes, the multiplier
///         becomes 10.0, the registry unpauses), so only a bounded rise counts as a dividend: a step above
///         `maxStepBps`, any fall, and a mode that keeps dividends as shares re-base `m0` without selling, and
///         nothing runs while the gate is not OPEN (a paused registry is FEED_PAUSED).
///
///         Mechanics, all in one transaction and only in an OPEN session (the sale gate): a Morpho flash loan
///         of the repayment; the repayment through `CreditDesk.repay` for a desk line (the desk's principal and
///         exposure stay true) or `Morpho.repay` for a plain position, so health improves first; Morpho
///         `withdrawCollateral` of at most `dividendRaw` (the borrower authorised this contract on Morpho);
///         an exact-output sale on the collateral's own pool with a price floor `maxSlippageBps` under the
///         gate's price; any unsold collateral supplied back to the position; the flash loan repaid. The
///         position's LTV afterwards may not exceed its LTV before.
///
///         Authority: the borrower's Morpho authorisation lets this contract withdraw collateral and borrow
///         for them; its code withdraws only `dividendRaw` (bounded by the multiplier step), always after a
///         repayment of at least the sale's proceeds, and never borrows. The owner sets routes, the keeper and
///         two bounded parameters; it cannot move a position.
contract DividendHarvester is IMorphoFlashLoanCallback, IUniswapV3SwapCallback, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using MorphoBalancesLib for IMorpho;

    enum Mode {
        NONE,
        HARVEST, // dividends repay the loan
        HEADROOM // dividends stay as shares (the default B20 behaviour); harvest only re-bases
    }

    enum Standing {
        NOT_ENROLLED,
        GATE_CLOSED, // the sale gate: session, registry pause, transfer pause, stale or invalid feed
        NO_CHANGE, // the multiplier has not moved since the last harvest
        STEP_DOWN, // the multiplier fell (a reverse split or a correction): re-base, never sell
        STEP_TOO_LARGE, // a rise above maxStepBps is a split or another corporate action: re-base, never sell
        HEADROOM, // the borrower keeps dividends as shares: re-base
        NO_DEBT, // nothing to repay: the dividend stays as shares, re-base
        TOO_SMALL, // the dividend rounds to nothing yet: wait for the next one
        NOT_AUTHORIZED, // Morpho.isAuthorized(user, this) is false
        READY
    }

    struct Enrollment {
        uint128 baseMultiplier; // m0: the multiplier the last harvest (or the enrolment) settled at
        uint64 enrolledAt;
        uint64 lastHarvestAt;
        Mode mode;
        uint256 lineId; // CreditDesk line, 0 for a plain Morpho position
    }

    struct Route {
        ICLSwapPool pool;
        bool collateralIsToken0;
    }

    struct Preview {
        Standing standing;
        uint256 baseMultiplier;
        uint256 multiplier; // m1, the registry multiplier the gate read
        uint256 collateral; // raw collateral on the position
        uint256 debt; // loan units, interest accrued to now
        uint256 price8; // the gate's 8-decimal price, 0 when not OPEN
        uint256 dividendRaw; // raw collateral equal in value to the dividends since m0
        uint256 dividendValue; // its value in loan units at price8
        uint256 repayAssets; // what a harvest repays: min(debt, dividendValue less the slippage floor)
        bool fullRepay; // repayAssets clears the debt
    }

    /// @notice The tuple behind every `Harvested` decision hash: `keccak256(abi.encode(Decision))`.
    struct Decision {
        uint256 chainId;
        address harvester;
        address user;
        Id marketId;
        uint256 lineId;
        uint256 baseMultiplier;
        uint256 multiplier;
        uint256 dividendRaw;
        uint256 collateralSold;
        uint256 repaid;
        uint256 price8;
        uint256 timestamp;
        uint256 nonce;
    }

    struct Flash {
        address user;
        MarketParams params;
        uint256 lineId;
        uint256 dividendRaw;
        uint256 price8;
        bool fullRepay;
    }

    uint16 public constant MAX_STEP_BPS = 1000;
    uint16 public constant MAX_SLIPPAGE_BPS = 500;
    uint8 internal constant PRICE_DECIMALS = 8;

    IMorpho public immutable MORPHO;
    IPriceGate public immutable GATE;
    /// @notice The CreditDesk whose lines repay through `desk.repay`; zero when only plain positions are served.
    CreditDesk public immutable DESK;

    address public keeper;
    /// @notice Largest multiplier rise treated as a dividend, in bps of the base multiplier.
    uint16 public maxStepBps;
    /// @notice Floor on the sale price under the gate's price, in bps; also the haircut on what a harvest repays.
    uint16 public maxSlippageBps;
    /// @notice Harvests so far; part of every decision hash.
    uint256 public decisionCount;
    mapping(address collateral => Route) public routes;
    mapping(address user => mapping(Id => Enrollment)) private _enrollments;

    // Call-scoped state for the two callbacks; transient so nothing survives the transaction.
    bool private transient _inFlash;
    bool private transient _inSwap;
    address private transient _swapCollateral;
    uint256 private transient _swapMaxIn;
    uint256 private transient _sold;
    uint256 private transient _repaid;
    uint256 private transient _returned;

    event KeeperSet(address indexed keeper);
    event ParamsSet(uint16 maxStepBps, uint16 maxSlippageBps);
    event RouteSet(address indexed collateral, address indexed pool, bool collateralIsToken0);
    event Swept(address indexed token, address indexed to, uint256 amount);
    event Enrolled(address indexed user, Id indexed marketId, uint256 lineId, Mode mode, uint256 baseMultiplier);
    event ModeSet(address indexed user, Id indexed marketId, Mode mode);
    event Left(address indexed user, Id indexed marketId);
    event Rebased(
        address indexed user, Id indexed marketId, uint256 fromMultiplier, uint256 toMultiplier, Standing reason
    );
    event Harvested(
        uint256 indexed decision,
        address indexed user,
        Id indexed marketId,
        uint256 lineId,
        uint256 baseMultiplier,
        uint256 multiplier,
        uint256 dividendRaw,
        uint256 collateralSold,
        uint256 repaid,
        uint256 collateralReturned,
        uint256 price8,
        bytes32 decisionHash
    );

    error ZeroAddress();
    error NotOperator(address caller);
    error Expired(uint256 deadline);
    error BadParams(uint16 maxStepBps, uint16 maxSlippageBps);
    error PoolMismatch(address pool, address token0, address token1);
    error NoRoute(address collateral);
    error UnknownMarket(Id marketId);
    error NotLineOwner(uint256 lineId, address user);
    error LineMarketMismatch(uint256 lineId);
    error NoDesk();
    error NotEnrolled(address user, Id marketId);
    error AlreadyEnrolled(address user, Id marketId);
    error BadMode(Mode mode);
    error RegistryUnreadable(address collateral);
    error NotHarvestable(Standing standing);
    error UnexpectedCallback(address caller);
    error NothingOwed();
    error SlippageExceeded(uint256 owed, uint256 maxIn);
    error InsufficientOutput(uint256 received, uint256 needed);
    error LtvRose(uint256 debtBefore, uint256 collateralBefore, uint256 debtAfter, uint256 collateralAfter);

    modifier onlyOperator() {
        if (msg.sender != owner() && msg.sender != keeper) revert NotOperator(msg.sender);
        _;
    }

    constructor(address initialOwner, IMorpho morpho, IPriceGate gate, CreditDesk desk, address keeper_)
        Ownable(initialOwner)
    {
        if (address(morpho) == address(0) || address(gate) == address(0)) revert ZeroAddress();
        MORPHO = morpho;
        GATE = gate;
        DESK = desk;
        keeper = keeper_;
        maxStepBps = 500;
        maxSlippageBps = 100;
        emit KeeperSet(keeper_);
        emit ParamsSet(500, 100);
    }

    // ---------------------------------------------------------------- owner

    function setKeeper(address newKeeper) external onlyOwner {
        keeper = newKeeper;
        emit KeeperSet(newKeeper);
    }

    function setParams(uint16 maxStepBps_, uint16 maxSlippageBps_) external onlyOwner {
        if (maxStepBps_ == 0 || maxStepBps_ > MAX_STEP_BPS || maxSlippageBps_ > MAX_SLIPPAGE_BPS) {
            revert BadParams(maxStepBps_, maxSlippageBps_);
        }
        maxStepBps = maxStepBps_;
        maxSlippageBps = maxSlippageBps_;
        emit ParamsSet(maxStepBps_, maxSlippageBps_);
    }

    /// @notice Bind the pool `collateral` is sold on; the market's loan token must be its other side (checked
    ///         at harvest time against the market).
    function setRoute(address collateral, ICLSwapPool pool) external onlyOwner {
        if (collateral == address(0) || address(pool) == address(0)) revert ZeroAddress();
        address t0 = pool.token0();
        address t1 = pool.token1();
        if (t0 != collateral && t1 != collateral) revert PoolMismatch(address(pool), t0, t1);
        routes[collateral] = Route({pool: pool, collateralIsToken0: t0 == collateral});
        emit RouteSet(collateral, address(pool), t0 == collateral);
    }

    /// @notice Recover dust sent here by mistake. The contract holds nothing of a borrower's between transactions.
    function sweep(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit Swept(address(token), to, amount);
    }

    // ---------------------------------------------------------------- borrower

    /// @notice Opt a Morpho position (or a CreditDesk line on it) into the harvester. The base multiplier is the
    ///         registry's value now: dividends paid before the enrolment are never harvested. Batch it with
    ///         `Morpho.setAuthorization(this, true)`.
    function enroll(Id marketId, uint256 lineId, Mode mode) external {
        if (mode == Mode.NONE) revert BadMode(mode);
        Enrollment storage e = _enrollments[msg.sender][marketId];
        if (e.mode != Mode.NONE) revert AlreadyEnrolled(msg.sender, marketId);
        MarketParams memory params = MORPHO.idToMarketParams(marketId);
        if (params.collateralToken == address(0)) revert UnknownMarket(marketId);
        if (lineId != 0) {
            if (address(DESK) == address(0)) revert NoDesk();
            CreditDesk.Line memory l = DESK.line(lineId);
            if (l.user != msg.sender) revert NotLineOwner(lineId, msg.sender);
            if (Id.unwrap(l.marketId) != Id.unwrap(marketId)) revert LineMarketMismatch(lineId);
        }
        IPriceGate.Verdict memory v = GATE.check(params.collateralToken);
        if (v.registryPaused || v.multiplier == 0) revert RegistryUnreadable(params.collateralToken);
        e.baseMultiplier = uint128(v.multiplier);
        e.enrolledAt = uint64(block.timestamp);
        e.mode = mode;
        e.lineId = lineId;
        emit Enrolled(msg.sender, marketId, lineId, mode, v.multiplier);
    }

    function setMode(Id marketId, Mode mode) external {
        if (mode == Mode.NONE) revert BadMode(mode);
        Enrollment storage e = _enrollments[msg.sender][marketId];
        if (e.mode == Mode.NONE) revert NotEnrolled(msg.sender, marketId);
        e.mode = mode;
        emit ModeSet(msg.sender, marketId, mode);
    }

    /// @notice Leave the harvester. Revoke the Morpho authorisation in the same batch.
    function leave(Id marketId) external {
        if (_enrollments[msg.sender][marketId].mode == Mode.NONE) revert NotEnrolled(msg.sender, marketId);
        delete _enrollments[msg.sender][marketId];
        emit Left(msg.sender, marketId);
    }

    // ---------------------------------------------------------------- keeper

    /// @notice Harvest `user`'s dividends on `marketId` into their loan, or re-base when the multiplier step is not
    ///         a dividend to sell (fall, split-sized rise, HEADROOM mode, no debt). Returns what was repaid and sold.
    function harvest(address user, Id marketId, uint256 deadline)
        external
        onlyOperator
        nonReentrant
        returns (uint256 repaid, uint256 sold)
    {
        if (block.timestamp > deadline) revert Expired(deadline);
        Preview memory p = preview(user, marketId);
        Enrollment storage e = _enrollments[user][marketId];

        if (
            p.standing == Standing.STEP_DOWN || p.standing == Standing.STEP_TOO_LARGE || p.standing == Standing.HEADROOM
                || p.standing == Standing.NO_DEBT
        ) {
            e.baseMultiplier = uint128(p.multiplier);
            emit Rebased(user, marketId, p.baseMultiplier, p.multiplier, p.standing);
            return (0, 0);
        }
        if (p.standing != Standing.READY) revert NotHarvestable(p.standing);

        MarketParams memory params = MORPHO.idToMarketParams(marketId);
        _checkRoute(params);
        Position memory before = MORPHO.position(marketId, user);
        uint256 debtBefore = p.debt;

        _inFlash = true;
        MORPHO.flashLoan(
            params.loanToken,
            p.repayAssets,
            abi.encode(
                Flash({
                    user: user,
                    params: params,
                    lineId: e.lineId,
                    dividendRaw: p.dividendRaw,
                    price8: p.price8,
                    fullRepay: p.fullRepay
                })
            )
        );
        _inFlash = false;
        repaid = _repaid;
        sold = _sold;

        // Health may only improve: debt/collateral after <= debt/collateral before.
        Position memory afterPos = MORPHO.position(marketId, user);
        uint256 debtAfter = MORPHO.expectedBorrowAssets(params, user);
        if (debtAfter * before.collateral > debtBefore * afterPos.collateral) {
            revert LtvRose(debtBefore, before.collateral, debtAfter, afterPos.collateral);
        }

        // A rounding remainder of the loan token, if any, belongs to the borrower.
        uint256 dust = IERC20(params.loanToken).balanceOf(address(this));
        if (dust != 0) IERC20(params.loanToken).safeTransfer(user, dust);

        e.baseMultiplier = uint128(p.multiplier);
        e.lastHarvestAt = uint64(block.timestamp);
        _record(user, marketId, e.lineId, p, sold, repaid);
    }

    /// @inheritdoc IMorphoFlashLoanCallback
    /// @dev Repay first (health improves), then withdraw the dividend collateral, sell what returns the loan,
    ///      supply the rest back, approve Morpho to pull the flash loan.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (!_inFlash || msg.sender != address(MORPHO)) revert UnexpectedCallback(msg.sender);
        Flash memory f = abi.decode(data, (Flash));
        IERC20 loan = IERC20(f.params.loanToken);
        IERC20 collateral = IERC20(f.params.collateralToken);

        uint256 loanBefore = loan.balanceOf(address(this));
        if (f.lineId != 0) {
            loan.forceApprove(address(DESK), assets);
            DESK.repay(f.lineId, f.fullRepay ? DESK.REPAY_ALL() : assets);
            loan.forceApprove(address(DESK), 0);
        } else {
            loan.forceApprove(address(MORPHO), assets);
            if (f.fullRepay) {
                MORPHO.repay(f.params, 0, MORPHO.position(_id(f.params), f.user).borrowShares, f.user, "");
            } else {
                MORPHO.repay(f.params, assets, 0, f.user, "");
            }
        }
        uint256 spent = loanBefore - loan.balanceOf(address(this));
        _repaid = spent;

        uint256 collBefore = collateral.balanceOf(address(this));
        MORPHO.withdrawCollateral(f.params, f.dividendRaw, f.user, address(this));
        uint256 withdrawn = collateral.balanceOf(address(this)) - collBefore;

        // Sell exactly what returns the flash loan (`spent`; anything the repayment left unspent is already
        // here), paying at most the dividend collateral and never below the price floor.
        uint256 maxIn = Math.min(withdrawn, _maxCollateralFor(spent, f));
        uint256 sold = spent == 0 ? 0 : _sellForExactLoan(f.params, spent, maxIn);
        _sold = sold;

        uint256 back = withdrawn - sold;
        if (back != 0) {
            collateral.forceApprove(address(MORPHO), back);
            MORPHO.supplyCollateral(f.params, back, f.user, "");
        }
        _returned = back;
        loan.forceApprove(address(MORPHO), assets);
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        address collateral = _swapCollateral;
        Route memory route = routes[collateral];
        if (!_inSwap || address(route.pool) == address(0) || msg.sender != address(route.pool)) {
            revert UnexpectedCallback(msg.sender);
        }
        int256 owed = route.collateralIsToken0 ? amount0Delta : amount1Delta;
        if (owed <= 0) revert NothingOwed();
        if (uint256(owed) > _swapMaxIn) revert SlippageExceeded(uint256(owed), _swapMaxIn);
        IERC20(collateral).safeTransfer(msg.sender, uint256(owed));
    }

    // ---------------------------------------------------------------- views

    function enrollment(address user, Id marketId) external view returns (Enrollment memory) {
        return _enrollments[user][marketId];
    }

    /// @notice What a harvest of `user` on `marketId` would do right now. Never reverts for a known market.
    function preview(address user, Id marketId) public view returns (Preview memory p) {
        Enrollment memory e = _enrollments[user][marketId];
        p.baseMultiplier = e.baseMultiplier;
        if (e.mode == Mode.NONE) return p; // NOT_ENROLLED
        MarketParams memory params = MORPHO.idToMarketParams(marketId);
        Position memory pos = MORPHO.position(marketId, user);
        p.collateral = pos.collateral;
        p.debt = MORPHO.expectedBorrowAssets(params, user);

        IPriceGate.Verdict memory v = GATE.check(params.collateralToken);
        p.multiplier = v.multiplier;
        if (v.state != IPriceGate.GateState.OPEN || v.multiplier == 0) {
            p.standing = Standing.GATE_CLOSED;
            return p;
        }
        p.price8 = GATE.priceOf(params.collateralToken);
        uint256 m0 = e.baseMultiplier;
        uint256 m1 = v.multiplier;
        if (m1 == m0) {
            p.standing = Standing.NO_CHANGE;
            return p;
        }
        if (m1 < m0) {
            p.standing = Standing.STEP_DOWN;
            return p;
        }
        if ((m1 - m0) * 10_000 > m0 * maxStepBps) {
            p.standing = Standing.STEP_TOO_LARGE;
            return p;
        }
        p.dividendRaw = Math.mulDiv(p.collateral, m1 - m0, m1);
        p.dividendValue = _value(p.dividendRaw, p.price8, params);
        if (e.mode == Mode.HEADROOM) {
            p.standing = Standing.HEADROOM;
            return p;
        }
        if (p.debt == 0) {
            p.standing = Standing.NO_DEBT;
            return p;
        }
        uint256 net = Math.mulDiv(p.dividendValue, 10_000 - maxSlippageBps, 10_000);
        if (net >= p.debt) {
            p.repayAssets = p.debt;
            p.fullRepay = true;
        } else {
            p.repayAssets = net;
        }
        if (p.dividendRaw == 0 || p.repayAssets == 0) {
            p.standing = Standing.TOO_SMALL;
            return p;
        }
        p.standing = MORPHO.isAuthorized(user, address(this)) ? Standing.READY : Standing.NOT_AUTHORIZED;
    }

    // ---------------------------------------------------------------- internals

    function _checkRoute(MarketParams memory params) internal view {
        Route memory route = routes[params.collateralToken];
        if (address(route.pool) == address(0)) revert NoRoute(params.collateralToken);
        address t0 = route.pool.token0();
        address t1 = route.pool.token1();
        if ((route.collateralIsToken0 ? t1 : t0) != params.loanToken) revert PoolMismatch(address(route.pool), t0, t1);
    }

    /// @dev Value of `raw` collateral in loan units at an 8-decimal USD price: raw × price8 × 10^loanDec / 10^(8 + collDec).
    function _value(uint256 raw, uint256 price8, MarketParams memory params) internal view returns (uint256) {
        uint8 cd = IERC20Metadata(params.collateralToken).decimals();
        uint8 ld = IERC20Metadata(params.loanToken).decimals();
        return Math.mulDiv(raw, price8 * 10 ** ld, 10 ** (PRICE_DECIMALS + cd));
    }

    /// @dev Most collateral the sale may take for `loanOut` at the price floor (rounded up).
    function _maxCollateralFor(uint256 loanOut, Flash memory f) internal view returns (uint256) {
        uint8 cd = IERC20Metadata(f.params.collateralToken).decimals();
        uint8 ld = IERC20Metadata(f.params.loanToken).decimals();
        uint256 floorPrice = Math.mulDiv(f.price8, 10_000 - maxSlippageBps, 10_000);
        if (floorPrice == 0) return 0;
        return Math.mulDiv(loanOut, 10 ** (PRICE_DECIMALS + cd), floorPrice * 10 ** ld, Math.Rounding.Ceil);
    }

    /// @dev Exact-output sale of the collateral for `loanOut` on its route's pool, paying at most `maxIn`.
    function _sellForExactLoan(MarketParams memory params, uint256 loanOut, uint256 maxIn)
        internal
        returns (uint256 sold)
    {
        Route memory route = routes[params.collateralToken];
        bool zeroForOne = route.collateralIsToken0;
        uint256 loanBefore = IERC20(params.loanToken).balanceOf(address(this));
        _inSwap = true;
        _swapCollateral = params.collateralToken;
        _swapMaxIn = maxIn;
        (int256 amount0, int256 amount1) = route.pool
            .swap(
                address(this),
                zeroForOne,
                -int256(loanOut),
                zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
                ""
            );
        _inSwap = false;
        int256 paid = zeroForOne ? amount0 : amount1;
        sold = paid > 0 ? uint256(paid) : 0;
        uint256 received = IERC20(params.loanToken).balanceOf(address(this)) - loanBefore;
        if (received < loanOut) revert InsufficientOutput(received, loanOut);
    }

    function _record(address user, Id marketId, uint256 lineId, Preview memory p, uint256 sold, uint256 repaid)
        internal
    {
        Decision memory d = Decision({
            chainId: block.chainid,
            harvester: address(this),
            user: user,
            marketId: marketId,
            lineId: lineId,
            baseMultiplier: p.baseMultiplier,
            multiplier: p.multiplier,
            dividendRaw: p.dividendRaw,
            collateralSold: sold,
            repaid: repaid,
            price8: p.price8,
            timestamp: block.timestamp,
            nonce: ++decisionCount
        });
        bytes32 h = keccak256(abi.encode(d));
        emit Harvested(
            d.nonce,
            user,
            marketId,
            lineId,
            p.baseMultiplier,
            p.multiplier,
            p.dividendRaw,
            sold,
            repaid,
            _returned,
            p.price8,
            h
        );
    }

    function _id(MarketParams memory params) internal pure returns (Id) {
        return Id.wrap(keccak256(abi.encode(params)));
    }
}
