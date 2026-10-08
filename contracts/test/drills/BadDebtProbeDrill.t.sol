// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Vm} from "forge-std/Vm.sol";
import {IMorpho, IMorphoBase, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IOracleRegistry} from "../../src/interfaces/IOracleRegistry.sol";
import {ICLPool} from "../../src/interfaces/ICLPool.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {SessionGuard} from "../../src/oracle/SessionGuard.sol";
import {ShadowGuard} from "../../src/oracle/ShadowGuard.sol";
import {ICLSwapPool} from "../../src/protection/interfaces/ICLSwapPool.sol";
import {Protector} from "../../src/protection/Protector.sol";
import {IPreLiquidation, PreLiquidationParams} from "../../src/protection/vendor/interfaces/IPreLiquidation.sol";
import {IPreLiquidationFactory} from "../../src/protection/vendor/interfaces/IPreLiquidationFactory.sol";
import {MockSwapPool} from "../../src/test/MockSwapPool.sol";
import {DrillBase} from "./DrillBase.sol";

/// @notice Drill `bad-debt-probe` on a Base mainnet fork: the largest real borrower of the Steakhouse AAPLc/USDC
///         Morpho market, staged to venue LTV 0.56 at Friday's close, taken through LLTV by a reopen print far beyond
///         the protection band, and liquidated at the venue. Every flow is logged as a ledger record that the
///         runner reconciles with the ledger package (five identities; bad debt only ever a part of the remaining
///         debt). From the same Friday snapshot:
///
///         1. raw venue, -45% print: all collateral seized, the rest of the debt written off as bad debt;
///         2. raw venue, -15% print: liquidated, every share repaid, collateral left, no bad debt;
///         3. the same position on a SessionGuard market: the Saturday liquidation reverts MarketClosed(WEEKEND),
///            repay still works, and the -45% reopen still leaves bad debt (the guard refuses a held price, it does
///            not prevent a gap);
///         4. protected mode with the default ShadowGuard (30% deviation guard): the DEX walks down 4% at a time on
///            Saturday and the Protector pre-liquidates every time the shadow LTV enters the band, until the guard
///            stops pricing a TWAP more than 30% from the held feed; the -45% reopen then liquidates without bad debt;
///         5. protected mode with the guard at its 50% maximum: the Protector follows the DEX to -44% and the -45%
///            reopen finds the position healthy.
///
///         base-forge only (B20 transfers in every seizure and sale); skips without BASE_RPC_URL.
contract BadDebtProbeDrillTest is DrillBase {
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    IMorpho constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    Id constant MARKET = Id.wrap(0xae1a30486234bf7e7ac166c7c03d9bc5f2cd8a39be2c48e73c665ac7148c3c28);
    address constant IRM = 0x46415998764C29aB2a25CbeA6254146D50D22687;
    IPreLiquidationFactory constant FACTORY = IPreLiquidationFactory(0x8cd16b62E170Ee0bA83D80e1F80E6085367e2aef);
    uint256 constant WAD = 1e18;
    uint256 constant LLTV = 0.625e18;
    uint256 constant PRE_LLTV = 0.58e18;
    uint256 constant STAGE_LTV = 0.56e18;
    uint256 constant SCALE = 1e26; // feed (8 decimals) to Morpho price36 for AAPLc (8) / USDC (6)
    bytes32 constant LIQUIDATE_TOPIC =
        keccak256("Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)");
    bytes32 constant PROTECTED_TOPIC =
        keccak256("Protected(uint256,address,address,uint256,uint256,uint256,uint256,uint256,bytes32)");

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address supplier = makeAddr("supplier");
    address liquidator = makeAddr("liquidator");
    address clone = makeAddr("clone");
    address borrower;

    MarketCalendar cal;
    SessionGate gate;
    MockSwapPool pool;
    ShadowGuard shadow30;
    ShadowGuard shadow50;
    IPreLiquidation preLiq30;
    IPreLiquidation preLiq50;
    Protector protector;
    MarketParams mp;

    uint256 baseSnap;
    uint256 c0;
    uint256 d0;
    uint256 p0;

    function setUp() public {
        if (!_fork("bad-debt-probe")) return;
        borrower = vm.envOr("BADDEBT_BORROWER", address(0x8E8745Acd6fbE3e70Afc96042c7F3eC84B1f0e9f));
        mp = MORPHO.idToMarketParams(MARKET);
        require(mp.collateralToken == AAPLC && mp.loanToken == USDC && mp.lltv == LLTV, "Steakhouse AAPLc market");
        _discoverFeedSlot();

        cal = new MarketCalendar(owner);
        vm.prank(owner);
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        gate = new SessionGate(owner, cal, IOracleRegistry(ORACLE_REGISTRY));
        vm.prank(owner);
        gate.setFeed(AAPLC, AAPL_FEED, 0, 0);

        pool = new MockSwapPool(USDC, AAPLC, 100, owner);
        pool.setObservationCardinality(1000);
        shadow30 = new ShadowGuard(owner, gate, AAPLC, 8, USDC, 6, ICLPool(address(pool)), 3600);
        shadow50 = new ShadowGuard(owner, gate, AAPLC, 8, USDC, 6, ICLPool(address(pool)), 3600);
        vm.prank(owner);
        shadow50.setMaxDeviation(5000);
        preLiq30 = FACTORY.createPreLiquidation(MARKET, _params(address(shadow30)));
        preLiq50 = FACTORY.createPreLiquidation(MARKET, _params(address(shadow50)));
        protector = new Protector(owner, MORPHO, keeper);
        vm.prank(owner);
        protector.setRoute(AAPLC, ICLSwapPool(address(pool)));

        // Liquidity for the staging borrow (the market runs at about 90% utilisation), a funded liquidator, and USDC
        // in the simulated DEX for the Protector's sales.
        deal(USDC, supplier, 1_000_000e6);
        vm.startPrank(supplier);
        IERC20(USDC).approve(address(MORPHO), type(uint256).max);
        MORPHO.supply(mp, 1_000_000e6, 0, supplier, "");
        vm.stopPrank();
        deal(USDC, liquidator, 10_000_000e6);
        vm.prank(liquidator);
        IERC20(USDC).approve(address(MORPHO), type(uint256).max);
        deal(USDC, address(pool), 10_000_000e6);

        // Friday 19:59 ET: the last print of the week, then the staged position (venue LTV 0.56 at that price).
        vm.warp(T_FRI_CLOSE - 60);
        _writeFeed(heldAnswer, T_FRI_CLOSE - 120, T_FRI_CLOSE - 100);
        _setDex(uint256(heldAnswer) * SCALE);
        p0 = IOracle(mp.oracle).price();
        c0 = MORPHO.position(MARKET, borrower).collateral;
        require(c0 > 0, "the borrower holds AAPLc collateral on the market");
        uint256 wanted = Math.mulDiv(Math.mulDiv(c0, p0, 1e36), STAGE_LTV, WAD);
        uint256 debt = MORPHO.expectedBorrowAssets(mp, borrower);
        if (wanted > debt) {
            vm.prank(borrower);
            MORPHO.borrow(mp, wanted - debt, 0, borrower, borrower);
        }
        d0 = MORPHO.expectedBorrowAssets(mp, borrower);
    }

    function _params(address oracle) internal pure returns (PreLiquidationParams memory) {
        return PreLiquidationParams({
            preLltv: PRE_LLTV,
            preLCF1: 1e18,
            preLCF2: 1e18,
            preLIF1: 1.01e18,
            preLIF2: 1.02e18,
            preLiquidationOracle: oracle
        });
    }

    /// @dev The simulated weekend DEX (the real Aerodrome TWAP cannot move on a fork without trading through it): the
    ///      1h TWAP the ShadowGuard reads and the price the Protector sells at.
    function _setDex(uint256 price36) internal {
        uint256 sqrtP = Math.sqrt(price36);
        uint160 sqrtX96 = uint160((uint256(1e18) << 96) / sqrtP);
        int24 tick = TickMath.getTickAtSqrtRatio(sqrtX96);
        pool.setAverageTick(3600, tick);
        pool.setSlot0(sqrtX96, tick);
        vm.prank(owner);
        pool.setPrice36(price36);
    }

    function _ltv(MarketParams memory p, address user) internal view returns (uint256) {
        uint256 collateral = MORPHO.position(p.id(), user).collateral;
        if (collateral == 0) return type(uint256).max;
        return Math.mulDiv(MORPHO.expectedBorrowAssets(p, user), 1e36 * WAD, collateral * IOracle(p.oracle).price());
    }

    function _reopen(int256 bps) internal {
        vm.warp(T_REOPEN + 12);
        _writeFeed(heldAnswer * (10_000 + bps) / 10_000, T_REOPEN, T_REOPEN + 2);
    }

    // ---------------------------------------------------------------- records

    function _ledger(
        string memory scenario,
        string memory id,
        string memory kind,
        address subject,
        uint256[10] memory f, // in, sold, retained, remaining, debtBefore, debtAfter, repaid, proceeds, fromLiquidator, morphoBadDebt
        string memory ref
    ) internal view {
        string memory flows = string.concat(
            _kvU("in", f[0]),
            ",",
            _kvU("sold", f[1]),
            ",",
            _kvU("retained", f[2]),
            ",",
            _kvU("remainingOnPosition", f[3]),
            ",",
            _kvU("debtBefore", f[4]),
            ",",
            _kvU("debtAfter", f[5]),
            ",",
            _kvU("repaid", f[6])
        );
        _rec(
            "ledger",
            string.concat(
                _kvS("scenario", scenario),
                ",",
                _kvS("id", id),
                ",",
                _kvS("eventKind", kind),
                ",",
                _kvS("subject", vm.toString(subject)),
                ",",
                _kvU("at", block.timestamp),
                ",",
                flows,
                ",",
                _kvU("proceeds", f[7]),
                ",",
                _kvU("fromLiquidator", f[8]),
                ",",
                _kvU("morphoBadDebtAssets", f[9]),
                ",",
                _kvS("reference", ref)
            )
        );
    }

    struct Liq {
        uint256 repaidAssets;
        uint256 repaidShares;
        uint256 seizedAssets;
        uint256 badDebtAssets;
        uint256 badDebtShares;
    }

    function _liquidateLogged(MarketParams memory p, address user, uint256 seize, uint256 shares)
        internal
        returns (bool ok, bytes memory ret, Liq memory l)
    {
        vm.recordLogs();
        vm.prank(liquidator);
        (ok, ret) = address(MORPHO).call(abi.encodeCall(IMorphoBase.liquidate, (p, user, seize, shares, "")));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(MORPHO) && logs[i].topics[0] == LIQUIDATE_TOPIC) {
                (l.repaidAssets, l.repaidShares, l.seizedAssets, l.badDebtAssets, l.badDebtShares) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256));
            }
        }
    }

    /// @dev The venue liquidation as a ledger record: the liquidator takes the seized collateral against the debt
    ///      it repays (its incentive is in kind), and whatever debt is left once the position holds no collateral is
    ///      bad debt. Morpho writes that remainder off against the suppliers in the same call.
    function _venueLiquidation(string memory s, MarketParams memory p, address user, bool seizeAll)
        internal
        returns (Liq memory l)
    {
        uint256 debtBefore = MORPHO.expectedBorrowAssets(p, user);
        uint256 collBefore = MORPHO.position(p.id(), user).collateral;
        // Morpho accrues interest inside liquidate before it writes bad debt off, so compare against the
        // interest-accrued totals, not the stored ones.
        (uint256 supplyBefore,,,) = MORPHO.expectedMarketBalances(p);
        uint256 storedSupplyBefore = MORPHO.market(p.id()).totalSupplyAssets;
        uint256 price36 = IOracle(p.oracle).price();
        uint256 liqUsdcBefore = IERC20(USDC).balanceOf(liquidator);
        uint256 liqAaplBefore = IERC20(AAPLC).balanceOf(liquidator);
        bool ok;
        bytes memory ret;
        (ok, ret, l) = seizeAll
            ? _liquidateLogged(p, user, collBefore, 0)
            : _liquidateLogged(p, user, 0, MORPHO.position(p.id(), user).borrowShares);
        uint256 paid = liqUsdcBefore - IERC20(USDC).balanceOf(liquidator);
        uint256 taken = IERC20(AAPLC).balanceOf(liquidator) - liqAaplBefore;
        _checkCall(
            s, seizeAll ? "liquidate seizing all collateral" : "liquidate repaying every share", ok, ret, true, ""
        );
        uint256 supplyAfter = MORPHO.market(p.id()).totalSupplyAssets;
        uint256 collAfter = MORPHO.position(p.id(), user).collateral;
        uint256 seizedValue = Math.mulDiv(l.seizedAssets, price36, 1e36);
        _value(s, "price at the liquidation (price36)", price36);
        _value(s, "collateral seized (raw AAPLc)", l.seizedAssets);
        _value(s, "seized collateral value at the oracle price (USDC units)", seizedValue);
        _value(s, "debt repaid by the liquidator (USDC units)", l.repaidAssets);
        _value(s, "liquidation incentive, in kind (USDC units at the oracle price)", seizedValue - l.repaidAssets);
        _value(s, "collateral left with the borrower (raw AAPLc)", collAfter);
        _value(s, "bad debt written off by Morpho (USDC units)", l.badDebtAssets);
        _value(s, "interest accrued into supply inside the call (USDC units)", supplyBefore - storedSupplyBefore);
        _value(s, "supplier loss: accrued totalSupplyAssets before - after (USDC units)", supplyBefore - supplyAfter);
        _checkU(s, "supplier loss equals Morpho's badDebtAssets", supplyBefore - supplyAfter, l.badDebtAssets);
        _checkU(s, "collateral conservation: before = seized + left", collBefore, l.seizedAssets + collAfter);
        _checkU(s, "liquidator paid what Morpho reports repaid (USDC units)", paid, l.repaidAssets);
        _checkU(s, "liquidator received what Morpho reports seized (raw AAPLc)", taken, l.seizedAssets);
        // Measured independently: collateral out of the position, collateral into the liquidator, USDC out of the
        // liquidator. The debt left once the position holds no collateral is the ledger's bad debt; the runner
        // compares it with Morpho's own badDebtAssets.
        _ledger(
            s,
            string.concat(drillId, ":", s, ":liquidation"),
            "liquidation",
            user,
            [
                collBefore - collAfter,
                taken,
                0,
                collAfter,
                debtBefore,
                debtBefore - paid,
                paid,
                0,
                paid,
                l.badDebtAssets
            ],
            "fork"
        );
    }

    // ---------------------------------------------------------------- the drill

    function test_drill_badDebtProbe() public {
        _rec(
            "meta",
            string.concat(
                _kvU("forkBlock", forkBlock),
                ",",
                _kvU("forkBlockTime", forkTime),
                ",",
                _kvS("market", vm.toString(Id.unwrap(MARKET))),
                ",",
                _kvS("borrower", vm.toString(borrower)),
                ",",
                _kvU("heldAnswer", uint256(heldAnswer)),
                ",",
                _kvS("feedSlot", vm.toString(feedSlot)),
                ",",
                _kvU("collateralRaw", c0),
                ",",
                _kvU("debtAtStage", d0),
                ",",
                _kvU("priceAtClose36", p0),
                ",",
                _kvU("venueLtvAtStage", _ltv(mp, borrower)),
                ",",
                _kvS("preLiquidation30", vm.toString(address(preLiq30))),
                ",",
                _kvS("preLiquidation50", vm.toString(address(preLiq50)))
            )
        );
        _checkApprox("friday-close", "staged venue LTV (WAD)", _ltv(mp, borrower), STAGE_LTV, 1e12);
        baseSnap = vm.snapshotState();

        _raw(-4500);
        vm.revertToState(baseSnap);
        _raw(-1500);
        vm.revertToState(baseSnap);
        _sessionGuardMarket(-4500);
        vm.revertToState(baseSnap);
        _protected("protected (30% deviation guard)", preLiq30, -4500, true);
        vm.revertToState(baseSnap);
        _protected("protected (50% deviation guard)", preLiq50, -4500, false);
        vm.revertToState(baseSnap);
    }

    function _raw(int256 bps) internal {
        string memory s = string.concat("raw venue ", vm.toString(bps / 100), "%");
        vm.warp(T_SAT);
        _setDex(uint256(heldAnswer * (10_000 + bps) / 10_000) * SCALE);
        (bool ok, bytes memory ret,) = _liquidateLogged(mp, borrower, 1e6, 0);
        _checkCall(s, "Saturday liquidation at the held price", ok, ret, false, "Error(position is healthy)");
        _reopen(bps);
        uint256 ltv = _ltv(mp, borrower);
        _value(s, "venue LTV at the reopen print (WAD)", ltv);
        _checkB(s, "liquidatable at the reopen (LTV > LLTV)", ltv > LLTV, true);
        bool seizeAll = bps <= -4000;
        Liq memory l = _venueLiquidation(s, mp, borrower, seizeAll);
        _checkB(s, "bad debt realised by Morpho (badDebtAssets > 0)", l.badDebtAssets > 0, seizeAll);
    }

    /// @dev The same position on a market whose oracle is a SessionGuard (Boundline's session-safe market): a clone
    ///      account with the same collateral (moved from the Aerodrome pool, a B20 transfer) borrowing the same debt
    ///      before the close.
    function _sessionGuardMarket(int256 bps) internal {
        string memory s = "session-safe market, -45%";
        SessionGuard guard = new SessionGuard(gate, AAPLC, 8, USDC, 6, 0);
        MarketParams memory sg =
            MarketParams({loanToken: USDC, collateralToken: AAPLC, oracle: address(guard), irm: IRM, lltv: LLTV});
        MORPHO.createMarket(sg);
        deal(USDC, supplier, 100_000e6);
        vm.prank(supplier);
        MORPHO.supply(sg, 100_000e6, 0, supplier, "");
        vm.prank(AERODROME_AAPLC_POOL);
        IERC20(AAPLC).transfer(clone, c0);
        vm.startPrank(clone);
        IERC20(AAPLC).approve(address(MORPHO), type(uint256).max);
        IERC20(USDC).approve(address(MORPHO), type(uint256).max);
        MORPHO.supplyCollateral(sg, c0, clone, "");
        MORPHO.borrow(sg, d0, 0, clone, clone);
        vm.stopPrank();
        _value(s, "clone venue LTV at the close (WAD)", _ltvSafe(sg, clone, p0));

        vm.warp(T_SAT);
        (bool ok, bytes memory ret,) = _liquidateLogged(sg, clone, 1e6, 0);
        _checkCall(s, "Saturday liquidation", ok, ret, false, "MarketClosed(5)");
        vm.prank(clone);
        (ok, ret) = address(MORPHO).call(abi.encodeCall(IMorphoBase.borrow, (sg, 1e6, 0, clone, clone)));
        _checkCall(s, "Saturday borrow", ok, ret, false, "MarketClosed(5)");
        deal(USDC, clone, 1e6);
        vm.prank(clone);
        (ok, ret) = address(MORPHO).call(abi.encodeCall(IMorphoBase.repay, (sg, 1e6, 0, clone, "")));
        _checkCall(s, "Saturday repay of 1 USDC (repay never reads the oracle)", ok, ret, true, "");

        _reopen(bps);
        _value(s, "venue LTV at the reopen print (WAD)", _ltv(sg, clone));
        Liq memory l = _venueLiquidation(s, sg, clone, true);
        _checkB(s, "bad debt realised by Morpho (badDebtAssets > 0)", l.badDebtAssets > 0, true);
    }

    function _ltvSafe(MarketParams memory p, address user, uint256 price36) internal view returns (uint256) {
        uint256 collateral = MORPHO.position(p.id(), user).collateral;
        return Math.mulDiv(MORPHO.expectedBorrowAssets(p, user), 1e36 * WAD, collateral * price36);
    }

    /// @dev Saturday: the DEX walks down 4% every 30 minutes to -44%; at every step the keeper asks the Protector's
    ///      on-chain sizing and pre-liquidates when the shadow LTV is inside the band. Then the reopen prints `bps`.
    function _protected(string memory s, IPreLiquidation preLiq, int256 bps, bool expectLiquidation) internal {
        vm.prank(borrower);
        MORPHO.setAuthorization(address(preLiq), true);
        uint256 actions;
        int256 lastActedBps;
        for (uint256 k = 1; k <= 11; k++) {
            vm.warp(T_SAT + k * 30 minutes);
            int256 stepBps = -int256(k * 400);
            _setDex(uint256(heldAnswer * (10_000 + stepBps) / 10_000) * SCALE);
            Protector.Sizing memory z = protector.sizing(preLiq, borrower, 0);
            string memory step = string.concat(s, " step ", vm.toString(stepBps / 100), "%");
            _valueS(step, "standing", _standing(z.standing));
            if (z.standing != Protector.Standing.IN_BAND || z.maxSeizedAssets == 0) continue;
            _valueS(step, "shadow LTV before (WAD)", vm.toString(z.shadowLtvWad));
            uint256 debtBefore = MORPHO.expectedBorrowAssets(mp, borrower);
            uint256[4] memory pre = [
                MORPHO.position(MARKET, borrower).collateral,
                IERC20(AAPLC).balanceOf(address(pool)),
                IERC20(AAPLC).balanceOf(address(protector)),
                IERC20(USDC).balanceOf(address(pool))
            ];
            vm.recordLogs();
            vm.prank(keeper);
            (uint256 seized, uint256 repaid) =
                protector.protect(preLiq, borrower, z.maxSeizedAssets, 0, 0, block.timestamp + 1 hours);
            uint256 soldReported;
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 i = 0; i < logs.length; i++) {
                if (logs[i].emitter == address(protector) && logs[i].topics[0] == PROTECTED_TOPIC) {
                    (,, soldReported,,,) =
                        abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, bytes32));
                }
            }
            uint256 remaining = MORPHO.position(MARKET, borrower).collateral;
            uint256 sold = IERC20(AAPLC).balanceOf(address(pool)) - pre[1];
            uint256 kept = IERC20(AAPLC).balanceOf(address(protector)) - pre[2];
            uint256 proceeds = pre[3] - IERC20(USDC).balanceOf(address(pool));
            _checkU(step, "collateral out of the position = seized (raw AAPLc)", pre[0] - remaining, seized);
            _checkU(step, "sold on the pool = collateralSold in the Protected event (raw AAPLc)", sold, soldReported);
            // Measured independently: collateral out of the position, into the pool, kept by the Protector; USDC out
            // of the pool (the sale proceeds) and the debt before and after.
            _ledger(
                step,
                string.concat(drillId, ":", step, ":pre-liquidation"),
                "pre-liquidation",
                borrower,
                [
                    pre[0] - remaining,
                    sold,
                    kept,
                    remaining,
                    debtBefore,
                    MORPHO.expectedBorrowAssets(mp, borrower),
                    repaid,
                    proceeds,
                    0,
                    0
                ],
                "fork"
            );
            _valueS(step, "shadow LTV after (WAD)", vm.toString(protector.sizing(preLiq, borrower, 0).shadowLtvWad));
            actions++;
            lastActedBps = stepBps;
        }
        _value(s, "pre-liquidations on Saturday", actions);
        _valueS(s, "last step acted on (bps)", vm.toString(lastActedBps));
        _checkB(s, "at least one pre-liquidation ran", actions > 0, true);

        _reopen(bps);
        uint256 ltv = _ltv(mp, borrower);
        _value(s, "venue LTV at the reopen print (WAD)", ltv);
        _checkB(s, "liquidatable at the reopen (LTV > LLTV)", ltv > LLTV, expectLiquidation);
        if (ltv > LLTV) {
            _checkB(s, "collateral covers the debt plus incentive (no bad debt possible)", ltv < 0.8875e18, true);
            Liq memory l = _venueLiquidation(s, mp, borrower, false);
            _checkU(s, "bad debt written off by Morpho (USDC units)", l.badDebtAssets, 0);
            _checkB(
                s,
                "collateral left with the borrower after every share is repaid",
                MORPHO.position(MARKET, borrower).collateral > 0,
                true
            );
        } else {
            (bool ok, bytes memory ret,) = _liquidateLogged(mp, borrower, 1e6, 0);
            _checkCall(s, "liquidation at the reopen", ok, ret, false, "Error(position is healthy)");
        }
    }

    function _standing(Protector.Standing st) internal pure returns (string memory) {
        if (st == Protector.Standing.NO_POSITION) return "NO_POSITION";
        if (st == Protector.Standing.NO_SHADOW_PRICE) return "NO_SHADOW_PRICE";
        if (st == Protector.Standing.BELOW_BAND) return "BELOW_BAND";
        if (st == Protector.Standing.IN_BAND) return "IN_BAND";
        return "ABOVE_LLTV";
    }
}
