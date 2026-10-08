// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IB20Asset} from "base-std/interfaces/IB20Asset.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {IOracleRegistry} from "../../src/interfaces/IOracleRegistry.sol";
import {IPriceGate} from "../../src/interfaces/IPriceGate.sol";
import {MarketCalendar} from "../../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../../src/calendar/Nyse2026.sol";
import {SessionGate} from "../../src/oracle/SessionGate.sol";
import {CreditDesk} from "../../src/desk/CreditDesk.sol";
import {ICLSwapPool} from "../../src/protection/interfaces/ICLSwapPool.sol";
import {DividendHarvester} from "../../src/harvest/DividendHarvester.sol";

/// @notice The self-repaying leg against a real dividend on a Base mainnet fork (BASE_RPC_URL, an archive node):
///         NVDAc's "Cash Dividend" (Coinbase corporate action 0d25ab63-6a9b-4f46-93fd-9d7f6fae92da, tx
///         0x7aef5d1292d0f78b1cdc05518301553fc7220e5a0022d98b822dc09ac925ddcd, block 52,041,960, Thu 1 Oct 2026
///         16:47:47 UTC) raised the multiplier from 1.0 to 1.000537939576369481. A real borrower of the Steakhouse
///         NVDAc/USDC market enrols one block earlier; one block later the harvester repays their loan with exactly
///         the dividend-equivalent NVDAc, sold on the real Aerodrome pool, priced through the real feed and
///         OracleRegistry. B20 transfers and the registry need the precompiles, so this runs under `base-forge`.
contract HarvestForkTest is Test {
    using MorphoBalancesLib for IMorpho;

    IMorpho constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    IAggregatorV3 constant FEED = IAggregatorV3(0x04689a41629776563E6822F76f2e57D148d28513);
    IOracleRegistry constant REGISTRY = IOracleRegistry(0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD);
    ICLSwapPool constant POOL = ICLSwapPool(0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9);
    /// @dev Steakhouse NVDAc/USDC, LLTV 62.5%, MorphoChainlinkOracleV2.
    Id constant MARKET = Id.wrap(0xb4b42dd66cef25614b94510a910d54b2c148e7621d22b4271566724beda63d13);
    /// @dev A real borrower of that market: 4.88797212 NVDAc against about 423 USDC on 1 Oct 2026.
    address constant BORROWER = 0xcBFBeC7B487E11dee369B52EEf69D8357c01f2E6;
    uint256 constant BLOCK_BEFORE = 52_041_959;
    uint256 constant BLOCK_DIVIDEND = 52_041_960;
    uint256 constant M1 = 1_000_537_939_576_369_481;

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");

    MarketCalendar cal;
    SessionGate gate;
    DividendHarvester harvester;
    MarketParams mp;

    function setUp() public {
        string memory url = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url, BLOCK_BEFORE);
        (bool ok, bytes memory data) = NVDAC.staticcall(abi.encodeCall(IERC20.balanceOf, (BORROWER)));
        if (!ok || data.length < 32) {
            vm.skip(true); // stock forge: the B20 precompiles are not there
            return;
        }
        mp = MORPHO.idToMarketParams(MARKET);
        assertEq(mp.collateralToken, NVDAC, "Steakhouse NVDAc market");
        assertEq(mp.loanToken, USDC);

        cal = new MarketCalendar(owner);
        vm.prank(owner);
        cal.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
        gate = new SessionGate(owner, cal, REGISTRY);
        vm.prank(owner);
        gate.setFeed(NVDAC, FEED, 0, 0);
        harvester = new DividendHarvester(owner, MORPHO, gate, CreditDesk(address(0)), keeper);
        vm.prank(owner);
        harvester.setRoute(NVDAC, POOL);
        // Our three contracts survive the roll to the dividend block; Morpho, the token and the pool are re-read there.
        vm.makePersistent(address(cal), address(gate), address(harvester));

        vm.startPrank(BORROWER);
        MORPHO.setAuthorization(address(harvester), true);
        harvester.enroll(MARKET, 0, DividendHarvester.Mode.HARVEST);
        vm.stopPrank();
    }

    function test_fork_beforeTheDividend_theMultiplierIsOne() public view {
        assertEq(IB20Asset(NVDAC).multiplier(), 1e18);
        (uint256 m, bool paused) = REGISTRY.getOracleParams(NVDAC);
        assertEq(m, 1e18);
        assertFalse(paused);
        assertEq(harvester.enrollment(BORROWER, MARKET).baseMultiplier, 1e18, "enrolled at the pre-dividend multiplier");
        DividendHarvester.Preview memory p = harvester.preview(BORROWER, MARKET);
        assertEq(uint8(p.standing), uint8(DividendHarvester.Standing.NO_CHANGE));
    }

    function test_fork_realCashDividend_repaysTheLoanAndKeepsTheShareCount() public {
        vm.rollFork(BLOCK_DIVIDEND);
        assertEq(IB20Asset(NVDAC).multiplier(), M1, "the token's multiplier after the announce");
        (uint256 m, bool paused) = REGISTRY.getOracleParams(NVDAC);
        assertEq(m, M1, "the registry, which the feed composes with, reads the same value");
        assertFalse(paused);
        IPriceGate.Verdict memory v = gate.check(NVDAC);
        assertEq(uint256(v.state), uint256(IPriceGate.GateState.OPEN), "Thu 1 Oct 12:47 ET: an open session");

        // The roll re-reads Morpho at the new block, so the borrower's authorisation is given again there.
        vm.prank(BORROWER);
        MORPHO.setAuthorization(address(harvester), true);

        DividendHarvester.Preview memory p = harvester.preview(BORROWER, MARKET);
        assertEq(uint8(p.standing), uint8(DividendHarvester.Standing.READY));
        Position memory before = MORPHO.position(MARKET, BORROWER);
        uint256 debtBefore = MORPHO.expectedBorrowAssets(mp, BORROWER);
        assertEq(p.dividendRaw, uint256(before.collateral) * (M1 - 1e18) / M1, "raw x (m1 - m0) / m1");

        vm.prank(keeper);
        (uint256 repaid, uint256 sold) = harvester.harvest(BORROWER, MARKET, block.timestamp + 60);

        Position memory afterPos = MORPHO.position(MARKET, BORROWER);
        uint256 debtAfter = MORPHO.expectedBorrowAssets(mp, BORROWER);
        assertEq(repaid, p.repayAssets);
        assertEq(debtAfter, debtBefore - repaid, "the dividend repaid the loan");
        assertLe(sold, p.dividendRaw, "never more than the dividend collateral");
        assertEq(afterPos.collateral, before.collateral - sold);
        assertGe(uint256(afterPos.collateral) * M1, uint256(before.collateral) * 1e18, "the share count is kept");
        assertLe(debtAfter * before.collateral, debtBefore * afterPos.collateral, "LTV fell");
        assertEq(IERC20(USDC).balanceOf(address(harvester)), 0);
        assertEq(IERC20(NVDAC).balanceOf(address(harvester)), 0);
        assertEq(harvester.enrollment(BORROWER, MARKET).baseMultiplier, M1);

        console2.log("block", block.number, "timestamp", block.timestamp);
        console2.log("collateral before (raw NVDAc)", before.collateral);
        console2.log("debt before (USDC raw)", debtBefore);
        console2.log("gate price8", p.price8);
        console2.log("dividend-equivalent collateral (raw)", p.dividendRaw);
        console2.log("dividend value (USDC raw)", p.dividendValue);
        console2.log("repaid (USDC raw)", repaid);
        console2.log("sold (raw NVDAc)", sold);
        console2.log("returned to the position (raw NVDAc)", p.dividendRaw - sold);
        console2.log("debt after (USDC raw)", debtAfter);
    }
}
