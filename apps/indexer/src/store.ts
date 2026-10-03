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
  address?: string;
  name?: string;
  fromBlock?: number;
  toBlock?: number;
  /** Newest first; `before` continues a page strictly below this (block_number, log_index). */
  before?: { blockNumber: number; logIndex: number };
  limit: number;
}

/** Everything the Worker persists. `D1Store` is the real one; `MemoryStore` backs the tests. */
export interface Store {
  getCursor(chainId: number, source: string): Promise<CursorRow | null>;
  setCursor(row: CursorRow): Promise<void>;
  listCursors(): Promise<CursorRow[]>;
  /** Inserts with INSERT OR IGNORE semantics on (chain_id, tx_hash, log_index); returns the rows actually added. */
  insertEvents(rows: readonly EventRow[]): Promise<number>;
  queryEvents(q: EventQuery): Promise<EventRow[]>;
  /** Events with block_time in [fromTime, toTime), oldest first. */
  eventsBetween(chainId: number, fromTime: number, toTime: number): Promise<EventRow[]>;
  /** Every event an address emitted, oldest first. */
  eventsOfAddress(chainId: number, address: string): Promise<EventRow[]>;
  earliestEventTime(chainId: number): Promise<number | null>;
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
