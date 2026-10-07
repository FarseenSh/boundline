// The weekend-gap panel: for every priced B20 feed, the last print before a closure, the first print after the
// reopen, the lag and the gap in basis points, one block per reopen. Three sources, merged by reopen instant:
//   - the reconstructed 2 to 4 Oct 2026 weekend (docs/evidence/reopen-2026-10-04.json, bundled at build time),
//   - the Observatory's own completed capture runs (D1, from the 11 Oct reopen on),
//   - the indexer's AnswerUpdated history (`/v1/feeds/:symbol/rounds`, through the service binding), whose
//     pauses are classified against the calendar: a pause that spans a 20:00 ET close is a closure, any other
//     pause is an in-session lull (the heartbeat is 24 h) and is not a gap.
import { answerToNumber } from "@boundline/chain";
import type { CalendarPort } from "./calendar-port.js";
import type { CaptureRunRecord } from "./stores.js";
import evidence from "../../../docs/evidence/reopen-2026-10-04.json" with { type: "json" };

export const KV_GAPS = "gaps-latest";
/** The cached panel is rewritten every ten minutes (index.ts); the key outlives a missed tick. */
export const GAPS_TTL_SECONDS = 1500;
export const GAPS_REFRESH_MINUTES = 10;
/** Rounds requested per symbol from the indexer: the B20 feeds print a few rounds a day (50 bps deviation, 24 h heartbeat), so 60 spans weeks; the ten pages cost about a millisecond of CPU each to parse. */
export const ROUNDS_PER_SYMBOL = 60;
export const MAX_WEEKENDS = 8;
export const EVIDENCE_PATH = "docs/evidence/reopen-2026-10-04.json";

export type GapSource = "evidence" | "capture" | "indexer";

export interface GapFeedRow {
  symbol: string;
  source: GapSource;
  heldAnswer: string | null;
  heldPrice: number | null;
  heldUpdatedAt: number | null;
  /** How long the venue priced at the held value when the feed reopened. */
  heldAgeAtReopenSeconds: number | null;
  /** Prints inside the closed window (should be zero: the feeds do not publish while closed). */
  roundsWhileClosed: number | null;
  firstAnswer: string | null;
  firstPrice: number | null;
  firstUpdatedAt: number | null;
  lagSeconds: number | null;
  gapBps: number | null;
}

export interface DexAtReopen {
  spot: number;
  twap1h: number;
  heldFeed: number;
  spotVsHeldBps: number;
  twapVsHeldBps: number;
}

export interface WeekendGap {
  reopenAt: number;
  closeAt: number | null;
  sources: GapSource[];
  feeds: GapFeedRow[];
  /** DEX state in the last block before the reopen, when the evidence has it. */
  dex: Record<string, DexAtReopen> | null;
  summary: { feeds: number; minGapBps: number | null; maxGapBps: number | null; minLagSeconds: number | null; maxLagSeconds: number | null };
}

export interface GapsPanel {
  version: 1;
  computedAt: number;
  weekends: WeekendGap[];
  indexer: { symbols: number; through: number | null; errors: string[] };
  evidence: string;
  note: string;
}

// ---------------------------------------------------------------- the indexer's rounds body

export interface IndexerRound {
  roundId: string;
  answer: string;
  updatedAt: number;
}

export interface IndexerGap {
  fromUpdatedAt: number;
  toUpdatedAt: number;
  heldAnswer: string;
  nextAnswer: string;
  moveBps: number;
}

export interface IndexerRoundsBody {
  symbol: string;
  rounds?: IndexerRound[];
  gaps?: IndexerGap[];
}

function price(answer: string | null): number | null {
  if (answer === null) return null;
  try {
    return answerToNumber(BigInt(answer), 8);
  } catch {
    return null;
  }
}

function gapBpsOf(held: string | null, next: string | null): number | null {
  if (held === null || next === null) return null;
  const h = Number(held);
  const n = Number(next);
  if (!Number.isFinite(h) || !Number.isFinite(n) || h === 0) return null;
  return ((n - h) / h) * 10_000;
}

/**
 * The closure a pause between two prints spans, if any: the first 20:00 ET boundary after the earlier print
 * that turns the feed off, and the boundary that turns it back on. Null when no close lies inside the pause
 * (an in-session lull) or when the later print came before the reopen (a print while closed).
 */
export function closureWithin(calendar: CalendarPort, fromUpdatedAt: number, toUpdatedAt: number, maxBoundaries = 40): { closeAt: number; reopenAt: number } | null {
  let t = fromUpdatedAt;
  let closeAt: number | null = null;
  for (let i = 0; i < maxBoundaries; i += 1) {
    const b = calendar.feedBoundaryAfter(t);
    if (b === null || b <= t) return null;
    if (b > toUpdatedAt) return null;
    const live = calendar.isFeedLive(b);
    if (closeAt === null) {
      if (!live && calendar.isFeedLive(b - 1)) closeAt = b;
    } else if (live) {
      return { closeAt, reopenAt: b };
    }
    t = b;
  }
  return null;
}

/** The closures found in one symbol's indexer page, newest first. */
export function closuresFromRounds(symbol: string, body: IndexerRoundsBody, calendar: CalendarPort): Array<GapFeedRow & { reopenAt: number; closeAt: number }> {
  const out: Array<GapFeedRow & { reopenAt: number; closeAt: number }> = [];
  const rounds = body.rounds ?? [];
  for (const g of body.gaps ?? []) {
    const c = closureWithin(calendar, g.fromUpdatedAt, g.toUpdatedAt);
    if (!c) continue;
    const inside = rounds.filter((r) => r.updatedAt > c.closeAt && r.updatedAt < c.reopenAt).length;
    out.push({
      symbol,
      source: "indexer",
      heldAnswer: g.heldAnswer,
      heldPrice: price(g.heldAnswer),
      heldUpdatedAt: g.fromUpdatedAt,
      heldAgeAtReopenSeconds: c.reopenAt - g.fromUpdatedAt,
      roundsWhileClosed: inside,
      firstAnswer: g.nextAnswer,
      firstPrice: price(g.nextAnswer),
      firstUpdatedAt: g.toUpdatedAt,
      lagSeconds: g.toUpdatedAt - c.reopenAt,
      gapBps: typeof g.moveBps === "number" ? g.moveBps : gapBpsOf(g.heldAnswer, g.nextAnswer),
      reopenAt: c.reopenAt,
      closeAt: c.closeAt,
    });
  }
  return out.sort((a, b) => b.reopenAt - a.reopenAt);
}

// ---------------------------------------------------------------- the bundled evidence

interface EvidenceRound {
  roundId: number | string;
  answer: number | string;
  updatedAt: number;
}

interface EvidenceFeed {
  symbol: string;
  held: EvidenceRound | null;
  roundsInsideClosedWindow: unknown[];
  firstAfterReopen: EvidenceRound | null;
  lagSeconds: number | null;
  gapBps: number | null;
  heldAgeAtReopenSeconds: number | null;
}

export interface EvidenceJson {
  chainId: number;
  close: number;
  reopen: number;
  generatedAt: number;
  feeds: EvidenceFeed[];
  dex: Record<string, { spot: number; twap1h: number; heldFeed: number; spotVsHeldBps: number; twapVsHeldBps: number }>;
}

function answerString(a: number | string): string {
  return typeof a === "number" ? BigInt(Math.round(a)).toString() : a;
}

export function weekendFromEvidence(e: EvidenceJson): WeekendGap {
  const feeds: GapFeedRow[] = e.feeds.map((f) => {
    const held = f.held ? answerString(f.held.answer) : null;
    const first = f.firstAfterReopen ? answerString(f.firstAfterReopen.answer) : null;
    return {
      symbol: f.symbol,
      source: "evidence",
      heldAnswer: held,
      heldPrice: price(held),
      heldUpdatedAt: f.held?.updatedAt ?? null,
      heldAgeAtReopenSeconds: f.heldAgeAtReopenSeconds,
      roundsWhileClosed: f.roundsInsideClosedWindow.length,
      firstAnswer: first,
      firstPrice: price(first),
      firstUpdatedAt: f.firstAfterReopen?.updatedAt ?? null,
      lagSeconds: f.lagSeconds,
      gapBps: f.gapBps,
    };
  });
  const dex: Record<string, DexAtReopen> = {};
  for (const [symbol, d] of Object.entries(e.dex ?? {})) dex[symbol] = { spot: d.spot, twap1h: d.twap1h, heldFeed: d.heldFeed, spotVsHeldBps: d.spotVsHeldBps, twapVsHeldBps: d.twapVsHeldBps };
  return finishWeekend({ reopenAt: e.reopen, closeAt: e.close, sources: ["evidence"], feeds, dex: Object.keys(dex).length > 0 ? dex : null });
}

/** The bundled 2 to 4 Oct 2026 weekend. */
export const EVIDENCE_WEEKEND: WeekendGap = weekendFromEvidence(evidence as unknown as EvidenceJson);

// ---------------------------------------------------------------- the Observatory's own captures

export function weekendsFromCaptureRuns(runs: readonly CaptureRunRecord[]): WeekendGap[] {
  return runs
    .filter((r) => r.kind === "reopen")
    .map((r) => {
      const feeds: GapFeedRow[] = Object.entries(r.summary.perToken).map(([symbol, t]) => ({
        symbol,
        source: "capture",
        heldAnswer: t.heldAnswer,
        heldPrice: price(t.heldAnswer),
        heldUpdatedAt: t.heldUpdatedAt,
        heldAgeAtReopenSeconds: t.heldUpdatedAt === null ? null : r.transitionAt - t.heldUpdatedAt,
        roundsWhileClosed: null,
        firstAnswer: t.first?.answer ?? null,
        firstPrice: price(t.first?.answer ?? null),
        firstUpdatedAt: t.first?.feedUpdatedAt ?? null,
        lagSeconds: t.first?.lagSeconds ?? null,
        gapBps: t.first?.gapBps ?? null,
      }));
      return finishWeekend({ reopenAt: r.transitionAt, closeAt: null, sources: ["capture"], feeds, dex: null });
    });
}

// ---------------------------------------------------------------- merge

function finishWeekend(w: Omit<WeekendGap, "summary">): WeekendGap {
  const feeds = [...w.feeds].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const gaps = feeds.map((f) => f.gapBps).filter((g): g is number => g !== null && Number.isFinite(g));
  const lags = feeds.map((f) => f.lagSeconds).filter((l): l is number => l !== null && Number.isFinite(l));
  return {
    ...w,
    feeds,
    summary: {
      feeds: feeds.length,
      minGapBps: gaps.length ? Math.min(...gaps) : null,
      maxGapBps: gaps.length ? Math.max(...gaps) : null,
      minLagSeconds: lags.length ? Math.min(...lags) : null,
      maxLagSeconds: lags.length ? Math.max(...lags) : null,
    },
  };
}

const PRIORITY: Record<GapSource, number> = { evidence: 3, capture: 2, indexer: 1 };

/** One block per reopen; a symbol's row comes from the best source that has it (evidence, then capture, then indexer). */
export function mergeWeekends(lists: readonly (readonly WeekendGap[])[], max = MAX_WEEKENDS): WeekendGap[] {
  const byReopen = new Map<number, { reopenAt: number; closeAt: number | null; sources: Set<GapSource>; feeds: Map<string, GapFeedRow>; dex: Record<string, DexAtReopen> | null }>();
  for (const list of lists) {
    for (const w of list) {
      const cur = byReopen.get(w.reopenAt) ?? { reopenAt: w.reopenAt, closeAt: w.closeAt, sources: new Set<GapSource>(), feeds: new Map<string, GapFeedRow>(), dex: null };
      if (cur.closeAt === null && w.closeAt !== null) cur.closeAt = w.closeAt;
      for (const s of w.sources) cur.sources.add(s);
      for (const f of w.feeds) {
        const have = cur.feeds.get(f.symbol);
        if (!have || PRIORITY[f.source] > PRIORITY[have.source]) cur.feeds.set(f.symbol, f);
      }
      if (w.dex && !cur.dex) cur.dex = w.dex;
      byReopen.set(w.reopenAt, cur);
    }
  }
  return [...byReopen.values()]
    .sort((a, b) => b.reopenAt - a.reopenAt)
    .slice(0, max)
    .map((c) => finishWeekend({ reopenAt: c.reopenAt, closeAt: c.closeAt, sources: [...c.sources].sort(), feeds: [...c.feeds.values()], dex: c.dex }));
}

export interface GapsInput {
  now: number;
  calendar: CalendarPort;
  /** symbol → the indexer's rounds body, or the error that stopped the fetch. */
  rounds: ReadonlyMap<string, IndexerRoundsBody | Error>;
  captureRuns: readonly CaptureRunRecord[];
  evidence?: WeekendGap;
}

export function buildGapsPanel(i: GapsInput): GapsPanel {
  const errors: string[] = [];
  const perSymbol: WeekendGap[] = [];
  let through: number | null = null;
  for (const [symbol, body] of i.rounds) {
    if (body instanceof Error) {
      errors.push(`${symbol}: ${body.message}`);
      continue;
    }
    for (const r of body.rounds ?? []) if (typeof r.updatedAt === "number" && (through === null || r.updatedAt > through)) through = r.updatedAt;
    for (const c of closuresFromRounds(symbol, body, i.calendar)) {
      const { reopenAt, closeAt, ...row } = c;
      perSymbol.push(finishWeekend({ reopenAt, closeAt, sources: ["indexer"], feeds: [row], dex: null }));
    }
  }
  const weekends = mergeWeekends([[i.evidence ?? EVIDENCE_WEEKEND], weekendsFromCaptureRuns(i.captureRuns), perSymbol]);
  return {
    version: 1,
    computedAt: i.now,
    weekends,
    indexer: { symbols: i.rounds.size - errors.length, through, errors },
    evidence: EVIDENCE_PATH,
    note: "One block per reopen: the last print before the close, the first after the reopen, its lag and the gap in bps. Sources: the reconstructed 2 to 4 Oct 2026 weekend, the Observatory's capture runs, the indexer's round history (pauses that span a 20:00 ET close).",
  };
}
