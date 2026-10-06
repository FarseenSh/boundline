// Mirror pairs: a Coinbase tokenized stock on Base mainnet (address book in @boundline/chain) and the
// Boundline test stock on Base Sepolia that mirrors it. Sepolia addresses are copied from
// deployments/base-sepolia.json (deployed and verified 3 Oct 2026); keep the two in step by hand.
import { B20_BY_SYMBOL, CHAIN_IDS, MAINNET } from "@boundline/chain";
import type { Address } from "viem";

export interface MirrorPair {
  /** Sepolia test stock symbol. */
  readonly symbol: string;
  /** Mainnet Coinbase stock it mirrors. */
  readonly source: string;
  readonly mainnetToken: Address;
  readonly mainnetFeed: Address;
  readonly sepoliaToken: Address;
  /** The Sepolia TestPriceFeed the keeper owns and writes. */
  readonly sepoliaFeed: Address;
}

function mainnet(symbol: string): { address: Address; feed: Address } {
  const t = B20_BY_SYMBOL[symbol];
  if (!t) throw new Error(`no mainnet B20 token ${symbol} in @boundline/chain`);
  return { address: t.address, feed: t.feed };
}

export const PAIRS: readonly MirrorPair[] = [
  { symbol: "AAPLt", source: "AAPLc", ...pair("AAPLc", "0xB2000000000000000000000E063E65377cA34141", "0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a") },
  { symbol: "NVDAt", source: "NVDAc", ...pair("NVDAc", "0xB200000000000000000000AEd76Eae58870E2ae6", "0x097dCec820dCF11b5e8d0fA698b86714f96dB0e2") },
  { symbol: "TSLAt", source: "TSLAc", ...pair("TSLAc", "0xb200000000000000000000Af3FB2181a8772F804", "0x5CB94874E3a54F36Bc8DD9c85405ea300e5b43a1") },
];

function pair(source: string, sepoliaToken: Address, sepoliaFeed: Address) {
  const m = mainnet(source);
  return { mainnetToken: m.address, mainnetFeed: m.feed, sepoliaToken, sepoliaFeed };
}

/** Coinbase OracleRegistry on Base mainnet. */
export const MAINNET_REGISTRY: Address = MAINNET.oracleRegistry;
/** Boundline MirrorOracleRegistry on Base Sepolia (deployments/base-sepolia.json). */
export const SEPOLIA_REGISTRY: Address = "0xc78A796710be93774310ff8Cf467EaABCeAb4655";
/** The keeper key's address: owner of the three TestPriceFeeds and the MirrorOracleRegistry since 3 Oct 2026. */
export const KEEPER_ADDRESS: Address = "0x28A50Eb7C2Db2B04638D3b226c724A1Cfe999894";

export const CHAINS = { mainnet: CHAIN_IDS.base, sepolia: CHAIN_IDS.baseSepolia } as const;

/** How long the status tooling waits for a receipt; a cron tick never waits (see tick.ts). */
export const RECEIPT_TIMEOUT_MS = 15_000;

/**
 * Transactions signed per tick. One by default: the Workers Free plan allows 10 ms of CPU per invocation and a
 * signature costs about 1.6 ms, so a backlog drains one transaction a minute (the next tick sees `pending ==
 * latest` once it is mined, about two seconds later). Raise with the var MAX_TX_PER_TICK on a paid plan.
 */
export const MAX_TX_PER_TICK = 1;

/** Gas for `setRoundData` / `setOracleParams` (observed 51,542 on warm slots; cold slots cost more). */
export const GAS_LIMIT = 160_000n;
/** EIP-1559 fees on Base Sepolia: base fee is about 0.005 gwei (6 Oct 2026); the tip is nominal. */
export const PRIORITY_FEE_WEI = 1_000_000n;
export const MIN_MAX_FEE_WEI = 20_000_000n;
