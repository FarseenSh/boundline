import type { Hex } from "viem";
import type { EventRow } from "./decode.js";

export interface CursorRow {
  chainId: number;
  source: string;
  lastBlock: number;
  /** Timestamp of `lastBlock`; closes UTC days for the daily roots. */
  lastBlockTime: number;
  updatedAt: number;
}

/** Cursor rows that are bookkeeping, not scan positions: they never gate the daily roots. */
export const INTERNAL_CURSORS = new Set(["reconcile", "roots", "tick", "tick-done"]);

export interface DailyRootRow {
  chainId: number;
  day: string;
  firstBlock: number | null;
  lastBlock: number | null;
  eventCount: number;
  prevRoot: Hex;
  root: Hex;
  computedAt: number;
}

export type ReconciliationStatus = "PASS" | "FAIL" | "SKIP";

export interface ReconciliationRow {
  id?: number;
  chainId: number;
  subject: string;
  checkedAt: number;
  blockNumber: number;
  expectedJson: string;
  actualJson: string;
  status: ReconciliationStatus;
}

export interface EventQuery {
  chainId: number;
  /** One emitter, or several (`addresses`); both lowercase-compared. */
  address?: string;
  addresses?: readonly string[];
  name?: string;
  /** Several event names (OR). */
  names?: readonly string[];
  fromBlock?: number;
  toBlock?: number;
  /** Only events whose block_time is at or after this unix time. */
  fromTime?: number;
  /** A substring that must occur in the canonical args_json, e.g. `"lineId":"1"`. */
  argsContains?: string;
  /** Newest first; `before` continues a page strictly below this (block_number, log_index). */
  before?: { blockNumber: number; logIndex: number };
  limit: number;
}

/** The cursor rows that coordinate ticks (chain 0). */
export const TICK_CURSOR = "tick";
export const TICK_DONE_CURSOR = "tick-done";

/** A stored event hash (see migrations/0003_event_hashes.sql). */
export interface HashRow {
  chainId: number;
  txHash: Hex;
  logIndex: number;
  day: string;
  blockNumber: number;
  hash: Hex;
}

/** One day's events with their stored hashes (null when not hashed yet), in (block, log index) order. */
export interface DayHashes {
  events: number;
  hashes: (Hex | null)[];
  /** `${txHash}:${logIndex}` of each event, aligned with `hashes`. */
  keys: string[];
  firstBlock: number | null;
  lastBlock: number | null;
}

/** Events of one source, inserted together by `commit` so the rows it added can be reported per source. */
export interface EventGroup {
  key: string;
  events: readonly EventRow[];
}

/** Everything the Worker persists. `D1Store` is the real one; `MemoryStore` backs the tests. */
export interface Store {
  getCursor(chainId: number, source: string): Promise<CursorRow | null>;
  setCursor(row: CursorRow): Promise<void>;
  listCursors(): Promise<CursorRow[]>;
  /**
   * Claims the tick lease in one atomic statement: the `tick` row becomes (lastBlock = startedAt, updatedAt = startedAt)
   * only when the previous holder's lease is at least `leaseSeconds` old or that tick finished (its start equals the
   * `tick-done` row's lastBlock). False means another tick is alive; two ticks that race both read-then-write, so this
   * is a compare-and-set, not a read.
   */
  claimTick(startedAt: number, leaseSeconds: number): Promise<boolean>;
  /** One round trip for a tick's writes: every group's events (INSERT OR IGNORE), then the cursor upserts. Returns the
   *  rows each group actually added. On Workers every D1 call costs CPU, so a tick makes as few as it can. */
  commit(groups: readonly EventGroup[], cursors: readonly CursorRow[]): Promise<Record<string, number>>;
  /** Inserts with INSERT OR IGNORE semantics on (chain_id, tx_hash, log_index); returns the rows actually added. */
  insertEvents(rows: readonly EventRow[]): Promise<number>;
  queryEvents(q: EventQuery): Promise<EventRow[]>;
  /** Events with block_time in [fromTime, toTime), oldest first. */
  eventsBetween(chainId: number, fromTime: number, toTime: number): Promise<EventRow[]>;
  /** Every event an address emitted, oldest first. */
  eventsOfAddress(chainId: number, address: string): Promise<EventRow[]>;
  earliestEventTime(chainId: number): Promise<number | null>;
  /** Stored events per UTC day (YYYY-MM-DD → count), for the roots' drift report. */
  countEventsByDay(chainId: number): Promise<Record<string, number>>;
  /** Events with block_time ≥ fromTime that have no stored hash yet, oldest first, at most `limit`. */
  unhashedEvents(chainId: number, fromTime: number, limit: number): Promise<EventRow[]>;
  putEventHashes(rows: readonly HashRow[]): Promise<void>;
  /** The events of [fromTime, toTime) with their stored hashes, in root order. */
  dayHashes(chainId: number, fromTime: number, toTime: number): Promise<DayHashes>;
  getRoot(chainId: number, day: string): Promise<DailyRootRow | null>;
  latestRoot(chainId: number): Promise<DailyRootRow | null>;
  listRoots(chainId: number, limit: number): Promise<DailyRootRow[]>;
  putRoot(row: DailyRootRow): Promise<void>;
  insertReconciliations(rows: readonly ReconciliationRow[]): Promise<void>;
  /** The rows of the most recent run (they share checked_at). */
  latestReconciliations(chainId: number): Promise<ReconciliationRow[]>;
}

export function eventKey(e: { chainId: number; txHash: string; logIndex: number }): string {
  return `${e.chainId}:${e.txHash.toLowerCase()}:${e.logIndex}`;
}

export function byBlockAsc(a: EventRow, b: EventRow): number {
  return a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
}

/** The emitter set a query asks for, lowercased; empty when it asks for any emitter. */
export function queryAddresses(q: EventQuery): string[] {
  const set = new Set<string>();
  if (q.address) set.add(q.address.toLowerCase());
  for (const a of q.addresses ?? []) set.add(a.toLowerCase());
  return [...set];
}

/** The event-name set a query asks for; empty when it asks for any name. */
export function queryNames(q: EventQuery): string[] {
  const set = new Set<string>();
  if (q.name) set.add(q.name);
  for (const n of q.names ?? []) set.add(n);
  return [...set];
}
