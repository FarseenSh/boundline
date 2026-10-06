import { aaveSpokeAbi, b20AssetAbi, type ChainId } from "@boundline/chain";
import { encodeEventTopics, isAddress, type Abi, type Address, type Hex } from "viem";
import {
  AAVE_SPOKE_EVENT_NAMES,
  B20_TOKEN_EVENT_NAMES,
  MORPHO_MARKET_EVENTS,
  answerUpdatedAbi,
  boundlineStackAbi,
  creditDeskAbi,
  mainnetOracleRegistryEventsAbi,
  morphoEventsAbi,
} from "./abis.js";
import { blockFromEnv, type Env } from "./env.js";

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
export const MAINNET: ChainId = 8453;

/** topic0 of every market-scoped Morpho event. */
export const MORPHO_MARKET_TOPIC0S: Hex[] = MORPHO_MARKET_EVENTS.map(
  (eventName) => encodeEventTopics({ abi: morphoEventsAbi, eventName })[0] as Hex,
);

export const SOURCE_IDS = {
  morphoMarketAaplt: "morpho-market-aaplt",
  oracleStack: "oracle-stack",
  creditDesk: "credit-desk",
  // phase 2, Base mainnet
  mainnetFeeds: "mainnet-feeds",
  mainnetOracleRegistry: "mainnet-oracle-registry",
  mainnetB20Tokens: "mainnet-b20-tokens",
  mainnetMorphoB20Markets: "mainnet-morpho-b20-markets",
  mainnetAaveSpoke: "mainnet-aave-mag7-spoke",
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

// ---------------------------------------------------------------- phase 2: Base mainnet

export interface MainnetFeed {
  symbol: string;
  token: Address;
  /** The Chainlink proxy (what `@boundline/chain` calls the feed). The proxy itself emits nothing. */
  proxy: Address;
  /** `proxy.aggregator()` at phase 2, resolved by RPC on 6 Oct 2026. `AnswerUpdated` is emitted here. */
  aggregator: Address;
}

export interface MainnetMarket {
  id: Hex;
  symbol: string;
  lltv: number;
}

/**
 * Base mainnet constants for phase 2 (every address re-read by RPC on 6 Oct 2026). The feed aggregators are the
 * phase-2 aggregators behind the proxies; a Chainlink phase change moves them, so `GET /v1/sources` shows what is
 * being followed and the sources test pins the proxies to `@boundline/chain`.
 */
export const MAINNET_STACK = {
  oracleRegistry: "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD" as Address,
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as Address,
  aaveMag7Spoke: "0x17905Db0e4A3514467539956c084180616AE7B8D" as Address,
  feeds: [
    { symbol: "AAPLc", token: "0xb200000000000000000000C2e324d24d7eEcd1fb", proxy: "0x787f13dEa48Db0897CbCDD985de77809D837F988", aggregator: "0xc37B6F754e90D4Cca1f533F5a08f7d532b3d0d9D" },
    { symbol: "AMZNc", token: "0xb200000000000000000000d9192b6B456483C2E8", proxy: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295", aggregator: "0x4816cb7EE43eE12C0BC9D3C597246f34D5CFdb7C" },
    { symbol: "GOOGLc", token: "0xb2000000000000000000002D0BA3164cc74f58B7", proxy: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2", aggregator: "0x6bF33b7855eB8047dDe206D9F6321D7d02CfB308" },
    { symbol: "METAc", token: "0xb2000000000000000000008bC8786B856E61707C", proxy: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D", aggregator: "0xA7155928bEE40052EFb3094a046c5498202FD3EE" },
    { symbol: "MSFTc", token: "0xB200000000000000000000Ab99cFa739E253872B", proxy: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c", aggregator: "0xD72B34be6c2180Ad0d28dbb415AEfdE8a55F3eD3" },
    { symbol: "MSTRc", token: "0xb2000000000000000000004884b426556b92883d", proxy: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a", aggregator: "0xBC94b7BA3A8941Fb7AEE8bD10538F79F39185EdB" },
    { symbol: "NVDAc", token: "0xb20000000000000000000078ee7ce2fE4908108C", proxy: "0x04689a41629776563E6822F76f2e57D148d28513", aggregator: "0xF72B1eB5932800F3d2a5EeC5f99e6cD586479675" },
    { symbol: "SNDKc", token: "0xb200000000000000000000397293Cb8cda9a10c5", proxy: "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA", aggregator: "0x767B5C02AF56C2621d66C8596aaC32DE7374b55b" },
    { symbol: "SPCXc", token: "0xb2000000000000000000007b9fcbd005511aCBd5", proxy: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68", aggregator: "0xa994B7fC3123AE0EF4EE53ab5e3545f2639187a7" },
    { symbol: "TSLAc", token: "0xb2000000000000000000001e800a7f5189430cD0", proxy: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4", aggregator: "0x0288234d9311C33BE6c3a34b051bff8A799dAA82" },
  ] as readonly MainnetFeed[],
  /** The 13 B20 Morpho Blue markets the Observatory listed on 6 Oct 2026 (Morpho API discovery, ids recomputed from params). */
  markets: [
    { id: "0xae1a30486234bf7e7ac166c7c03d9bc5f2cd8a39be2c48e73c665ac7148c3c28", symbol: "AAPLc", lltv: 0.625 },
    { id: "0xcca091ada0a486dd74743ab5f1b1b972adefaad357e2634fd7362a0d798dcd42", symbol: "AMZNc", lltv: 0.625 },
    { id: "0x0cc78b1f4993015116e90626a18a1ba0e1ca73d0b75781b231d02fa5536e62a5", symbol: "GOOGLc", lltv: 0.625 },
    { id: "0xa3913d896b7e9c0e0a84f1be27d376cf2065616101cb7c44674af8a154e684cc", symbol: "GOOGLc", lltv: 0.77 },
    { id: "0x44b343b5087c0bd34207cb5c199f12030777bf6b8c0a128438246f1212f37ca5", symbol: "METAc", lltv: 0.625 },
    { id: "0xa8835b567d1808f1fc9970d635b374d0f376b9f74e4b5840b2c74c5597cac88a", symbol: "METAc", lltv: 0.86 },
    { id: "0x4f9329a87a70e722cdab07b3647ef705671b25079d4f3bae559be5cfe12a7318", symbol: "MSFTc", lltv: 0.625 },
    { id: "0xb4b42dd66cef25614b94510a910d54b2c148e7621d22b4271566724beda63d13", symbol: "NVDAc", lltv: 0.625 },
    { id: "0xfef5641f70e19a87e369304daa9ba823754f3db1e6481d757fcae0442cffe479", symbol: "NVDAc", lltv: 0.77 },
    { id: "0x91360eea2686ef7ce4966b4e82cf6ff712af02baf0f7211459780d9f5af1612a", symbol: "NVDAc", lltv: 0.77 },
    { id: "0x5c800e8607e95fb96196570e229aef9a8a66595d4233a58fc406373bfac675db", symbol: "NVDAc", lltv: 0.77 },
    { id: "0xce983b9ee6344e16ebbcc66812f23caafc63ae83fcc14fa29b66c7e69e9cecf6", symbol: "SPCXc", lltv: 0.625 },
    { id: "0xc819df1685193012fc1d189e4ae22f6658442805f121303aebb04c81bd6d55d5", symbol: "TSLAc", lltv: 0.625 },
  ] as readonly MainnetMarket[],
  /**
   * Scan cutoffs. `phase2Start` is head − 50,000 when phase 2 was written (6 Oct 2026 ~08:30 UTC, about 28 hours of
   * Base blocks); `feedsStart` reaches back to ~Tue 22 Sep 2026 so the weekend-gap history covers the 26–28 Sep and
   * 3–5 Oct weekends. Both are overridable with MAINNET_START_BLOCK / MAINNET_FEEDS_START_BLOCK.
   */
  blocks: { phase2Start: 52_198_000, feedsStart: 51_640_000 },
} as const;

export const MAINNET_FEED_BY_SYMBOL: Readonly<Record<string, MainnetFeed>> = Object.fromEntries(MAINNET_STACK.feeds.map((f) => [f.symbol, f]));

/** The Morpho events worth a row on the mainnet B20 markets (CreateMarket, Supply and Withdraw are left to the vaults). */
export const MAINNET_MORPHO_EVENTS = ["Borrow", "Repay", "SupplyCollateral", "WithdrawCollateral", "Liquidate", "AccrueInterest"] as const;

function topic0s(abi: Abi, names: readonly string[]): Hex[] {
  return names.map((eventName) => encodeEventTopics({ abi, eventName } as never)[0] as Hex);
}

function eventsOnly(abi: Abi, names: readonly string[]): Abi {
  return abi.filter((item) => item.type === "event" && names.includes(item.name));
}

/** The B20 asset events we keep, taken from `@boundline/chain`'s full asset ABI. */
export const b20TokenEventsAbi: Abi = eventsOnly(b20AssetAbi as Abi, B20_TOKEN_EVENT_NAMES);
/** The Aave spoke events we keep, taken from `@boundline/chain`'s spoke ABI. */
export const aaveSpokeEventsAbi: Abi = eventsOnly(aaveSpokeAbi as Abi, AAVE_SPOKE_EVENT_NAMES);

export const MAINNET_MORPHO_TOPIC0S: Hex[] = topic0s(morphoEventsAbi, MAINNET_MORPHO_EVENTS);
export const B20_TOKEN_TOPIC0S: Hex[] = topic0s(b20TokenEventsAbi, B20_TOKEN_EVENT_NAMES);
export const AAVE_SPOKE_TOPIC0S: Hex[] = topic0s(aaveSpokeEventsAbi, AAVE_SPOKE_EVENT_NAMES);
export const ANSWER_UPDATED_TOPIC0: Hex = topic0s(answerUpdatedAbi, ["AnswerUpdated"])[0] as Hex;

/** Phase 2: the five Base mainnet sources. Registered only when `INDEX_MAINNET` is "true" (see index.ts). */
export function mainnetSources(env: Pick<Env, "MAINNET_START_BLOCK" | "MAINNET_FEEDS_START_BLOCK"> = {}): Source[] {
  const start = blockFromEnv(env.MAINNET_START_BLOCK) ?? MAINNET_STACK.blocks.phase2Start;
  const feedsStart = blockFromEnv(env.MAINNET_FEEDS_START_BLOCK) ?? MAINNET_STACK.blocks.feedsStart;
  return [
    {
      id: SOURCE_IDS.mainnetFeeds,
      chainId: MAINNET,
      addresses: MAINNET_STACK.feeds.map((f) => f.aggregator),
      topics: [ANSWER_UPDATED_TOPIC0],
      abi: answerUpdatedAbi,
      startBlock: feedsStart,
    },
    {
      id: SOURCE_IDS.mainnetOracleRegistry,
      chainId: MAINNET,
      addresses: [MAINNET_STACK.oracleRegistry],
      topics: [],
      abi: mainnetOracleRegistryEventsAbi,
      startBlock: start,
    },
    {
      id: SOURCE_IDS.mainnetB20Tokens,
      chainId: MAINNET,
      addresses: MAINNET_STACK.feeds.map((f) => f.token),
      topics: [B20_TOKEN_TOPIC0S],
      abi: b20TokenEventsAbi,
      startBlock: start,
    },
    {
      id: SOURCE_IDS.mainnetMorphoB20Markets,
      chainId: MAINNET,
      addresses: [MAINNET_STACK.morpho],
      topics: [MAINNET_MORPHO_TOPIC0S, MAINNET_STACK.markets.map((m) => m.id)],
      abi: morphoEventsAbi,
      startBlock: start,
    },
    {
      id: SOURCE_IDS.mainnetAaveSpoke,
      chainId: MAINNET,
      addresses: [MAINNET_STACK.aaveMag7Spoke],
      topics: [AAVE_SPOKE_TOPIC0S],
      abi: aaveSpokeEventsAbi,
      startBlock: start,
    },
  ];
}

/** What a source follows, for `GET /v1/sources` and the README. */
export function describeSource(s: Source): { id: string; chainId: number; addresses: number; topic0s: number; indexedFilter: boolean; startBlock: number } {
  const t0 = s.topics[0];
  return {
    id: s.id,
    chainId: s.chainId,
    addresses: s.addresses.length,
    topic0s: Array.isArray(t0) ? t0.length : t0 ? 1 : 0,
    indexedFilter: s.topics.length > 1,
    startBlock: s.startBlock,
  };
}
