import { B20_TOKENS, MAINNET as CHAIN_MAINNET } from "@boundline/chain";
import { encodeEventTopics, keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { answerUpdatedAbi, morphoEventsAbi } from "../src/abis.js";
import {
  AAVE_SPOKE_TOPIC0S,
  ANSWER_UPDATED_TOPIC0,
  B20_TOKEN_TOPIC0S,
  MAINNET,
  MAINNET_FEED_BY_SYMBOL,
  MAINNET_MORPHO_TOPIC0S,
  MAINNET_STACK,
  SOURCE_IDS,
  aaveSpokeEventsAbi,
  b20TokenEventsAbi,
  describeSource,
  mainnetSources,
} from "../src/sources.js";

describe("MAINNET_STACK", () => {
  it("pins the ten feed proxies and tokens to @boundline/chain", () => {
    expect(MAINNET_STACK.feeds).toHaveLength(10);
    for (const f of MAINNET_STACK.feeds) {
      const t = B20_TOKENS.find((x) => x.symbol === f.symbol);
      expect(t, f.symbol).toBeDefined();
      expect(f.proxy).toBe(t!.feed);
      expect(f.token).toBe(t!.address);
      expect(f.aggregator).not.toBe(f.proxy);
    }
    expect(MAINNET_STACK.oracleRegistry).toBe(CHAIN_MAINNET.oracleRegistry);
    expect(MAINNET_STACK.morpho).toBe(CHAIN_MAINNET.morpho);
    expect(MAINNET_STACK.aaveMag7Spoke).toBe(CHAIN_MAINNET.aaveMag7Spoke);
    expect(MAINNET_FEED_BY_SYMBOL.AAPLc?.aggregator).toBe("0xc37B6F754e90D4Cca1f533F5a08f7d532b3d0d9D");
  });

  it("lists 13 distinct B20 market ids", () => {
    const ids = new Set(MAINNET_STACK.markets.map((m) => m.id));
    expect(ids.size).toBe(13);
    for (const m of MAINNET_STACK.markets) expect(m.id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(MAINNET_STACK.blocks.feedsStart).toBeLessThan(MAINNET_STACK.blocks.phase2Start);
  });
});

describe("topic filters", () => {
  it("AnswerUpdated is the Chainlink aggregator signature", () => {
    expect(ANSWER_UPDATED_TOPIC0).toBe(keccak256(toHex("AnswerUpdated(int256,uint256,uint256)")));
    expect(encodeEventTopics({ abi: answerUpdatedAbi, eventName: "AnswerUpdated" })[0]).toBe(ANSWER_UPDATED_TOPIC0);
  });
  it("Morpho market topics exclude CreateMarket, Supply and Withdraw", () => {
    const names = ["Borrow", "Repay", "SupplyCollateral", "WithdrawCollateral", "Liquidate", "AccrueInterest"] as const;
    expect(MAINNET_MORPHO_TOPIC0S).toEqual(names.map((eventName) => encodeEventTopics({ abi: morphoEventsAbi, eventName })[0]));
    expect(MAINNET_MORPHO_TOPIC0S).not.toContain(encodeEventTopics({ abi: morphoEventsAbi, eventName: "Supply" })[0]);
  });
  it("B20 token topics carry no Transfer, and the Aave spoke topics match the v0.5.11 signatures", () => {
    expect(b20TokenEventsAbi.every((i) => i.type === "event" && i.name !== "Transfer" && i.name !== "Approval")).toBe(true);
    expect(B20_TOKEN_TOPIC0S).toHaveLength(12);
    expect(B20_TOKEN_TOPIC0S).toContain(keccak256(toHex("Paused(address,uint8[])")));
    expect(B20_TOKEN_TOPIC0S).toContain(keccak256(toHex("UIMultiplierUpdated(uint256,uint256,uint256)")));
    expect(B20_TOKEN_TOPIC0S).toContain(keccak256(toHex("PolicyUpdated(bytes32,uint64,uint64)")));
    expect(aaveSpokeEventsAbi).toHaveLength(7);
    expect(AAVE_SPOKE_TOPIC0S).toContain(keccak256(toHex("Borrow(uint256,address,address,uint256,uint256)")));
    expect(AAVE_SPOKE_TOPIC0S).toContain(keccak256(toHex("Repay(uint256,address,address,uint256,uint256,(int256,int256,uint256))")));
    expect(AAVE_SPOKE_TOPIC0S).toContain(keccak256(toHex("SetUserPositionManager(address,address,bool)")));
  });
});

describe("mainnetSources", () => {
  it("registers the six sources with the right filters and start blocks", () => {
    const s = mainnetSources();
    expect(s.map((x) => x.id)).toEqual([
      SOURCE_IDS.mainnetFeeds,
      SOURCE_IDS.mainnetOracleRegistry,
      SOURCE_IDS.mainnetB20Tokens,
      SOURCE_IDS.mainnetMorphoB20Markets,
      SOURCE_IDS.mainnetAaveSpoke,
      SOURCE_IDS.mainnetPolicyRegistry,
    ]);
    expect(s.every((x) => x.chainId === MAINNET)).toBe(true);
    const [feeds, registry, tokens, morpho, aave, policies] = s;
    // seize watch: every membership change of every B20 policy (whole-chain volume was 2 events in 129,000 blocks)
    expect(policies!.addresses).toEqual(["0x8453000000000000000000000000000000000002"]);
    expect(policies!.topics).toEqual([]);
    expect(policies!.startBlock).toBe(MAINNET_STACK.blocks.phase2Start);
    expect(feeds!.addresses).toEqual(MAINNET_STACK.feeds.map((f) => f.aggregator));
    expect(feeds!.topics).toEqual([ANSWER_UPDATED_TOPIC0]);
    expect(feeds!.startBlock).toBe(MAINNET_STACK.blocks.feedsStart);
    expect(registry!.topics).toEqual([]);
    expect(registry!.startBlock).toBe(MAINNET_STACK.blocks.phase2Start);
    expect(tokens!.addresses).toHaveLength(10);
    expect(tokens!.topics[0]).toHaveLength(12);
    expect(morpho!.topics[1]).toHaveLength(13);
    expect(aave!.addresses).toEqual([MAINNET_STACK.aaveMag7Spoke]);
    expect(describeSource(morpho!)).toEqual({ id: SOURCE_IDS.mainnetMorphoB20Markets, chainId: 8453, addresses: 1, topic0s: 6, indexedFilter: true, startBlock: MAINNET_STACK.blocks.phase2Start });
  });
  it("takes the start blocks from the env when given", () => {
    const s = mainnetSources({ MAINNET_START_BLOCK: "52000000", MAINNET_FEEDS_START_BLOCK: "51000000" });
    expect(s[0]!.startBlock).toBe(51_000_000);
    expect(s[1]!.startBlock).toBe(52_000_000);
    const bad = mainnetSources({ MAINNET_START_BLOCK: "soon", MAINNET_FEEDS_START_BLOCK: "-1" });
    expect(bad[0]!.startBlock).toBe(MAINNET_STACK.blocks.feedsStart);
    expect(bad[1]!.startBlock).toBe(MAINNET_STACK.blocks.phase2Start);
  });
});
