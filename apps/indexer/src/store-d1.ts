import type { Hex } from "viem";
import type { EventRow } from "./decode.js";
import { queryAddresses, queryNames, type CursorRow, type DailyRootRow, type EventQuery, type ReconciliationRow, type ReconciliationStatus, type Store } from "./store.js";

const EVENT_COLUMNS = "chain_id, block_number, block_time, tx_hash, log_index, address, topic0, name, args_json";
const INSERT_EVENT = `INSERT OR IGNORE INTO events (${EVENT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`;
const BATCH = 100;

interface EventRecord {
  chain_id: number;
  block_number: number;
  block_time: number;
  tx_hash: string;
  log_index: number;
  address: string;
  topic0: string;
  name: string;
  args_json: string;
}
interface CursorRecord {
  chain_id: number;
  source: string;
  last_block: number;
  last_block_time: number;
  updated_at: number;
}
interface RootRecord {
  chain_id: number;
  day: string;
  first_block: number | null;
  last_block: number | null;
  event_count: number;
  prev_root: string;
  root: string;
  computed_at: number;
}
interface ReconciliationRecord {
  id: number;
  chain_id: number;
  subject: string;
  checked_at: number;
  block_number: number;
  expected_json: string;
  actual_json: string;
  status: string;
}

function toEvent(r: EventRecord): EventRow {
  return {
    chainId: r.chain_id,
    blockNumber: r.block_number,
    blockTime: r.block_time,
    txHash: r.tx_hash as Hex,
    logIndex: r.log_index,
    address: r.address as `0x${string}`,
    topic0: r.topic0 as Hex,
    name: r.name,
    argsJson: r.args_json,
  };
}
function toCursor(r: CursorRecord): CursorRow {
  return { chainId: r.chain_id, source: r.source, lastBlock: r.last_block, lastBlockTime: r.last_block_time, updatedAt: r.updated_at };
}
function toRoot(r: RootRecord): DailyRootRow {
  return {
    chainId: r.chain_id,
    day: r.day,
    firstBlock: r.first_block,
    lastBlock: r.last_block,
    eventCount: r.event_count,
    prevRoot: r.prev_root as Hex,
    root: r.root as Hex,
    computedAt: r.computed_at,
  };
}
function toReconciliation(r: ReconciliationRecord): ReconciliationRow {
  return {
    id: r.id,
    chainId: r.chain_id,
    subject: r.subject,
    checkedAt: r.checked_at,
    blockNumber: r.block_number,
    expectedJson: r.expected_json,
    actualJson: r.actual_json,
    status: r.status as ReconciliationStatus,
  };
}

/** The parameterised SELECT behind `queryEvents`: every filter is optional, pages run newest first. Exported for tests. */
export function buildEventQuery(q: EventQuery): { sql: string; params: unknown[] } {
  const where: string[] = ["chain_id = ?"];
  const params: unknown[] = [q.chainId];
  const addresses = queryAddresses(q);
  if (addresses.length === 1) {
    where.push("address = ?");
    params.push(addresses[0]);
  } else if (addresses.length > 1) {
    where.push(`address IN (${addresses.map(() => "?").join(", ")})`);
    params.push(...addresses);
  }
  const names = queryNames(q);
  if (names.length === 1) {
    where.push("name = ?");
    params.push(names[0]);
  } else if (names.length > 1) {
    where.push(`name IN (${names.map(() => "?").join(", ")})`);
    params.push(...names);
  }
  if (q.fromBlock !== undefined) {
    where.push("block_number >= ?");
    params.push(q.fromBlock);
  }
  if (q.toBlock !== undefined) {
    where.push("block_number <= ?");
    params.push(q.toBlock);
  }
  if (q.fromTime !== undefined) {
    where.push("block_time >= ?");
    params.push(q.fromTime);
  }
  if (q.argsContains !== undefined && q.argsContains !== "") {
    // instr, not LIKE: the needle is a literal substring of the canonical JSON, and D1 rejects LIKE patterns
    // longer than about 50 bytes ("LIKE or GLOB pattern too complex"), which a bytes32 argument always is.
    where.push("instr(args_json, ?) > 0");
    params.push(q.argsContains);
  }
  if (q.before !== undefined) {
    where.push("(block_number < ? OR (block_number = ? AND log_index < ?))");
    params.push(q.before.blockNumber, q.before.blockNumber, q.before.logIndex);
  }
  params.push(q.limit);
  return { sql: `SELECT ${EVENT_COLUMNS} FROM events WHERE ${where.join(" AND ")} ORDER BY block_number DESC, log_index DESC LIMIT ?`, params };
}

/** The D1-backed Store. Every statement is parameterised; inserts run in batches of 100. */
export class D1Store implements Store {
  constructor(private readonly db: D1Database) {}

  async getCursor(chainId: number, source: string): Promise<CursorRow | null> {
    const r = await this.db
      .prepare("SELECT chain_id, source, last_block, last_block_time, updated_at FROM cursors WHERE chain_id = ?1 AND source = ?2")
      .bind(chainId, source)
      .first<CursorRecord>();
    return r ? toCursor(r) : null;
  }
  async setCursor(row: CursorRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO cursors (chain_id, source, last_block, last_block_time, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (chain_id, source) DO UPDATE SET last_block = excluded.last_block, last_block_time = excluded.last_block_time, updated_at = excluded.updated_at`,
      )
      .bind(row.chainId, row.source, row.lastBlock, row.lastBlockTime, row.updatedAt)
      .run();
  }
  async listCursors(): Promise<CursorRow[]> {
    const { results } = await this.db
      .prepare("SELECT chain_id, source, last_block, last_block_time, updated_at FROM cursors ORDER BY chain_id, source")
      .all<CursorRecord>();
    return results.map(toCursor);
  }
  async insertEvents(rows: readonly EventRow[]): Promise<number> {
    let added = 0;
    const stmt = this.db.prepare(INSERT_EVENT);
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows
        .slice(i, i + BATCH)
        .map((e) => stmt.bind(e.chainId, e.blockNumber, e.blockTime, e.txHash, e.logIndex, e.address, e.topic0, e.name, e.argsJson));
      const results = await this.db.batch(chunk);
      for (const r of results) added += r.meta.changes ?? 0;
    }
    return added;
  }
  async queryEvents(q: EventQuery): Promise<EventRow[]> {
    const { sql, params } = buildEventQuery(q);
    const { results } = await this.db.prepare(sql).bind(...params).all<EventRecord>();
    return results.map(toEvent);
  }
  async eventsBetween(chainId: number, fromTime: number, toTime: number): Promise<EventRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE chain_id = ?1 AND block_time >= ?2 AND block_time < ?3 ORDER BY block_number, log_index`)
      .bind(chainId, fromTime, toTime)
      .all<EventRecord>();
    return results.map(toEvent);
  }
  async eventsOfAddress(chainId: number, address: string): Promise<EventRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE chain_id = ?1 AND address = ?2 ORDER BY block_number, log_index`)
      .bind(chainId, address.toLowerCase())
      .all<EventRecord>();
    return results.map(toEvent);
  }
  async earliestEventTime(chainId: number): Promise<number | null> {
    const r = await this.db.prepare("SELECT MIN(block_time) AS t FROM events WHERE chain_id = ?1").bind(chainId).first<{ t: number | null }>();
    return r?.t ?? null;
  }
  async getRoot(chainId: number, day: string): Promise<DailyRootRow | null> {
    const r = await this.db
      .prepare("SELECT chain_id, day, first_block, last_block, event_count, prev_root, root, computed_at FROM daily_roots WHERE chain_id = ?1 AND day = ?2")
      .bind(chainId, day)
      .first<RootRecord>();
    return r ? toRoot(r) : null;
  }
  async latestRoot(chainId: number): Promise<DailyRootRow | null> {
    const rows = await this.listRoots(chainId, 1);
    return rows[0] ?? null;
  }
  async listRoots(chainId: number, limit: number): Promise<DailyRootRow[]> {
    const { results } = await this.db
      .prepare("SELECT chain_id, day, first_block, last_block, event_count, prev_root, root, computed_at FROM daily_roots WHERE chain_id = ?1 ORDER BY day DESC LIMIT ?2")
      .bind(chainId, limit)
      .all<RootRecord>();
    return results.map(toRoot);
  }
  async putRoot(row: DailyRootRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO daily_roots (chain_id, day, first_block, last_block, event_count, prev_root, root, computed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (chain_id, day) DO UPDATE SET first_block = excluded.first_block, last_block = excluded.last_block, event_count = excluded.event_count,
           prev_root = excluded.prev_root, root = excluded.root, computed_at = excluded.computed_at`,
      )
      .bind(row.chainId, row.day, row.firstBlock, row.lastBlock, row.eventCount, row.prevRoot, row.root, row.computedAt)
      .run();
  }
  async insertReconciliations(rows: readonly ReconciliationRow[]): Promise<void> {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      "INSERT INTO reconciliations (chain_id, subject, checked_at, block_number, expected_json, actual_json, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    );
    for (let i = 0; i < rows.length; i += BATCH) {
      await this.db.batch(
        rows.slice(i, i + BATCH).map((r) => stmt.bind(r.chainId, r.subject, r.checkedAt, r.blockNumber, r.expectedJson, r.actualJson, r.status)),
      );
    }
  }
  async latestReconciliations(chainId: number): Promise<ReconciliationRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, chain_id, subject, checked_at, block_number, expected_json, actual_json, status FROM reconciliations
         WHERE chain_id = ?1 AND checked_at = (SELECT MAX(checked_at) FROM reconciliations WHERE chain_id = ?1) ORDER BY id`,
      )
      .bind(chainId)
      .all<ReconciliationRecord>();
    return results.map(toReconciliation);
  }
}
