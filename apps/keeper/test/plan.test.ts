import { describe, expect, it } from "vitest";
import { lagSeconds, planFeedMirror, planRegistryMirror, roundDiff, shouldSend, toRoundArgs } from "../src/plan.js";
import { round } from "./fake-chain.js";

const MAIN = round(36893488147419103512n, 33_366_495_000n, 1_790_959_199n);

describe("planFeedMirror", () => {
  it("skips when every field matches", () => {
    expect(planFeedMirror(MAIN, { ...MAIN })).toEqual({ action: "skip", reason: "in-sync" });
  });

  it("writes the whole mainnet round when the answer differs", () => {
    const plan = planFeedMirror(MAIN, round(MAIN.roundId, 33_000_000_000n, MAIN.updatedAt));
    expect(plan.action).toBe("setRoundData");
    if (plan.action !== "setRoundData") throw new Error("unreachable");
    expect(plan.reason).toBe("differs");
    expect(plan.changed).toEqual(["answer"]);
    expect(plan.args).toEqual(toRoundArgs(MAIN));
  });

  it("writes when only updatedAt differs (a heartbeat round with the same price)", () => {
    const plan = planFeedMirror(MAIN, round(MAIN.roundId - 1n, MAIN.answer, MAIN.updatedAt - 3600n));
    expect(plan.action).toBe("setRoundData");
    if (plan.action !== "setRoundData") throw new Error("unreachable");
    expect(plan.changed).toEqual(["roundId", "startedAt", "updatedAt", "answeredInRound"]);
  });

  it("writes when Sepolia is unknown", () => {
    const plan = planFeedMirror(MAIN, null);
    expect(plan).toMatchObject({ action: "setRoundData", reason: "sepolia-unknown", args: toRoundArgs(MAIN) });
  });

  it("refuses an all-zero mainnet round", () => {
    expect(planFeedMirror(round(0n, 0n, 0n), null)).toEqual({ action: "skip", reason: "mainnet-empty" });
  });

  it("copies a held or stale mainnet round faithfully", () => {
    const stale = round(7n, 100_00000000n, 1_700_000_000n);
    const plan = planFeedMirror(stale, round(1n, 100_00000000n, 1_791_000_000n));
    expect(plan.action).toBe("setRoundData");
    if (plan.action !== "setRoundData") throw new Error("unreachable");
    expect(plan.args[3]).toBe(1_700_000_000n);
  });

  it("keeps args in ABI order: roundId, answer, startedAt, updatedAt, answeredInRound", () => {
    const r = round(9n, 5n, 40n, 30n, 8n);
    expect(toRoundArgs(r)).toEqual([9n, 5n, 30n, 40n, 8n]);
    expect(roundDiff(r, { ...r, answeredInRound: 9n })).toEqual(["answeredInRound"]);
  });
});

describe("planRegistryMirror", () => {
  it("skips when equal", () => {
    expect(planRegistryMirror({ multiplier: 10n ** 18n, paused: false }, { multiplier: 10n ** 18n, paused: false })).toEqual({ action: "skip", reason: "in-sync" });
  });
  it("writes on a pause", () => {
    expect(planRegistryMirror({ multiplier: 10n ** 18n, paused: true }, { multiplier: 10n ** 18n, paused: false })).toEqual({
      action: "setOracleParams",
      reason: "differs",
      args: [10n ** 18n, true],
    });
  });
  it("writes on a multiplier change", () => {
    expect(planRegistryMirror({ multiplier: 2n * 10n ** 18n, paused: false }, { multiplier: 10n ** 18n, paused: false })).toMatchObject({ action: "setOracleParams", args: [2n * 10n ** 18n, false] });
  });
  it("writes when Sepolia is unknown", () => {
    expect(planRegistryMirror({ multiplier: 10n ** 18n, paused: false }, null)).toMatchObject({ action: "setOracleParams", reason: "sepolia-unknown" });
  });
});

describe("shouldSend", () => {
  it("sends when nothing is pending", () => {
    expect(shouldSend(5n, 5n)).toBe(true);
  });
  it("waits while a transaction is in flight", () => {
    expect(shouldSend(5n, 6n)).toBe(false);
  });
  it("tolerates a lagging node that reports pending below latest", () => {
    expect(shouldSend(6n, 5n)).toBe(true);
  });
});

describe("lagSeconds", () => {
  it("is 0 in sync, the updatedAt gap otherwise, null when unknown", () => {
    expect(lagSeconds(MAIN, { ...MAIN })).toBe(0);
    expect(lagSeconds(MAIN, round(1n, 1n, MAIN.updatedAt - 90_000n))).toBe(90_000);
    expect(lagSeconds(MAIN, round(1n, 1n, MAIN.updatedAt + 10n))).toBe(0);
    expect(lagSeconds(MAIN, null)).toBeNull();
  });
});
