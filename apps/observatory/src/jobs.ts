// The two cron jobs added for the reopen: the capture recorder and the real-position refresh.
// Both take their I/O as arguments so the tests drive them with the memory stores and fakes.
import type { Hex } from "viem";
import { AAVE_BATCH_PER_TICK, AAVE_CHAIN_ID, readAavePositions, rotate, shadowUsdFromSnapshot, type AaveBorrowerRecord, type AaveMeta } from "./aave-positions.js";
import type { CalendarPort } from "./calendar-port.js";
import { CAPTURE_AFTER_SECONDS, activeTransition, captureRows, emptySummary, firstUpdateAt, isComplete, phaseFor, updateSummary, type CaptureSummary } from "./capture.js";
import type { MarketRow } from "./morpho.js";
import { CHAIN_ID, POSITIONS_EVERY_SECONDS, fetchApiBorrowers, planScan, readPositions, scanBorrowLogs, type Borrower, type PositionRow, type PositionsRpc } from "./positions.js";
import type { EthCall } from "./rpc.js";
import type { Snapshot } from "./snapshot.js";
import type { AaveStore, CaptureRunRecord, CaptureStore, PositionStore } from "./stores.js";

export interface Logger {
  log(message: string): void;
  error(message: string): void;
}

export type CaptureStatus = { status: "idle" } | { status: "recording" | "completed"; transitionAt: number; phase: string; ticks: number };

/** How many of the newest runs an idle tick looks at for one left open (a close and a reopen per weekend: two weekends). */
export const RUNS_CHECKED_WHEN_IDLE = 4;

/** Records this tick when inside a capture window and folds it into the run's summary; outside one, closes overdue runs. */
export async function runCapture(store: CaptureStore, calendar: CalendarPort, snapshot: Snapshot, log: Logger = console): Promise<CaptureStatus> {
  const now = snapshot.takenAt;
  const active = activeTransition(calendar, now);
  if (!active) return closeOverdueRuns(store, now, log);
  const phase = phaseFor(now, active.at) ?? "after";
  let run = await store.getRun(active.at);
  if (run?.completedAt) return { status: "completed", transitionAt: active.at, phase, ticks: run.summary.ticks };
  if (!run) {
    run = {
      transitionAt: active.at,
      fromSession: active.from,
      toSession: active.to,
      kind: active.kind,
      armedAt: now,
      firstUpdateAt: null,
      completedAt: null,
      summary: emptySummary(),
    };
    log.log(`capture armed for ${active.kind} at ${active.at} (${active.from} -> ${active.to}), phase ${phase}`);
  }
  // A run armed after the transition never saw the held print: take it from the snapshot history.
  const summary: CaptureSummary = { ...run.summary, perToken: { ...run.summary.perToken } };
  for (const t of snapshot.tokens) {
    const cur = summary.perToken[t.symbol];
    if (cur?.heldAnswer) continue;
    if (t.feedUpdatedAt <= active.at) continue; // this tick carries the held print itself
    const held = await store.lastHeldPrint(t.symbol, active.at);
    if (held) summary.perToken[t.symbol] = { heldAnswer: held.answer, heldUpdatedAt: held.updatedAt, first: cur?.first ?? null };
  }
  await store.addRows(captureRows(snapshot, active, phase));
  const next: CaptureRunRecord = { ...run, summary: updateSummary(summary, active, snapshot) };
  next.firstUpdateAt = firstUpdateAt(next.summary);
  if (isComplete(now, active.at)) {
    next.completedAt = now;
    log.log(`capture complete for ${active.at}: first update ${next.firstUpdateAt ?? "none"} after ${next.summary.ticks} ticks`);
  }
  await store.putRun(next);
  return { status: next.completedAt ? "completed" : "recording", transitionAt: active.at, phase, ticks: next.summary.ticks };
}

/**
 * Closes runs whose window ended without a completing tick. The window ends at +90 minutes to the second while the cron
 * ticks wherever its minute lands, so the in-window check above fires only for a tick at exactly +5400 s: both live runs
 * of 9 to 12 Oct 2026 (the Friday close and the Sunday reopen) stayed open after 89 "after" ticks. The first tick after
 * the window closes them, as does any later one if the cron was down; nothing is recorded (the window is over) and
 * `completedAt` is the window's end. Costs one read of RUNS_CHECKED_WHEN_IDLE rows on the primary key per idle tick.
 */
async function closeOverdueRuns(store: CaptureStore, now: number, log: Logger): Promise<CaptureStatus> {
  let newest: CaptureRunRecord | null = null;
  for (const run of await store.listRuns(RUNS_CHECKED_WHEN_IDLE)) {
    if (run.completedAt !== null || !isComplete(now, run.transitionAt)) continue;
    const closed: CaptureRunRecord = { ...run, completedAt: run.transitionAt + CAPTURE_AFTER_SECONDS };
    await store.putRun(closed);
    log.log(`capture complete for ${run.transitionAt} (closed at ${now}, after its window): first update ${run.firstUpdateAt ?? "none"} after ${run.summary.ticks} ticks`);
    newest ??= closed;
  }
  return newest ? { status: "completed", transitionAt: newest.transitionAt, phase: "after", ticks: newest.summary.ticks } : { status: "idle" };
}

export interface PositionsDeps {
  store: PositionStore;
  rpc: PositionsRpc;
  markets: readonly MarketRow[];
  fetchImpl: typeof fetch;
  snapshot: Snapshot;
  log?: Logger;
}

export interface PositionsResult {
  scanned: { from: number; to: number } | null;
  skippedFrom: number | null;
  seeded: number;
  newBorrowers: number;
  refreshed: number | null;
  errors: string[];
}

/** Advances the Borrow-event scan by a bounded range, seeds from Morpho's API when the cursor is missing or fell behind, and refreshes positions every 10 minutes. Runs on every fifth minute's tick (index.ts). */
export async function runPositions(deps: PositionsDeps): Promise<PositionsResult> {
  const { store, rpc, markets, fetchImpl, snapshot } = deps;
  const log = deps.log ?? console;
  const result: PositionsResult = { scanned: null, skippedFrom: null, seeded: 0, newBorrowers: 0, refreshed: null, errors: [] };
  const marketIds = markets.map((m) => m.id.toLowerCase() as Hex);
  if (marketIds.length === 0) return result;
  const head = snapshot.block;
  const now = snapshot.takenAt;

  try {
    const cursor = await store.cursor(CHAIN_ID);
    const plan = planScan(cursor, head);
    if (cursor === null || (plan && plan.skippedFrom !== null)) {
      // No history on public RPCs: the API tells us who borrows today, the logs keep us current from here.
      const seed = await fetchApiBorrowers(fetchImpl, marketIds, head);
      result.seeded = await store.addBorrowers(seed);
      if (plan?.skippedFrom !== null && plan?.skippedFrom !== undefined) log.error(`borrow scan skipped blocks ${plan.skippedFrom}..${plan.from - 1} (archive cutoff); reseeded from the API`);
    }
    if (plan) {
      const found = await scanBorrowLogs(rpc.getLogs, marketIds, plan);
      result.newBorrowers = await store.addBorrowers(found);
      await store.setCursor(CHAIN_ID, marketIds, plan.to, now);
      result.scanned = { from: plan.from, to: plan.to };
      result.skippedFrom = plan.skippedFrom;
    }
  } catch (err) {
    result.errors.push(`scan: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const last = await store.lastPositionsTakenAt(CHAIN_ID);
    if (last === null || now - last >= POSITIONS_EVERY_SECONDS) {
      const borrowers: Borrower[] = await store.borrowers(CHAIN_ID);
      const shadow = new Map<string, bigint>();
      for (const t of snapshot.tokens) if (t.dexTwapPrice36) shadow.set(t.symbol, BigInt(t.dexTwapPrice36));
      const rows: PositionRow[] = borrowers.length === 0 ? [] : await readPositions(rpc.call, markets, borrowers, shadow, head, now);
      await store.addPositions(rows);
      result.refreshed = rows.length;
    }
  } catch (err) {
    result.errors.push(`positions: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (result.errors.length > 0) log.error(`positions job: ${result.errors.join("; ")}`);
  return result;
}

export interface AaveJobDeps {
  store: AaveStore;
  call: EthCall;
  /** Reserve metadata (decimals, collateral factors, oracle); the live loader caches it in KV. */
  meta: () => Promise<AaveMeta>;
  /** Today's borrowers from the indexer's Borrow-event scan, already parsed. */
  borrowers: () => Promise<AaveBorrowerRecord[]>;
  snapshot: Snapshot;
  log?: Logger;
  batch?: number;
}

export interface AaveJobResult {
  known: number;
  newBorrowers: number;
  scanned: number;
  nextOffset: number;
  refreshed: number;
  protectionCases: number;
  errors: string[];
}

/**
 * Refreshes a rotating batch of Aave V4 MAG7 positions: merges the indexer's borrower list into D1, reads
 * `batch` of them in one aggregate3 call at the venue's prices and the snapshot's DEX TWAPs, stores the rows
 * and advances the offset. Runs on the fifth-minute tick next to the Morpho scan (index.ts).
 */
export async function runAavePositions(deps: AaveJobDeps): Promise<AaveJobResult> {
  const log = deps.log ?? console;
  const result: AaveJobResult = { known: 0, newBorrowers: 0, scanned: 0, nextOffset: 0, refreshed: 0, protectionCases: 0, errors: [] };
  const now = deps.snapshot.takenAt;
  let known: AaveBorrowerRecord[] = [];
  try {
    known = await deps.store.borrowers(AAVE_CHAIN_ID);
  } catch (err) {
    result.errors.push(`known: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    // Only what the indexer knows and D1 does not yet (a new borrower, or a later Borrow) is written: in the
    // steady state that is nothing, and a 60-statement batch every tick was most of the job's CPU.
    const have = new Map(known.map((b) => [b.address.toLowerCase(), b.lastSeenBlock]));
    const changed = (await deps.borrowers()).filter((b) => {
      const seen = have.get(b.address.toLowerCase());
      return seen === undefined || seen < b.lastSeenBlock;
    });
    if (changed.length > 0) {
      result.newBorrowers = await deps.store.upsertBorrowers(changed);
      known = await deps.store.borrowers(AAVE_CHAIN_ID);
    }
  } catch (err) {
    result.errors.push(`borrowers: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    result.known = known.length;
    const offset = await deps.store.scanOffset(AAVE_CHAIN_ID);
    const { picked, nextOffset } = rotate(known, offset, deps.batch ?? AAVE_BATCH_PER_TICK);
    result.scanned = picked.length;
    result.nextOffset = nextOffset;
    if (picked.length > 0) {
      const meta = await deps.meta();
      const rows = await readAavePositions(
        deps.call,
        meta,
        picked.map((b) => b.address),
        shadowUsdFromSnapshot(deps.snapshot),
        deps.snapshot.block,
        now,
      );
      await deps.store.addPositions(rows);
      result.refreshed = rows.length;
      result.protectionCases = rows.filter((r) => r.protectionCase).length;
    }
    await deps.store.setScanOffset(AAVE_CHAIN_ID, nextOffset, now);
  } catch (err) {
    result.errors.push(`positions: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (result.errors.length > 0) log.error(`aave job: ${result.errors.join("; ")}`);
  return result;
}
