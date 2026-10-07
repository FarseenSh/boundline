import { describe, expect, it } from "vitest";
import { check, createLedger, event, LedgerError, reconcile, record, residuals, toJSON, type ProtectionEvent } from "../src/index.js";

// The 6 Oct 2026 Sepolia protection drill (deployments/base-sepolia.json, protection.drill.keeperAction):
// 1,000,000 raw AAPLt against 2.000001 USDC; the keeper's partial pre-liquidation seized 52,273 raw, the Protector
// sold enough on the MockSwapPool to repay 0.171377 USDC and kept 757 raw as the incentive; position after:
// 947,727 raw, 1.828624 USDC.
const drill = event({
  id: "sepolia-drill-2026-10-06",
  venue: "morpho",
  kind: "pre-liquidation",
  subject: "0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E",
  at: 1_791_293_000,
  reference: "0x982c7327efa9f0460b92501a4322ec5dc730e5faaca3ce1d87dc80f708dfb695",
  collateral: { in: 52_273n, sold: 52_273n - 757n, retained: 757n, remainingOnPosition: 947_727n },
  debt: { before: 2_000_001n, after: 1_828_624n, repaid: 171_377n },
  sources: { proceeds: 171_377n },
});

// The Aave fork proof (docs/CONTEXT.md §4.7): an 80 USDC Saturday repay through the live Giver, 50 from the user's
// reserve and 30 advanced at a 1% fee; then the user settles 30 of principal and the 0.3 fee.
const aaveRepay = event({
  id: "aave-fork-saturday-repay",
  venue: "aave",
  kind: "protective-repay",
  subject: "0xC9Bc5Cab29dC93A9D2ea16Ef38620598FAd5ca66",
  at: 1_791_640_800,
  collateral: { remainingOnPosition: 1_477_000_000n },
  debt: { before: 1_200_000_000n, after: 1_120_000_000n, repaid: 80_000_000n },
  sources: { fromUser: 50_000_000n, fromAdvance: 30_000_000n },
  reserve: { advanced: 30_000_000n, outstandingBefore: 0n, outstandingAfter: 30_000_000n },
});
const aaveSettle = event({
  id: "aave-fork-settlement",
  venue: "aave",
  kind: "settlement",
  subject: "0xC9Bc5Cab29dC93A9D2ea16Ef38620598FAd5ca66",
  at: 1_791_650_000,
  collateral: { remainingOnPosition: 1_477_000_000n },
  debt: { before: 1_120_000_000n, after: 1_120_000_000n, repaid: 0n },
  sources: { fromUser: 30_300_000n },
  fees: { advance: 300_000n },
  reserve: { settled: 30_000_000n, outstandingBefore: 30_000_000n, outstandingAfter: 0n },
});

describe("reconcile", () => {
  it("closes the 6 Oct Sepolia pre-liquidation exactly", () => {
    const r = reconcile(drill);
    expect(r.pass).toBe(true);
    expect(r.badDebt).toBe(0n);
    expect(r.equalities.map((q) => q.residual)).toEqual([0n, 0n, 0n, 0n, 1_828_624n]);
    expect(residuals(r)).toEqual({});
  });

  it("closes the Aave Saturday repay and its settlement", () => {
    expect(reconcile(aaveRepay).pass).toBe(true);
    expect(reconcile(aaveSettle).pass).toBe(true);
  });

  it("names the identity that fails and its residual", () => {
    const off = { ...drill, debt: { ...drill.debt, after: 1_828_625n } };
    const r = reconcile(off);
    expect(r.pass).toBe(false);
    expect(residuals(r)).toEqual({ debt: -1n });
    const leak = { ...drill, sources: { ...drill.sources, proceeds: 171_378n } };
    expect(residuals(reconcile(leak))).toEqual({ "sources-uses": 1n });
    const lostCollateral = { ...drill, collateral: { ...drill.collateral, sold: 51_000n } };
    expect(residuals(reconcile(lostCollateral))).toEqual({ collateral: 516n });
    const phantomAdvance = { ...aaveRepay, reserve: { ...aaveRepay.reserve, outstandingAfter: 31_000_000n } };
    expect(residuals(reconcile(phantomAdvance))).toEqual({ advance: -1_000_000n });
  });

  it("refuses an advance that is not booked as advance funding", () => {
    const r = reconcile({ ...aaveRepay, reserve: { ...aaveRepay.reserve, advanced: 20_000_000n, outstandingAfter: 20_000_000n } });
    expect(r.pass).toBe(false);
    expect(r.equalities.find((q) => q.id === "advance")?.holds).toBe(false);
  });

  it("bad debt is the remaining debt once the position holds no collateral, and never more", () => {
    const wipedOut = event({
      id: "liq",
      venue: "morpho",
      kind: "liquidation",
      subject: "0x1",
      at: 1,
      collateral: { in: 1_000n, sold: 1_000n, remainingOnPosition: 0n },
      debt: { before: 500n, after: 120n, repaid: 380n },
      sources: { fromLiquidator: 380n },
    });
    const r = reconcile(wipedOut);
    expect(r.pass).toBe(true);
    expect(r.badDebt).toBe(120n);
    const stillBacked = { ...wipedOut, collateral: { ...wipedOut.collateral, remainingOnPosition: 1n } };
    expect(reconcile(stillBacked).badDebt).toBe(0n);
  });

  it("rejects negative flows", () => {
    expect(reconcile({ ...drill, borrowerRemainder: -1n, sources: { ...drill.sources, proceeds: 171_376n } }).pass).toBe(false);
  });
});

describe("ledger", () => {
  it("keeps running totals and the ledger-wide identities", () => {
    const l = createLedger();
    record(l, drill);
    record(l, aaveRepay);
    record(l, aaveSettle, { strictChain: true });
    expect(l.totals.events).toBe(3);
    expect(l.totals.advanced).toBe(30_000_000n);
    expect(l.totals.settled).toBe(30_000_000n);
    expect(l.totals.outstanding).toBe(0n);
    expect(l.totals.fees).toBe(300_000n);
    expect(l.totals.collateralRetained).toBe(757n);
    const c = check(l);
    expect(c.pass).toBe(true);
    expect(c.advanceConservation).toEqual({ advanced: 30_000_000n, settled: 30_000_000n, outstandingBySubject: 0n, holds: true });
    expect(c.flowConservation.sources).toBe(171_377n + 80_000_000n + 30_300_000n);
    expect(l.subjects.get("aave:0xC9Bc5Cab29dC93A9D2ea16Ef38620598FAd5ca66")?.outstanding).toBe(0n);
    const json = toJSON(l) as { totals: { advanced: string }; check: { pass: boolean } };
    expect(json.totals.advanced).toBe("30000000");
    expect(json.check.pass).toBe(true);
  });

  it("refuses an event that does not close or that contradicts the subject's running state", () => {
    const l = createLedger();
    record(l, aaveRepay);
    expect(() => record(l, { ...aaveSettle, reserve: { ...aaveSettle.reserve, outstandingBefore: 0n } })).toThrow(LedgerError);
    expect(() => record(l, { ...aaveSettle, debt: { before: 1n, after: 1n, repaid: 0n } }, { strictChain: true })).toThrow(/debt before/);
    expect(() => record(l, { ...drill, debt: { ...drill.debt, repaid: 1n } })).toThrow(/does not reconcile/);
    expect(l.events).toHaveLength(1);
  });
});

// Property tests with a seeded generator: an event built from its parts always reconciles, and any single
// perturbation of a flow breaks exactly the identity it belongs to.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function big(r: () => number, max: bigint): bigint {
  // up to 2^53 is enough entropy per draw; compose two draws for wide ranges
  const hi = BigInt(Math.floor(r() * 2 ** 26));
  const lo = BigInt(Math.floor(r() * 2 ** 26));
  return ((hi << 26n) | lo) % (max + 1n);
}

function randomEvent(r: () => number, i: number, outstandingBefore = big(r, 10n ** 10n)): ProtectionEvent {
  const sold = big(r, 10n ** 12n);
  const returned = big(r, 10n ** 12n);
  const retained = big(r, 10n ** 9n);
  const proceeds = big(r, 10n ** 12n);
  const fromUser = big(r, 10n ** 10n);
  const fromPartner = big(r, 10n ** 10n);
  const fromAdvance = big(r, 10n ** 10n);
  const fromLiquidator = big(r, 10n ** 10n);
  const sources = proceeds + fromUser + fromPartner + fromAdvance + fromLiquidator;
  const fees = { protocol: big(r, 10n ** 6n), incentive: big(r, 10n ** 6n), advance: big(r, 10n ** 6n), keeper: big(r, 10n ** 6n) };
  const feeSum = fees.protocol + fees.incentive + fees.advance + fees.keeper;
  const settled = big(r, outstandingBefore + fromAdvance);
  const rest = sources - feeSum - settled;
  if (rest < 0n) return randomEvent(r, i + 1000, outstandingBefore);
  const repaid = big(r, rest);
  const borrowerRemainder = rest - repaid;
  const after = big(r, 10n ** 12n);
  return event({
    id: `p${i}`,
    venue: r() < 0.5 ? "morpho" : "aave",
    kind: "pre-liquidation",
    subject: `s${i % 7}`,
    at: i,
    collateral: { in: sold + returned + retained, sold, returned, retained, remainingOnPosition: big(r, 3n) },
    debt: { before: after + repaid, after, repaid },
    sources: { proceeds, fromUser, fromPartner, fromAdvance, fromLiquidator },
    fees,
    reserve: { advanced: fromAdvance, settled, outstandingBefore, outstandingAfter: outstandingBefore + fromAdvance - settled },
    borrowerRemainder,
  });
}

describe("conservation holds for every generated event", () => {
  const r = rng(20261007);
  it("500 random events reconcile and the ledger-wide check passes", () => {
    const l = createLedger();
    for (let i = 0; i < 500; i++) {
      // every subject starts with nothing advanced; later events chain on the subject's running outstanding
      const venue = i % 2 === 0 ? "morpho" : "aave";
      const prev = l.subjects.get(`${venue}:s${i % 7}`);
      const e = { ...randomEvent(r, i, prev?.outstanding ?? 0n), venue } as ProtectionEvent;
      const rec = reconcile(e);
      expect(rec.pass, `event ${i}: ${JSON.stringify(residuals(rec), (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`).toBe(true);
      record(l, e);
    }
    expect(check(l).pass).toBe(true);
    expect(l.totals.outstanding).toBe(check(l).advanceConservation.outstandingBySubject);
  });

  it("every single-flow perturbation breaks exactly the identity it belongs to", () => {
    for (let i = 0; i < 200; i++) {
      const e = randomEvent(r, 10_000 + i);
      const cases: [ProtectionEvent, string][] = [
        [{ ...e, sources: { ...e.sources, proceeds: e.sources.proceeds + 1n } }, "sources-uses"],
        [{ ...e, collateral: { ...e.collateral, returned: e.collateral.returned + 1n } }, "collateral"],
        [{ ...e, debt: { ...e.debt, before: e.debt.before + 1n } }, "debt"],
        [{ ...e, reserve: { ...e.reserve, outstandingAfter: e.reserve.outstandingAfter + 1n } }, "advance"],
      ];
      for (const [bad, id] of cases) expect(Object.keys(residuals(reconcile(bad)))).toEqual([id]);
    }
  });
});
