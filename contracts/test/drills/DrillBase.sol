// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";

interface IAggregatorProxy {
    function aggregator() external view returns (address);
}

/// @notice Shared plumbing for the fork drills (venue-halt, bad-debt-probe): the Base mainnet fork, the AAPLc feed
///         rewrite (the replay's technique: the OCR2 aggregator keeps the latest round in `s_transmissions[roundId]`,
///         one packed slot `int192 answer | uint32 observationsTimestamp | uint32 transmissionTimestamp`, found by
///         recording the storage reads of `latestRoundData()` and cross-checked against the layout slot
///         `keccak256(abi.encode(roundId, 12))`), and one-line JSON records that `scripts/drills/run-fork-drills.ts`
///         turns into `docs/evidence/drills/<drill>.json`.
///
///         Every record is a console line `DRILL {"drill":…,"kind":…,…}`; kinds are `meta`, `check` (an assertion
///         with its observed and expected values, asserted right after it is logged), `attempt` (an action and what
///         the venue answered, decoded to the error name), `value` (a number worth keeping) and `ledger` (a flow
///         record the runner reconciles with the ledger package's `reconcile`).
abstract contract DrillBase is Test {
    IAggregatorV3 internal constant AAPL_FEED = IAggregatorV3(0x787f13dEa48Db0897CbCDD985de77809D837F988);
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant AAPLC = 0xb200000000000000000000C2e324d24d7eEcd1fb;
    address internal constant ORACLE_REGISTRY = 0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD;
    /// @dev Aerodrome Slipstream AAPLc/USDC: a holder of free AAPLc on the fork (a B20 transfer, base-forge only).
    address internal constant AERODROME_AAPLC_POOL = 0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0;
    uint256 internal constant MAPPING_SLOT_TRANSMISSIONS = 12;

    // The weekend the drills are staged on (ET): the held round, the Saturday, the Sunday reopen.
    uint256 internal constant T_FRI_SESSION = 1_791_556_200; // Fri 2026-10-09 10:30 ET (REGULAR)
    uint256 internal constant T_FRI_CLOSE = 1_791_590_400; // Fri 2026-10-09 20:00 ET
    uint256 internal constant T_SAT = 1_791_640_800; // Sat 2026-10-10 10:00 ET
    uint256 internal constant T_REOPEN = 1_791_763_200; // Sun 2026-10-11 20:00 ET

    string internal drillId;
    uint256 internal forkBlock;
    uint256 internal forkTime;
    address internal aggregator;
    bytes32 internal feedSlot;
    bytes32 internal feedSlotByLayout;
    int256 internal heldAnswer;
    uint80 internal heldRound;
    bool internal b20Live;

    /// @dev Selects the fork at `evidenceBlock` (the block the drill's evidence file records; DRILL_FORK_BLOCK overrides it,
    ///      0 = latest; a block after the staged 9-11 Oct weekend would warp back past its feeds) and checks the B20
    ///      precompiles answer. Returns false and marks the test skipped when there is no RPC or the build cannot run
    ///      Base precompiles.
    function _fork(string memory id, uint256 evidenceBlock) internal returns (bool) {
        drillId = id;
        string memory url = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return false;
        }
        uint256 pinned = vm.envOr("DRILL_FORK_BLOCK", evidenceBlock);
        if (pinned == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, pinned);
        forkBlock = block.number;
        forkTime = block.timestamp;
        (bool ok, bytes memory data) = AAPLC.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        b20Live = ok && data.length >= 32;
        if (!b20Live) {
            console.log("B20 precompiles unavailable in this build: the drill runs under base-forge only");
            vm.skip(true);
            return false;
        }
        return true;
    }

    // ---------------------------------------------------------------- the AAPLc feed

    function _discoverFeedSlot() internal {
        aggregator = IAggregatorProxy(address(AAPL_FEED)).aggregator();
        (uint80 roundId, int256 answer,,,) = AAPL_FEED.latestRoundData();
        heldAnswer = answer;
        heldRound = roundId;
        // The aggregator answers only its proxy, so its own round id comes from the proxy's: phaseId << 64 | round.
        uint256 aggRound = uint256(uint64(roundId));
        vm.record();
        AAPL_FEED.latestRoundData();
        (bytes32[] memory reads,) = vm.accesses(aggregator);
        for (uint256 i = 0; i < reads.length; i++) {
            uint256 v = uint256(vm.load(aggregator, reads[i]));
            if ((v & ((uint256(1) << 192) - 1)) == uint256(answer)) {
                feedSlot = reads[i];
                break;
            }
        }
        require(feedSlot != bytes32(0), "transmission slot not found among the recorded reads");
        feedSlotByLayout = keccak256(abi.encode(aggRound, MAPPING_SLOT_TRANSMISSIONS));
        require(feedSlot == feedSlotByLayout, "recorded slot disagrees with the OCR2 layout");
    }

    /// @dev Rewrites the latest round in place: what every reader of the proxy sees (Morpho's Chainlink oracle,
    ///      Aave's oracle, the SessionGate) from the next call on.
    function _writeFeed(int256 answer, uint256 observedAt, uint256 transmittedAt) internal {
        require(answer > 0 && uint256(answer) < (uint256(1) << 191), "answer range");
        uint256 packed = (transmittedAt << 224) | (observedAt << 192) | uint256(answer);
        vm.store(aggregator, feedSlot, bytes32(packed));
        (, int256 a,, uint256 u,) = AAPL_FEED.latestRoundData();
        require(a == answer && u == transmittedAt, "feed rewrite not visible through the proxy");
    }

    // ---------------------------------------------------------------- records

    function _rec(string memory kind, string memory body) internal view {
        console.log(string.concat("DRILL {\"drill\":", _q(drillId), ",\"kind\":", _q(kind), ",", body, "}"));
    }

    function _checkU(string memory scenario, string memory what, uint256 actual, uint256 expected) internal {
        _rec(
            "check",
            string.concat(
                _kvS("scenario", scenario),
                ",",
                _kvS("what", what),
                ",",
                _kvS("actual", vm.toString(actual)),
                ",",
                _kvS("expected", vm.toString(expected)),
                ",",
                _kvB("pass", actual == expected)
            )
        );
        assertEq(actual, expected, string.concat(scenario, ": ", what));
    }

    function _checkApprox(string memory scenario, string memory what, uint256 actual, uint256 expected, uint256 tol)
        internal
    {
        bool pass = actual > expected ? actual - expected <= tol : expected - actual <= tol;
        _rec(
            "check",
            string.concat(
                _kvS("scenario", scenario),
                ",",
                _kvS("what", what),
                ",",
                _kvS("actual", vm.toString(actual)),
                ",",
                _kvS("expected", string.concat(vm.toString(expected), " +/- ", vm.toString(tol))),
                ",",
                _kvB("pass", pass)
            )
        );
        assertApproxEqAbs(actual, expected, tol, string.concat(scenario, ": ", what));
    }

    function _checkB(string memory scenario, string memory what, bool actual, bool expected) internal {
        _rec(
            "check",
            string.concat(
                _kvS("scenario", scenario),
                ",",
                _kvS("what", what),
                ",",
                _kvB("actual", actual),
                ",",
                _kvB("expected", expected),
                ",",
                _kvB("pass", actual == expected)
            )
        );
        assertEq(actual, expected, string.concat(scenario, ": ", what));
    }

    /// @dev Logs a named check of a call's outcome: `wantOk` true means it must succeed, else it must revert with
    ///      `want` (the decoded error name, e.g. "SpokeHalted()" or "Error(position is healthy)").
    function _checkCall(
        string memory scenario,
        string memory what,
        bool ok,
        bytes memory ret,
        bool wantOk,
        string memory want
    ) internal {
        string memory got = ok ? "ok" : _errName(ret);
        string memory expected = wantOk ? "ok" : want;
        bool pass = keccak256(bytes(got)) == keccak256(bytes(expected));
        _rec(
            "check",
            string.concat(
                _kvS("scenario", scenario),
                ",",
                _kvS("what", what),
                ",",
                _kvS("actual", got),
                ",",
                _kvS("expected", expected),
                ",",
                _kvB("pass", pass)
            )
        );
        assertTrue(pass, string.concat(scenario, ": ", what, " answered ", got, ", expected ", expected));
    }

    function _attempt(string memory scenario, string memory what, bool ok, bytes memory ret) internal view {
        _rec(
            "attempt",
            string.concat(
                _kvS("scenario", scenario), ",", _kvS("what", what), ",", _kvS("result", ok ? "ok" : _errName(ret))
            )
        );
    }

    function _value(string memory scenario, string memory name, uint256 v) internal view {
        _rec(
            "value",
            string.concat(_kvS("scenario", scenario), ",", _kvS("name", name), ",", _kvS("value", vm.toString(v)))
        );
    }

    function _valueS(string memory scenario, string memory name, string memory v) internal view {
        _rec("value", string.concat(_kvS("scenario", scenario), ",", _kvS("name", name), ",", _kvS("value", v)));
    }

    // ---------------------------------------------------------------- revert decoding

    /// @dev The error a call reverted with, by name: Error(string) and Panic(uint256) decoded, the custom errors
    ///      the drills meet named from their selectors, anything else as its selector.
    function _errName(bytes memory ret) internal pure returns (string memory) {
        if (ret.length < 4) return ret.length == 0 ? "revert()" : "revert(short)";
        bytes4 sel = bytes4(ret);
        if (sel == 0x08c379a0) {
            bytes memory tail = new bytes(ret.length - 4);
            for (uint256 i = 0; i < tail.length; i++) {
                tail[i] = ret[i + 4];
            }
            return string.concat("Error(", abi.decode(tail, (string)), ")");
        }
        if (sel == 0x4e487b71) return "Panic";
        if (sel == bytes4(keccak256("SpokeHalted()"))) return "SpokeHalted()";
        if (sel == bytes4(keccak256("SpokeNotActive()"))) return "SpokeNotActive()";
        if (sel == bytes4(keccak256("ReservePaused()"))) return "ReservePaused()";
        if (sel == bytes4(keccak256("ReserveFrozen()"))) return "ReserveFrozen()";
        if (sel == bytes4(keccak256("ReserveNotBorrowable()"))) return "ReserveNotBorrowable()";
        if (sel == bytes4(keccak256("HealthFactorNotBelowThreshold()"))) return "HealthFactorNotBelowThreshold()";
        if (sel == bytes4(keccak256("LiquidatablePosition()"))) return "LiquidatablePosition()";
        if (sel == bytes4(keccak256("NotPreLiquidatablePosition()"))) return "NotPreLiquidatablePosition()";
        if (sel == bytes4(keccak256("Refused(uint8)"))) {
            return string.concat("Refused(", vm.toString(uint256(uint8(ret[ret.length - 1]))), ")");
        }
        if (sel == bytes4(keccak256("MarketClosed(uint8)"))) {
            return string.concat("MarketClosed(", vm.toString(uint256(uint8(ret[ret.length - 1]))), ")");
        }
        if (sel == bytes4(keccak256("ShadowDeviation(uint256,uint256,uint16)"))) return "ShadowDeviation";
        return vm.toString(abi.encodePacked(sel));
    }

    // ---------------------------------------------------------------- json

    function _q(string memory s) internal pure returns (string memory) {
        return string.concat("\"", s, "\"");
    }

    function _kvS(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat(_q(k), ":", _q(v));
    }

    function _kvU(string memory k, uint256 v) internal pure returns (string memory) {
        return string.concat(_q(k), ":", _q(vm.toString(v)));
    }

    function _kvB(string memory k, bool v) internal pure returns (string memory) {
        return string.concat(_q(k), ":", v ? "true" : "false");
    }
}
