// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMorpho, MarketParams, Id, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IMarketCalendar} from "../../src/interfaces/IMarketCalendar.sol";
import {IOracleRegistry} from "../../src/interfaces/IOracleRegistry.sol";
import {IPriceGate} from "../../src/interfaces/IPriceGate.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {ICLPool} from "../../src/interfaces/ICLPool.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {ShadowGuard} from "../../src/oracle/ShadowGuard.sol";
import {ICLSwapPool} from "../../src/protection/interfaces/ICLSwapPool.sol";
import {Protector} from "../../src/protection/Protector.sol";
import {IPreLiquidation, PreLiquidationParams} from "../../src/protection/vendor/interfaces/IPreLiquidation.sol";
import {IPreLiquidationFactory} from "../../src/protection/vendor/interfaces/IPreLiquidationFactory.sol";
import {MockSwapPool} from "../../src/test/MockSwapPool.sol";
import {ProtectionVault} from "../../src/aave/ProtectionVault.sol";
import {IAaveSpoke, ITakerPositionManager, IGiverPositionManager} from "../../src/aave/interfaces/IAaveV4.sol";

/// @notice The replay harness (M8/M13): real Base mainnet positions on Morpho (Steakhouse AAPLc/USDC) and the
///         Aave V4 MAG7 spoke taken through the Friday close, a weekend DEX move of -3%, -8% and -15%, and the
///         Sunday 20:00 ET reopen where the feed prints the gap. For every position and gap the raw venue and
///         the Boundline-protected path run from the same Saturday state (EVM snapshots), and each path is asked
///         the same question at the first block after the reopen: is the position liquidatable, and does a real
///         liquidation call go through?
///
///         Price forcing: the Coinbase AAPL aggregator (AccessControlledOCR2Aggregator) keeps the latest round in
///         `s_transmissions[roundId]` as one packed slot (int192 answer | uint32 observationsTimestamp | uint32
///         transmissionTimestamp). The slot is found by recording the storage reads of `latestRoundData()`
///         (`vm.record`/`vm.accesses`, the Foundry form of the prestate tracer) and cross-checked against the
///         layout (mapping slot 12), then rewritten with `vm.store` (anvil_setStorageAt's equivalent). Time moves
///         with `vm.warp` (evm_setNextBlockTimestamp). The weekend DEX move is a mock Slipstream pool set to the
///         gapped price: the real Aerodrome pool's TWAP cannot be moved on a fork without trading through it.
///
///         Runs under base-forge only (B20 transfers happen in every liquidation and sale); skips without
///         BASE_RPC_URL. Driven by scripts/replay/run.ts, which parses the REPLAY_* log lines into the evidence.
contract ReplayForkTest is Test {
    using MorphoBalancesLib for IMorpho;

    IMorpho constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant AAPLC = 0xb200000000000000000000C2e324d24d7eEcd1fb;
    IAggregatorV3 constant FEED = IAggregatorV3(0x787f13dEa48Db0897CbCDD985de77809D837F988);
    address constant AGGREGATOR = 0xc37B6F754e90D4Cca1f533F5a08f7d532b3d0d9D;
    IOracleRegistry constant REGISTRY = IOracleRegistry(0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD);
    IPreLiquidationFactory constant FACTORY = IPreLiquidationFactory(0x8cd16b62E170Ee0bA83D80e1F80E6085367e2aef);
    Id constant MARKET = Id.wrap(0xae1a30486234bf7e7ac166c7c03d9bc5f2cd8a39be2c48e73c665ac7148c3c28);
    address constant MORPHO_BORROWER = 0x8E8745Acd6fbE3e70Afc96042c7F3eC84B1f0e9f;
    IAaveSpoke constant SPOKE = IAaveSpoke(0x17905Db0e4A3514467539956c084180616AE7B8D);
    ITakerPositionManager constant TAKER = ITakerPositionManager(0x8481204E528735aF2F3391AD98f36E757A56D695);
    IGiverPositionManager constant GIVER = IGiverPositionManager(0x9E81c2fDE4E34CAB3AB1667ca3c932dBAED95F08);
    uint256 constant AAPL_RESERVE = 0;
    uint256 constant USDC_RESERVE = 7;
    bytes32 constant PARTNER = "boundline-app";

    uint256 constant WAD = 1e18;
    uint256 constant LLTV = 0.625e18;
    uint256 constant PRE_LLTV = 0.58e18;
    uint256 constant HF_TARGET = 1.02e18; // the Aave shadow health the Saturday repay aims for at the gapped price
    uint256 constant MORPHO_STAGE_LTV = 0.56e18; // venue LTV the staged Morpho row is brought to at Friday's close
    uint256 constant AAVE_STAGE_HF = 1.05e18; // health the staged Aave row is brought to at Friday's close
    uint256 constant T_FRI_CLOSE = 1_791_590_400; // Fri 2026-10-09 20:00 ET
    uint256 constant T_SAT = 1_791_640_800; // Sat 2026-10-10 10:00 ET
    uint256 constant T_REOPEN = 1_791_763_200; // Sun 2026-10-11 20:00 ET
    uint256 constant SCALE = 1e26; // feed (8 decimals) to Morpho price36 for AAPLc (8) / USDC (6)
    uint256 constant MAPPING_SLOT_TRANSMISSIONS = 12;

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address supplier = makeAddr("supplier");
    address liquidator = makeAddr("liquidator");
    address reserveFunder = makeAddr("reserve"); // the Boundline Reserve's money for the Morpho repay rung

    MarketCalendar cal;
    SessionGate gate;
    ShadowGuard shadow;
    MockSwapPool pool; // the simulated weekend DEX: TWAP for the ShadowGuard and the Protector's sale venue
    IPreLiquidation preLiq;
    Protector protector;
    ProtectionVault vault;
    MarketParams mp;

    bytes32 feedSlot;
    bytes32 feedSlotByLayout;
    int256 heldAnswer;
    uint80 heldRound;
    uint256 forkBlock;
    uint256 forkTime;

    struct Pos {
        string label;
        string venue; // "morpho" | "aave"
        address user;
        bool staged;
    }

    struct Row {
        Pos pos;
        int256 gapBps;
        int256 gappedAnswer;
        uint256 shadowPrice36;
        uint256 collateralRaw;
        uint256 debtUsdc;
        uint256 hfReal;
        uint256 hfBefore;
        uint256 hfHeld;
        bool rawLiqSaturday;
        uint256 rawHfReopen;
        bool rawLiqReopen;
        bool rawLiquidated;
        string action;
        string standing;
        uint256 amountUsdc;
        uint256 hfAfterSat;
        uint256 blHfReopen;
        bool blLiqReopen;
        bool blLiquidated;
        string note;
    }

    function setUp() public {
        string memory url = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 pinned = vm.envOr("REPLAY_FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, pinned);
        forkBlock = block.number;
        forkTime = block.timestamp;
        mp = MORPHO.idToMarketParams(MARKET);
        require(mp.collateralToken == AAPLC && mp.loanToken == USDC && mp.lltv == LLTV, "Steakhouse AAPLc market");

        (bool ok, bytes memory data) = AAPLC.staticcall(abi.encodeCall(IERC20.balanceOf, (MORPHO_BORROWER)));
        if (!(ok && data.length >= 32)) {
            console.log("B20 precompiles unavailable in this build: the replay needs base-forge");
            vm.skip(true);
            return;
        }

        _discoverFeedSlot();

        cal = new MarketCalendar(owner);
        vm.prank(owner);
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        gate = new SessionGate(owner, cal, REGISTRY);
        vm.prank(owner);
        gate.setFeed(AAPLC, FEED, 0, 0);

        pool = new MockSwapPool(USDC, AAPLC, 100, owner);
        pool.setObservationCardinality(1000);
        shadow = new ShadowGuard(owner, gate, AAPLC, 8, USDC, 6, ICLPool(address(pool)), 3600);
        preLiq = FACTORY.createPreLiquidation(
            MARKET,
            PreLiquidationParams({
                preLltv: PRE_LLTV,
                preLCF1: 1e18,
                preLCF2: 1e18,
                preLIF1: 1.01e18,
                preLIF2: 1.02e18,
                preLiquidationOracle: address(shadow)
            })
        );
        protector = new Protector(owner, MORPHO, keeper);
        vm.prank(owner);
        protector.setRoute(AAPLC, ICLSwapPool(address(pool)));

        vault = new ProtectionVault(owner, SPOKE, TAKER, GIVER, gate, USDC_RESERVE, keeper);
        vm.startPrank(owner);
        vault.setPartnerAdmin(PARTNER, owner);
        vault.setAdvanceTerms(10_000_000e6, 100);
        vm.stopPrank();
        deal(USDC, owner, 10_000_000e6);
        vm.startPrank(owner);
        IERC20(USDC).approve(address(vault), type(uint256).max);
        vault.fundAdvances(10_000_000e6);
        vm.stopPrank();

        // The Morpho repay rung: the Reserve's USDC, and liquidity on the market for the staging borrow.
        deal(USDC, reserveFunder, 10_000_000e6);
        vm.prank(reserveFunder);
        IERC20(USDC).approve(address(MORPHO), type(uint256).max);
        deal(USDC, supplier, 1_000_000e6);
        vm.startPrank(supplier);
        IERC20(USDC).approve(address(MORPHO), type(uint256).max);
        MORPHO.supply(mp, 1_000_000e6, 0, supplier, "");
        vm.stopPrank();
        deal(USDC, liquidator, 10_000_000e6);
        vm.startPrank(liquidator);
        IERC20(USDC).approve(address(MORPHO), type(uint256).max);
        IERC20(USDC).approve(address(SPOKE), type(uint256).max);
        vm.stopPrank();
        // The simulated DEX must be able to pay USDC for the collateral the Protector sells.
        deal(USDC, address(pool), 10_000_000e6);
    }

    // ---------------------------------------------------------------- feed forcing

    /// @dev Records the storage the aggregator reads for latestRoundData and keeps the slot whose low 192 bits
    ///      hold the answer; the layout-derived slot keccak256(roundId . 12) must agree.
    function _discoverFeedSlot() internal {
        (uint80 roundId, int256 answer,,,) = FEED.latestRoundData();
        // The aggregator is access-controlled (only the proxy may read it), so its own round id is derived
        // from the proxy's: proxyRoundId = phaseId << 64 | aggregatorRoundId.
        uint256 aggRound = uint256(uint64(roundId));
        heldAnswer = answer;
        heldRound = roundId;
        vm.record();
        FEED.latestRoundData();
        (bytes32[] memory reads,) = vm.accesses(AGGREGATOR);
        for (uint256 i = 0; i < reads.length; i++) {
            uint256 v = uint256(vm.load(AGGREGATOR, reads[i]));
            if ((v & ((uint256(1) << 192) - 1)) == uint256(answer)) {
                feedSlot = reads[i];
                break;
            }
        }
        require(feedSlot != bytes32(0), "transmission slot not found among the recorded reads");
        feedSlotByLayout = keccak256(abi.encode(aggRound, MAPPING_SLOT_TRANSMISSIONS));
        require(feedSlot == feedSlotByLayout, "recorded slot disagrees with the OCR2 layout");
    }

    function _writeFeed(int256 answer, uint256 observedAt, uint256 transmittedAt) internal {
        require(answer > 0 && uint256(answer) < (uint256(1) << 191), "answer range");
        uint256 packed = (transmittedAt << 224) | (observedAt << 192) | uint256(answer);
        vm.store(AGGREGATOR, feedSlot, bytes32(packed));
        (, int256 a,, uint256 u,) = FEED.latestRoundData();
        require(a == answer && u == transmittedAt, "feed rewrite not visible through the proxy");
    }

    // ---------------------------------------------------------------- venue views

    function _morphoDebt(address user) internal view returns (uint256) {
        return MORPHO.expectedBorrowAssets(mp, user);
    }

    /// @dev Morpho has no health factor; this is collateral x price x LLTV / debt on the same WAD scale as Aave's.
    function _morphoHf(address user, uint256 price36) internal view returns (uint256) {
        uint256 debt = _morphoDebt(user);
        if (debt == 0) return type(uint256).max;
        uint256 collateral = MORPHO.position(MARKET, user).collateral;
        return Math.mulDiv(Math.mulDiv(collateral, price36, 1e36), LLTV, debt);
    }

    function _aaveHf(address user) internal view returns (uint256) {
        return SPOKE.getUserAccountData(user).healthFactor;
    }

    function _hf(Pos memory p) internal view returns (uint256) {
        if (_isMorpho(p)) return _morphoHf(p.user, IOracle(mp.oracle).price());
        return _aaveHf(p.user);
    }

    function _debt(Pos memory p) internal view returns (uint256) {
        return _isMorpho(p) ? _morphoDebt(p.user) : SPOKE.getUserTotalDebt(USDC_RESERVE, p.user);
    }

    function _collateral(Pos memory p) internal view returns (uint256) {
        return
            _isMorpho(p)
                ? MORPHO.position(MARKET, p.user).collateral
                : SPOKE.getUserSuppliedAssets(AAPL_RESERVE, p.user);
    }

    function _isMorpho(Pos memory p) internal pure returns (bool) {
        return keccak256(bytes(p.venue)) == keccak256("morpho");
    }

    /// @dev A real liquidation attempt from a funded liquidator: Morpho seizes 0.01 AAPLc, Aave covers 1% of the
    ///      debt. True when the venue let it through.
    function _tryLiquidate(Pos memory p) internal returns (bool) {
        vm.startPrank(liquidator);
        bool ok;
        if (_isMorpho(p)) {
            (ok,) = address(MORPHO)
                .call(
                    abi.encodeWithSignature(
                        "liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)",
                        mp,
                        p.user,
                        1e6,
                        0,
                        ""
                    )
                );
        } else {
            uint256 cover = SPOKE.getUserTotalDebt(USDC_RESERVE, p.user) / 100;
            if (cover == 0) cover = 1;
            (ok,) = address(SPOKE)
                .call(
                    abi.encodeWithSignature(
                        "liquidationCall(uint256,uint256,address,uint256,bool)",
                        AAPL_RESERVE,
                        USDC_RESERVE,
                        p.user,
                        cover,
                        false
                    )
                );
        }
        vm.stopPrank();
        return ok;
    }

    // ---------------------------------------------------------------- staging and opt-in

    function _stage(Pos memory p) internal returns (string memory note) {
        if (!p.staged) return "";
        if (_isMorpho(p)) {
            uint256 price36 = IOracle(mp.oracle).price();
            uint256 collateral = MORPHO.position(MARKET, p.user).collateral;
            uint256 wanted = Math.mulDiv(Math.mulDiv(collateral, price36, 1e36), MORPHO_STAGE_LTV, WAD);
            uint256 debt = _morphoDebt(p.user);
            if (wanted <= debt) return "already at or above the staging LTV";
            vm.prank(p.user);
            MORPHO.borrow(mp, wanted - debt, 0, p.user, p.user);
            return
                string.concat(
                    "borrowed ", vm.toString(wanted - debt), " USDC to reach venue LTV 0.56 at the held price"
                );
        }
        // Aave: borrow until the health factor is at the staging target at the held price.
        uint256 borrowed;
        for (uint256 i = 0; i < 6; i++) {
            IAaveSpoke.UserAccountData memory d = SPOKE.getUserAccountData(p.user);
            if (d.healthFactor <= AAVE_STAGE_HF) break;
            uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE, p.user);
            // hf = C x cf / D; target D' = D x hf / target
            uint256 targetDebt = Math.mulDiv(debt, d.healthFactor, AAVE_STAGE_HF);
            if (targetDebt <= debt) break;
            uint256 step = targetDebt - debt;
            vm.prank(p.user);
            try SPOKE.borrow(USDC_RESERVE, step, p.user) {
                borrowed += step;
            } catch {
                return string.concat("Aave staging borrow refused after ", vm.toString(borrowed), " USDC");
            }
        }
        return string.concat("borrowed ", vm.toString(borrowed), " USDC to reach health 1.05 at the held price");
    }

    /// @dev The one-time opt-in a user signs: Morpho users authorise the audited pre-liquidation contract, Aave
    ///      users approve Aave's own Giver as a position manager.
    function _optIn(Pos memory p) internal {
        if (_isMorpho(p)) {
            vm.prank(p.user);
            MORPHO.setAuthorization(address(preLiq), true);
        } else {
            vm.prank(p.user);
            SPOKE.setUserPositionManager(address(GIVER), true);
        }
    }

    // ---------------------------------------------------------------- the simulated weekend DEX

    function _setDex(uint256 price36) internal {
        uint256 sqrtP = Math.sqrt(price36);
        uint160 sqrtX96 = uint160((uint256(1e18) << 96) / sqrtP);
        int24 tick = TickMath.getTickAtSqrtRatio(sqrtX96);
        pool.setAverageTick(3600, tick);
        pool.setSlot0(sqrtX96, tick);
        vm.prank(owner);
        pool.setPrice36(price36);
    }

    // ---------------------------------------------------------------- Boundline's Saturday action

    function _morphoAction(Row memory r) internal {
        Protector.Sizing memory z = protector.sizing(preLiq, r.pos.user, 0);
        r.standing = _standingName(z.standing);
        r.shadowPrice36 = z.shadowPrice36;
        if (z.standing == Protector.Standing.IN_BAND && z.maxSeizedAssets > 0) {
            vm.prank(keeper);
            (, uint256 repaid) = protector.protect(preLiq, r.pos.user, z.maxSeizedAssets, 0, 0, T_SAT + 1 hours);
            r.action = "pre-liquidate";
            r.amountUsdc = repaid;
            return;
        }
        if (
            z.standing == Protector.Standing.ABOVE_LLTV
                || (z.standing == Protector.Standing.IN_BAND && z.maxSeizedAssets == 0)
        ) {
            // Past the band at the DEX price: no pre-liquidation can run (Morpho's audited contract refuses a
            // liquidatable position), so the ladder's repay rung pays debt down to the band's edge at the
            // shadow price. Morpho's repay reads no oracle and is callable by anyone.
            uint256 collateral = MORPHO.position(MARKET, r.pos.user).collateral;
            uint256 safeDebt = Math.mulDiv(Math.mulDiv(collateral, z.shadowPrice36, 1e36), PRE_LLTV, WAD);
            uint256 debt = _morphoDebt(r.pos.user);
            if (debt > safeDebt) {
                uint256 amount = debt - safeDebt;
                vm.prank(reserveFunder);
                (uint256 repaid,) = MORPHO.repay(mp, amount, 0, r.pos.user, "");
                r.action = "pre-repay";
                r.amountUsdc = repaid;
                return;
            }
        }
        r.action = "none";
    }

    function _aaveAction(Row memory r) internal {
        // Shadow health: the venue's own account data at the gapped price, read in a throwaway snapshot.
        uint256 s = vm.snapshotState();
        _writeFeed(r.gappedAnswer, T_SAT - 60, T_SAT - 30);
        uint256 hfGapped = _aaveHf(r.pos.user);
        vm.revertToState(s);
        r.shadowPrice36 = uint256(r.gappedAnswer) * SCALE;
        r.standing = hfGapped < WAD ? "ABOVE_LLTV" : (hfGapped < HF_TARGET ? "IN_BAND" : "BELOW_BAND");
        if (hfGapped >= HF_TARGET) {
            r.action = "none";
            return;
        }
        uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE, r.pos.user);
        uint256 amount = Math.mulDiv(debt, HF_TARGET - hfGapped, HF_TARGET) + 1;
        vm.prank(keeper);
        (uint256 repaid,) = vault.protect(r.pos.user, PARTNER, amount);
        r.action = "pre-repay";
        r.amountUsdc = repaid;
    }

    function _standingName(Protector.Standing s) internal pure returns (string memory) {
        if (s == Protector.Standing.NO_POSITION) return "NO_POSITION";
        if (s == Protector.Standing.NO_SHADOW_PRICE) return "NO_SHADOW_PRICE";
        if (s == Protector.Standing.BELOW_BAND) return "BELOW_BAND";
        if (s == Protector.Standing.IN_BAND) return "IN_BAND";
        return "ABOVE_LLTV";
    }

    // ---------------------------------------------------------------- one scenario

    function _run(Pos memory p, int256 gapBps) internal returns (Row memory r) {
        r.pos = p;
        r.gapBps = gapBps;
        uint256 base = vm.snapshotState();

        r.hfReal = _hf(p);
        // Friday's last print: the held answer, timestamped just before the 20:00 ET close.
        vm.warp(T_FRI_CLOSE - 60);
        _writeFeed(heldAnswer, T_FRI_CLOSE - 120, T_FRI_CLOSE - 100);
        r.note = _stage(p);
        _optIn(p);
        r.hfBefore = _hf(p);
        r.collateralRaw = _collateral(p);
        r.debtUsdc = _debt(p);

        // Saturday: the feed is held, the DEX has moved.
        vm.warp(T_SAT);
        r.gappedAnswer = heldAnswer * (10_000 + gapBps) / 10_000;
        _setDex(uint256(r.gappedAnswer) * SCALE);
        r.hfHeld = _hf(p);
        r.rawLiqSaturday = r.hfHeld < WAD;

        // Raw venue: nothing happens until the reopen prints the gap.
        uint256 sat = vm.snapshotState();
        _reopen(r.gappedAnswer);
        r.rawHfReopen = _hf(p);
        r.rawLiqReopen = r.rawHfReopen < WAD;
        r.rawLiquidated = _tryLiquidate(p);
        vm.revertToState(sat);
        vm.warp(T_SAT);

        // Boundline: the keeper acts on Saturday at the DEX price, then the same reopen.
        if (_isMorpho(p)) _morphoAction(r);
        else _aaveAction(r);
        r.hfAfterSat = _hf(p);
        _reopen(r.gappedAnswer);
        r.blHfReopen = _hf(p);
        r.blLiqReopen = r.blHfReopen < WAD;
        r.blLiquidated = _tryLiquidate(p);

        vm.revertToState(base);
        vm.warp(forkTime);
    }

    function _reopen(int256 answer) internal {
        vm.warp(T_REOPEN + 12);
        _writeFeed(answer, T_REOPEN, T_REOPEN + 2);
    }

    // ---------------------------------------------------------------- positions

    function _aavePositions() internal view returns (Pos[] memory out) {
        address[] memory none;
        address[] memory candidates = vm.envOr("REPLAY_AAVE_CANDIDATES", ",", none);
        address largest;
        uint256 largestDebt;
        address weakest;
        uint256 weakestHf = type(uint256).max;
        for (uint256 i = 0; i < candidates.length; i++) {
            address u = candidates[i];
            uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE, u);
            uint256 aapl = SPOKE.getUserSuppliedAssets(AAPL_RESERVE, u);
            uint256 hf = _aaveHf(u);
            console.log(
                string.concat(
                    "REPLAY_CANDIDATE {",
                    _obj5(
                        _kvA("address", u),
                        _kvU("debtUsdc", debt),
                        _kvU("aaplcRaw", aapl),
                        _kvU("hf", hf),
                        _kvB("eligible", debt > 0 && aapl > 0 && hf >= WAD)
                    ),
                    "}"
                )
            );
            if (debt == 0 || aapl == 0 || hf < WAD) continue;
            if (debt > largestDebt) {
                largestDebt = debt;
                largest = u;
            }
            if (hf < weakestHf) {
                weakestHf = hf;
                weakest = u;
            }
        }
        uint256 n = (largest != address(0) ? 1 : 0) + (weakest != address(0) && weakest != largest ? 1 : 0)
            + (weakest != address(0) ? 1 : 0);
        out = new Pos[](n);
        uint256 k;
        if (largest != address(0)) out[k++] = Pos("aave largest USDC debt", "aave", largest, false);
        if (weakest != address(0) && weakest != largest) out[k++] = Pos("aave lowest health", "aave", weakest, false);
        if (weakest != address(0)) out[k++] = Pos("aave lowest health, staged to health 1.05", "aave", weakest, true);
    }

    function test_replay() public {
        Pos[] memory aave = _aavePositions();
        Pos[] memory positions = new Pos[](2 + aave.length);
        positions[0] = Pos("morpho Steakhouse AAPLc borrower", "morpho", MORPHO_BORROWER, false);
        positions[1] =
            Pos("morpho Steakhouse AAPLc borrower, staged to venue LTV 0.56", "morpho", MORPHO_BORROWER, true);
        for (uint256 i = 0; i < aave.length; i++) {
            positions[2 + i] = aave[i];
        }

        console.log(
            string.concat(
                "REPLAY_META {",
                _obj8(
                    _kvU("forkBlock", forkBlock),
                    _kvU("forkBlockTime", forkTime),
                    _kvI("heldAnswer", heldAnswer),
                    _kvU("heldRound", uint256(heldRound)),
                    _kvS("feedSlot", vm.toString(feedSlot)),
                    _kvS("feedSlotByLayout", vm.toString(feedSlotByLayout)),
                    _kvU("positions", positions.length),
                    _kvS(
                        "timestamps",
                        string.concat(
                            "{\"fridayClose\":",
                            vm.toString(T_FRI_CLOSE),
                            ",\"saturday\":",
                            vm.toString(T_SAT),
                            ",\"reopen\":",
                            vm.toString(T_REOPEN),
                            "}"
                        )
                    )
                ),
                "}"
            )
        );

        int256[3] memory gaps = [int256(-300), -800, -1500];
        uint256 failures;
        for (uint256 g = 0; g < gaps.length; g++) {
            for (uint256 i = 0; i < positions.length; i++) {
                Row memory r = _run(positions[i], gaps[g]);
                console.log(string.concat("REPLAY_ROW ", _rowJson(r)));
                if (r.blLiqReopen || r.blLiquidated) failures++;
            }
        }
        console.log(
            string.concat(
                "REPLAY_DONE {\"rows\":",
                vm.toString(gaps.length * positions.length),
                ",\"boundlineFailures\":",
                vm.toString(failures),
                "}"
            )
        );
        assertEq(failures, 0, "Boundline left a position liquidatable at the reopen (see REPLAY_ROW lines)");
    }

    // ---------------------------------------------------------------- json

    function _rowJson(Row memory r) internal pure returns (string memory) {
        string memory raw = _obj4(
            _kvU("hfBefore", r.hfBefore),
            _kvU("hfAtReopen", r.rawHfReopen),
            _kvB("liquidatableSaturday", r.rawLiqSaturday),
            _kvB("liquidatableAtReopen", r.rawLiqReopen)
        );
        raw = string.concat(
            raw, ",", _kvB("liquidationExecuted", r.rawLiquidated), ",", _kvU("hfSaturdayHeld", r.hfHeld)
        );
        string memory bl = _obj5(
            _kvS("action", r.action),
            _kvS("actionAt", "saturday"),
            _kvU("amountUsdc", r.amountUsdc),
            _kvU("hfAfter", r.blHfReopen),
            _kvB("liquidatableAtReopen", r.blLiqReopen)
        );
        bl = string.concat(
            bl,
            ",",
            _kvB("liquidationExecuted", r.blLiquidated),
            ",",
            _kvU("hfAfterSaturday", r.hfAfterSat),
            ",",
            _kvS("standing", r.standing),
            ",",
            _kvU("shadowPrice36", r.shadowPrice36)
        );
        string memory head = _obj8(
            _kvS("venue", r.pos.venue),
            _kvA("address", r.pos.user),
            _kvS("label", r.pos.label),
            _kvB("staged", r.pos.staged),
            _kvI("gapBps", r.gapBps),
            _kvI("gappedAnswer", r.gappedAnswer),
            _kvU("collateralRaw", r.collateralRaw),
            _kvU("debtUsdc", r.debtUsdc)
        );
        return string.concat(
            "{",
            head,
            ",",
            _kvU("hfReal", r.hfReal),
            ",",
            _kvS("note", r.note),
            ",\"raw\":{",
            raw,
            "},\"boundline\":{",
            bl,
            "}}"
        );
    }

    function _q(string memory s) internal pure returns (string memory) {
        return string.concat("\"", s, "\"");
    }

    function _kvU(string memory k, uint256 v) internal pure returns (string memory) {
        return string.concat(_q(k), ":", _q(vm.toString(v)));
    }

    function _kvI(string memory k, int256 v) internal pure returns (string memory) {
        return string.concat(_q(k), ":", vm.toString(v));
    }

    function _kvB(string memory k, bool v) internal pure returns (string memory) {
        return string.concat(_q(k), ":", v ? "true" : "false");
    }

    function _kvS(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat(_q(k), ":", bytes(v).length > 0 && bytes(v)[0] == "{" ? v : _q(v));
    }

    function _kvA(string memory k, address v) internal pure returns (string memory) {
        return string.concat(_q(k), ":", _q(vm.toString(v)));
    }

    function _obj4(string memory a, string memory b, string memory c, string memory d)
        internal
        pure
        returns (string memory)
    {
        return string.concat(a, ",", b, ",", c, ",", d);
    }

    function _obj5(string memory a, string memory b, string memory c, string memory d, string memory e)
        internal
        pure
        returns (string memory)
    {
        return string.concat(a, ",", b, ",", c, ",", d, ",", e);
    }

    function _obj8(
        string memory a,
        string memory b,
        string memory c,
        string memory d,
        string memory e,
        string memory f,
        string memory g,
        string memory h
    ) internal pure returns (string memory) {
        return string.concat(a, ",", b, ",", c, ",", d, ",", e, ",", f, ",", g, ",", h);
    }
}
