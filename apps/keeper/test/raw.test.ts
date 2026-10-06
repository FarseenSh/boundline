import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, toFunctionSelector, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  MULTICALL3,
  SELECTOR,
  decodeAggregate3,
  decodeLatestRoundData,
  decodeOracleParams,
  describeRevert,
  encodeAggregate3,
  encodeGetOracleParams,
  encodeSetOracleParams,
  encodeSetRoundData,
  hexToBigInt,
  toInt256,
  word,
} from "../src/raw.js";

const aggregate3Abi = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "returnData", type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }],
  },
] as const;

const FEED: Address = "0x787f13dEa48Db0897CbCDD985de77809D837F988";
const REGISTRY: Address = "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD";
const TOKEN: Address = "0xb200000000000000000000C2e324d24d7eEcd1fb";

describe("selectors", () => {
  it("match the function signatures", () => {
    expect(SELECTOR.aggregate3).toBe(toFunctionSelector("aggregate3((address,bool,bytes)[])"));
    expect(SELECTOR.latestRoundData).toBe(toFunctionSelector("latestRoundData()"));
    expect(SELECTOR.getOracleParams).toBe(toFunctionSelector("getOracleParams(address)"));
    expect(SELECTOR.setRoundData).toBe(toFunctionSelector("setRoundData(uint80,int256,uint256,uint256,uint80)"));
    expect(SELECTOR.setOracleParams).toBe(toFunctionSelector("setOracleParams(address,uint256,bool)"));
    expect(MULTICALL3).toBe("0xcA11bde05977b3631167028862bE2a173976CA11");
  });
});

describe("words", () => {
  it("encodes unsigned, boolean and negative values", () => {
    expect(word(0)).toBe("0".repeat(64));
    expect(word(true)).toBe(`${"0".repeat(63)}1`);
    expect(word(-1n)).toBe("f".repeat(64));
    expect(word(2n ** 255n)).toBe(`8${"0".repeat(63)}`);
    expect(() => word(2n ** 256n)).toThrow(RangeError);
  });
  it("round-trips int256", () => {
    expect(toInt256(hexToBigInt(`0x${word(-33_366_495_000n)}`))).toBe(-33_366_495_000n);
    expect(toInt256(hexToBigInt(`0x${word(33_366_495_000n)}`))).toBe(33_366_495_000n);
    expect(hexToBigInt("0x")).toBe(0n);
  });
});

describe("encodeAggregate3", () => {
  it("equals viem's encoding for a mixed call list", () => {
    const calls = [
      { target: FEED, allowFailure: true, callData: SELECTOR.latestRoundData as Hex },
      { target: REGISTRY, allowFailure: true, callData: encodeGetOracleParams(TOKEN) },
      { target: FEED, allowFailure: false, callData: "0x" as Hex },
      { target: TOKEN, allowFailure: true, callData: "0x0102030405" as Hex },
    ];
    const expected = encodeFunctionData({ abi: aggregate3Abi, functionName: "aggregate3", args: [calls] });
    expect(encodeAggregate3(calls).toLowerCase()).toBe(expected.toLowerCase());
  });
  it("encodes an empty list like viem", () => {
    const expected = encodeFunctionData({ abi: aggregate3Abi, functionName: "aggregate3", args: [[]] });
    expect(encodeAggregate3([]).toLowerCase()).toBe(expected.toLowerCase());
  });
});

describe("decodeAggregate3", () => {
  const results = [
    { success: true, returnData: encodeAbiParameters([{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }], [36893488147419103518n, 33267000000n, 1791223116n, 1791223131n, 36893488147419103518n]) },
    { success: true, returnData: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [1000537939576369481n, true]) },
    { success: false, returnData: "0x08c379a0" as Hex },
    { success: false, returnData: "0x" as Hex },
  ];
  const encoded = encodeAbiParameters([{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }], [results]);

  it("decodes what viem encodes", () => {
    const out = decodeAggregate3(encoded);
    expect(out).toEqual(results);
    // and the inner payloads decode to the typed values
    expect(decodeLatestRoundData(out[0]!.returnData)).toEqual({ roundId: 36893488147419103518n, answer: 33267000000n, startedAt: 1791223116n, updatedAt: 1791223131n, answeredInRound: 36893488147419103518n });
    expect(decodeOracleParams(out[1]!.returnData)).toEqual({ multiplier: 1000537939576369481n, paused: true });
    expect(describeRevert(out[2]!.returnData)).toBe("reverted 0x08c379a0");
    expect(describeRevert(out[3]!.returnData)).toBe("reverted without data");
  });
  it("agrees with viem's decoder on the same bytes", () => {
    const viaViem = decodeAbiParameters([{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }], encoded)[0];
    expect(decodeAggregate3(encoded)).toEqual(viaViem.map((r) => ({ success: r.success, returnData: r.returnData })));
  });
  it("rejects truncated data", () => {
    expect(() => decodeAggregate3("0x")).toThrow(/empty/);
    expect(() => decodeAggregate3(`0x${encoded.slice(2, 2 + 64 * 3)}`)).toThrow();
    expect(() => decodeLatestRoundData("0x1234")).toThrow(/5 words/);
    expect(() => decodeOracleParams(`0x${"0".repeat(64)}`)).toThrow(/2 words/);
  });
  it("decodes a negative answer", () => {
    const neg = encodeAbiParameters([{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }], [1n, -5n, 2n, 3n, 1n]);
    expect(decodeLatestRoundData(neg).answer).toBe(-5n);
  });
});

describe("setter calldata", () => {
  const setRoundDataAbi = [{ type: "function", name: "setRoundData", stateMutability: "nonpayable", inputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }], outputs: [] }] as const;
  const setOracleParamsAbi = [{ type: "function", name: "setOracleParams", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "bool" }], outputs: [] }] as const;
  it("setRoundData equals viem", () => {
    const args = [36893488147419103731n, 24123750142n, 1791284868n, 1791284883n, 36893488147419103731n] as const;
    expect(encodeSetRoundData(args)).toBe(encodeFunctionData({ abi: setRoundDataAbi, functionName: "setRoundData", args: [...args] }));
  });
  it("setOracleParams equals viem", () => {
    expect(encodeSetOracleParams(TOKEN, 10n ** 18n, false).toLowerCase()).toBe(encodeFunctionData({ abi: setOracleParamsAbi, functionName: "setOracleParams", args: [TOKEN, 10n ** 18n, false] }).toLowerCase());
    expect(encodeSetOracleParams(TOKEN, 2n * 10n ** 18n, true).toLowerCase()).toBe(encodeFunctionData({ abi: setOracleParamsAbi, functionName: "setOracleParams", args: [TOKEN, 2n * 10n ** 18n, true] }).toLowerCase());
  });
});
