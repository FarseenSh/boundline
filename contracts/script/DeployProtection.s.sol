// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {SessionGate} from "../src/oracle/SessionGate.sol";
import {ShadowGuard} from "../src/oracle/ShadowGuard.sol";
import {TickMath} from "../src/libraries/TickMath.sol";
import {MockSwapPool} from "../src/test/MockSwapPool.sol";
import {ICLSwapPool} from "../src/protection/interfaces/ICLSwapPool.sol";
import {Protector} from "../src/protection/Protector.sol";
import {PreLiquidationFactory} from "../src/protection/vendor/PreLiquidationFactory.sol";
import {IPreLiquidation, PreLiquidationParams} from "../src/protection/vendor/interfaces/IPreLiquidation.sol";

/// @notice Puts the Morpho protection stack on Base Sepolia for one session-safe market: a mock Slipstream pool
///         (TWAP source and sale venue, scripted at the feed's current price), ShadowGuard bound to it, a copy of
///         Morpho's PreLiquidationFactory (Sepolia has none), the market's pre-liquidation contract with ShadowGuard
///         as its oracle, and the Protector with the keeper as operator. The pool is funded with USDC from the
///         broadcaster so the Protector's sale has something to buy with.
///
///   GATE=<SessionGate> COLLATERAL=<stock> MARKET_ID=<Morpho id> KEEPER=<keeper> \
///     forge script script/DeployProtection.s.sol --tc DeployProtection --rpc-url base_sepolia \
///     --broadcast --verify --slow --private-key "$KEY"
///
/// Needs an RPC (the market and the feed are read). Stock forge is enough: nothing here calls a B20 precompile.
/// After it: extend the stock's Cobalt allowlists with the Protector, the pre-liquidation contract and the pool
/// (`wire-protection-sepolia.sh`), and let borrowers opt in with `Morpho.setAuthorization(preLiquidation, true)`.
///
/// | Env | Default |
/// | --- | --- |
/// | `GATE`, `COLLATERAL`, `MARKET_ID`, `KEEPER` | required |
/// | `MORPHO` | `0xBBBB…FFCb` |
/// | `LOAN_TOKEN` | USDC on 8453 and 84532, required elsewhere |
/// | `COLLATERAL_DECIMALS`, `LOAN_DECIMALS` | 8, 6 |
/// | `TWAP_WINDOW` | 3600 |
/// | `POOL_TICK` | derived from the gate's feed answer (the tick whose price is the feed's) |
/// | `SWAP_PRICE_36` | the feed's price in Morpho's 36-decimal scale |
/// | `FUND_USDC` | `2_000_000` (2 USDC) moved from the broadcaster to the pool |
/// | `PRE_LLTV`, `PRE_LCF_1`, `PRE_LCF_2`, `PRE_LIF_1`, `PRE_LIF_2` | `0.58e18`, `1e18`, `1e18`, `1.01e18`, `1.02e18` |
contract DeployProtection is Script {
    address public constant MORPHO_DEFAULT = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address public constant USDC_MAINNET = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant USDC_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    int24 public constant TICK_SPACING = 10;

    struct Config {
        address morpho;
        address gate;
        address collateral;
        uint8 collateralDecimals;
        address loan;
        uint8 loanDecimals;
        uint32 twapWindow;
        int24 poolTick;
        uint256 swapPrice36;
        uint256 fundUsdc;
        bytes32 marketId;
        address keeper;
        PreLiquidationParams params;
    }

    struct Deployed {
        MockSwapPool pool;
        ShadowGuard shadow;
        PreLiquidationFactory factory;
        IPreLiquidation preLiquidation;
        Protector protector;
    }

    error NoRpc(string hint);
    error MissingEnv(string name, string hint);
    error MarketMissing(bytes32 id);
    error MarketMismatch(address collateral, address loan);
    error FeedNotOnGate(address collateral);
    error BadAnswer(int256 answer);

    function run() external returns (Deployed memory d) {
        Config memory c = _config();
        vm.startBroadcast();
        d = _deploy(c, msg.sender);
        vm.stopBroadcast();
        _print(c, d);
    }

    // ================================================================= logic

    function _deploy(Config memory c, address deployer) internal returns (Deployed memory d) {
        if (c.morpho.code.length == 0) revert NoRpc("Morpho has no code in this EVM: pass --rpc-url base_sepolia");
        Id id = Id.wrap(c.marketId);
        MarketParams memory mp = IMorpho(c.morpho).idToMarketParams(id);
        if (mp.lltv == 0) revert MarketMissing(c.marketId);
        if (mp.collateralToken != c.collateral || mp.loanToken != c.loan) {
            revert MarketMismatch(mp.collateralToken, mp.loanToken);
        }

        // Pool: token0 = loan, token1 = stock, as the live Aerodrome B20 pools are laid out.
        d.pool = new MockSwapPool(c.loan, c.collateral, TICK_SPACING, deployer);
        d.pool.setSlot0(TickMath.getSqrtRatioAtTick(c.poolTick), c.poolTick);
        d.pool.setLiquidity(1e18);
        d.pool.setObservationCardinality(100);
        d.pool.setAverageTick(c.twapWindow, c.poolTick);
        d.pool.setPrice36(c.swapPrice36);
        if (c.fundUsdc != 0) IERC20(c.loan).transfer(address(d.pool), c.fundUsdc);

        d.shadow = new ShadowGuard(
            deployer,
            SessionGate(c.gate),
            c.collateral,
            c.collateralDecimals,
            c.loan,
            c.loanDecimals,
            ICLSwapPool(address(d.pool)),
            c.twapWindow
        );
        d.factory = new PreLiquidationFactory(c.morpho);
        c.params.preLiquidationOracle = address(d.shadow);
        d.preLiquidation = d.factory.createPreLiquidation(id, c.params);
        d.protector = new Protector(deployer, IMorpho(c.morpho), c.keeper);
        d.protector.setRoute(c.collateral, ICLSwapPool(address(d.pool)));
    }

    /// @notice The tick whose price is `price36` (loan raw units per collateral raw unit, times 1e36) in a pool
    ///         where the collateral is token1: ratioX192 = 2^192 * 1e36 / price36, then the largest tick whose
    ///         sqrt ratio does not exceed sqrt(ratioX192).
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

    function _config() internal view returns (Config memory c) {
        c.morpho = vm.envOr("MORPHO", MORPHO_DEFAULT);
        c.gate = vm.envOr("GATE", address(0));
        if (c.gate == address(0)) revert MissingEnv("GATE", "the SessionGate the market's oracles are bound to");
        c.collateral = vm.envOr("COLLATERAL", address(0));
        if (c.collateral == address(0)) revert MissingEnv("COLLATERAL", "the tokenized stock of the market");
        c.marketId = vm.envOr("MARKET_ID", bytes32(0));
        if (c.marketId == bytes32(0)) revert MissingEnv("MARKET_ID", "the Morpho market id to protect");
        c.keeper = vm.envOr("KEEPER", address(0));
        if (c.keeper == address(0)) revert MissingEnv("KEEPER", "the account that may run protections");
        c.loan = _loanToken();
        c.collateralDecimals = uint8(vm.envOr("COLLATERAL_DECIMALS", uint256(8)));
        c.loanDecimals = uint8(vm.envOr("LOAN_DECIMALS", uint256(6)));
        c.twapWindow = uint32(vm.envOr("TWAP_WINDOW", uint256(3600)));
        c.fundUsdc = vm.envOr("FUND_USDC", uint256(2_000_000));
        c.params = PreLiquidationParams({
            preLltv: vm.envOr("PRE_LLTV", uint256(0.58e18)),
            preLCF1: vm.envOr("PRE_LCF_1", uint256(1e18)),
            preLCF2: vm.envOr("PRE_LCF_2", uint256(1e18)),
            preLIF1: vm.envOr("PRE_LIF_1", uint256(1.01e18)),
            preLIF2: vm.envOr("PRE_LIF_2", uint256(1.02e18)),
            preLiquidationOracle: address(0)
        });

        // The feed's current answer, in Morpho's scale, prices both the TWAP tick and the mock sale.
        SessionGate.FeedConfig memory f = SessionGate(c.gate).feedOf(c.collateral);
        if (address(f.feed) == address(0)) revert FeedNotOnGate(c.collateral);
        (, int256 answer,,,) = IAggregatorV3(address(f.feed)).latestRoundData();
        if (answer <= 0) revert BadAnswer(answer);
        uint256 scale = 10 ** (36 + uint256(c.loanDecimals) - 8 - uint256(c.collateralDecimals));
        uint256 feedPrice36 = uint256(answer) * scale;
        c.swapPrice36 = vm.envOr("SWAP_PRICE_36", feedPrice36);
        c.poolTick = int24(vm.envOr("POOL_TICK", int256(tickForPrice36(feedPrice36))));
    }

    function _loanToken() internal view returns (address) {
        if (block.chainid == 8453) return USDC_MAINNET;
        if (block.chainid == 84_532) return USDC_SEPOLIA;
        address loan = vm.envOr("LOAN_TOKEN", address(0));
        if (loan == address(0)) revert MissingEnv("LOAN_TOKEN", "USDC is known only on 8453 and 84532");
        return loan;
    }

    function _print(Config memory c, Deployed memory d) internal view {
        console.log("{");
        console.log('  "chainId": %s,', block.chainid);
        console.log('  "marketId": "%s",', vm.toString(c.marketId));
        console.log('  "collateral": "%s", "loan": "%s",', c.collateral, c.loan);
        console.log('  "pool": "%s",', address(d.pool));
        console.log(
            '  "poolTick": %s, "swapPrice36": %s, "fundUsdc": %s,', vm.toString(c.poolTick), c.swapPrice36, c.fundUsdc
        );
        console.log('  "shadowGuard": "%s",', address(d.shadow));
        console.log('  "preLiquidationFactory": "%s",', address(d.factory));
        console.log('  "preLiquidation": "%s",', address(d.preLiquidation));
        console.log('  "protector": "%s", "keeper": "%s",', address(d.protector), c.keeper);
        console.log(
            '  "params": { "preLltv": %s, "preLCF1": %s, "preLCF2": %s,',
            c.params.preLltv,
            c.params.preLCF1,
            c.params.preLCF2
        );
        console.log('             "preLIF1": %s, "preLIF2": %s }', c.params.preLIF1, c.params.preLIF2);
        console.log("}");
    }
}
