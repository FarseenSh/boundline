// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IMorpho, MarketParams, Id, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {ORACLE_PRICE_SCALE} from "morpho-blue/libraries/ConstantsLib.sol";
import {WAD, MathLib} from "morpho-blue/libraries/MathLib.sol";
import {SharesMathLib} from "morpho-blue/libraries/SharesMathLib.sol";
import {UtilsLib} from "morpho-blue/libraries/UtilsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IPriceGate} from "../interfaces/IPriceGate.sol";
import {TickMath} from "../libraries/TickMath.sol";
import {ICLSwapPool, IUniswapV3SwapCallback} from "./interfaces/ICLSwapPool.sol";
import {IPreLiquidation, PreLiquidationParams} from "./vendor/interfaces/IPreLiquidation.sol";
import {IPreLiquidationCallback} from "./vendor/interfaces/IPreLiquidationCallback.sol";

/// @title Protector
/// @notice Boundline's pre-liquidator for Morpho Blue. It runs Morpho's audited `PreLiquidation` contracts
///         whose `preLiquidationOracle` is a ShadowGuard (the fresh feed in session, the DEX time-weighted
///         price less a haircut while the feed is held), so a position can be protected at a live price at
///         any hour instead of being liquidated against a gap at the Sunday 20:00 ET reopen.
///
///         Self-funding: `PreLiquidation.onMorphoRepay` hands the seized collateral to the pre-liquidator
///         before pulling the repayment, so inside `onPreLiquidate` the Protector sells exactly enough of
///         it on the collateral's own Slipstream pool to cover `repaidAssets`, approves the pre-liquidation
///         contract, and keeps the remainder (the incentive, preLIF just above 1.0) for the Reserve.
///
///         Sizing is enforced, not advised: a partial action may never seize more than brings the shadow
///         LTV back to the band's edge (`preLltv`), and a full close-out is allowed only when no partial
///         can run. Morpho's `withdrawCollateral` inside the pre-liquidation re-checks health through the
///         market's own oracle, so on a SessionGuard market while Wall Street is closed only a repay of
///         every share (Morpho skips the oracle when `borrowShares == 0`) can pass; on markets whose
///         oracle serves a held price (MorphoChainlinkOracleV2) partial actions run at any hour.
contract Protector is IPreLiquidationCallback, IUniswapV3SwapCallback, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using MathLib for uint256;
    using SharesMathLib for uint256;
    using MorphoBalancesLib for IMorpho;

    enum Standing {
        NO_POSITION, // no collateral or no debt
        NO_SHADOW_PRICE, // the pre-liquidation oracle refuses (issuer pause, invalid feed, deviation, no TWAP)
        BELOW_BAND, // shadow LTV <= preLltv: nothing to do
        IN_BAND, // preLltv < shadow LTV <= LLTV: the Protector may act
        ABOVE_LLTV // shadow LTV > LLTV: pre-liquidation refuses, only a repay can help
    }

    struct Sizing {
        Standing standing;
        uint256 collateral; // raw collateral units on the position
        uint256 borrowShares;
        uint256 debtAssets; // loan units, interest accrued to now
        uint256 shadowPrice36; // pre-liquidation oracle price, 0 when unavailable
        uint256 venuePrice36; // market oracle price; the held feed value when the oracle refuses
        bool venueOracleLive; // the market oracle answered: a partial action can pass Morpho's health check
        uint256 shadowLtvWad;
        uint256 venueLtvWad; // at venuePrice36, 0 when unknown
        uint256 preLifWad; // incentive factor at the current shadow LTV
        uint256 preLcfWad; // close factor at the current shadow LTV
        uint256 targetLtvWad; // the shadow LTV a partial action aims for
        uint256 maxSeizedAssets; // largest partial seize: reaches the target or a constraint, 0 when none can run
        uint256 maxRepaidShares;
        uint256 maxRepaidAssets;
        bool fullCloseAllowed; // every share may be repaid (close factor 100%) and the collateral covers it
        uint256 fullCloseSeizedAssets;
        uint256 fullCloseRepaidAssets;
    }

    struct Route {
        ICLSwapPool pool;
        bool collateralIsToken0;
    }

    struct Env {
        uint256 totalBorrowAssets;
        uint256 totalBorrowShares;
        uint256 lltv;
    }

    /// @notice The tuple behind every `Protected` decision hash: `keccak256(abi.encode(Decision))`.
    struct Decision {
        uint256 chainId;
        address protector;
        address preLiquidation;
        address borrower;
        uint256 seizedAssets;
        uint256 repaidAssets;
        uint256 collateralSold;
        uint256 venuePrice36;
        uint256 shadowPrice36;
        uint256 timestamp;
        uint256 nonce;
    }

    IMorpho public immutable MORPHO;

    /// @notice The account allowed to run protections besides the owner.
    address public keeper;
    /// @notice The pool each collateral is sold on.
    mapping(address collateral => Route) public routes;
    /// @notice Decisions taken so far; part of every decision hash.
    uint256 public decisionCount;

    // Call-scoped state for the two callbacks; transient so nothing survives the transaction.
    address private transient _activePreLiq;
    uint256 private transient _collateralBefore;
    uint256 private transient _maxSold;
    uint256 private transient _sold;
    bool private transient _inSwap;

    event KeeperSet(address indexed keeper);
    event RouteSet(address indexed collateral, address indexed pool, bool collateralIsToken0);
    event Swept(address indexed token, address indexed to, uint256 amount);
    event Protected(
        uint256 indexed decision,
        address indexed preLiquidation,
        address indexed borrower,
        uint256 seizedAssets,
        uint256 repaidAssets,
        uint256 collateralSold,
        uint256 venuePrice36,
        uint256 shadowPrice36,
        bytes32 decisionHash
    );

    error ZeroAddress();
    error NotOperator(address caller);
    error Expired(uint256 deadline);
    error WrongMorpho(address morpho);
    error NoRoute(address collateral);
    error PoolMismatch(address pool, address token0, address token1);
    error NotInBand(Standing standing);
    error SeizeTooLarge(uint256 requested, uint256 allowed);
    error OnlyFullClose(uint256 repaidShares, uint256 borrowShares);
    error FullCloseNotAllowed();
    error PartialAvailable(uint256 maxSeizedAssets);
    error UnexpectedCallback(address caller);
    error NothingOwed();
    error SlippageExceeded(uint256 owed, uint256 maxCollateralSold);
    error InsufficientOutput(uint256 received, uint256 needed);

    modifier onlyOperator() {
        if (msg.sender != owner() && msg.sender != keeper) revert NotOperator(msg.sender);
        _;
    }

    constructor(address initialOwner, IMorpho morpho, address keeper_) Ownable(initialOwner) {
        if (address(morpho) == address(0)) revert ZeroAddress();
        MORPHO = morpho;
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    // ---------------------------------------------------------------- owner

    function setKeeper(address newKeeper) external onlyOwner {
        keeper = newKeeper;
        emit KeeperSet(newKeeper);
    }

    /// @notice Bind the pool `collateral` is sold on. The pool must hold the collateral on one side.
    function setRoute(address collateral, ICLSwapPool pool) external onlyOwner {
        if (collateral == address(0) || address(pool) == address(0)) revert ZeroAddress();
        address t0 = pool.token0();
        address t1 = pool.token1();
        if (t0 != collateral && t1 != collateral) revert PoolMismatch(address(pool), t0, t1);
        routes[collateral] = Route({pool: pool, collateralIsToken0: t0 == collateral});
        emit RouteSet(collateral, address(pool), t0 == collateral);
    }

    /// @notice Move retained incentive (collateral or loan tokens) out, to the Reserve or wherever the owner says.
    function sweep(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit Swept(address(token), to, amount);
    }

    // ---------------------------------------------------------------- protect

    /// @notice Pre-liquidate `borrower` through `preLiq`. Pass `seizedAssets` for a partial action (capped at
    ///         `sizing().maxSeizedAssets`) or `repaidShares == borrowShares` with `seizedAssets == 0` for a
    ///         full close-out (allowed only when no partial can run). `maxCollateralSold` bounds the collateral
    ///         sold to raise the repayment; 0 means "no more than was seized". Reverts with the pre-liquidation
    ///         oracle's own reason when it refuses to price.
    function protect(
        IPreLiquidation preLiq,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        uint256 maxCollateralSold,
        uint256 deadline
    ) external onlyOperator nonReentrant returns (uint256 seized, uint256 repaid) {
        if (block.timestamp > deadline) revert Expired(deadline);
        if (address(preLiq.MORPHO()) != address(MORPHO)) revert WrongMorpho(address(preLiq.MORPHO()));
        MarketParams memory mp = MORPHO.idToMarketParams(preLiq.ID());
        _checkRoute(mp);
        // Read the shadow price without a try so the oracle's refusal (ShadowUnavailable, ShadowDeviation, OLD)
        // reaches the keeper verbatim.
        IOracle(preLiq.preLiquidationParams().preLiquidationOracle).price();
        Sizing memory z = sizing(preLiq, borrower, 0);
        _authorize(z, seizedAssets, repaidShares);

        _activePreLiq = address(preLiq);
        _collateralBefore = IERC20(mp.collateralToken).balanceOf(address(this));
        _maxSold = maxCollateralSold;
        _sold = 0;
        (seized, repaid) =
            preLiq.preLiquidate(borrower, seizedAssets, repaidShares, abi.encode(mp.collateralToken, mp.loanToken));
        _activePreLiq = address(0);
        _record(address(preLiq), borrower, seized, repaid, z);
    }

    /// @dev The route must exist and its other side must be the market's loan token.
    function _checkRoute(MarketParams memory mp) internal view {
        Route memory route = routes[mp.collateralToken];
        if (address(route.pool) == address(0)) revert NoRoute(mp.collateralToken);
        address t0 = route.pool.token0();
        address t1 = route.pool.token1();
        if ((route.collateralIsToken0 ? t1 : t0) != mp.loanToken) revert PoolMismatch(address(route.pool), t0, t1);
    }

    /// @dev The sizing rule as an on-chain cap: partials never beyond the band's edge, close-outs only as a fallback.
    function _authorize(Sizing memory z, uint256 seizedAssets, uint256 repaidShares) internal pure {
        if (z.standing != Standing.IN_BAND) revert NotInBand(z.standing);
        if (seizedAssets != 0) {
            if (seizedAssets > z.maxSeizedAssets) revert SeizeTooLarge(seizedAssets, z.maxSeizedAssets);
            return;
        }
        if (repaidShares != z.borrowShares) revert OnlyFullClose(repaidShares, z.borrowShares);
        if (!z.fullCloseAllowed) revert FullCloseNotAllowed();
        if (z.venueOracleLive && z.maxSeizedAssets != 0) revert PartialAvailable(z.maxSeizedAssets);
    }

    /// @dev One decision record per action: hash of the full tuple, bound to the chain, this contract and a nonce.
    function _record(address preLiq, address borrower, uint256 seized, uint256 repaid, Sizing memory z) internal {
        Decision memory d = Decision({
            chainId: block.chainid,
            protector: address(this),
            preLiquidation: preLiq,
            borrower: borrower,
            seizedAssets: seized,
            repaidAssets: repaid,
            collateralSold: _sold,
            venuePrice36: z.venuePrice36,
            shadowPrice36: z.shadowPrice36,
            timestamp: block.timestamp,
            nonce: ++decisionCount
        });
        bytes32 h = keccak256(abi.encode(d));
        emit Protected(d.nonce, preLiq, borrower, seized, repaid, d.collateralSold, d.venuePrice36, d.shadowPrice36, h);
    }

    /// @inheritdoc IPreLiquidationCallback
    /// @dev The seized collateral is already here. Sell what covers `repaidAssets`, approve the pre-liquidation
    ///      contract, keep the rest.
    function onPreLiquidate(uint256 repaidAssets, bytes calldata data) external {
        address preLiq = _activePreLiq;
        if (preLiq == address(0) || msg.sender != preLiq) revert UnexpectedCallback(msg.sender);
        (address collateral, address loan) = abi.decode(data, (address, address));
        uint256 received = IERC20(collateral).balanceOf(address(this)) - _collateralBefore;
        uint256 maxSold = _maxSold;
        if (maxSold == 0 || maxSold > received) maxSold = received;
        _sold = _sellForExactLoan(routes[collateral], collateral, loan, repaidAssets, maxSold);
        IERC20(loan).forceApprove(preLiq, repaidAssets);
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        (address collateral, uint256 maxIn) = abi.decode(data, (address, uint256));
        Route memory route = routes[collateral];
        if (!_inSwap || address(route.pool) == address(0) || msg.sender != address(route.pool)) {
            revert UnexpectedCallback(msg.sender);
        }
        int256 owed = route.collateralIsToken0 ? amount0Delta : amount1Delta;
        if (owed <= 0) revert NothingOwed();
        if (uint256(owed) > maxIn) revert SlippageExceeded(uint256(owed), maxIn);
        IERC20(collateral).safeTransfer(msg.sender, uint256(owed));
    }

    // ---------------------------------------------------------------- sizing

    /// @notice What the Protector may do for `borrower` on `preLiq` right now. `targetLtvWad` is the shadow LTV a
    ///         partial action aims for; 0 means the band's edge (`preLltv`), which is also the cap `protect` enforces.
    function sizing(IPreLiquidation preLiq, address borrower, uint256 targetLtvWad)
        public
        view
        returns (Sizing memory s)
    {
        Id id = preLiq.ID();
        MarketParams memory mp = MORPHO.idToMarketParams(id);
        PreLiquidationParams memory pp = preLiq.preLiquidationParams();
        Env memory e;
        (,, e.totalBorrowAssets, e.totalBorrowShares) = MORPHO.expectedMarketBalances(mp);
        e.lltv = mp.lltv;
        Position memory pos = MORPHO.position(id, borrower);
        s.collateral = pos.collateral;
        s.borrowShares = pos.borrowShares;
        s.debtAssets = uint256(pos.borrowShares).toAssetsUp(e.totalBorrowAssets, e.totalBorrowShares);
        (s.venuePrice36, s.venueOracleLive) = _venuePrice(mp.oracle);
        s.shadowPrice36 = _tryPrice(pp.preLiquidationOracle);
        s.targetLtvWad = targetLtvWad == 0 ? pp.preLltv : targetLtvWad;
        if (pos.borrowShares == 0 || pos.collateral == 0) {
            s.standing = Standing.NO_POSITION;
            return s;
        }
        if (s.venuePrice36 != 0) {
            s.venueLtvWad = s.debtAssets.wDivUp(s.collateral.mulDivDown(s.venuePrice36, ORACLE_PRICE_SCALE));
        }
        if (s.shadowPrice36 == 0) {
            s.standing = Standing.NO_SHADOW_PRICE;
            return s;
        }
        uint256 quoted = s.collateral.mulDivDown(s.shadowPrice36, ORACLE_PRICE_SCALE);
        s.shadowLtvWad = s.debtAssets.wDivUp(quoted);
        if (s.debtAssets > quoted.wMulDown(e.lltv)) {
            s.standing = Standing.ABOVE_LLTV;
            return s;
        }
        if (s.debtAssets <= quoted.wMulDown(pp.preLltv)) {
            s.standing = Standing.BELOW_BAND;
            return s;
        }
        s.standing = Standing.IN_BAND;
        // The same linear factors PreLiquidation computes from the pre-action LTV.
        uint256 quotient = (s.shadowLtvWad - pp.preLltv).wDivDown(e.lltv - pp.preLltv);
        s.preLifWad = quotient.wMulDown(pp.preLIF2 - pp.preLIF1) + pp.preLIF1;
        s.preLcfWad = quotient.wMulDown(pp.preLCF2 - pp.preLCF1) + pp.preLCF1;

        s.fullCloseAllowed = s.borrowShares.wMulDown(s.preLcfWad) >= s.borrowShares;
        if (s.fullCloseAllowed) {
            s.fullCloseRepaidAssets = s.borrowShares.toAssetsUp(e.totalBorrowAssets, e.totalBorrowShares);
            s.fullCloseSeizedAssets = s.borrowShares.toAssetsDown(e.totalBorrowAssets, e.totalBorrowShares)
                .wMulDown(s.preLifWad).mulDivDown(ORACLE_PRICE_SCALE, s.shadowPrice36);
            if (s.fullCloseSeizedAssets > s.collateral) s.fullCloseAllowed = false;
        }
        if (!s.venueOracleLive) return s; // a partial cannot pass Morpho's health check: maxSeizedAssets stays 0
        s.maxSeizedAssets = _maxFeasibleSeize(s, e, _seizeForTarget(s, s.targetLtvWad));
        if (s.maxSeizedAssets != 0) {
            s.maxRepaidShares = _repaidSharesFor(s, e, s.maxSeizedAssets);
            s.maxRepaidAssets = s.maxRepaidShares.toAssetsUp(e.totalBorrowAssets, e.totalBorrowShares);
        }
    }

    /// @dev Collateral to seize so the shadow LTV lands at `target`: with x the seized value, r = x / LIF repaid,
    ///      (D - r) <= target * (V - x)  <=>  x >= (D - target * V) * LIF / (1 - target * LIF).
    function _seizeForTarget(Sizing memory s, uint256 target) internal pure returns (uint256) {
        uint256 value = s.collateral.mulDivDown(s.shadowPrice36, ORACLE_PRICE_SCALE);
        uint256 targetValue = value.wMulDown(target);
        if (s.debtAssets <= targetValue) return 0;
        uint256 tl = target.wMulDown(s.preLifWad);
        if (tl >= WAD) return s.collateral;
        uint256 seizedValue = (s.debtAssets - targetValue).mulDivUp(s.preLifWad, WAD - tl);
        uint256 seize = seizedValue.mulDivUp(ORACLE_PRICE_SCALE, s.shadowPrice36);
        return seize > s.collateral ? s.collateral : seize;
    }

    /// @dev Largest seize in [0, hi] that the close factor, Morpho's health check at the venue price and health at
    ///      the shadow price all accept. Feasibility only ever flips from true to false as the seize grows.
    function _maxFeasibleSeize(Sizing memory s, Env memory e, uint256 hi) internal pure returns (uint256) {
        if (hi == 0) return 0;
        if (_feasible(s, e, hi)) return hi;
        uint256 lo = 0;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            if (_feasible(s, e, mid)) lo = mid;
            else hi = mid;
        }
        return lo;
    }

    /// @dev PreLiquidation's own rounding for the shares a seize repays.
    function _repaidSharesFor(Sizing memory s, Env memory e, uint256 seized) internal pure returns (uint256) {
        return seized.mulDivUp(s.shadowPrice36, ORACLE_PRICE_SCALE).wDivUp(s.preLifWad)
            .toSharesUp(e.totalBorrowAssets, e.totalBorrowShares);
    }

    function _feasible(Sizing memory s, Env memory e, uint256 seized) internal pure returns (bool) {
        if (seized > s.collateral) return false;
        uint256 rs = _repaidSharesFor(s, e, seized);
        if (rs == 0 || rs > s.borrowShares || rs > s.borrowShares.wMulDown(s.preLcfWad)) return false;
        uint256 ra = rs.toAssetsUp(e.totalBorrowAssets, e.totalBorrowShares);
        uint256 sharesAfter = s.borrowShares - rs;
        if (sharesAfter == 0) return true;
        uint256 debtAfter =
            sharesAfter.toAssetsUp(UtilsLib.zeroFloorSub(e.totalBorrowAssets, ra), e.totalBorrowShares - rs);
        uint256 collateralAfter = s.collateral - seized;
        if (collateralAfter.mulDivDown(s.venuePrice36, ORACLE_PRICE_SCALE).wMulDown(e.lltv) < debtAfter) return false;
        if (collateralAfter.mulDivDown(s.shadowPrice36, ORACLE_PRICE_SCALE).wMulDown(e.lltv) < debtAfter) return false;
        return true;
    }

    // ---------------------------------------------------------------- prices

    /// @dev The market oracle's price when it answers (what Morpho's health check will use). A SessionGuard that
    ///      refuses while closed still reports its held feed value, flagged as not live.
    function _venuePrice(address oracle) internal view returns (uint256 price36, bool live) {
        (bool ok, bytes memory data) = oracle.staticcall(abi.encodeCall(IOracle.price, ()));
        if (ok && data.length >= 32) return (abi.decode(data, (uint256)), true);
        (ok, data) = oracle.staticcall(abi.encodeWithSignature("verdict()"));
        if (!ok || data.length < 7 * 32) return (0, false);
        IPriceGate.Verdict memory v = abi.decode(data, (IPriceGate.Verdict));
        (bool okScale, bytes memory scale) = oracle.staticcall(abi.encodeWithSignature("SCALE()"));
        if (v.answer <= 0 || !okScale || scale.length < 32) return (0, false);
        return (uint256(v.answer) * abi.decode(scale, (uint256)), false);
    }

    function _tryPrice(address oracle) internal view returns (uint256) {
        (bool ok, bytes memory data) = oracle.staticcall(abi.encodeCall(IOracle.price, ()));
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    // ---------------------------------------------------------------- swap

    /// @dev Exact-output sale of `collateral` for `loanOut` on the route's pool, paying at most `maxIn`.
    function _sellForExactLoan(Route memory route, address collateral, address loan, uint256 loanOut, uint256 maxIn)
        internal
        returns (uint256 sold)
    {
        if (address(route.pool) == address(0)) revert NoRoute(collateral);
        bool zeroForOne = route.collateralIsToken0;
        uint256 loanBefore = IERC20(loan).balanceOf(address(this));
        _inSwap = true;
        (int256 amount0, int256 amount1) = route.pool
            .swap(
                address(this),
                zeroForOne,
                -int256(loanOut),
                zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
                abi.encode(collateral, maxIn)
            );
        _inSwap = false;
        int256 paid = zeroForOne ? amount0 : amount1;
        sold = paid > 0 ? uint256(paid) : 0;
        uint256 received = IERC20(loan).balanceOf(address(this)) - loanBefore;
        if (received < loanOut) revert InsufficientOutput(received, loanOut);
    }
}
