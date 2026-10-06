import { aggregatorV3Abi, b20AssetAbi, clPoolAbi, oracleRegistryAbi } from "@boundline/chain";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, multicall3Abi, toFunctionSelector, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  SELECTOR,
  decodeAggregate3,
  decodeAggregate3Calldata,
  decodeLatestRoundData,
  decodeObserve,
  decodeOracleParams,
  decodeSlot0,
  decodeUint8Array,
  encodeAggregate3,
  encodeAggregate3Result,
  intAt,
  observeCallData,
  uintAt,
  type Call,
} from "../src/encoding.js";
import { DEFAULT_PLAN, HEAD_CALLS, TOKEN_STRIDE } from "../src/reader.js";

import { AGGREGATE3_FIXTURE } from "./fixtures/aggregate3-mainnet.js";

export const fixture: { recordedAt: string; calls: number; calldata: Hex; result: Hex } = AGGREGATE3_FIXTURE;

const SIGNATURES: Record<keyof typeof SELECTOR, string> = {
  aggregate3: "aggregate3((address,bool,bytes)[])",
  getBlockNumber: "getBlockNumber()",
  getCurrentBlockTimestamp: "getCurrentBlockTimestamp()",
  latestRoundData: "latestRoundData()",
  decimals: "decimals()",
  getOracleParams: "getOracleParams(address)",
  isPaused: "isPaused(uint8)",
  pausedFeatures: "pausedFeatures()",
  uiMultiplier: "uiMultiplier()",
  newUIMultiplier: "newUIMultiplier()",
  effectiveAt: "effectiveAt()",
  slot0: "slot0()",
  liquidity: "liquidity()",
  observe: "observe(uint32[])",
  market: "market(bytes32)",
  position: "position(bytes32,address)",
  price: "price()",
};

describe("selectors", () => {
  it("match viem's toFunctionSelector for every signature", () => {
    for (const [name, sig] of Object.entries(SIGNATURES)) expect(SELECTOR[name as keyof typeof SELECTOR], name).toBe(toFunctionSelector(sig));
  });
});

const viemCalls = (calls: readonly Call[]) => calls.map((c) => ({ target: c.target, allowFailure: c.allowFailure ?? true, callData: c.callData }));

describe("encodeAggregate3", () => {
  it("is byte-identical to viem for the default read plan (88 calls)", () => {
    expect(DEFAULT_PLAN.calls).toHaveLength(HEAD_CALLS + 10 * TOKEN_STRIDE + 2 * 3);
    expect(DEFAULT_PLAN.data).toBe(encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [viemCalls(DEFAULT_PLAN.calls)] }));
  });

  it("is byte-identical to viem for awkward lengths and allowFailure=false", () => {
    const calls: Call[] = [
      { target: "0x1111111111111111111111111111111111111111", callData: "0x", allowFailure: false },
      { target: "0x2222222222222222222222222222222222222222", callData: "0xdeadbeef01" },
      { target: "0x3333333333333333333333333333333333333333", callData: observeCallData([3600, 60, 0]) },
      { target: "0x4444444444444444444444444444444444444444", callData: `0x${"ab".repeat(33)}`, allowFailure: true },
    ];
    expect(encodeAggregate3(calls)).toBe(encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [viemCalls(calls)] }));
    expect(decodeAggregate3Calldata(encodeAggregate3(calls))).toEqual(viemCalls(calls));
  });

  it("encodes observe's dynamic array like viem", () => {
    expect(observeCallData([3600, 0])).toBe(encodeFunctionData({ abi: clPoolAbi, functionName: "observe", args: [[3600, 0]] }));
  });
});

describe("decodeAggregate3", () => {
  it("round-trips through encodeAggregate3Result, including empty and 33-byte payloads", () => {
    const results = [
      { success: true, data: "" },
      { success: false, data: "08c379a0" },
      { success: true, data: "ab".repeat(33) },
      { success: true, data: "00".repeat(64) },
    ];
    expect(decodeAggregate3(encodeAggregate3Result(results))).toEqual(results);
  });

  it("agrees with viem on the recorded mainnet response", () => {
    const ours = decodeAggregate3(fixture.result);
    const theirs = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: fixture.result }) as { success: boolean; returnData: Hex }[];
    expect(ours).toHaveLength(fixture.calls);
    expect(ours.map((r) => ({ success: r.success, returnData: `0x${r.data}` }))).toEqual(theirs.map((r) => ({ success: r.success, returnData: r.returnData.toLowerCase() })));
  });

  it("rejects truncated data", () => {
    expect(() => decodeAggregate3("0x")).toThrow(RangeError);
    expect(() => decodeAggregate3(fixture.result.slice(0, 400))).toThrow(RangeError);
  });
});

describe("typed decoders agree with viem on the recorded response", () => {
  const results = decodeAggregate3(fixture.result);
  // AAPLc is the first token: latestRoundData at HEAD_CALLS, getOracleParams +2, pausedFeatures +4; its pool is the first pool block.
  const base = HEAD_CALLS;
  const poolBase = HEAD_CALLS + 10 * TOKEN_STRIDE;
  const data = (i: number): Hex => `0x${results[i]!.data}`;

  it("latestRoundData", () => {
    const [roundId, answer, startedAt, updatedAt, answeredInRound] = decodeFunctionResult({ abi: aggregatorV3Abi, functionName: "latestRoundData", data: data(base) });
    expect(decodeLatestRoundData(results[base]!.data)).toEqual([roundId, answer, startedAt, updatedAt, answeredInRound]);
    expect(answer).toBeGreaterThan(0n);
  });

  it("getOracleParams and pausedFeatures", () => {
    const [multiplier, paused] = decodeFunctionResult({ abi: oracleRegistryAbi, functionName: "getOracleParams", data: data(base + 2) });
    expect(decodeOracleParams(results[base + 2]!.data)).toEqual([multiplier, paused]);
    const features = decodeFunctionResult({ abi: b20AssetAbi, functionName: "pausedFeatures", data: data(base + 4) });
    expect(decodeUint8Array(results[base + 4]!.data)).toEqual([...features]);
  });

  it("slot0 and observe", () => {
    const slot0 = decodeFunctionResult({ abi: clPoolAbi, functionName: "slot0", data: data(poolBase) });
    expect(decodeSlot0(results[poolBase]!.data)).toEqual([...slot0]);
    const [ticks, liq] = decodeFunctionResult({ abi: clPoolAbi, functionName: "observe", data: data(poolBase + 2) });
    expect(decodeObserve(results[poolBase + 2]!.data)).toEqual([[...ticks], [...liq]]);
    expect(ticks).toHaveLength(2);
  });

  it("reads negative ints as two's complement", () => {
    const encoded = encodeAbiParameters([{ type: "int24" }, { type: "int56" }, { type: "uint256" }], [-12047, -99140738406n, 7n]).slice(2);
    expect(intAt(encoded, 0)).toBe(-12047n);
    expect(intAt(encoded, 1)).toBe(-99140738406n);
    expect(uintAt(encoded, 2)).toBe(7n);
    expect(() => uintAt(encoded, 3)).toThrow(RangeError);
  });
});
