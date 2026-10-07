import { decodeAbiParameters, encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { PROTECTOR_SELECTOR, decodeSizing, encodeSizing } from "../src/raw.js";
import { PRE_LIQ, USER, encodeSizingReturn } from "./helpers.js";

const abi = parseAbi(["function sizing(address preLiq, address borrower, uint256 targetLtvWad)"]);

describe("raw Protector encoding", () => {
  it("matches viem's selector and calldata for sizing()", () => {
    expect(toFunctionSelector("sizing(address,address,uint256)")).toBe(PROTECTOR_SELECTOR.sizing);
    const target = 580_000_000_000_000_000n;
    expect(encodeSizing(PRE_LIQ, USER, target)).toBe(encodeFunctionData({ abi, functionName: "sizing", args: [PRE_LIQ, USER, target] }).toLowerCase());
  });

  it("decodes the 18-word Sizing the way viem does", () => {
    const data = encodeSizingReturn({ standing: 3n, maxSeizedAssets: 52_273n, maxRepaidAssets: 171_377n, fullCloseAllowed: true });
    const s = decodeSizing(data);
    const words = decodeAbiParameters(Array.from({ length: 18 }, () => ({ type: "uint256" })), data);
    expect(s.standing).toBe("IN_BAND");
    expect(s.collateral).toBe(words[1]);
    expect(s.debtAssets).toBe(words[3]);
    expect(s.shadowPrice36).toBe(words[4]);
    expect(s.venueOracleLive).toBe(true);
    expect(s.maxSeizedAssets).toBe(52_273n);
    expect(s.maxRepaidAssets).toBe(171_377n);
    expect(s.fullCloseAllowed).toBe(true);
    expect(() => decodeSizing("0x1234")).toThrow(/expected 18 words/);
    expect(() => decodeSizing(encodeSizingReturn({ standing: 9n }))).toThrow(/unknown standing/);
  });
});
