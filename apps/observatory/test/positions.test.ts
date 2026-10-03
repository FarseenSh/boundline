import { describe, expect, it } from "vitest";
import { SCAN_ARCHIVE_DEPTH, SCAN_CALLS_PER_TICK, SCAN_SPAN, chunks, parsePositionsDiscovery, planScan, shapePosition, toAssetsUp } from "../src/positions.js";

const MARKET = "0xae1a30486234bf7e7ac166c7c03d9bc5f2cd8a39be2c48e73c665ac7148c3c28";
const USER = "0x1111111111111111111111111111111111111111";
const PRICE_333 = 333_66495000n * 10n ** 26n; // $333.66495 in Morpho's 36 scale for 8-dec vs 6-dec

describe("toAssetsUp", () => {
  it("matches Morpho's virtual-share rounding", () => {
    expect(toAssetsUp(0n, 100n, 100n)).toBe(0n);
    // 1 share of a market with 1e6 virtual shares and 1 virtual asset
    expect(toAssetsUp(1n, 0n, 0n)).toBe(1n);
    // proportional, rounded up
    expect(toAssetsUp(10n ** 12n, 2_000_000n, 2n * 10n ** 12n)).toBe(1_000_000n);
    expect(toAssetsUp(3n, 10n, 7n)).toBe(1n); // 3*11/(7+1e6) rounds up to 1
  });
});

describe("shapePosition", () => {
  const base = {
    chainId: 8453,
    marketId: MARKET as `0x${string}`,
    address: USER as `0x${string}`,
    collateralSymbol: "AAPLc",
    lltv: 0.625,
    collateral: 10n * 10n ** 8n, // 10 shares
    borrowShares: 1_500n * 10n ** 12n,
    totalBorrowAssets: 3_000n * 10n ** 6n,
    totalBorrowShares: 3_000n * 10n ** 12n,
    venuePrice36: PRICE_333,
    shadowPrice36: PRICE_333,
    blockNumber: 52_200_000,
    takenAt: 1791158400,
  };

  it("computes debt, prices and health at both prices", () => {
    const p = shapePosition(base);
    expect(p.debtAssets).toBe("1500000000"); // 1,500 USDC: 1.5e15 shares of 3e15 against 3,000 USDC, virtual offsets included
    expect(p.venuePrice).toBeCloseTo(333.66495, 5);
    expect(p.shadowPrice).toBeCloseTo(333.66495, 5);
    // 10 shares * 333.66 * 0.625 / 1500 = 1.39
    expect(p.venueHf).toBeCloseTo(1.39, 2);
    expect(p.shadowHf).toBeCloseTo(1.39, 2);
    expect(p.protectionCase).toBe(false);
  });

  it("flags the protection case: healthy at the held venue price, under water at the DEX TWAP", () => {
    const crashed = 230n * 10n ** 34n; // $230
    const p = shapePosition({ ...base, shadowPrice36: crashed });
    expect(p.venueHf).toBeGreaterThan(1);
    expect(p.shadowHf).toBeLessThan(1);
    expect(p.protectionCase).toBe(true);
  });

  it("leaves health null with no debt, and shadow null without a pool", () => {
    const noDebt = shapePosition({ ...base, borrowShares: 0n });
    expect(noDebt.debtAssets).toBe("0");
    expect(noDebt.venueHf).toBeNull();
    expect(noDebt.shadowHf).toBeNull();
    expect(noDebt.protectionCase).toBe(false);
    const noPool = shapePosition({ ...base, shadowPrice36: null });
    expect(noPool.shadowPrice).toBeNull();
    expect(noPool.shadowHf).toBeNull();
    expect(noPool.venueHf).not.toBeNull();
    const noOracle = shapePosition({ ...base, venuePrice36: null });
    expect(noOracle.venueHf).toBeNull();
    expect(noOracle.protectionCase).toBe(false);
  });
});

describe("planScan", () => {
  const head = 52_200_000;

  it("starts one span behind the head on the first run and stops one block short of the head", () => {
    expect(planScan(null, head)).toEqual({ from: head - SCAN_SPAN, to: head - 1, skippedFrom: null });
  });

  it("advances from the cursor by at most calls × span", () => {
    const plan = planScan(head - 10_000 + 5_000, head);
    expect(plan).toEqual({ from: head - 4_999, to: head - 4_999 + SCAN_SPAN * SCAN_CALLS_PER_TICK - 1, skippedFrom: null });
    expect(chunks(plan!)).toHaveLength(SCAN_CALLS_PER_TICK);
    expect(chunks(plan!)[0]).toEqual({ from: plan!.from, to: plan!.from + SCAN_SPAN - 1 });
  });

  it("returns nothing when the cursor already touches the head", () => {
    expect(planScan(head - 1, head)).toBeNull();
    expect(planScan(head, head)).toBeNull();
  });

  it("jumps forward past the archive cutoff and reports the gap", () => {
    const plan = planScan(head - 50_000, head);
    expect(plan?.skippedFrom).toBe(head - 50_000 + 1);
    expect(plan?.from).toBe(head - SCAN_ARCHIVE_DEPTH);
  });
});

describe("parsePositionsDiscovery", () => {
  it("keeps borrowers on the wanted markets only", () => {
    const body = {
      data: {
        marketPositions: {
          items: [
            { user: { address: USER }, market: { marketId: MARKET.toUpperCase().replace("0X", "0x") }, state: { borrowShares: "5", collateral: "1" } },
            { user: { address: "0x2222222222222222222222222222222222222222" }, market: { marketId: MARKET }, state: { borrowShares: "0", collateral: "9" } },
            { user: { address: "0x3333333333333333333333333333333333333333" }, market: { marketId: "0x01" }, state: { borrowShares: "7", collateral: "1" } },
            { user: { address: "0x4444444444444444444444444444444444444444" }, market: { marketId: MARKET }, state: null },
          ],
        },
      },
    };
    const out = parsePositionsDiscovery(body, new Set([MARKET]), 52_200_000);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ chainId: 8453, marketId: MARKET, address: USER, firstSeenBlock: 52_200_000, source: "api" });
    expect(parsePositionsDiscovery({}, new Set([MARKET]), 1)).toEqual([]);
  });
});
