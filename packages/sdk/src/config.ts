// Every address the SDK and the app need, per chain, in one place. Base Sepolia is live
// (deployments/base-sepolia.json, 3 Oct 2026); Base mainnet has no desk yet and is listed so the
// app can add it without touching anything else.
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
  ],
  preLiquidation: null,
};

export const BASE_MAINNET: BoundlineChainConfig = {
  chainId: 8453,
  name: "Base",
  rpcUrls: ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://mainnet.base.org"],
  explorer: "https://basescan.org",
  desk: null,
  gate: null,
  morpho: addr("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"),
  usdc: addr("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  usdcDecimals: 6,
  partnerId: BOUNDLINE_PARTNER_ID,
  stocks: stocks([
    { symbol: "AAPLc", name: "Apple", token: addr("0xb200000000000000000000C2e324d24d7eEcd1fb"), feed: addr("0x787f13dEa48Db0897CbCDD985de77809D837F988"), sessionGuard: null, decimals: 8 },
    { symbol: "NVDAc", name: "NVIDIA", token: addr("0xb20000000000000000000078ee7ce2fE4908108C"), feed: addr("0x04689a41629776563E6822F76f2e57D148d28513"), sessionGuard: null, decimals: 8 },
    { symbol: "TSLAc", name: "Tesla", token: addr("0xb2000000000000000000001e800a7f5189430cD0"), feed: addr("0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4"), sessionGuard: null, decimals: 8 },
  ]),
  markets: [],
  preLiquidation: null,
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
