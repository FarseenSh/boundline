import { describe, expect, it } from "vitest";
import { ERC8021_MARKER, appendDataSuffix, buildSendCalls, builderCodeSuffix, walletSendCallsParams } from "../src/sendcalls.js";

const call = { to: "0x39aBaDc0aAa12D1F7e259b89536Aa1848997399a", data: "0x12345678", value: 0n } as const;

describe("ERC-8021 builder code suffix (schema 0)", () => {
  it("matches Base's worked example for \"baseapp\"", () => {
    expect(builderCodeSuffix("baseapp")).toBe("0x62617365617070070080218021802180218021802180218021");
    expect(builderCodeSuffix(["baseapp"])).toBe(builderCodeSuffix("baseapp"));
  });
  it("joins several codes with a comma and counts bytes", () => {
    // "ab,cd" = 0x61622c6364, 5 bytes
    expect(builderCodeSuffix(["ab", "cd"])).toBe(`0x61622c63640500${ERC8021_MARKER.slice(2)}`);
  });
  it("rejects bad codes", () => {
    expect(() => builderCodeSuffix([])).toThrow();
    expect(() => builderCodeSuffix("has,comma")).toThrow();
    expect(() => builderCodeSuffix("spa ce")).toThrow();
    expect(() => builderCodeSuffix("x".repeat(256))).toThrow();
  });
  it("appends to calldata", () => {
    expect(appendDataSuffix("0xabcd", "0x0102")).toBe("0xabcd0102");
  });
});

describe("buildSendCalls", () => {
  it("carries only the capabilities that were given", () => {
    const plain = buildSendCalls([call], { chainId: 84532 });
    expect(plain.capabilities).toBeUndefined();
    expect(plain.forceAtomic).toBe(true);
    expect(plain.chainId).toBe(84532);
    const sponsored = buildSendCalls([call], { chainId: 84532, paymasterUrl: "https://proxy/paymaster", builderCode: "boundline" });
    expect(sponsored.capabilities).toEqual({ paymasterService: { url: "https://proxy/paymaster" }, dataSuffix: builderCodeSuffix("boundline") });
    expect(buildSendCalls([call], { chainId: 84532, atomicRequired: false }).forceAtomic).toBe(false);
    expect(() => buildSendCalls([], { chainId: 84532 })).toThrow(/no calls/);
  });
  it("renders the raw EIP-5792 body", () => {
    const body = walletSendCallsParams(buildSendCalls([{ ...call, value: 1n }], { chainId: 84532, builderCode: "boundline" }), "0xB789aD318945B37566E2549F65526Cc269a482Fc");
    expect(body.version).toBe("2.0.0");
    expect(body.chainId).toBe("0x14a34");
    expect(body.atomicRequired).toBe(true);
    expect(body.calls).toEqual([{ to: call.to, data: call.data, value: "0x1" }]);
    expect(body.capabilities?.dataSuffix).toBe(builderCodeSuffix("boundline"));
  });
});
