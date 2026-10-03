import { describe, expect, it } from "vitest";
import { STALE_AFTER_SECONDS, buildSnapshot, shapePool } from "../src/snapshot.js";
import { NOW, calendar, pool, reads, token } from "./fixtures.js";

describe("shapePool", () => {
  it("prices the AAPLc pool from slot0 and the 1h observation", () => {
    const p = shapePool(pool());
    expect(p.spot).toBeGreaterThan(333);
    expect(p.spot).toBeLessThan(334.5);
    expect(p.twap).not.toBeNull();
    expect(p.twap as number).toBeCloseTo(333.6, 0);
    expect(p.price36?.toString().length).toBe(37); // 3.3e36
  });
  it("returns no TWAP without history", () => {
    const p = shapePool(pool({ tickCumulatives: null }));
    expect(p.twap).toBeNull();
    expect(p.price36).toBeNull();
  });
});

describe("buildSnapshot on a frozen weekend", () => {
  const amzn = token({ symbol: "AMZNc", address: "0xb200000000000000000000d9192b6B456483C2E8", feedAnswer: 21500000000n });
  const s = buildSnapshot(reads([token(), amzn], [pool()]), calendar("WEEKEND"), NOW);

  it("carries block, session and the last feed print", () => {
    expect(s.block).toBe(52117568);
    expect(s.session.state).toBe("WEEKEND");
    expect(s.session.isFeedLive).toBe(false);
    expect(s.session.lastFeedUpdateAt).toBe(1790959199);
    expect(s.session.nextTransition.at).toBe(1791158400);
  });

  it("shapes the AAPLc row with price, age, divergence and the reopen gap", () => {
    const a = s.tokens[0]!;
    expect(a.symbol).toBe("AAPLc");
    expect(a.feedPrice).toBeCloseTo(333.66495, 5);
    expect(a.feedAgeSeconds).toBe(65284);
    expect(a.feedLive).toBe(false);
    expect(a.feedFrozen).toBe(true);
    expect(a.dexTwap1h).not.toBeNull();
    expect(a.divergenceBps).not.toBeNull();
    expect(Math.abs(a.divergenceBps as number)).toBeLessThan(20);
    expect(a.gapAtReopenBps).toBe(a.divergenceBps);
    expect(a.pool).toBe(pool().pool);
    expect(a.scheduledAction).toBeNull();
    expect(a.effectiveAt).toBeNull();
  });

  it("leaves DEX fields null for a token without a pool", () => {
    const b = s.tokens[1]!;
    expect(b.symbol).toBe("AMZNc");
    expect(b.dexPrice).toBeNull();
    expect(b.dexTwap1h).toBeNull();
    expect(b.divergenceBps).toBeNull();
    expect(b.gapAtReopenBps).toBeNull();
    expect(b.feedPrice).toBe(215);
  });
});

describe("buildSnapshot in session", () => {
  it("reports no reopen gap while the feed is live and fresh", () => {
    const fresh = token({ feedUpdatedAt: BigInt(NOW - 120) });
    const s = buildSnapshot(reads([fresh], [pool()]), calendar("REGULAR"), NOW);
    const a = s.tokens[0]!;
    expect(a.feedLive).toBe(true);
    expect(a.feedFrozen).toBe(false);
    expect(a.gapAtReopenBps).toBeNull();
    expect(a.divergenceBps).not.toBeNull();
  });

  it("marks a feed stale inside a session once it passes heartbeat + tolerance", () => {
    const stale = token({ feedUpdatedAt: BigInt(NOW - STALE_AFTER_SECONDS - 1) });
    const s = buildSnapshot(reads([stale], []), calendar("REGULAR"), NOW);
    expect(s.tokens[0]!.feedFrozen).toBe(true);
  });

  it("surfaces a scheduled corporate action with its ratio", () => {
    const split = token({ newUIMultiplier: 2n * 10n ** 18n, effectiveAt: BigInt(NOW + 86400) });
    const s = buildSnapshot(reads([split], []), calendar("REGULAR"), NOW);
    expect(s.tokens[0]!.scheduledAction).toEqual({ newUIMultiplier: 2, effectiveAt: NOW + 86400, ratio: 2 });
  });

  it("names paused features and keeps read errors", () => {
    const paused = token({ transferPaused: true, pausedFeatures: [0, 3], errors: ["effectiveAt"] });
    const s = buildSnapshot(reads([paused], []), calendar("POST"), NOW);
    expect(s.tokens[0]!.pausedFeatures).toEqual(["TRANSFER", "SEIZE"]);
    expect(s.tokens[0]!.transferPaused).toBe(true);
    expect(s.tokens[0]!.readErrors).toEqual(["effectiveAt"]);
  });
});
