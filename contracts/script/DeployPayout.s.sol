// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceGate} from "../src/interfaces/IPriceGate.sol";
import {TickMath} from "../src/libraries/TickMath.sol";
import {MockStable} from "../src/test/MockStable.sol";
import {MockSwapPool} from "../src/test/MockSwapPool.sol";
import {LocalPayoutRouter} from "../src/payout/LocalPayoutRouter.sol";

/// @notice Puts the local-money payout leg on Base Sepolia: a test local stablecoin (EURCt, 6 decimals), a
///         fixed-rate Slipstream-shaped pool USDC → EURCt (token0 EURCt, token1 USDC, as the mainnet EURC/USDC
///         pool is laid out) seeded with minted EURCt, and the LocalPayoutRouter bound to the SessionGate. On
///         mainnet only the router is deployed; the pool is Aerodrome's.
///
///   GATE=<SessionGate> forge script script/DeployPayout.s.sol --tc DeployPayout --rpc-url base_sepolia \
///     --broadcast --verify --private-key "$KEY"
///
/// | Env | Default |
/// | --- | --- |
/// | `GATE` | required |
/// | `USDC` | USDC on 8453 and 84532, required elsewhere |
/// | `EURC_PER_USDC_36` | `0.92e36` (EURCt raw per USDC raw, times 1e36: the mock pool's `price36`) |
/// | `SEED_EURC` | `100_000e6` EURCt minted to the pool |
/// | `MOCK_POOL` | `true` on 84532, `false` elsewhere (mainnet deploys the router only) |
contract DeployPayout is Script {
    address public constant USDC_MAINNET = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant USDC_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    int24 public constant TICK_SPACING = 50;

    struct Deployed {
        MockStable eurc;
        MockSwapPool pool;
        LocalPayoutRouter router;
    }

    error MissingEnv(string name, string hint);
    error NoGate(address gate);

    function run() external returns (Deployed memory d) {
        address gate = vm.envOr("GATE", address(0));
        if (gate == address(0)) revert MissingEnv("GATE", "the SessionGate the router asks for the session verdict");
        if (gate.code.length == 0) revert NoGate(gate);
        address usdc = _usdc();
        uint256 price36 = vm.envOr("EURC_PER_USDC_36", uint256(0.92e36));
        uint256 seed = vm.envOr("SEED_EURC", uint256(100_000e6));
        bool mockPool = vm.envOr("MOCK_POOL", block.chainid == 84_532);

        vm.startBroadcast();
        address deployer = msg.sender;
        if (mockPool) {
            d.eurc = new MockStable("Boundline test EURC", "EURCt", 6, deployer);
            d.pool = new MockSwapPool(address(d.eurc), usdc, TICK_SPACING, deployer);
            int24 tick = tickForPrice36(price36);
            d.pool.setSlot0(TickMath.getSqrtRatioAtTick(tick), tick);
            d.pool.setLiquidity(1e18);
            d.pool.setObservationCardinality(100);
            d.pool.setAverageTick(3600, tick);
            d.pool.setPrice36(price36);
            d.eurc.mint(address(d.pool), seed);
        }
        d.router = new LocalPayoutRouter(IPriceGate(gate));
        vm.stopBroadcast();

        console.log("{");
        console.log('  "chainId": %s,', block.chainid);
        console.log('  "gate": "%s", "usdc": "%s",', gate, usdc);
        console.log('  "router": "%s",', address(d.router));
        if (mockPool) {
            console.log('  "eurct": "%s",', address(d.eurc));
            console.log('  "pool": "%s", "price36": %s, "seedEurc": %s', address(d.pool), price36, seed);
        }
        console.log("}");
    }

    /// @notice The tick whose price is `price36` (token0 raw per token1 raw, times 1e36): the same formula
    ///         DeployProtection uses, ratioX192 = 2^192 * 1e36 / price36.
    function tickForPrice36(uint256 price36) public pure returns (int24) {
        uint256 ratioX192 = Math.mulDiv(1 << 192, 1e36, price36);
        uint256 sqrtPriceX96 = Math.sqrt(ratioX192);
        int24 lo = TickMath.MIN_TICK;
        int24 hi = TickMath.MAX_TICK;
        while (hi - lo > 1) {
            int24 mid = int24((int256(lo) + int256(hi)) / 2);
            if (TickMath.getSqrtRatioAtTick(mid) <= sqrtPriceX96) lo = mid;
            else hi = mid;
        }
        return lo;
    }

    function _usdc() internal view returns (address) {
        if (block.chainid == 8453) return USDC_MAINNET;
        if (block.chainid == 84_532) return USDC_SEPOLIA;
        address u = vm.envOr("USDC", address(0));
        if (u == address(0)) revert MissingEnv("USDC", "USDC is known only on 8453 and 84532");
        return u;
    }
}
