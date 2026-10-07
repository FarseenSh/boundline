import type { Hex } from "viem";

// The API's own records. Partners and their key hashes, idempotency replays, quotes by hash, the lines this API
// has seen (the desk has no enumeration, so /v1/obligations lists these) and the policy versions a partner prepared.

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

export type PolicyVersionStatus = "prepared" | "applied";

export interface PolicyVersionRecord {
  id: string;
  partnerId: Hex;
  status: PolicyVersionStatus;
  note: string;
  /** Field-level diffs against the on-chain policy at preparation time (JSON-safe). */
  changes: unknown[];
  /** The calls the partner admin signs, in order (JSON-safe). */
  calls: unknown[];
  policyVersionBefore: number;
  policyVersionAfter: number | null;
  txHash: string | null;
  createdAt: number;
  appliedAt: number | null;
}

export interface Store {
  findPartnerByKeyHash(hash: string): Promise<PartnerRecord | null>;
  setPartnerPolicyVersion(partnerId: Hex, policyVersion: number): Promise<void>;
  getIdempotent(partnerId: Hex, key: string): Promise<IdempotencyRecord | null>;
  putIdempotent(record: IdempotencyRecord): Promise<void>;
  saveQuote(record: QuoteRecord): Promise<void>;
  rememberLine(record: LineRecord): Promise<void>;
  listLines(partnerId: Hex, limit: number): Promise<LineRecord[]>;
  /** Lines seen for one user address (case-insensitive), any partner. */
  listLinesByUser(user: string, limit: number): Promise<LineRecord[]>;
  savePolicyVersion(record: PolicyVersionRecord): Promise<void>;
  getPolicyVersion(partnerId: Hex, id: string): Promise<PolicyVersionRecord | null>;
  listPolicyVersions(partnerId: Hex, limit: number): Promise<PolicyVersionRecord[]>;
  markPolicyVersionApplied(partnerId: Hex, id: string, policyVersionAfter: number, txHash: string, appliedAt: number): Promise<void>;
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
  SET_PARTNER_POLICY_VERSION: "UPDATE partners SET policy_version = ?2 WHERE partner_id = ?1",
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
  LIST_LINES_BY_USER:
    "SELECT line_id, partner_id, user, market_id, first_seen FROM lines WHERE lower(user) = lower(?1) ORDER BY first_seen DESC, line_id DESC LIMIT ?2",
  SAVE_POLICY_VERSION:
    "INSERT INTO policy_versions (id, partner_id, status, note, changes_json, calls_json, policy_version_before, policy_version_after, tx_hash, created_at, applied_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
  GET_POLICY_VERSION:
    "SELECT id, partner_id, status, note, changes_json, calls_json, policy_version_before, policy_version_after, tx_hash, created_at, applied_at FROM policy_versions WHERE partner_id = ?1 AND id = ?2",
  LIST_POLICY_VERSIONS:
    "SELECT id, partner_id, status, note, changes_json, calls_json, policy_version_before, policy_version_after, tx_hash, created_at, applied_at FROM policy_versions WHERE partner_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2",
  MARK_POLICY_VERSION_APPLIED:
    "UPDATE policy_versions SET status = 'applied', policy_version_after = ?3, tx_hash = ?4, applied_at = ?5 WHERE partner_id = ?1 AND id = ?2",
} as const;

interface PartnerRow { partner_id: string; name: string; api_key_hash: string; policy_version: number; created_at: number }
interface IdempotencyRow { key: string; partner_id: string; request_hash: string; status: number; response_json: string; created_at: number }
interface LineRow { line_id: string; partner_id: string; user: string; market_id: string; first_seen: number }
interface PolicyVersionRow {
  id: string;
  partner_id: string;
  status: string;
  note: string;
  changes_json: string;
  calls_json: string;
  policy_version_before: number;
  policy_version_after: number | null;
  tx_hash: string | null;
  created_at: number;
  applied_at: number | null;
}

function lineOf(row: LineRow): LineRecord {
  return { lineId: String(row.line_id), partnerId: row.partner_id as Hex, user: row.user, marketId: row.market_id as Hex, firstSeen: Number(row.first_seen) };
}

function policyVersionOf(row: PolicyVersionRow): PolicyVersionRecord {
  return {
    id: row.id,
    partnerId: row.partner_id as Hex,
    status: row.status === "applied" ? "applied" : "prepared",
    note: row.note,
    changes: JSON.parse(row.changes_json) as unknown[],
    calls: JSON.parse(row.calls_json) as unknown[],
    policyVersionBefore: Number(row.policy_version_before),
    policyVersionAfter: row.policy_version_after === null || row.policy_version_after === undefined ? null : Number(row.policy_version_after),
    txHash: row.tx_hash ?? null,
    createdAt: Number(row.created_at),
    appliedAt: row.applied_at === null || row.applied_at === undefined ? null : Number(row.applied_at),
  };
}

/** The store over D1 (or anything with D1's prepare/bind/first/all/run). */
export function createD1Store(db: Db): Store {
  return {
    async findPartnerByKeyHash(hash) {
      const row = await db.prepare(SQL.FIND_PARTNER).bind(hash).first<PartnerRow>();
      return row
        ? { partnerId: row.partner_id as Hex, name: row.name, apiKeyHash: row.api_key_hash, policyVersion: Number(row.policy_version), createdAt: Number(row.created_at) }
        : null;
    },
    async setPartnerPolicyVersion(partnerId, policyVersion) {
      await db.prepare(SQL.SET_PARTNER_POLICY_VERSION).bind(partnerId, policyVersion).run();
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
      return results.map(lineOf);
    },
    async listLinesByUser(user, limit) {
      const { results } = await db.prepare(SQL.LIST_LINES_BY_USER).bind(user, limit).all<LineRow>();
      return results.map(lineOf);
    },
    async savePolicyVersion(r) {
      await db
        .prepare(SQL.SAVE_POLICY_VERSION)
        .bind(r.id, r.partnerId, r.status, r.note, JSON.stringify(r.changes), JSON.stringify(r.calls), r.policyVersionBefore, r.policyVersionAfter, r.txHash, r.createdAt, r.appliedAt)
        .run();
    },
    async getPolicyVersion(partnerId, id) {
      const row = await db.prepare(SQL.GET_POLICY_VERSION).bind(partnerId, id).first<PolicyVersionRow>();
      return row ? policyVersionOf(row) : null;
    },
    async listPolicyVersions(partnerId, limit) {
      const { results } = await db.prepare(SQL.LIST_POLICY_VERSIONS).bind(partnerId, limit).all<PolicyVersionRow>();
      return results.map(policyVersionOf);
    },
    async markPolicyVersionApplied(partnerId, id, policyVersionAfter, txHash, appliedAt) {
      await db.prepare(SQL.MARK_POLICY_VERSION_APPLIED).bind(partnerId, id, policyVersionAfter, txHash, appliedAt).run();
    },
  };
}

/** An in-memory store with the same semantics, for tests and local runs. */
export function createMemoryStore(): Store & {
  partners: PartnerRecord[];
  idempotency: Map<string, IdempotencyRecord>;
  quotes: Map<string, QuoteRecord>;
  lines: Map<string, LineRecord>;
  policyVersions: Map<string, PolicyVersionRecord>;
} {
  const partners: PartnerRecord[] = [];
  const idempotency = new Map<string, IdempotencyRecord>();
  const quotes = new Map<string, QuoteRecord>();
  const lines = new Map<string, LineRecord>();
  const policyVersions = new Map<string, PolicyVersionRecord>();
  const byRecency = (a: LineRecord, b: LineRecord) => b.firstSeen - a.firstSeen || Number(BigInt(b.lineId) - BigInt(a.lineId));
  return {
    partners,
    idempotency,
    quotes,
    lines,
    policyVersions,
    async findPartnerByKeyHash(hash) {
      return partners.find((p) => p.apiKeyHash === hash) ?? null;
    },
    async setPartnerPolicyVersion(partnerId, policyVersion) {
      for (const p of partners) if (p.partnerId === partnerId) p.policyVersion = policyVersion;
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
      return [...lines.values()].filter((l) => l.partnerId === partnerId).sort(byRecency).slice(0, limit);
    },
    async listLinesByUser(user, limit) {
      const u = user.toLowerCase();
      return [...lines.values()].filter((l) => l.user.toLowerCase() === u).sort(byRecency).slice(0, limit);
    },
    async savePolicyVersion(r) {
      policyVersions.set(`${r.partnerId}:${r.id}`, { ...r });
    },
    async getPolicyVersion(partnerId, id) {
      const r = policyVersions.get(`${partnerId}:${id}`);
      return r ? { ...r } : null;
    },
    async listPolicyVersions(partnerId, limit) {
      return [...policyVersions.values()]
        .filter((v) => v.partnerId === partnerId)
        .sort((a, b) => b.createdAt - a.createdAt || (b.id > a.id ? 1 : -1))
        .slice(0, limit)
        .map((v) => ({ ...v }));
    },
    async markPolicyVersionApplied(partnerId, id, policyVersionAfter, txHash, appliedAt) {
      const r = policyVersions.get(`${partnerId}:${id}`);
      if (r) Object.assign(r, { status: "applied", policyVersionAfter, txHash, appliedAt });
    },
  };
}
