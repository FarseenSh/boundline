import { describe, expect, it } from "vitest";
import { EVIDENCE_WEEKEND, buildGapsPanel, closureWithin, closuresFromRounds, mergeWeekends, weekendFromEvidence, weekendsFromCaptureRuns, type IndexerRoundsBody, type WeekendGap } from "../src/gaps.js";
import type { CaptureRunRecord } from "../src/stores.js";
import { REOPEN, weekendCalendar } from "./capture.test.js";

const cal = weekendCalendar();
const CLOSE = REOPEN - 48 * 3600;

describe("closureWithin", () => {
  it("finds the close and the reopen a weekend pause spans", () => {
    expect(closureWithin(cal, CLOSE - 2 * 3600, REOPEN + 45)).toEqual({ closeAt: CLOSE, reopenAt: REOPEN });
  });

  it("is null for an in-session lull, however long", () => {
    expect(closureWithin(cal, CLOSE - 10 * 3600, CLOSE - 2 * 3600)).toBeNull();
    expect(closureWithin(cal, REOPEN + 3600, REOPEN + 20 * 3600)).toBeNull();
  });

  it("is null when the later print came before the reopen", () => {
    expect(closureWithin(cal, CLOSE - 3600, REOPEN - 3600)).toBeNull();
  });
});

const body: IndexerRoundsBody = {
  symbol: "AAPLc",
  rounds: [
    { roundId: "250", answer: "34024000000", updatedAt: REOPEN + 45 },
    { roundId: "249", answer: "34151300000", updatedAt: CLOSE - 1800 },
    { roundId: "248", answer: "33972000000", updatedAt: CLOSE - 12 * 3600 },
    { roundId: "247", answer: "33793000000", updatedAt: CLOSE - 20 * 3600 },
  ],
  gaps: [
    { fromUpdatedAt: CLOSE - 1800, toUpdatedAt: REOPEN + 45, heldAnswer: "34151300000", nextAnswer: "34024000000", moveBps: -37.28 },
    { fromUpdatedAt: CLOSE - 20 * 3600, toUpdatedAt: CLOSE - 12 * 3600, heldAnswer: "33793000000", nextAnswer: "33972000000", moveBps: 52.97 },
  ],
};

describe("closuresFromRounds", () => {
  it("keeps the pause that spans the close and drops the in-session lull", () => {
    const rows = closuresFromRounds("AAPLc", body, cal);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbol: "AAPLc",
      source: "indexer",
      reopenAt: REOPEN,
      closeAt: CLOSE,
      heldAnswer: "34151300000",
      heldUpdatedAt: CLOSE - 1800,
      heldAgeAtReopenSeconds: 48 * 3600 + 1800,
      roundsWhileClosed: 0,
      firstAnswer: "34024000000",
      firstUpdatedAt: REOPEN + 45,
      lagSeconds: 45,
      gapBps: -37.28,
    });
    expect(rows[0]?.heldPrice).toBeCloseTo(341.513, 3);
    expect(rows[0]?.firstPrice).toBeCloseTo(340.24, 2);
  });

  it("tolerates a body without gaps or rounds", () => {
    expect(closuresFromRounds("AAPLc", { symbol: "AAPLc" }, cal)).toEqual([]);
  });
});

describe("the bundled 2 to 4 Oct 2026 evidence", () => {
  it("is one weekend with ten feeds, the known lags and gaps, and the DEX state", () => {
    const w = EVIDENCE_WEEKEND;
    expect(w.reopenAt).toBe(1791158400);
    expect(w.closeAt).toBe(1790985600);
    expect(w.sources).toEqual(["evidence"]);
    expect(w.feeds).toHaveLength(10);
    const aapl = w.feeds.find((f) => f.symbol === "AAPLc");
    expect(aapl).toMatchObject({ source: "evidence", heldAnswer: "33366495000", firstAnswer: "33341500000", lagSeconds: 45, roundsWhileClosed: 0, heldAgeAtReopenSeconds: 199201 });
    expect(aapl?.gapBps).toBeCloseTo(-7.49, 2);
    expect(aapl?.heldPrice).toBeCloseTo(333.66495, 5);
    expect(w.summary.feeds).toBe(10);
    expect(w.summary.minLagSeconds).toBeGreaterThanOrEqual(20);
    expect(w.summary.maxLagSeconds).toBeLessThanOrEqual(60);
    expect(w.summary.minGapBps as number).toBeLessThan(0);
    expect(w.summary.maxGapBps as number).toBeGreaterThan(200);
    expect(w.dex?.["NVDAc"]?.twapVsHeldBps).toBeCloseTo(45.9, 1);
    expect(weekendFromEvidence({ chainId: 8453, close: 1, reopen: 2, generatedAt: 3, feeds: [], dex: {} }).dex).toBeNull();
  });
});

describe("weekendsFromCaptureRuns", () => {
  it("turns a completed reopen run into a weekend and ignores close runs", () => {
    const run: CaptureRunRecord = {
      transitionAt: REOPEN,
      fromSession: "WEEKEND",
      toSession: "OVERNIGHT",
      kind: "reopen",
      armedAt: REOPEN - 900,
      firstUpdateAt: REOPEN + 190,
      completedAt: REOPEN + 5400,
      summary: { perToken: { AAPLc: { heldAnswer: "33000000000", heldUpdatedAt: CLOSE - 10, first: { feedUpdatedAt: REOPEN + 190, seenAt: REOPEN + 240, block: 1, roundId: "9", answer: "33500000000", lagSeconds: 190, gapBps: 151.5 } }, NVDAc: { heldAnswer: "20000000000", heldUpdatedAt: CLOSE - 20, first: null } }, ticks: 106, lastTickAt: REOPEN + 5400 },
    };
    const closeRun: CaptureRunRecord = { ...run, transitionAt: CLOSE, kind: "close", fromSession: "POST", toSession: "WEEKEND" };
    const ws = weekendsFromCaptureRuns([run, closeRun]);
    expect(ws).toHaveLength(1);
    expect(ws[0]?.reopenAt).toBe(REOPEN);
    expect(ws[0]?.feeds.map((f) => f.symbol)).toEqual(["AAPLc", "NVDAc"]);
    expect(ws[0]?.feeds[0]).toMatchObject({ source: "capture", lagSeconds: 190, gapBps: 151.5, heldAgeAtReopenSeconds: 48 * 3600 + 10, roundsWhileClosed: null });
    expect(ws[0]?.feeds[1]).toMatchObject({ firstAnswer: null, lagSeconds: null, gapBps: null });
  });
});

function weekend(reopenAt: number, source: "evidence" | "capture" | "indexer", symbols: string[], gap = 10): WeekendGap {
  return {
    reopenAt,
    closeAt: null,
    sources: [source],
    feeds: symbols.map((symbol) => ({ symbol, source, heldAnswer: "1", heldPrice: 1e-8, heldUpdatedAt: 1, heldAgeAtReopenSeconds: 1, roundsWhileClosed: 0, firstAnswer: "1", firstPrice: 1e-8, firstUpdatedAt: 2, lagSeconds: 30, gapBps: gap })),
    dex: null,
    summary: { feeds: symbols.length, minGapBps: gap, maxGapBps: gap, minLagSeconds: 30, maxLagSeconds: 30 },
  };
}

describe("mergeWeekends", () => {
  it("merges by reopen, prefers evidence over capture over indexer per symbol, sorts newest first, caps", () => {
    const merged = mergeWeekends([[weekend(100, "indexer", ["AAPLc", "TSLAc"], 5)], [weekend(100, "evidence", ["AAPLc"], 9), weekend(50, "capture", ["NVDAc"])], [weekend(200, "indexer", ["AAPLc"])]]);
    expect(merged.map((w) => w.reopenAt)).toEqual([200, 100, 50]);
    const w100 = merged[1] as WeekendGap;
    expect(w100.sources).toEqual(["evidence", "indexer"]);
    expect(w100.feeds.map((f) => `${f.symbol}:${f.source}:${f.gapBps}`)).toEqual(["AAPLc:evidence:9", "TSLAc:indexer:5"]);
    expect(w100.summary).toEqual({ feeds: 2, minGapBps: 5, maxGapBps: 9, minLagSeconds: 30, maxLagSeconds: 30 });
    expect(mergeWeekends([[weekend(1, "indexer", ["A"]), weekend(2, "indexer", ["A"]), weekend(3, "indexer", ["A"])]], 2).map((w) => w.reopenAt)).toEqual([3, 2]);
  });
});

describe("buildGapsPanel", () => {
  it("folds the indexer pages, the capture runs and the evidence into one panel and reports the errors", () => {
    const rounds = new Map<string, IndexerRoundsBody | Error>([
      ["AAPLc", body],
      ["NVDAc", new Error("indexer answered 503 for /v1/feeds/NVDAc/rounds")],
      ["TSLAc", { symbol: "TSLAc", rounds: [{ roundId: "1", answer: "1", updatedAt: REOPEN + 9000 }], gaps: [] }],
    ]);
    const panel = buildGapsPanel({ now: REOPEN + 10_000, calendar: cal, rounds, captureRuns: [] });
    expect(panel.version).toBe(1);
    expect(panel.indexer).toEqual({ symbols: 2, through: REOPEN + 9000, errors: ["NVDAc: indexer answered 503 for /v1/feeds/NVDAc/rounds"] });
    // the evidence weekend and the indexer's closure share the reopen instant: one block, evidence first for AAPLc
    expect(panel.weekends).toHaveLength(1);
    const w = panel.weekends[0] as WeekendGap;
    expect(w.reopenAt).toBe(REOPEN);
    expect(w.sources).toEqual(["evidence", "indexer"]);
    expect(w.feeds.find((f) => f.symbol === "AAPLc")?.source).toBe("evidence");
    expect(w.feeds).toHaveLength(10);
    expect(panel.evidence).toBe("docs/evidence/reopen-2026-10-04.json");
  });

  it("works with nothing but the evidence", () => {
    const panel = buildGapsPanel({ now: 5, calendar: cal, rounds: new Map(), captureRuns: [] });
    expect(panel.weekends).toHaveLength(1);
    expect(panel.indexer).toEqual({ symbols: 0, through: null, errors: [] });
  });
});
