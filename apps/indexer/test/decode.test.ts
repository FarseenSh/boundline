import { TOPICS } from "@boundline/chain";
import { encodeEventTopics } from "viem";
import { describe, expect, it } from "vitest";
import { answerUpdatedAbi, creditDeskAbi, morphoEventsAbi } from "../src/abis.js";
import { decodeLog } from "../src/decode.js";
import { MORPHO_MARKET_TOPIC0S } from "../src/sources.js";
import { BORROWER, CHAIN, FEED, MARKET, MORPHO, makeLog } from "./fixtures.js";

describe("decodeLog", () => {
  it("decodes a Morpho Borrow with canonical args", () => {
    const log = makeLog({
      abi: morphoEventsAbi,
      eventName: "Borrow",
      args: { id: MARKET, caller: BORROWER, onBehalf: BORROWER, receiver: BORROWER, assets: 1_000_000n, shares: 1_000_000_000_000n },
      address: MORPHO,
      blockNumber: 47_635_000,
      logIndex: 3,
    });
    const e = decodeLog(morphoEventsAbi, log, CHAIN, 1_791_040_000);
    expect(e.name).toBe("Borrow");
    expect(e.topic0).toBe(TOPICS.morphoBorrow);
    expect(e.blockNumber).toBe(47_635_000);
    expect(e.logIndex).toBe(3);
    expect(e.blockTime).toBe(1_791_040_000);
    expect(JSON.parse(e.argsJson)).toEqual({
      assets: "1000000",
      caller: BORROWER,
      id: MARKET,
      onBehalf: BORROWER,
      receiver: BORROWER,
      shares: "1000000000000",
    });
  });
  it("decodes SupplyCollateral and AnswerUpdated", () => {
    const sc = decodeLog(
      morphoEventsAbi,
      makeLog({ abi: morphoEventsAbi, eventName: "SupplyCollateral", args: { id: MARKET, caller: BORROWER, onBehalf: BORROWER, assets: 1_000_000_000n }, address: MORPHO, blockNumber: 1, logIndex: 0 }),
      CHAIN,
      1,
    );
    expect(sc.name).toBe("SupplyCollateral");
    expect(JSON.parse(sc.argsJson)).toEqual({ assets: "1000000000", caller: BORROWER, id: MARKET, onBehalf: BORROWER });

    const au = decodeLog(
      answerUpdatedAbi,
      makeLog({ abi: answerUpdatedAbi, eventName: "AnswerUpdated", args: { current: 33_366_495_000n, roundId: 2n, updatedAt: 1_791_037_640n }, address: FEED, blockNumber: 2, logIndex: 1 }),
      CHAIN,
      2,
    );
    expect(au.name).toBe("AnswerUpdated");
    expect(JSON.parse(au.argsJson)).toEqual({ current: "33366495000", roundId: "2", updatedAt: "1791037640" });
  });
  it("decodes a CreditDesk Decision", () => {
    const action = `0x${"11".repeat(32)}` as const;
    const hash = `0x${"22".repeat(32)}` as const;
    const e = decodeLog(
      creditDeskAbi,
      makeLog({ abi: creditDeskAbi, eventName: "Decision", args: { lineId: 7n, action, decisionHash: hash, amount: 5n, price8: 33_366_495_000n }, address: BORROWER, blockNumber: 3, logIndex: 0 }),
      CHAIN,
      3,
    );
    expect(e.name).toBe("Decision");
    expect(JSON.parse(e.argsJson)).toEqual({ action, amount: "5", decisionHash: hash, lineId: "7", price8: "33366495000" });
  });
  it("keeps an unknown topic with its raw topics and data", () => {
    const log = makeLog({ abi: answerUpdatedAbi, eventName: "AnswerUpdated", args: { current: 1n, roundId: 1n, updatedAt: 1n }, address: FEED, blockNumber: 4, logIndex: 0 });
    const e = decodeLog(morphoEventsAbi, log, CHAIN, 4);
    expect(e.name).toBe(`unknown:${log.topics[0]}`);
    expect(JSON.parse(e.argsJson)).toEqual({ topics: log.topics, data: log.data });
  });
  it("lists the market-scoped Morpho topic0s, Borrow among them", () => {
    expect(MORPHO_MARKET_TOPIC0S).toHaveLength(9);
    expect(MORPHO_MARKET_TOPIC0S).toContain(TOPICS.morphoBorrow);
    expect(MORPHO_MARKET_TOPIC0S).toContain(encodeEventTopics({ abi: morphoEventsAbi, eventName: "AccrueInterest" })[0]);
  });
});
