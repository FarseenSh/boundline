import { encodeEventTopics, isAddress, type Abi, type Address, type Hex } from "viem";
import type { ChainId } from "@boundline/chain";
import { MORPHO_MARKET_EVENTS, boundlineStackAbi, creditDeskAbi, morphoEventsAbi } from "./abis.js";
import type { Env } from "./env.js";

/** One `eth_getLogs` filter plus the ABI that decodes its logs and the block the scan starts at. */
export interface Source {
  id: string;
  chainId: ChainId;
  addresses: Address[];
  /** `eth_getLogs` topics: position 0 is topic0 (one or many), later positions are indexed args; empty means every log. */
  topics: (Hex | Hex[] | null)[];
  abi: Abi;
  startBlock: number;
}

/**
 * Base Sepolia addresses from `deployments/base-sepolia.json` (deployed 3 Oct 2026).
 * `test/sources.test.ts` reads that file and fails if these drift from it.
 */
export const SEPOLIA_STACK = {
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  marketCalendar: "0x70575eb938645A9D3E18Dda035f5A6a7713696B8",
  mirrorOracleRegistry: "0xc78A796710be93774310ff8Cf467EaABCeAb4655",
  sessionGate: "0x92f59437d4ef5CDcEAe2CcDE89B03A7B4B1Ae427",
  feeds: {
    AAPLt: "0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a",
    NVDAt: "0x097dCec820dCF11b5e8d0fA698b86714f96dB0e2",
    TSLAt: "0x5CB94874E3a54F36Bc8DD9c85405ea300e5b43a1",
  },
  tokens: {
    AAPLt: "0xB2000000000000000000000E063E65377cA34141",
    NVDAt: "0xB200000000000000000000AEd76Eae58870E2ae6",
    TSLAt: "0xb200000000000000000000Af3FB2181a8772F804",
  },
  market: {
    id: "0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047",
    collateral: "0xB2000000000000000000000E063E65377cA34141",
    oracle: "0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854",
  },
  blocks: { stocks: 47_634_622, oracleStack: 47_634_676, market: 47_634_839 },
} as const;

export const SEPOLIA: ChainId = 84532;

/** topic0 of every market-scoped Morpho event. */
export const MORPHO_MARKET_TOPIC0S: Hex[] = MORPHO_MARKET_EVENTS.map(
  (eventName) => encodeEventTopics({ abi: morphoEventsAbi, eventName })[0] as Hex,
);

export const SOURCE_IDS = {
  morphoMarketAaplt: "morpho-market-aaplt",
  oracleStack: "oracle-stack",
  creditDesk: "credit-desk",
} as const;

/** The phase-1 sources on Base Sepolia. The desk source appears once `CREDIT_DESK_SEPOLIA` holds an address. */
export function sepoliaSources(env: Pick<Env, "CREDIT_DESK_SEPOLIA">): Source[] {
  const sources: Source[] = [
    {
      id: SOURCE_IDS.morphoMarketAaplt,
      chainId: SEPOLIA,
      addresses: [SEPOLIA_STACK.morpho],
      topics: [MORPHO_MARKET_TOPIC0S, SEPOLIA_STACK.market.id],
      abi: morphoEventsAbi,
      startBlock: SEPOLIA_STACK.blocks.market,
    },
    {
      id: SOURCE_IDS.oracleStack,
      chainId: SEPOLIA,
      addresses: [
        SEPOLIA_STACK.marketCalendar,
        SEPOLIA_STACK.mirrorOracleRegistry,
        SEPOLIA_STACK.sessionGate,
        SEPOLIA_STACK.feeds.AAPLt,
        SEPOLIA_STACK.feeds.NVDAt,
        SEPOLIA_STACK.feeds.TSLAt,
      ],
      topics: [],
      abi: boundlineStackAbi,
      startBlock: SEPOLIA_STACK.blocks.oracleStack,
    },
  ];
  const desk = env.CREDIT_DESK_SEPOLIA?.trim();
  if (desk && isAddress(desk)) {
    sources.push({
      id: SOURCE_IDS.creditDesk,
      chainId: SEPOLIA,
      addresses: [desk],
      topics: [],
      abi: creditDeskAbi,
      // The desk is deployed after the oracle stack; scanning from there costs a few thousand empty blocks once.
      startBlock: SEPOLIA_STACK.blocks.oracleStack,
    });
  }
  return sources;
}

/** Phase 2 (Base mainnet feeds, OracleRegistry, Morpho B20 markets, Aave spoke) is not registered yet. */
export function mainnetSources(): Source[] {
  return [];
}
