import { describe, expect, it } from "vitest";
import { CENT, formatUsdc, parseBaseUnits, roundDownToCents, roundUpToCents } from "../src/rounding.js";

describe("rounding", () => {
  it("capacity rounds down to the cent", () => {
    expect(CENT).toBe(10_000n);
    expect(roundDownToCents(1_234_567n)).toBe(1_230_000n);
    expect(roundDownToCents(1_230_000n)).toBe(1_230_000n);
    expect(roundDownToCents(9_999n)).toBe(0n);
    expect(roundDownToCents(0n)).toBe(0n);
    expect(roundDownToCents(1_835_157_225n)).toBe(1_835_150_000n);
    expect(() => roundDownToCents(-1n)).toThrow(/negative/);
  });

  it("charges round up to the cent", () => {
    expect(roundUpToCents(0n)).toBe(0n);
    expect(roundUpToCents(1n)).toBe(10_000n);
    expect(roundUpToCents(9_999n)).toBe(10_000n);
    expect(roundUpToCents(10_000n)).toBe(10_000n);
    expect(roundUpToCents(1_230_001n)).toBe(1_240_000n);
    expect(() => roundUpToCents(-5n)).toThrow(/negative/);
  });

  it("formats six decimals without exponents", () => {
    expect(formatUsdc(0n)).toBe("0.000000");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(1_234_567n)).toBe("1.234567");
    expect(formatUsdc(10_000_000n)).toBe("10.000000");
    expect(formatUsdc(123_456_789_012_345_678n)).toBe("123456789012.345678");
  });

  it("parses base units strictly", () => {
    expect(parseBaseUnits("123")).toBe(123n);
    expect(parseBaseUnits("0")).toBe(0n);
    expect(parseBaseUnits(12)).toBe(12n);
    expect(parseBaseUnits(7n)).toBe(7n);
    expect(parseBaseUnits("-1")).toBeNull();
    expect(parseBaseUnits("1.5")).toBeNull();
    expect(parseBaseUnits(1.5)).toBeNull();
    expect(parseBaseUnits("")).toBeNull();
    expect(parseBaseUnits("1e6")).toBeNull();
    expect(parseBaseUnits(null)).toBeNull();
    expect(parseBaseUnits(undefined)).toBeNull();
    expect(parseBaseUnits(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
  });
});
