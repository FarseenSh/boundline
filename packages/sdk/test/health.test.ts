import { wallClockToEpoch } from "@boundline/calendar";
import { describe, expect, it } from "vitest";
import { computeHealth } from "../src/health.js";
import type { Quote } from "../src/reads.js";

const LLTV = 625_000_000_000_000_000n;
const base: Quote = {
  reason: "NONE",
  reasonCode: 0,
  session: "REGULAR",
  sessionCode: 2,
  price8: 33_267_000_000n,
  collateralRaw: 1_000_000_000n, // 10 shares
  collateralValue: 3_326_700_000n, // $3,326.70
  debt: 0n,
  maxDebt: 1_663_350_000n,
  available: 1_663_350_000n,
  effectiveMaxLtvWad: 500_000_000_000_000_000n,
  corporateActionHaircut: false,
};
const q = (over: Partial<Quote>): Quote => ({ ...base, ...over });
const SAT_NOON = wallClockToEpoch(2026, 10, 10, 12 * 60);

describe("computeHealth", () => {
  it("no debt in session", () => {
    const h = computeHealth({ quote: base, lltvWad: LLTV });
    expect(h.state).toBe("no_debt");
    expect(h.gateOpen).toBe(true);
    expect(h.headline).toBe("Borrow up to $1,663.35");
    expect(h.copy).toContain("50% of your collateral");
    expect(h.copy).toContain("62.5%");
    expect(h.policyMaxLtv).toBeCloseTo(0.5);
    expect(h.lltv).toBeCloseTo(0.625);
  });
  it("healthy, watch, near limit, over policy, liquidatable", () => {
    expect(computeHealth({ quote: q({ debt: 500_000_000n }), lltvWad: LLTV }).state).toBe("healthy");
    const watch = computeHealth({ quote: q({ debt: 1_250_000_000n }), lltvWad: LLTV });
    expect(watch.state).toBe("watch");
    expect(watch.usedOfPolicy).toBeCloseTo(0.75, 2);
    expect(computeHealth({ quote: q({ debt: 1_600_000_000n }), lltvWad: LLTV }).state).toBe("near_limit");
    const over = computeHealth({ quote: q({ debt: 1_800_000_000n, available: 0n, reason: "INSUFFICIENT_CAPACITY", reasonCode: 18 }), lltvWad: LLTV });
    expect(over.state).toBe("over_policy");
    expect(over.gateOpen).toBe(true);
    expect(over.copy).toContain("Repay or add collateral");
    const liq = computeHealth({ quote: q({ debt: 2_200_000_000n, available: 0n }), lltvWad: LLTV });
    expect(liq.state).toBe("liquidatable");
    expect(liq.headline).toBe("Above the liquidation threshold");
  });
  it("weekend: closed until Sunday 20:00 ET, repay and collateral stay open", () => {
    const h = computeHealth({ quote: q({ reason: "MARKET_CLOSED", reasonCode: 6, session: "WEEKEND", sessionCode: 5, price8: 0n, available: 0n, debt: 500_000_000n }), lltvWad: LLTV, now: SAT_NOON });
    expect(h.gateOpen).toBe(false);
    expect(h.closedUntil).toBe(wallClockToEpoch(2026, 10, 11, 20 * 60));
    expect(h.headline).toBe("Protected while Wall Street is closed");
    expect(h.copy.startsWith("Wall Street is closed until Sun 11 Oct, 20:00 ET. Repay and add collateral stay open; draws and liquidations resume at the reopen.")).toBe(true);
  });
  it("stale feed and keeper hold are closed gates with their own words", () => {
    const stale = computeHealth({ quote: q({ reason: "FEED_STALE", reasonCode: 9, available: 0n }), lltvWad: LLTV });
    expect(stale.gateOpen).toBe(false);
    expect(stale.copy).toContain("has not printed for over a day");
    const held = computeHealth({ quote: q({ reason: "LINE_HELD", reasonCode: 3, available: 0n }), lltvWad: LLTV });
    expect(held.gateOpen).toBe(false);
    expect(held.copy).toContain("keeper");
  });
  it("no collateral", () => {
    const h = computeHealth({ quote: q({ collateralRaw: 0n, collateralValue: 0n, maxDebt: 0n, available: 0n }), lltvWad: LLTV });
    expect(h.state).toBe("no_collateral");
    expect(h.ltv).toBeNull();
  });
});
