// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IOracleRegistry} from "../../src/interfaces/IOracleRegistry.sol";
import {IPriceGate} from "../../src/interfaces/IPriceGate.sol";
import {IEligibility} from "../../src/interfaces/IEligibility.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {AaveDesk} from "../../src/aave/AaveDesk.sol";
import {ProtectionVault} from "../../src/aave/ProtectionVault.sol";
import {AaveTypes as T} from "../../src/aave/AaveTypes.sol";
import {IAaveSpoke, ITakerPositionManager, IGiverPositionManager} from "../../src/aave/interfaces/IAaveV4.sol";
import {DrillBase} from "./DrillBase.sol";

/// @dev Aave V4 v0.5.11 `IHub.SpokeConfig`: the hub-side switch that halted the MAG7 spoke on 24 Sep 2026.
interface IAaveHub {
    struct SpokeConfig {
        uint40 addCap;
        uint40 drawCap;
        uint24 riskPremiumThreshold;
        bool active;
        bool halted;
    }

    function getSpokeConfig(uint256 assetId, address spoke) external view returns (SpokeConfig memory);
}

/// @dev The governance executor the Base Security Council Safe drives (owner = the Safe).
interface IAaveExecutor {
    function executeTransaction(
        address target,
        uint256 value,
        string calldata signature,
        bytes calldata data,
        bool withDelegatecall
    ) external payable returns (bytes memory);
}

/// @dev Aave V4 SpokeConfigurator (role 400 on the AccessManager, held by the executor).
interface IAaveSpokeConfigurator {
    function updateFrozen(address spoke, uint256 reserveId, bool frozen) external;
    function updatePaused(address spoke, uint256 reserveId, bool paused) external;
}

/// @notice Drill `venue-halt` on a Base mainnet fork of the live Aave V4 MAG7 spoke, with the real borrower of the
///         6 Oct fork proof enrolled on an AaveDesk line and a ProtectionVault. From one in-session baseline:
///
///         A. **The real 24 Sep 2026 halt, replayed.** At 16:54:43 UTC the Safe `0x187A…77e9` had executor
///            `0xA9D9…3d70` run payload `0xbff6…3ac1` (tx `0x86de1998…ed8f`, block 51,739,768), which set
///            `SpokeConfig.halted` on the hub for every asset of the MAG7, treasury and tokenization spokes through
///            HubConfigurator `0x2Cd4…778A.updateSpokeHalted`; payload `0x6BDf…198E` reversed it (24 Sep 16:17:23 and
///            25 Sep 12:47:01, tx `0x9d66188f…5d30`). The drill runs both payloads exactly, as the Safe.
///         B. The AAPLc reserve frozen, C. the AAPLc reserve paused, D. the USDC reserve paused, each through
///            SpokeConfigurator `0x0191…a57f` as the executor (the AccessManager `0x4010…1Cc6` grants it role 400;
///            the configurator holds role 301 on `Spoke.updateReserveConfig`).
///
///         For each: what the desk quotes and records, what a draw, the protective repay through the Giver, a
///         withdrawal and a liquidation get from the venue, and that the switch's reversal returns the line to OPEN.
///         Runs under base-forge only (the gate reads the B20 token and the registry); skips without BASE_RPC_URL.
contract VenueHaltDrillTest is DrillBase {
    IAaveSpoke constant SPOKE = IAaveSpoke(0x17905Db0e4A3514467539956c084180616AE7B8D);
    ITakerPositionManager constant TAKER = ITakerPositionManager(0x8481204E528735aF2F3391AD98f36E757A56D695);
    IGiverPositionManager constant GIVER = IGiverPositionManager(0x9E81c2fDE4E34CAB3AB1667ca3c932dBAED95F08);
    IAaveHub constant HUB = IAaveHub(0xa4d5947Eb727A052bae69C593FfC84247EC9864E);
    address constant SAFE = 0x187AAE17d4931310B3fc75743e7F16Bdc9eD77e9;
    IAaveExecutor constant EXECUTOR = IAaveExecutor(0xA9D9923A1ADC1200771aaaA38CFeD6A5b8483d70);
    address constant HALT_PAYLOAD = 0xbff63E3ad59a5F06716FD2EDd0E3C2a7123E3ac1;
    address constant GO_LIVE_PAYLOAD = 0x6BDf957Ff2AE324fe23911f549aff9b5621b198E;
    IAaveSpokeConfigurator constant SPOKE_CONFIGURATOR =
        IAaveSpokeConfigurator(0x0191B1Aa743c6B3C545119B5D56a0577D7f3a57F);
    uint256 constant AAPL_RESERVE = 0; // hub asset 0
    uint256 constant USDC_RESERVE = 7; // hub asset 7
    bytes32 constant PARTNER = "boundline-app";
    uint256 constant WAD = 1e18;

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address liquidator = makeAddr("liquidator");
    address borrower;

    MarketCalendar cal;
    SessionGate gate;
    AaveDesk desk;
    ProtectionVault vault;
    uint256 lineId;

    function setUp() public {
        if (!_fork("venue-halt")) return;
        borrower = vm.envOr("AAVE_FORK_BORROWER", address(0xC9Bc5Cab29dC93A9D2ea16Ef38620598FAd5ca66));
        require(SPOKE.getReserve(AAPL_RESERVE).underlying == AAPLC, "reserve 0 is AAPLc");
        require(SPOKE.getReserve(USDC_RESERVE).underlying == USDC, "reserve 7 is USDC");
        _discoverFeedSlot();

        cal = new MarketCalendar(owner);
        vm.prank(owner);
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        gate = new SessionGate(owner, cal, IOracleRegistry(ORACLE_REGISTRY));
        vm.prank(owner);
        gate.setFeed(AAPLC, AAPL_FEED, 0, 0);

        desk = new AaveDesk(owner, SPOKE, TAKER, GIVER, gate, USDC_RESERVE, keeper);
        vault = new ProtectionVault(owner, SPOKE, TAKER, GIVER, gate, USDC_RESERVE, keeper);
        vm.startPrank(owner);
        desk.enableReserve(AAPL_RESERVE);
        desk.createPartner(PARTNER, owner, address(0), IEligibility(address(0)), 10_000e6);
        desk.setReservePolicy(PARTNER, AAPL_RESERVE, true, 0.5e18, 1e6, 1000e6, 5000e6);
        vault.setPartnerAdmin(PARTNER, owner);
        vault.setAdvanceTerms(1000e6, 100);
        vm.stopPrank();

        // Headroom for a policy draw, as in the 6 Oct proof: repay to 30% of the AAPLc value at Aave's price.
        uint256 supplied = SPOKE.getUserSuppliedAssets(AAPL_RESERVE, borrower);
        require(supplied > 0, "the borrower holds AAPLc on the spoke");
        uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE, borrower);
        uint256 target = supplied * _aavePrice(AAPL_RESERVE) / 1e10 * 30 / 100;
        if (debt > target) {
            uint256 down = debt - target;
            deal(USDC, borrower, down);
            vm.startPrank(borrower);
            IERC20(USDC).approve(address(SPOKE), down);
            SPOKE.repay(USDC_RESERVE, down, borrower);
            vm.stopPrank();
        }

        // Enrolment and the line, then the ladder's money: 50 USDC of the user's own reserve, 500 of advances.
        vm.startPrank(borrower);
        SPOKE.setUserPositionManager(address(TAKER), true);
        SPOKE.setUserPositionManager(address(GIVER), true);
        TAKER.approveBorrow(address(SPOKE), USDC_RESERVE, address(desk), 1000e6);
        IERC20(USDC).approve(address(desk), type(uint256).max);
        IERC20(USDC).approve(address(vault), type(uint256).max);
        IERC20(USDC).approve(address(SPOKE), type(uint256).max);
        lineId = desk.openLine(PARTNER, AAPL_RESERVE, 0, "");
        vm.stopPrank();
        deal(USDC, borrower, 50e6);
        vm.prank(borrower);
        vault.deposit(50e6);
        deal(USDC, owner, 500e6);
        vm.startPrank(owner);
        IERC20(USDC).approve(address(vault), 500e6);
        vault.fundAdvances(500e6);
        vm.stopPrank();
        deal(USDC, liquidator, 10_000_000e6);
        vm.prank(liquidator);
        IERC20(USDC).approve(address(SPOKE), type(uint256).max);

        // A fixed in-session moment so the drill reads the same whenever it runs: Friday 10:30 ET with the feed's
        // own last answer re-stamped one minute earlier (only the timestamp moves; Aave's price is unchanged).
        vm.warp(T_FRI_SESSION);
        _writeFeed(heldAnswer, T_FRI_SESSION - 90, T_FRI_SESSION - 60);
    }

    function _aavePrice(uint256 reserveId) internal view returns (uint256) {
        (bool ok, bytes memory data) =
            SPOKE.ORACLE().staticcall(abi.encodeWithSignature("getReservePrice(uint256)", reserveId));
        require(ok && data.length >= 32, "oracle price");
        return abi.decode(data, (uint256));
    }

    // ---------------------------------------------------------------- probes

    function _draw(uint256 amount) internal returns (bool ok, bytes memory ret) {
        vm.prank(borrower);
        (ok, ret) = address(desk).call(abi.encodeCall(AaveDesk.draw, (lineId, amount)));
    }

    function _protect(uint256 amount) internal returns (bool ok, bytes memory ret) {
        vm.prank(keeper);
        (ok, ret) = address(vault).call(abi.encodeCall(ProtectionVault.protect, (borrower, PARTNER, amount)));
    }

    function _venueRepay(uint256 amount) internal returns (bool ok, bytes memory ret) {
        deal(USDC, borrower, amount);
        vm.prank(borrower);
        (ok, ret) = address(SPOKE).call(abi.encodeCall(IAaveSpoke.repay, (USDC_RESERVE, amount, borrower)));
    }

    /// @dev The desk's own repay (anyone may fund it): a stranger with fresh USDC.
    function _deskRepay(uint256 amount) internal returns (bool ok, bytes memory ret) {
        address payer = makeAddr("payer");
        deal(USDC, payer, amount);
        vm.startPrank(payer);
        IERC20(USDC).approve(address(desk), amount);
        (ok, ret) = address(desk).call(abi.encodeCall(AaveDesk.repay, (lineId, amount)));
        vm.stopPrank();
    }

    function _venueBorrow(uint256 amount) internal returns (bool ok, bytes memory ret) {
        vm.prank(borrower);
        (ok, ret) = address(SPOKE).call(abi.encodeCall(IAaveSpoke.borrow, (USDC_RESERVE, amount, borrower)));
    }

    function _venueWithdraw(uint256 amount) internal returns (bool ok, bytes memory ret) {
        vm.prank(borrower);
        (ok, ret) = address(SPOKE).call(abi.encodeCall(IAaveSpoke.withdraw, (AAPL_RESERVE, amount, borrower)));
    }

    /// @dev New AAPLc supplied to the spoke: 0.01 AAPLc moved from the Aerodrome pool first (a B20 transfer).
    function _venueSupply() internal returns (bool ok, bytes memory ret) {
        vm.prank(AERODROME_AAPLC_POOL);
        IERC20(AAPLC).transfer(borrower, 1e6);
        vm.startPrank(borrower);
        IERC20(AAPLC).approve(address(SPOKE), 1e6);
        (ok, ret) = address(SPOKE).call(abi.encodeCall(IAaveSpoke.supply, (AAPL_RESERVE, 1e6, borrower)));
        vm.stopPrank();
    }

    /// @dev Stages an under-water position while every switch is still off: the borrower borrows at the venue
    ///      until health is 1.10 at the live price, then the AAPLc feed is rewritten to 35% of its value. AAPLc is
    ///      about two thirds of this borrower's risk-weighted collateral (six other MAG7 stocks make up the rest),
    ///      so health lands near 0.6. Returns the health factor after the crash.
    function _stageUnderwater() internal returns (uint256 hf) {
        IAaveSpoke.UserAccountData memory d = SPOKE.getUserAccountData(borrower);
        uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE, borrower);
        uint256 targetDebt = debt * d.healthFactor / 1.1e18;
        if (targetDebt > debt) {
            vm.prank(borrower);
            SPOKE.borrow(USDC_RESERVE, targetDebt - debt, borrower);
        }
        _writeFeed(heldAnswer * 35 / 100, block.timestamp - 30, block.timestamp - 20);
        hf = SPOKE.getUserAccountData(borrower).healthFactor;
    }

    /// @dev A liquidator covers 1% of the USDC debt against the AAPLc collateral (no shares received).
    function _liquidate() internal returns (bool ok, bytes memory ret) {
        uint256 cover = SPOKE.getUserTotalDebt(USDC_RESERVE, borrower) / 100;
        vm.prank(liquidator);
        (ok, ret) = address(SPOKE)
            .call(
                abi.encodeWithSignature(
                    "liquidationCall(uint256,uint256,address,uint256,bool)",
                    AAPL_RESERVE,
                    USDC_RESERVE,
                    borrower,
                    cover,
                    false
                )
            );
    }

    function _reason(T.Reason r) internal pure returns (string memory) {
        string[26] memory names = [
            "NONE",
            "DESK_PAUSED",
            "LINE_NOT_OPEN",
            "LINE_HELD",
            "PARTNER_INACTIVE",
            "MARKET_DISABLED",
            "MARKET_CLOSED",
            "FEED_PAUSED",
            "TRANSFER_PAUSED",
            "FEED_STALE",
            "FEED_INVALID",
            "UNKNOWN_TOKEN",
            "TICKER_NOT_ALLOWED",
            "NOT_ELIGIBLE",
            "BELOW_MIN_DRAW",
            "ABOVE_MAX_DRAW",
            "PARTNER_CAP",
            "TICKER_CAP",
            "INSUFFICIENT_CAPACITY",
            "NOT_AUTHORIZED_ON_VENUE",
            "VENUE_PAUSED",
            "VENUE_FROZEN",
            "NO_COLLATERAL",
            "COLLATERAL_DISABLED",
            "VENUE_UNHEALTHY",
            "VENUE_HALTED"
        ];
        return names[uint256(r)];
    }

    function _status(T.ObligationStatus s) internal pure returns (string memory) {
        string[9] memory names = [
            "NONE",
            "OPEN",
            "HOLD_SESSION",
            "HOLD_FEED",
            "HOLD_ISSUER",
            "HOLD_TRANSFER",
            "HOLD_KEEPER",
            "CLOSED",
            "HOLD_VENUE"
        ];
        return names[uint256(s)];
    }

    function _checkS(string memory scenario, string memory what, string memory actual, string memory expected)
        internal
    {
        bool pass = keccak256(bytes(actual)) == keccak256(bytes(expected));
        _rec(
            "check",
            string.concat(
                _kvS("scenario", scenario),
                ",",
                _kvS("what", what),
                ",",
                _kvS("actual", actual),
                ",",
                _kvS("expected", expected),
                ",",
                _kvB("pass", pass)
            )
        );
        assertTrue(pass, string.concat(scenario, ": ", what, " is ", actual, ", expected ", expected));
    }

    /// @dev Desk view of the line: the quote's reason for a 10 USDC draw and the obligation status.
    function _deskView(string memory scenario, string memory wantReason, string memory wantStatus) internal {
        T.Quote memory q = desk.quote(lineId, 10e6);
        _checkS(scenario, "desk quote reason for a 10 USDC draw", _reason(q.reason), wantReason);
        _checkS(scenario, "obligation status", _status(desk.obligationStatus(lineId)), wantStatus);
    }

    uint8 constant SW_HUB_HALT = 0;
    uint8 constant SW_AAPL_FROZEN = 1;
    uint8 constant SW_AAPL_PAUSED = 2;
    uint8 constant SW_USDC_PAUSED = 3;

    function _setHalted(bool halted) internal {
        vm.prank(SAFE);
        EXECUTOR.executeTransaction(halted ? HALT_PAYLOAD : GO_LIVE_PAYLOAD, 0, "execute()", "", true);
    }

    /// @dev The four switches, each through the path governance uses: the hub halt through the executor and the
    ///      24 Sep payloads, the reserve flags through the SpokeConfigurator as the executor.
    function _switch(uint8 sw, bool on) internal {
        if (sw == SW_HUB_HALT) {
            _setHalted(on);
        } else {
            vm.prank(address(EXECUTOR));
            if (sw == SW_AAPL_FROZEN) SPOKE_CONFIGURATOR.updateFrozen(address(SPOKE), AAPL_RESERVE, on);
            else if (sw == SW_AAPL_PAUSED) SPOKE_CONFIGURATOR.updatePaused(address(SPOKE), AAPL_RESERVE, on);
            else SPOKE_CONFIGURATOR.updatePaused(address(SPOKE), USDC_RESERVE, on);
        }
    }

    // ---------------------------------------------------------------- the drill

    uint256 baseSnap;

    function test_drill_venueHalt() public {
        _rec(
            "meta",
            string.concat(
                _kvU("forkBlock", forkBlock),
                ",",
                _kvU("forkBlockTime", forkTime),
                ",",
                _kvU("drillTime", block.timestamp),
                ",",
                _kvS("borrower", vm.toString(borrower)),
                ",",
                _kvU("lineId", lineId),
                ",",
                _kvU("heldAnswer", uint256(heldAnswer)),
                ",",
                _kvS("feedSlot", vm.toString(feedSlot)),
                ",",
                _kvU("aaplcSupplied", SPOKE.getUserSuppliedAssets(AAPL_RESERVE, borrower)),
                ",",
                _kvU("usdcDebt", SPOKE.getUserTotalDebt(USDC_RESERVE, borrower)),
                ",",
                _kvU("healthFactor", SPOKE.getUserAccountData(borrower).healthFactor)
            )
        );
        IPriceGate.Verdict memory v = gate.check(AAPLC);
        _checkU("baseline", "gate state (0 = OPEN)", uint256(v.state), uint256(IPriceGate.GateState.OPEN));
        _checkB("baseline", "hub: MAG7 spoke halted for AAPLc", HUB.getSpokeConfig(0, address(SPOKE)).halted, false);
        _deskView("baseline", "NONE", "OPEN");
        baseSnap = vm.snapshotState();
        (bool ok, bytes memory ret) = _draw(10e6);
        _checkCall("baseline", "desk draw of 10 USDC through the Taker", ok, ret, true, "");
        vm.revertToState(baseSnap);

        _scenarioHubHalt();
        _scenarioFrozen();
        _scenarioCollateralPaused();
        _scenarioDebtPaused();

        // Liquidations under each switch, from one under-water position staged before the switch is thrown.
        _liquidationUnder("hub-halt (24 Sep payload)", SW_HUB_HALT, false, "SpokeHalted()");
        _liquidationUnder("aaplc-reserve-frozen", SW_AAPL_FROZEN, true, "");
        _liquidationUnder("aaplc-reserve-paused", SW_AAPL_PAUSED, false, "ReservePaused()");
        _liquidationUnder("usdc-reserve-paused", SW_USDC_PAUSED, false, "ReservePaused()");
    }

    function _liquidationUnder(string memory s, uint8 sw, bool okWhileOn, string memory whileOn) internal {
        vm.revertToState(baseSnap);
        uint256 hf = _stageUnderwater();
        _value(s, "health factor of the staged position after the AAPLc feed is rewritten to 35%", hf);
        _checkB(s, "staged position liquidatable by health (HF < 1)", hf < WAD, true);
        _switch(sw, true);
        (bool ok, bytes memory ret) = _liquidate();
        _checkCall(s, "liquidationCall covering 1% of the debt while the switch is on", ok, ret, okWhileOn, whileOn);
        _switch(sw, false);
        (ok, ret) = _liquidate();
        _checkCall(string.concat(s, " -> reversed"), "liquidationCall covering 1% of the debt", ok, ret, true, "");
        vm.revertToState(baseSnap);
    }

    /// @dev A. The real switch: the hub halts the spoke. Every hub action reverts SpokeHalted() (add, remove, draw
    ///      and restore), so nothing moves in either direction: no draw, no repay, no withdrawal (and, below, no
    ///      liquidation). The desk and the vault read the hub's SpokeConfig, record HOLD_VENUE and refuse by name
    ///      (VENUE_HALTED) before the venue is called.
    function _scenarioHubHalt() internal {
        string memory s = "hub-halt (24 Sep payload)";
        _switch(SW_HUB_HALT, true);
        _checkB(s, "hub: MAG7 spoke halted for AAPLc (asset 0)", HUB.getSpokeConfig(0, address(SPOKE)).halted, true);
        _checkB(s, "hub: MAG7 spoke halted for USDC (asset 7)", HUB.getSpokeConfig(7, address(SPOKE)).halted, true);
        // The desk and the vault read the hub's SpokeConfig: the record says HOLD_VENUE, nothing is quoted, and
        // both refuse by name before any call reaches the venue.
        _deskView(s, "VENUE_HALTED", "HOLD_VENUE");
        _checkU(s, "desk quote available (USDC units)", desk.quote(lineId, 10e6).available, 0);
        _checkS(s, "vault venueReason for the USDC reserve", _reason(vault.venueReason(USDC_RESERVE)), "VENUE_HALTED");
        _checkS(s, "vault venueReason for the AAPLc reserve", _reason(vault.venueReason(AAPL_RESERVE)), "VENUE_HALTED");

        uint256 usdcBefore = IERC20(USDC).balanceOf(borrower);
        (bool ok, bytes memory ret) = _draw(10e6);
        _checkCall(s, "desk draw of 10 USDC", ok, ret, false, "Refused(25)");
        _checkU(s, "borrower USDC unchanged after the refused draw", IERC20(USDC).balanceOf(borrower), usdcBefore);
        uint256 vaultBefore = IERC20(USDC).balanceOf(address(vault));
        (ok, ret) = _protect(20e6);
        _checkCall(s, "protective repay of 20 USDC through the Giver", ok, ret, false, "Refused(25)");
        _checkU(s, "vault USDC unchanged", IERC20(USDC).balanceOf(address(vault)), vaultBefore);
        (ok, ret) = _deskRepay(1e6);
        _checkCall(s, "desk repay of 1 USDC (anyone, any hour)", ok, ret, false, "Refused(25)");
        (ok, ret) = _venueRepay(1e6);
        _checkCall(s, "repay of 1 USDC by the borrower at the venue", ok, ret, false, "SpokeHalted()");
        (ok, ret) = _venueWithdraw(1e6);
        _checkCall(s, "withdrawal of 0.01 AAPLc at the venue", ok, ret, false, "SpokeHalted()");

        _switch(SW_HUB_HALT, false);
        string memory r = string.concat(s, " -> reversed");
        _checkB(r, "hub: halted cleared by the go-live payload", HUB.getSpokeConfig(0, address(SPOKE)).halted, false);
        _deskView(r, "NONE", "OPEN");
        _checkS(r, "vault venueReason for the USDC reserve", _reason(vault.venueReason(USDC_RESERVE)), "NONE");
        (ok, ret) = _deskRepay(1e6);
        _checkCall(r, "desk repay of 1 USDC (anyone, any hour)", ok, ret, true, "");
        (ok, ret) = _draw(10e6);
        _checkCall(r, "desk draw of 10 USDC", ok, ret, true, "");
        vm.revertToState(baseSnap);
    }

    /// @dev B. The AAPLc reserve frozen: no new AAPLc supply at the venue; the desk refuses every draw against it
    ///      (VENUE_FROZEN, HOLD_VENUE) although Aave itself still lends USDC against frozen collateral; the
    ///      protective repay through the Giver passes.
    function _scenarioFrozen() internal {
        string memory s = "aaplc-reserve-frozen";
        _switch(SW_AAPL_FROZEN, true);
        _checkB(s, "spoke: AAPLc reserve frozen", SPOKE.getReserveConfig(AAPL_RESERVE).frozen, true);
        _deskView(s, "VENUE_FROZEN", "HOLD_VENUE");
        _checkS(
            s,
            "vault venueReason for the AAPLc reserve (a frozen reserve still withdraws)",
            _reason(vault.venueReason(AAPL_RESERVE)),
            "NONE"
        );
        (bool ok, bytes memory ret) = _draw(10e6);
        _checkCall(s, "desk draw of 10 USDC", ok, ret, false, "Refused(21)");

        uint256 debtBefore = SPOKE.getUserTotalDebt(USDC_RESERVE, borrower);
        uint256 hfBefore = SPOKE.getUserAccountData(borrower).healthFactor;
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        (uint256 repaid, ProtectionVault.Funding memory f) = vault.protect(borrower, PARTNER, 20e6);
        _checkU(s, "protective repay through the Giver: repaid (USDC units)", repaid, 20e6);
        _checkU(s, "funded from the user's reserve (USDC units)", f.fromUser, 20e6);
        _checkApprox(
            s,
            "venue debt reduced by the repay (USDC units)",
            debtBefore - SPOKE.getUserTotalDebt(USDC_RESERVE, borrower),
            20e6,
            2
        );
        _checkB(s, "health factor rose", SPOKE.getUserAccountData(borrower).healthFactor > hfBefore, true);
        vm.revertToState(snap);

        (ok, ret) = _venueSupply();
        _checkCall(s, "new AAPLc supply at the venue", ok, ret, false, "ReserveFrozen()");
        (ok, ret) = _venueBorrow(1e6);
        _checkCall(s, "USDC borrow straight at the venue (Aave freezes per reserve)", ok, ret, true, "");

        vm.revertToState(snap);
        _switch(SW_AAPL_FROZEN, false);
        string memory r = string.concat(s, " -> unfrozen");
        _deskView(r, "NONE", "OPEN");
        (ok, ret) = _draw(10e6);
        _checkCall(r, "desk draw of 10 USDC", ok, ret, true, "");
        vm.revertToState(baseSnap);
    }

    /// @dev C. The AAPLc reserve paused: the desk refuses (VENUE_PAUSED, HOLD_VENUE); the USDC repay still passes
    ///      (Aave checks the repaid reserve's own flags); withdrawals of AAPLc stop.
    function _scenarioCollateralPaused() internal {
        string memory s = "aaplc-reserve-paused";
        _switch(SW_AAPL_PAUSED, true);
        _checkB(s, "spoke: AAPLc reserve paused", SPOKE.getReserveConfig(AAPL_RESERVE).paused, true);
        _deskView(s, "VENUE_PAUSED", "HOLD_VENUE");
        _checkS(s, "vault venueReason for the AAPLc reserve", _reason(vault.venueReason(AAPL_RESERVE)), "VENUE_PAUSED");
        _checkS(s, "vault venueReason for the USDC reserve", _reason(vault.venueReason(USDC_RESERVE)), "NONE");
        (bool ok, bytes memory ret) = _draw(10e6);
        _checkCall(s, "desk draw of 10 USDC", ok, ret, false, "Refused(20)");
        uint256 snap = vm.snapshotState();
        (ok, ret) = _protect(20e6);
        _checkCall(s, "protective repay of 20 USDC through the Giver", ok, ret, true, "");
        vm.revertToState(snap);
        (ok, ret) = _venueWithdraw(1e6);
        _checkCall(s, "withdrawal of 0.01 AAPLc at the venue", ok, ret, false, "ReservePaused()");

        _switch(SW_AAPL_PAUSED, false);
        _deskView(string.concat(s, " -> unpaused"), "NONE", "OPEN");
        vm.revertToState(baseSnap);
    }

    /// @dev D. The USDC reserve paused: nobody can repay any more, the protective repay included, so protection
    ///      has to land before such a switch; the desk refuses draws and records the hold.
    function _scenarioDebtPaused() internal {
        string memory s = "usdc-reserve-paused";
        _switch(SW_USDC_PAUSED, true);
        _checkB(s, "spoke: USDC reserve paused", SPOKE.getReserveConfig(USDC_RESERVE).paused, true);
        _deskView(s, "VENUE_PAUSED", "HOLD_VENUE");
        _checkS(s, "vault venueReason for the USDC reserve", _reason(vault.venueReason(USDC_RESERVE)), "VENUE_PAUSED");
        (bool ok, bytes memory ret) = _draw(10e6);
        _checkCall(s, "desk draw of 10 USDC", ok, ret, false, "Refused(20)");
        (ok, ret) = _protect(20e6);
        _checkCall(s, "protective repay of 20 USDC through the Giver", ok, ret, false, "Refused(20)");
        (ok, ret) = _venueRepay(1e6);
        _checkCall(s, "repay of 1 USDC by the borrower at the venue", ok, ret, false, "ReservePaused()");

        _switch(SW_USDC_PAUSED, false);
        string memory r = string.concat(s, " -> unpaused");
        _deskView(r, "NONE", "OPEN");
        (ok, ret) = _protect(20e6);
        _checkCall(r, "protective repay of 20 USDC through the Giver", ok, ret, true, "");
        vm.revertToState(baseSnap);
    }
}
