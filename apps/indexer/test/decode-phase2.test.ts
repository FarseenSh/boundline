import { describe, expect, it } from "vitest";
import { decodeLog } from "../src/decode.js";
import { answerUpdatedAbi } from "../src/abis.js";
import { MAINNET_STACK, aaveSpokeEventsAbi, b20TokenEventsAbi } from "../src/sources.js";
import { makeLog } from "./fixtures.js";

const SPOKE = MAINNET_STACK.aaveMag7Spoke;
const AAPLC = MAINNET_STACK.feeds[0]!.token;
const AGG = MAINNET_STACK.feeds[0]!.aggregator;

describe("phase-2 decoding", () => {
  it("decodes an Aave Repay with its PremiumDelta tuple into canonical args", () => {
    const log = makeLog({
      abi: aaveSpokeEventsAbi,
      eventName: "Repay",
      args: { reserveId: 7n, caller: "0x9E81c2fDE4E34CAB3AB1667ca3c932dBAED95F08", user: "0xB789aD318945B37566E2549F65526Cc269a482Fc", drawnShares: 123n, totalAmountRepaid: 5_000_000n, premiumDelta: { sharesDelta: -1n, offsetRayDelta: 2n, restoredPremiumRay: 3n } },
      address: SPOKE,
      blockNumber: 52_200_000,
      logIndex: 4,
    });
    const row = decodeLog(aaveSpokeEventsAbi, log, 8453, 1_791_200_000);
    expect(row.name).toBe("Repay");
    expect(JSON.parse(row.argsJson)).toEqual({
      caller: "0x9e81c2fde4e34cab3ab1667ca3c932dbaed95f08",
      drawnShares: "123",
      premiumDelta: { offsetRayDelta: "2", restoredPremiumRay: "3", sharesDelta: "-1" },
      reserveId: "7",
      totalAmountRepaid: "5000000",
      user: "0xb789ad318945b37566e2549f65526cc269a482fc",
    });
  });

  it("decodes a B20 Paused with a feature array and an AnswerUpdated from an aggregator", () => {
    const paused = decodeLog(
      b20TokenEventsAbi,
      makeLog({ abi: b20TokenEventsAbi, eventName: "Paused", args: { updater: "0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E", features: [0, 3] }, address: AAPLC, blockNumber: 52_200_001, logIndex: 0 }),
      8453,
      1,
    );
    expect(paused.name).toBe("Paused");
    expect(JSON.parse(paused.argsJson)).toEqual({ features: [0, 3], updater: "0x2f0d9b1f16cd702259c6cc259e8d5e5455282a4e" });
    const print = decodeLog(
      answerUpdatedAbi,
      makeLog({ abi: answerUpdatedAbi, eventName: "AnswerUpdated", args: { current: 33_267_000_000n, roundId: 36893488147419103518n, updatedAt: 1_791_223_131n }, address: AGG, blockNumber: 52_200_002, logIndex: 1 }),
      8453,
      1,
    );
    expect(JSON.parse(print.argsJson)).toEqual({ current: "33267000000", roundId: "36893488147419103518", updatedAt: "1791223131" });
    expect(print.topic0).toBe("0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f");
  });

  it("keeps a topic the source ABI does not know as unknown:<topic0>", () => {
    const foreign = makeLog({ abi: aaveSpokeEventsAbi, eventName: "Supply", args: { reserveId: 0n, caller: SPOKE, user: SPOKE, suppliedShares: 1n, suppliedAmount: 1n }, address: SPOKE, blockNumber: 1, logIndex: 0 });
    const row = decodeLog(answerUpdatedAbi, foreign, 8453, 1);
    expect(row.name).toMatch(/^unknown:0x/);
  });
});
