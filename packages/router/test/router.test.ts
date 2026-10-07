import { describe, expect, it } from "vitest";
import { canonicalRoutePlan, collateralValue, compareLegs, haircut, route, routePlanTypedData, WAD, type PartnerPolicy, type RouteRequest, type VenueCandidate } from "../src/index.js";

const USDC = 6;
const STOCK = 8;
const P336 = 33_628_499_999n; // AAPLc on 7 Oct 2026, 8 decimals
const POLICY: PartnerPolicy = { allowed: true, maxLtvWad: (WAD * 55n) / 100n, minDraw: 1_000_000n, maxDraw: 0n, exposureHeadroom: 10_000_000_000n };

function morpho(over: Partial<VenueCandidate> = {}): VenueCandidate {
  return {
    venue: "morpho",
    chainId: 84532,
    marketId: "0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047",
    collateral: "AAPLt",
    collateralDecimals: STOCK,
    loanDecimals: USDC,
    borrowRateWad: (WAD * 6n) / 100n, // 6% APR
    lltvWad: (WAD * 625n) / 1000n,
    availableLiquidity: 7_000_000n,
    protection: "pre-liquidation",
    gate: "OPEN",
    feedPrice8: P336,
    twapPrice8: P336 - 50_000_000n,
    pricesAroundTheClock: false,
    ...over,
  };
}

function aave(over: Partial<VenueCandidate> = {}): VenueCandidate {
  return {
    venue: "aave",
    chainId: 8453,
    marketId: "7",
    collateral: "AAPLt",
    collateralDecimals: STOCK,
    loanDecimals: USDC,
    borrowRateWad: (WAD * 5n) / 100n, // 5% APR, cheaper
    lltvWad: (WAD * 78n) / 100n,
    availableLiquidity: 1_000_000_000_000n,
    protection: "vault",
    gate: "OPEN",
    feedPrice8: P336,
    twapPrice8: P336 - 50_000_000n,
    pricesAroundTheClock: true,
    ...over,
  };
}

function req(over: Partial<RouteRequest> = {}): RouteRequest {
  return { user: "0xB789aD318945B37566E2549F65526Cc269a482Fc", collateral: "AAPLt", collateralAmount: 1_000_000_000n, collateralDecimals: STOCK, amount: 5_000_000n, policy: POLICY, now: 1_791_380_000, ...over };
}

describe("maths", () => {
  it("values collateral in loan units, rounding down", () => {
    // 10 AAPLt × $336.28499999 = $3,362.8499999 → 3,362.849999 USDC
    expect(collateralValue(1_000_000_000n, STOCK, P336, USDC)).toBe(3_362_849_999n);
    expect(collateralValue(0n, STOCK, P336, USDC)).toBe(0n);
  });
  it("haircuts in bps", () => {
    expect(haircut(10_000n, 200)).toBe(9_800n);
    expect(() => haircut(1n, 10_001)).toThrow();
  });
});

describe("route", () => {
  it("picks the cheaper protected venue and sizes the leg at min(policy, LLTV)", () => {
    const plan = route(req(), [morpho(), aave()]);
    expect(plan.chosen?.venue).toBe("aave");
    expect(plan.chosen?.amount).toBe(5_000_000n);
    expect(plan.chosen?.maxLtvWad).toBe(POLICY.maxLtvWad); // 55% < 78%
    expect(plan.chosen?.capacity).toBe((3_362_849_999n * POLICY.maxLtvWad) / WAD);
    expect(plan.alternatives.map((l) => l.venue)).toEqual(["morpho"]);
    expect(plan.reasonCodes).toEqual(["ROUTED"]);
    expect(plan.validUntil).toBe(plan.createdAt + 120);
  });

  it("prefers protection over rate, unless told otherwise", () => {
    const cheapUnprotected = aave({ protection: "none", borrowRateWad: WAD / 100n });
    expect(route(req(), [morpho(), cheapUnprotected]).chosen?.venue).toBe("morpho");
    expect(route(req({ preferProtection: false }), [morpho(), cheapUnprotected]).chosen?.venue).toBe("aave");
  });

  it("rejects a SessionGuard market while closed with the gate's reason and keeps the record", () => {
    const plan = route(req(), [morpho({ gate: "MARKET_CLOSED" }), aave({ gate: "FEED_STALE" })]);
    expect(plan.chosen).toBeNull();
    expect(plan.reasonCodes).toEqual(["NO_ROUTE"]);
    expect(plan.rejected).toEqual([
      { venue: "morpho", marketId: morpho().marketId, reason: "MARKET_CLOSED" },
      { venue: "aave", marketId: "7", reason: "FEED_STALE" },
    ]);
  });

  it("Saturday mode: half capacity at min(held, TWAP) less the haircut, only on around-the-clock venues", () => {
    const sat = { enabled: true, haircutBps: 300 };
    const plan = route(req({ saturdayMode: sat, amount: 2_000_000_000n }), [morpho({ gate: "MARKET_CLOSED" }), aave({ gate: "MARKET_CLOSED" })]);
    expect(plan.chosen?.venue).toBe("aave");
    expect(plan.chosen?.session).toBe("saturday");
    expect(plan.chosen?.priceSource).toBe("twap-haircut");
    const price = haircut(P336 - 50_000_000n, 300);
    expect(plan.chosen?.price8).toBe(price);
    const value = collateralValue(1_000_000_000n, STOCK, price, USDC);
    expect(plan.chosen?.capacity).toBe((value * POLICY.maxLtvWad) / WAD / 2n);
    expect(plan.chosen?.notes).toContain("SATURDAY_HALF_CAPACITY");
    expect(plan.reasonCodes).toEqual(["ROUTED", "CAPACITY_LIMITED", "SATURDAY_MODE"]);
    // the SessionGuard market stays closed even with Saturday mode on
    expect(plan.rejected).toEqual([{ venue: "morpho", marketId: morpho().marketId, reason: "MARKET_CLOSED" }]);
    // and Saturday mode without a TWAP fails closed
    expect(route(req({ saturdayMode: sat }), [aave({ gate: "MARKET_CLOSED", twapPrice8: null })]).rejected[0]?.reason).toBe("NO_PRICE");
  });

  it("caps at liquidity, max draw and the partner's headroom, and says which bound bit", () => {
    const liq = route(req({ amount: 100_000_000n }), [morpho()]);
    expect(liq.chosen?.amount).toBe(7_000_000n);
    expect(liq.chosen?.notes).toEqual(expect.arrayContaining(["LIQUIDITY_LIMITED", "CAPACITY_LIMITED"]));
    const maxDraw = route(req({ amount: 100_000_000n, policy: { ...POLICY, maxDraw: 3_000_000n } }), [aave()]);
    expect(maxDraw.chosen?.amount).toBe(3_000_000n);
    const headroom = route(req({ amount: 100_000_000n, policy: { ...POLICY, exposureHeadroom: 2_000_000n } }), [aave()]);
    expect(headroom.chosen?.amount).toBe(2_000_000n);
    expect(headroom.chosen?.notes).toContain("PARTNER_CAP_LIMITED");
    expect(route(req(), [aave()], ).chosen?.ltvWad).toBe((5_000_000n * WAD) / 3_362_849_999n);
  });

  it("fails closed on a disallowed ticker, a zero headroom, a tiny draw and a missing price", () => {
    expect(route(req({ policy: { ...POLICY, allowed: false } }), [aave()]).rejected[0]?.reason).toBe("TICKER_NOT_ALLOWED");
    expect(route(req({ policy: { ...POLICY, exposureHeadroom: 0n } }), [aave()]).rejected[0]?.reason).toBe("PARTNER_CAP");
    expect(route(req({ collateralAmount: 100n }), [aave()]).rejected[0]?.reason).toBe("BELOW_MIN_DRAW");
    expect(route(req(), [aave({ feedPrice8: null })]).rejected[0]?.reason).toBe("NO_PRICE");
    expect(route(req(), [aave({ collateral: "NVDAt" })]).rejected[0]?.reason).toBe("COLLATERAL_MISMATCH");
    expect(route(req(), [aave({ gate: "UNKNOWN" })]).rejected[0]?.reason).toBe("UNKNOWN_STATE");
    expect(() => route(req({ amount: 0n }), [aave()])).toThrow();
  });

  it("ranks deterministically: rate, then capacity, then venue order, then market id", () => {
    const a = route(req(), [morpho({ borrowRateWad: WAD / 10n }), aave({ borrowRateWad: WAD / 10n })]);
    expect(a.chosen?.venue).toBe("aave"); // larger capacity (78% LLTV does not matter: policy 55% both) → equal capacity? liquidity differs
    const m1 = morpho({ marketId: "0x01", borrowRateWad: WAD / 10n, availableLiquidity: 1_000_000_000n });
    const m2 = morpho({ marketId: "0x02", borrowRateWad: WAD / 10n, availableLiquidity: 1_000_000_000n });
    expect(route(req(), [m2, m1]).chosen?.marketId).toBe("0x01");
    expect(compareLegs(route(req(), [m1]).chosen!, route(req(), [m2]).chosen!)).toBeLessThan(0);
  });
});

describe("signing", () => {
  it("canonical JSON sorts keys and stringifies bigints, so two signers agree", () => {
    const plan = route(req(), [aave(), morpho()]);
    const s = canonicalRoutePlan(plan);
    expect(s).toContain('"requested":"5000000"');
    expect(s.indexOf('"alternatives"')).toBeLessThan(s.indexOf('"chosen"'));
    expect(canonicalRoutePlan(route(req(), [morpho(), aave()]))).toBe(s);
  });
  it("typed data carries the chosen leg and the reasons; refuses an unrouted plan", () => {
    const plan = route(req(), [aave(), morpho()]);
    const td = routePlanTypedData(plan, 84532, "0x0000000000000000000000000000000000000001");
    expect(td.domain).toEqual({ name: "Boundline Router", version: "1", chainId: 84532, verifyingContract: "0x0000000000000000000000000000000000000001" });
    expect(td.message.venue).toBe("aave");
    expect(td.message.amount).toBe(5_000_000n);
    expect(td.message.reasons).toBe("ROUTED,PROTECTED");
    expect(() => routePlanTypedData(route(req(), [aave({ gate: "MARKET_CLOSED" })]), 84532, "0x0000000000000000000000000000000000000001")).toThrow();
  });
});
