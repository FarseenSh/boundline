// The two cron jobs added for the reopen: the capture recorder and the real-position refresh.
// Both take their I/O as arguments so the tests drive them with the memory stores and fakes.
import type { Hex } from "viem";
import type { CalendarPort } from "./calendar-port.js";
import { activeTransition, captureRows, emptySummary, firstUpdateAt, isComplete, phaseFor, updateSummary, type CaptureSummary } from "./capture.js";
import type { MarketRow } from "./morpho.js";
import { CHAIN_ID, POSITIONS_EVERY_SECONDS, fetchApiBorrowers, planScan, readPositions, scanBorrowLogs, type Borrower, type Client, type PositionRow } from "./positions.js";
import type { Snapshot } from "./snapshot.js";
import type { CaptureRunRecord, CaptureStore, PositionStore } from "./stores.js";

export interface Logger {
  log(message: string): void;
  error(message: string): void;
}

export type CaptureStatus = { status: "idle" } | { status: "recording" | "completed"; transitionAt: number; phase: string; ticks: number };

/** Records this tick when inside a capture window and folds it into the run's summary. */
export async function runCapture(store: CaptureStore, calendar: CalendarPort, snapshot: Snapshot, log: Logger = console): Promise<CaptureStatus> {
  const now = snapshot.takenAt;
  const active = activeTransition(calendar, now);
  if (!active) return { status: "idle" };
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

export interface PositionsDeps {
  store: PositionStore;
  client: Client;
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

/** Advances the Borrow-event scan by a bounded range, seeds from Morpho's API when the cursor is missing or fell behind, and refreshes positions every 10 minutes. */
export async function runPositions(deps: PositionsDeps): Promise<PositionsResult> {
  const { store, client, markets, fetchImpl, snapshot } = deps;
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
      const found = await scanBorrowLogs(client, marketIds, plan);
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
      const rows: PositionRow[] = borrowers.length === 0 ? [] : await readPositions(client, markets, borrowers, shadow, head, now);
      await store.addPositions(rows);
      result.refreshed = rows.length;
    }
  } catch (err) {
    result.errors.push(`positions: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (result.errors.length > 0) log.error(`positions job: ${result.errors.join("; ")}`);
  return result;
}
