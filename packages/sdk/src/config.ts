// Every address the SDK and the app need, per chain, in one place. Base Sepolia is live
// (deployments/base-sepolia.json, 3 Oct 2026); Base mainnet carries the footprint of
// contracts/script/DeployMainnet.s.sol (deployments/base-mainnet.json). The app builds for one chain (VITE_CHAIN_ID).
import { getAddress, stringToHex, type Address, type Hex } from "viem";

export interface StockConfig {
  readonly symbol: string;
  readonly name: string;
  readonly token: Address;
  readonly feed: Address;
  readonly sessionGuard: Address | null;
  readonly decimals: 8;
}

export interface MarketConfig {
  readonly id: Hex;
  readonly symbol: string;
  readonly collateral: Address;
  readonly loan: Address;
  readonly oracle: Address;
  readonly lltvWad: bigint;
}

/** A local stablecoin the payout leg can pay in, and the pool the router swaps USDC on. */
export interface PayoutPoolConfig {
  readonly symbol: string;
  readonly name: string;
  readonly token: Address;
  readonly decimals: number;
  /** ISO-style currency the token tracks, for formatting (EUR, NGN). */
  readonly currency: string;
  readonly pool: Address;
  /** LocalPayoutRouter pool kind: "cl" (Slipstream / Uniswap v3 shape) or "v2" (Aerodrome v2 shape). */
  readonly kind: "cl" | "v2";
  /** How the SDK quotes it off-chain: a Slipstream pool's slot0 and fee, the Sepolia mock's fixed price36, a v2 pool's getAmountOut. */
  readonly quoteSource: "slot0" | "price36" | "getAmountOut";
  /** True when the local token is the pool's token0 (USDC its token1), as the mainnet EURC/USDC pool is laid out. */
  readonly tokenIsToken0: boolean;
}

export interface PayoutConfig {
  /** LocalPayoutRouter; null where it is not deployed yet (mainnet). */
  readonly router: Address | null;
  readonly pools: readonly PayoutPoolConfig[];
}

export interface BoundlineChainConfig {
  readonly chainId: 84532 | 8453;
  readonly name: string;
  readonly rpcUrls: readonly string[];
  readonly explorer: string;
  /** CreditDesk; null where nothing is deployed yet (mainnet). */
  readonly desk: Address | null;
  readonly gate: Address | null;
  readonly morpho: Address;
  readonly usdc: Address;
  readonly usdcDecimals: 6;
  /** bytes32("boundline-app"): Boundline is its own first partner. */
  readonly partnerId: Hex;
  readonly stocks: readonly StockConfig[];
  readonly markets: readonly MarketConfig[];
  /** Morpho pre-liquidation contract for protected mode (Lane A deploys it; null until then). */
  readonly preLiquidation: Address | null;
  /** The local-money payout leg (LocalPayoutRouter and the pools it may swap on). */
  readonly payout: PayoutConfig;
  /** The Boundline Reserve (ERC-4626 over USDC) that funds protection advances; null where not deployed. */
  readonly reserve: Address | null;
  /** The Morpho-side protection vault over desk lines (any-hour protective repay down the ladder); null where not deployed. */
  readonly deskProtectionVault: Address | null;
}

/** bytes32 of a short ASCII partner name, right-padded with zeros, exactly as `bytes32("boundline-app")` in Solidity. */
export function partnerIdOf(name: string): Hex {
  if (name.length === 0 || new TextEncoder().encode(name).length > 32) throw new Error("partner name must be 1 to 32 bytes");
  return stringToHex(name, { size: 32 });
}

export const BOUNDLINE_PARTNER_ID: Hex = partnerIdOf("boundline-app");

const addr = (a: string): Address => getAddress(a);

const stocks = (list: readonly StockConfig[]): readonly StockConfig[] => Object.freeze([...list]);

export const BASE_SEPOLIA: BoundlineChainConfig = {
  chainId: 84532,
  name: "Base Sepolia",
  rpcUrls: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
  explorer: "https://sepolia.basescan.org",
  desk: addr("0x39aBaDc0aAa12D1F7e259b89536Aa1848997399a"),
  gate: addr("0x92f59437d4ef5CDcEAe2CcDE89B03A7B4B1Ae427"),
  morpho: addr("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"),
  usdc: addr("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  usdcDecimals: 6,
  partnerId: BOUNDLINE_PARTNER_ID,
  stocks: stocks([
    { symbol: "AAPLt", name: "Apple (test)", token: addr("0xB2000000000000000000000E063E65377cA34141"), feed: addr("0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a"), sessionGuard: addr("0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854"), decimals: 8 },
    { symbol: "NVDAt", name: "NVIDIA (test)", token: addr("0xB200000000000000000000AEd76Eae58870E2ae6"), feed: addr("0x097dCec820dCF11b5e8d0fA698b86714f96dB0e2"), sessionGuard: addr("0xcEDcD908aB8B12766147459fb34F8C6Da4aA7518"), decimals: 8 },
    { symbol: "TSLAt", name: "Tesla (test)", token: addr("0xb200000000000000000000Af3FB2181a8772F804"), feed: addr("0x5CB94874E3a54F36Bc8DD9c85405ea300e5b43a1"), sessionGuard: addr("0xcADf92BBDC997fDb5920FF0Ba95B4d2d2b8389B3"), decimals: 8 },
  ]),
  markets: [
    {
      id: "0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047" as Hex,
      symbol: "AAPLt",
      collateral: addr("0xB2000000000000000000000E063E65377cA34141"),
      loan: addr("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
      oracle: addr("0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854"),
      lltvWad: 625_000_000_000_000_000n,
    },
    {
      id: "0x7cb7fcc828a7296f8ea18256e0f5763a5588cfe22df9c943088021c762e58cc9" as Hex,
      symbol: "NVDAt",
      collateral: addr("0xB200000000000000000000AEd76Eae58870E2ae6"),
      loan: addr("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
      oracle: addr("0xcEDcD908aB8B12766147459fb34F8C6Da4aA7518"),
      lltvWad: 625_000_000_000_000_000n,
    },
    {
      id: "0xb0e8d25d1c9b822cc718c89666b887698922a7b49fdb00dbdecd70dd4ed9e2f1" as Hex,
      symbol: "TSLAt",
      collateral: addr("0xb200000000000000000000Af3FB2181a8772F804"),
      loan: addr("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
      oracle: addr("0xcADf92BBDC997fDb5920FF0Ba95B4d2d2b8389B3"),
      lltvWad: 625_000_000_000_000_000n,
    },
  ],
  // AAPLt/USDC pre-liquidation (Lane A, 6 Oct 2026; deployments/base-sepolia.json → protection): protected mode opt-in.
  preLiquidation: addr("0xdcae709341aab652144e8afcb47479fe49e133a1"),
  // The Reserve and the desk-side protection vault (7 Oct 2026, deployments/base-sepolia.json → reserve).
  reserve: addr("0x7AcE5c9ca94d5B67feC97348Ff41778D092a6B6E"),
  deskProtectionVault: addr("0x87f600279F021ca859b9903DE884d3A7A169f38c"),
  // Local-money leg (7 Oct 2026, deployments/base-sepolia.json → payout): a test EURC and a fixed-rate pool at 0.92 EURCt per USDC.
  payout: {
    router: addr("0x1a6Dbc873F32f3dcE7719F213cf81842856F6354"),
    pools: [
      {
        symbol: "EURCt",
        name: "Boundline test EURC",
        token: addr("0xE9E71CFfFd3f053e2C7791277B794fd7aDaeA82A"),
        decimals: 6,
        currency: "EUR",
        pool: addr("0x31f0EB7569D34d72dEC3C80aCB8949bA5Ac96Cd4"),
        kind: "cl",
        quoteSource: "price36",
        tokenIsToken0: true,
      },
    ],
  },
};

export const BASE_MAINNET: BoundlineChainConfig = {
  chainId: 8453,
  name: "Base",
  rpcUrls: ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://mainnet.base.org"],
  explorer: "https://basescan.org",
  // deployments/base-mainnet.json: the desk on the SessionGate, over the session-safe AAPLc market.
  desk: addr("0x1671166DB8B93057Fa9a95b052b86c30E7B6a7Dd"),
  gate: addr("0x327895dA0fe53e18A8af5E98Bc749223B5227Ec6"),
  morpho: addr("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"),
  usdc: addr("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  usdcDecimals: 6,
  partnerId: BOUNDLINE_PARTNER_ID,
  stocks: stocks([
    { symbol: "AAPLc", name: "Apple", token: addr("0xb200000000000000000000C2e324d24d7eEcd1fb"), feed: addr("0x787f13dEa48Db0897CbCDD985de77809D837F988"), sessionGuard: addr("0xf94C3C8aEb3E79376868a23f42a31Cb3B6a3F132"), decimals: 8 },
    { symbol: "NVDAc", name: "NVIDIA", token: addr("0xb20000000000000000000078ee7ce2fE4908108C"), feed: addr("0x04689a41629776563E6822F76f2e57D148d28513"), sessionGuard: addr("0x8ffE3c46D677ee3b8CE1773C22607aA340e1fc8E"), decimals: 8 },
    { symbol: "TSLAc", name: "Tesla", token: addr("0xb2000000000000000000001e800a7f5189430cD0"), feed: addr("0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4"), sessionGuard: null, decimals: 8 },
  ]),
  markets: [
    {
      // Boundline's session-safe AAPLc/USDC market: SessionGuard oracle, AdaptiveCurveIrm, 62.5%.
      id: "0xb50ecaba0652b5a51bde9a747e9b7a2075c7ab68fd3c6ef7c05eabf6bb0f1d28" as Hex,
      symbol: "AAPLc",
      collateral: addr("0xb200000000000000000000C2e324d24d7eEcd1fb"),
      loan: addr("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
      oracle: addr("0xf94C3C8aEb3E79376868a23f42a31Cb3B6a3F132"),
      lltvWad: 625_000_000_000_000_000n,
    },
  ],
  // The session-safe AAPLc market's pre-liquidation (the Steakhouse AAPLc and NVDAc ones are in @boundline/router).
  preLiquidation: addr("0x1D6B5C5134C1450f9F07272106aE47637EbFCAFb"),
  reserve: addr("0xc4d5d866E9b5aDf35B4FD750fb192d99e20da1B4"),
  deskProtectionVault: addr("0x0828f1aDADaf7C1f44B3425337ebE7189c7B1cD9"),
  // The pool is Aerodrome's Slipstream EURC/USDC (token0 EURC, tickSpacing 50, verified 7 Oct 2026).
  payout: {
    router: addr("0xFC18E12929a3763476c13463fb05106F6F226112"),
    pools: [
      {
        symbol: "EURC",
        name: "Euro Coin",
        token: addr("0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42"),
        decimals: 6,
        currency: "EUR",
        pool: addr("0xE846373C1a92B167b4E9cd5d8E4d6B1Db9E90EC7"),
        kind: "cl",
        quoteSource: "slot0",
        tokenIsToken0: true,
      },
    ],
  },
};

export const CHAIN_CONFIGS: Readonly<Record<number, BoundlineChainConfig>> = Object.freeze({
  [BASE_SEPOLIA.chainId]: BASE_SEPOLIA,
  [BASE_MAINNET.chainId]: BASE_MAINNET,
});

export function configFor(chainId: number): BoundlineChainConfig {
  const c = CHAIN_CONFIGS[chainId];
  if (!c) throw new Error(`Boundline has no configuration for chain ${chainId}`);
  return c;
}

export function stockBySymbol(cfg: BoundlineChainConfig, symbol: string): StockConfig | undefined {
  return cfg.stocks.find((s) => s.symbol === symbol);
}

export function stockByToken(cfg: BoundlineChainConfig, token: Address): StockConfig | undefined {
  const t = token.toLowerCase();
  return cfg.stocks.find((s) => s.token.toLowerCase() === t);
}

export function marketByCollateral(cfg: BoundlineChainConfig, token: Address): MarketConfig | undefined {
  const t = token.toLowerCase();
  return cfg.markets.find((m) => m.collateral.toLowerCase() === t);
}

export function marketById(cfg: BoundlineChainConfig, id: Hex): MarketConfig | undefined {
  const x = id.toLowerCase();
  return cfg.markets.find((m) => m.id.toLowerCase() === x);
}

/** Explorer links, so the UI never builds URLs by hand. */
export const explorer = {
  tx: (cfg: BoundlineChainConfig, hash: Hex): string => `${cfg.explorer}/tx/${hash}`,
  address: (cfg: BoundlineChainConfig, a: Address): string => `${cfg.explorer}/address/${a}`,
};
