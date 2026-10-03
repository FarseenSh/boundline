import { describe, expect, it } from "vitest";
import {
  answerToNumber,
  divergenceBps,
  feedAgeSeconds,
  getSqrtRatioAtTick,
  price36ToHuman,
  sqrtPriceToPrice36,
  tickToPrice36,
  twapTick,
} from "../src/math.js";

describe("getSqrtRatioAtTick", () => {
  it("matches the Uniswap reference values", () => {
    expect(getSqrtRatioAtTick(0)).toBe(2n ** 96n);
    expect(getSqrtRatioAtTick(-887272)).toBe(4295128739n);
    expect(getSqrtRatioAtTick(887272)).toBe(1461446703485210103287273052203988822378723970342n);
  });
  it("rejects out-of-range ticks", () => {
    expect(() => getSqrtRatioAtTick(887273)).toThrow(RangeError);
    expect(() => getSqrtRatioAtTick(1.5)).toThrow(RangeError);
  });
});

describe("tickToPrice36", () => {
  it("prices AAPLc (token1, 8 dec) in USDC (token0, 6 dec) at the live tick from 3 Oct 2026", () => {
    // slot0 tick was -12047 while the feed printed 333.66; 1.0001^-12047 ≈ 0.29981 raw AAPLc per raw USDC
    const p = tickToPrice36(-12047, true);
    const human = price36ToHuman(p, 8, 6);
    expect(human).toBeGreaterThan(333);
    expect(human).toBeLessThan(334.2);
  });
  it("agrees with sqrtPriceToPrice36 at the same tick", () => {
    const tick = -12047;
    const a = tickToPrice36(tick, true);
    const b = sqrtPriceToPrice36(getSqrtRatioAtTick(tick), true);
    expect(a).toBe(b);
  });
  it("is $100 per share at tick 0: 1e36 is $100 for 8-dec collateral against 6-dec USDC", () => {
    // tick 0 => 1 raw token1 per raw token0 => price36 = 1e36 => 1e8 raw shares buy 1e8 raw USDC = $100
    expect(tickToPrice36(0, false)).toBe(10n ** 36n);
    expect(price36ToHuman(tickToPrice36(0, false), 8, 6)).toBeCloseTo(100, 9);
  });
});

describe("twapTick", () => {
  it("floors toward negative infinity like the pool", () => {
    expect(twapTick([0n, -7n], 2)).toBe(-4);
    expect(twapTick([0n, 7n], 2)).toBe(3);
    expect(twapTick([0n, -8n], 2)).toBe(-4);
  });
  it("reproduces the live 1h observation from 3 Oct 2026", () => {
    const tick = twapTick([-99140738406n, -99184115416n], 3600);
    expect(tick).toBe(-12050); // -43377010 / 3600 = -12049.17 -> floor -12050
    expect(price36ToHuman(tickToPrice36(tick, true), 8, 6)).toBeCloseTo(333.6, 0);
  });
});

describe("divergence and age", () => {
  it("computes signed basis points", () => {
    expect(divergenceBps(340.23, 341.513)).toBeCloseTo(-37.57, 1);
    expect(divergenceBps(100, 100)).toBe(0);
    expect(Number.isNaN(divergenceBps(1, 0))).toBe(true);
  });
  it("never reports a negative age", () => {
    expect(feedAgeSeconds(1790959199n, 1791024483)).toBe(65284);
    expect(feedAgeSeconds(100n, 50)).toBe(0);
  });
  it("converts 8-decimal answers", () => {
    expect(answerToNumber(33366495000n)).toBeCloseTo(333.66495, 8);
  });
});
