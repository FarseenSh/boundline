import type { Hex } from "viem";

// The API's own records. Partners and their key hashes, idempotency replays, quotes by hash and the
// lines this API has seen (the desk has no enumeration, so /v1/obligations lists these).

export interface PartnerRecord {
  /** bytes32 hex, lowercase; the same id the desk uses. */
  partnerId: Hex;
  name: string;
  apiKeyHash: string;
  policyVersion: number;
  createdAt: number;
}

export interface IdempotencyRecord {
  key: string;
  partnerId: Hex;
  requestHash: string;
  status: number;
  responseJson: string;
  createdAt: number;
}

export interface QuoteRecord {
  quoteHash: Hex;
  partnerId: Hex;
  requestJson: string;
  responseJson: string;
  createdAt: number;
}

export interface LineRecord {
  lineId: string;
  partnerId: Hex;
  user: string;
  marketId: Hex;
  firstSeen: number;
}

export interface Store {
  findPartnerByKeyHash(hash: string): Promise<PartnerRecord | null>;
  getIdempotent(partnerId: Hex, key: string): Promise<IdempotencyRecord | null>;
  putIdempotent(record: IdempotencyRecord): Promise<void>;
  saveQuote(record: QuoteRecord): Promise<void>;
  rememberLine(record: LineRecord): Promise<void>;
  listLines(partnerId: Hex, limit: number): Promise<LineRecord[]>;
}

/** The slice of D1Database the store uses; a fake with the same shape serves the tests. */
export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface Db {
  prepare(sql: string): DbStatement;
}

export const SQL = {
  FIND_PARTNER: "SELECT partner_id, name, api_key_hash, policy_version, created_at FROM partners WHERE api_key_hash = ?1",
  GET_IDEMPOTENT:
    "SELECT key, partner_id, request_hash, status, response_json, created_at FROM idempotency WHERE partner_id = ?1 AND key = ?2",
  PUT_IDEMPOTENT:
    "INSERT OR REPLACE INTO idempotency (key, partner_id, request_hash, status, response_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  SAVE_QUOTE:
    "INSERT OR IGNORE INTO quotes (quote_hash, partner_id, request_json, response_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  REMEMBER_LINE:
    "INSERT OR IGNORE INTO lines (line_id, partner_id, user, market_id, first_seen) VALUES (?1, ?2, ?3, ?4, ?5)",
  LIST_LINES:
    "SELECT line_id, partner_id, user, market_id, first_seen FROM lines WHERE partner_id = ?1 ORDER BY first_seen DESC, line_id DESC LIMIT ?2",
} as const;

interface PartnerRow { partner_id: string; name: string; api_key_hash: string; policy_version: number; created_at: number }
interface IdempotencyRow { key: string; partner_id: string; request_hash: string; status: number; response_json: string; created_at: number }
interface LineRow { line_id: string; partner_id: string; user: string; market_id: string; first_seen: number }

/** The store over D1 (or anything with D1's prepare/bind/first/all/run). */
export function createD1Store(db: Db): Store {
  return {
    async findPartnerByKeyHash(hash) {
      const row = await db.prepare(SQL.FIND_PARTNER).bind(hash).first<PartnerRow>();
      return row
        ? { partnerId: row.partner_id as Hex, name: row.name, apiKeyHash: row.api_key_hash, policyVersion: Number(row.policy_version), createdAt: Number(row.created_at) }
        : null;
    },
    async getIdempotent(partnerId, key) {
      const row = await db.prepare(SQL.GET_IDEMPOTENT).bind(partnerId, key).first<IdempotencyRow>();
      return row
        ? { key: row.key, partnerId: row.partner_id as Hex, requestHash: row.request_hash, status: Number(row.status), responseJson: row.response_json, createdAt: Number(row.created_at) }
        : null;
    },
    async putIdempotent(r) {
      await db.prepare(SQL.PUT_IDEMPOTENT).bind(r.key, r.partnerId, r.requestHash, r.status, r.responseJson, r.createdAt).run();
    },
    async saveQuote(r) {
      await db.prepare(SQL.SAVE_QUOTE).bind(r.quoteHash, r.partnerId, r.requestJson, r.responseJson, r.createdAt).run();
    },
    async rememberLine(r) {
      await db.prepare(SQL.REMEMBER_LINE).bind(r.lineId, r.partnerId, r.user, r.marketId, r.firstSeen).run();
    },
    async listLines(partnerId, limit) {
      const { results } = await db.prepare(SQL.LIST_LINES).bind(partnerId, limit).all<LineRow>();
      return results.map((row) => ({ lineId: String(row.line_id), partnerId: row.partner_id as Hex, user: row.user, marketId: row.market_id as Hex, firstSeen: Number(row.first_seen) }));
    },
  };
}

/** An in-memory store with the same semantics, for tests and local runs. */
export function createMemoryStore(): Store & {
  partners: PartnerRecord[];
  idempotency: Map<string, IdempotencyRecord>;
  quotes: Map<string, QuoteRecord>;
  lines: Map<string, LineRecord>;
} {
  const partners: PartnerRecord[] = [];
  const idempotency = new Map<string, IdempotencyRecord>();
  const quotes = new Map<string, QuoteRecord>();
  const lines = new Map<string, LineRecord>();
  return {
    partners,
    idempotency,
    quotes,
    lines,
    async findPartnerByKeyHash(hash) {
      return partners.find((p) => p.apiKeyHash === hash) ?? null;
    },
    async getIdempotent(partnerId, key) {
      return idempotency.get(`${partnerId}:${key}`) ?? null;
    },
    async putIdempotent(r) {
      idempotency.set(`${r.partnerId}:${r.key}`, r);
    },
    async saveQuote(r) {
      if (!quotes.has(r.quoteHash)) quotes.set(r.quoteHash, r);
    },
    async rememberLine(r) {
      if (!lines.has(r.lineId)) lines.set(r.lineId, r);
    },
    async listLines(partnerId, limit) {
      return [...lines.values()]
        .filter((l) => l.partnerId === partnerId)
        .sort((a, b) => b.firstSeen - a.firstSeen || Number(BigInt(b.lineId) - BigInt(a.lineId)))
        .slice(0, limit);
    },
  };
}
