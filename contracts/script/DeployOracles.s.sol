// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {ICLPool} from "../src/interfaces/ICLPool.sol";
import {IMarketCalendar} from "../src/interfaces/IMarketCalendar.sol";
import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {MarketCalendar} from "../src/calendar/MarketCalendar.sol";
import {Nyse2026} from "../src/calendar/Nyse2026.sol";
import {SessionGate} from "../src/oracle/SessionGate.sol";
import {SessionGuard} from "../src/oracle/SessionGuard.sol";
import {ShadowGuard} from "../src/oracle/ShadowGuard.sol";
import {MirrorOracleRegistry} from "../src/test/MirrorOracleRegistry.sol";
import {TestPriceFeed} from "../src/test/TestPriceFeed.sol";
import {MockB20} from "../src/test/MockB20.sol";

/// @dev Etched at a real Chainlink proxy address during a keyless local simulation of the
///      mainnet path, because `SessionGate.setFeed` reads `decimals()` and the proxy has no code
///      off-chain. No immutables, so `runtimeCode` is available.
contract DryRunFeedStub is IAggregatorV3 {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "DRY RUN feed stub";
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 100e8, block.timestamp, block.timestamp, 1);
    }
}

/// @dev Etched at a real Aerodrome pool address during a keyless local simulation, because the
///      ShadowGuard constructor reads `token0()` and `token1()`. Slots 0 and 1 are written with
///      `vm.store`.
contract DryRunPoolStub {
    address public token0;
    address public token1;

    function tickSpacing() external pure returns (int24) {
        return 10;
    }
}

/// @notice Deploys the oracle stack: MarketCalendar, SessionGate, one SessionGuard per token and
///         a ShadowGuard where a 24/7 pool exists.
///
///   Sepolia (simulators):  forge script script/DeployOracles.s.sol --sig "runSepolia()"
///   Mainnet (real feeds):  forge script script/DeployOracles.s.sol --sig "runMainnet()"
///
/// Both dry-run locally with no RPC and no key. The mainnet path needs DRY_RUN_ETCH=true for a
/// keyless local run (it etches stubs where the real feeds and pools would be); it refuses to
/// etch anything when broadcasting. See script/README.md for every env var.
contract DeployOracles is Script {
    address public constant USDC_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address public constant USDC_MAINNET = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant ORACLE_REGISTRY_MAINNET = 0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD;
    address public constant AERODROME_AAPLC_USDC = 0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0;
    address public constant AERODROME_NVDAC_USDC = 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9;
    uint32 public constant TWAP_WINDOW = 3600;
    int256 internal constant DEFAULT_ANSWER = 100e8;
    uint256 internal constant DEFAULT_MINT = 1000e8;

    struct Deployed {
        string symbol;
        address token;
        address feed;
        address guard;
        address shadow;
        address pool;
    }

    struct MainnetToken {
        string symbol;
        address token;
        address feed;
        address pool;
    }

    error DryRunEtchDuringBroadcast();
    error FeedHasNoCode(string symbol, address feed);
    error PoolHasNoCode(string symbol, address pool);

    // ================================================================= Sepolia

    function runSepolia()
        external
        returns (MarketCalendar calendar, MirrorOracleRegistry registry, SessionGate gate, Deployed[] memory out)
    {
        string[] memory defaults = new string[](3);
        defaults[0] = "AAPLt";
        defaults[1] = "NVDAt";
        defaults[2] = "TSLAt";
        string[] memory symbols = vm.envOr("TEST_STOCK_SYMBOLS", ",", defaults);
        uint256 mintAmount = vm.envOr("TEST_STOCK_MINT", DEFAULT_MINT);
        address finalOwner = vm.envOr("ORACLE_OWNER", address(0));
        bool lock = vm.envOr("LOCK_FEEDS", false);

        vm.startBroadcast();
        address deployer = msg.sender;
        calendar = _calendar(deployer);
        address registryEnv = vm.envOr("REGISTRY", address(0));
        registry = registryEnv == address(0) ? new MirrorOracleRegistry(deployer) : MirrorOracleRegistry(registryEnv);
        gate = new SessionGate(deployer, calendar, IOracleRegistry(address(registry)));

        out = new Deployed[](symbols.length);
        for (uint256 i = 0; i < symbols.length; ++i) {
            out[i] = _deploySepoliaToken(deployer, gate, symbols[i], mintAmount);
        }
        if (lock) {
            for (uint256 i = 0; i < out.length; ++i) {
                gate.lockFeed(out[i].token);
            }
        }
        if (finalOwner != address(0) && finalOwner != deployer) {
            _handOver(calendar, gate, out, finalOwner);
            if (registryEnv == address(0)) registry.transferOwnership(finalOwner);
            for (uint256 i = 0; i < out.length; ++i) {
                if (vm.envOr(string.concat(symbols[i], "_FEED"), address(0)) == address(0)) {
                    TestPriceFeed(out[i].feed).transferOwnership(finalOwner);
                }
            }
        }
        vm.stopBroadcast();

        _print("sepolia", address(calendar), address(registry), address(gate), USDC_SEPOLIA, finalOwner, out);
    }

    function _deploySepoliaToken(address deployer, SessionGate gate, string memory symbol, uint256 mintAmount)
        internal
        returns (Deployed memory d)
    {
        d.symbol = symbol;
        d.token = vm.envOr(string.concat(symbol, "_TOKEN"), address(0));
        if (d.token == address(0)) {
            MockB20 token = new MockB20(string.concat("Boundline test ", symbol), symbol, 8);
            token.mint(deployer, mintAmount);
            d.token = address(token);
        }
        d.feed = vm.envOr(string.concat(symbol, "_FEED"), address(0));
        if (d.feed == address(0)) {
            int256 answer = vm.envOr(string.concat(symbol, "_PRICE_E8"), DEFAULT_ANSWER);
            d.feed = address(new TestPriceFeed(deployer, 8, string.concat("Boundline test feed ", symbol), answer));
        }
        gate.setFeed(d.token, IAggregatorV3(d.feed), 0, 0);
        d.guard = address(new SessionGuard(gate, d.token, 8, USDC_SEPOLIA, 6, 0));
        d.pool = vm.envOr(string.concat(symbol, "_POOL"), address(0));
        if (d.pool != address(0)) {
            d.shadow =
                address(new ShadowGuard(deployer, gate, d.token, 8, USDC_SEPOLIA, 6, ICLPool(d.pool), TWAP_WINDOW));
        }
    }

    // ================================================================= Mainnet

    function runMainnet() external returns (MarketCalendar calendar, SessionGate gate, Deployed[] memory out) {
        MainnetToken[] memory tokens = mainnetTokens();
        string[] memory guardDefaults = new string[](2);
        guardDefaults[0] = "AAPLc";
        guardDefaults[1] = "NVDAc";
        string[] memory guardSymbols = vm.envOr("GUARD_SYMBOLS", ",", guardDefaults);
        address finalOwner = vm.envOr("ORACLE_OWNER", address(0));
        bool lock = vm.envOr("LOCK_FEEDS", false);

        _etchStubsIfDryRun(tokens);

        vm.startBroadcast();
        address deployer = msg.sender;
        calendar = _calendar(deployer);
        gate = new SessionGate(deployer, calendar, IOracleRegistry(ORACLE_REGISTRY_MAINNET));

        out = new Deployed[](tokens.length);
        for (uint256 i = 0; i < tokens.length; ++i) {
            MainnetToken memory t = tokens[i];
            if (t.feed.code.length == 0) revert FeedHasNoCode(t.symbol, t.feed);
            gate.setFeed(t.token, IAggregatorV3(t.feed), 0, 0);
            out[i] = Deployed({
                symbol: t.symbol, token: t.token, feed: t.feed, guard: address(0), shadow: address(0), pool: t.pool
            });
            if (_listed(guardSymbols, t.symbol) || t.pool != address(0)) {
                out[i].guard = address(new SessionGuard(gate, t.token, 8, USDC_MAINNET, 6, 0));
            }
            if (t.pool != address(0)) {
                if (t.pool.code.length == 0) revert PoolHasNoCode(t.symbol, t.pool);
                out[i].shadow =
                    address(new ShadowGuard(deployer, gate, t.token, 8, USDC_MAINNET, 6, ICLPool(t.pool), TWAP_WINDOW));
            }
        }
        if (lock) {
            for (uint256 i = 0; i < out.length; ++i) {
                gate.lockFeed(out[i].token);
            }
        }
        if (finalOwner != address(0) && finalOwner != deployer) _handOver(calendar, gate, out, finalOwner);
        vm.stopBroadcast();

        _print("mainnet", address(calendar), ORACLE_REGISTRY_MAINNET, address(gate), USDC_MAINNET, finalOwner, out);
    }

    /// @notice The ten priced Coinbase tokenized stocks on Base mainnet with their Chainlink
    ///         proxies (plan Appendix A, verified 26 Sep 2026) and the 24/7 Aerodrome pools.
    function mainnetTokens() public pure returns (MainnetToken[] memory t) {
        t = new MainnetToken[](10);
        t[0] = MainnetToken(
            "AAPLc",
            0xb200000000000000000000C2e324d24d7eEcd1fb,
            0x787f13dEa48Db0897CbCDD985de77809D837F988,
            AERODROME_AAPLC_USDC
        );
        t[1] = MainnetToken(
            "AMZNc", 0xb200000000000000000000d9192b6B456483C2E8, 0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295, address(0)
        );
        t[2] = MainnetToken(
            "GOOGLc", 0xb2000000000000000000002D0BA3164cc74f58B7, 0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2, address(0)
        );
        t[3] = MainnetToken(
            "METAc", 0xb2000000000000000000008bC8786B856E61707C, 0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D, address(0)
        );
        t[4] = MainnetToken(
            "MSFTc", 0xB200000000000000000000Ab99cFa739E253872B, 0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c, address(0)
        );
        t[5] = MainnetToken(
            "MSTRc", 0xb2000000000000000000004884b426556b92883d, 0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a, address(0)
        );
        t[6] = MainnetToken(
            "NVDAc",
            0xb20000000000000000000078ee7ce2fE4908108C,
            0x04689a41629776563E6822F76f2e57D148d28513,
            AERODROME_NVDAC_USDC
        );
        t[7] = MainnetToken(
            "SNDKc", 0xb200000000000000000000397293Cb8cda9a10c5, 0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA, address(0)
        );
        t[8] = MainnetToken(
            "SPCXc", 0xb2000000000000000000007b9fcbd005511aCBd5, 0x6A634B235903C4ad6376892180d6fF8612e3Fa68, address(0)
        );
        t[9] = MainnetToken(
            "TSLAc", 0xb2000000000000000000001e800a7f5189430cD0, 0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4, address(0)
        );
    }

    /// @dev Keyless local simulation only: etch stubs where the chain would have the real feeds
    ///      and pools. Refuses to run in a broadcast so a stub can never shadow a real contract.
    function _etchStubsIfDryRun(MainnetToken[] memory tokens) internal {
        if (!vm.envOr("DRY_RUN_ETCH", false)) return;
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            revert DryRunEtchDuringBroadcast();
        }
        console.log("DRY_RUN_ETCH: etching feed and pool stubs for a keyless local simulation");
        for (uint256 i = 0; i < tokens.length; ++i) {
            if (tokens[i].feed.code.length == 0) vm.etch(tokens[i].feed, type(DryRunFeedStub).runtimeCode);
            address pool = tokens[i].pool;
            if (pool != address(0) && pool.code.length == 0) {
                vm.etch(pool, type(DryRunPoolStub).runtimeCode);
                vm.store(pool, bytes32(uint256(0)), bytes32(uint256(uint160(USDC_MAINNET))));
                vm.store(pool, bytes32(uint256(1)), bytes32(uint256(uint160(tokens[i].token))));
            }
        }
    }

    // ================================================================= shared

    function _calendar(address deployer) internal returns (MarketCalendar calendar) {
        address existing = vm.envOr("CALENDAR", address(0));
        if (existing != address(0)) return MarketCalendar(existing);
        calendar = new MarketCalendar(deployer);
        calendar.loadYear(2026, Nyse2026.holidays(), Nyse2026.earlyCloses(), Nyse2026.SOURCE);
    }

    /// @dev Two-step everywhere it is two-step: the new owner must call acceptOwnership on the
    ///      calendar (when deployed here), the gate and every ShadowGuard.
    function _handOver(MarketCalendar calendar, SessionGate gate, Deployed[] memory out, address finalOwner) internal {
        if (vm.envOr("CALENDAR", address(0)) == address(0)) calendar.transferOwnership(finalOwner);
        gate.transferOwnership(finalOwner);
        for (uint256 i = 0; i < out.length; ++i) {
            if (out[i].shadow != address(0)) ShadowGuard(out[i].shadow).transferOwnership(finalOwner);
        }
        console.log(
            "ownership offered to %s; it must call acceptOwnership() on the calendar, gate and shadow guards",
            finalOwner
        );
    }

    function _listed(string[] memory list, string memory symbol) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(symbol));
        for (uint256 i = 0; i < list.length; ++i) {
            if (keccak256(bytes(list[i])) == h) return true;
        }
        return false;
    }

    function _print(
        string memory network,
        address calendar,
        address registry,
        address gate,
        address usdc,
        address finalOwner,
        Deployed[] memory out
    ) internal view {
        console.log("{");
        console.log('  "network": "%s", "chainId": %s,', network, block.chainid);
        console.log('  "calendar": "%s",', calendar);
        console.log('  "registry": "%s",', registry);
        console.log('  "sessionGate": "%s",', gate);
        console.log('  "usdc": "%s",', usdc);
        console.log('  "pendingOwner": "%s",', finalOwner);
        console.log('  "tokens": {');
        for (uint256 i = 0; i < out.length; ++i) {
            console.log('    "%s": {', out[i].symbol);
            console.log('      "token": "%s", "feed": "%s",', out[i].token, out[i].feed);
            console.log(
                '      "sessionGuard": "%s", "shadowGuard": "%s", "pool": "%s"',
                out[i].guard,
                out[i].shadow,
                out[i].pool
            );
            console.log(i + 1 < out.length ? "    }," : "    }");
        }
        console.log("  }");
        console.log("}");
    }
}
