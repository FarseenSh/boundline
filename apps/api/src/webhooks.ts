// Webhooks (plan M7): partners register an HTTPS endpoint and receive signed POSTs when a line enters grace, is
// protected, held, released, recovered or settled. Two sources feed the partner-scoped event log:
//   - the keeper, through the `Events` RPC entrypoint (index.ts): grace entry and exit, a protective action armed;
//   - the indexer, polled by this Worker's cron: the desk's HOLD/RELEASE decisions and the protection contracts'
//     executed events (DeskProtectionVault `Protected`, `AdvanceSettled`, `CollateralRecovered`; the Protector's
//     `Protected` for a pre-liquidation).
// Every delivery is signed `Boundline-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>` (Web Crypto, so
// the cost is native and not JavaScript CPU), retried by the cron with backoff 1, 2, 4, 8, 16 minutes, at most six
// attempts. Ingest is idempotent: each event carries a dedupe key (indexer: chain, transaction and log index).
import type { Hex } from "viem";
import { sha256Hex } from "./auth.js";
import type { Db, LineRecord, Store } from "./db.js";
import { formatUsdc } from "./rounding.js";

export const EVENT_TYPES = ["grace", "grace.cleared", "protect", "hold", "release", "recovery", "settle"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type AnyEventType = EventType | "ping";
export const MAX_ATTEMPTS = 6;
/** Minutes to wait after failed attempt n (1-based) before attempt n + 1. */
export const BACKOFF_MINUTES = [1, 2, 4, 8, 16] as const;
export const MAX_WEBHOOKS_PER_PARTNER = 10;
export const ECHO_KEEP = 20;
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_URL = 2_048;
const MAX_DESCRIPTION = 200;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** What the keeper sends through the `Events` entrypoint (the lane contract of 8 Oct 2026). */
export interface KeeperEvent {
  type: EventType;
  chainId: number;
  at: number;
  source: "keeper" | "indexer";
  lineId?: string;
  borrower?: string;
  txHash?: string;
  decisionHash?: string;
  data: Record<string, string | number | boolean | null>;
}

// ---------------------------------------------------------------- records

export interface WebhookRecord {
  id: string;
  partnerId: string;
  url: string;
  events: string[];
  description: string;
  secret: string;
  active: boolean;
  createdAt: number;
}

export interface EventRecord {
  id: string;
  partnerId: string;
  type: AnyEventType;
  chainId: number;
  source: "keeper" | "indexer" | "api";
  at: number;
  lineId: string | null;
  borrower: string | null;
  txHash: string | null;
  decisionHash: string | null;
  data: Record<string, string | number | boolean | null>;
  dedupeKey: string;
  backfill: boolean;
  createdAt: number;
}

export type DeliveryStatus = "pending" | "delivered" | "failed";

export interface DeliveryRecord {
  id: string;
  webhookId: string;
  eventId: string;
  partnerId: string;
  type: AnyEventType;
  status: DeliveryStatus;
  attempts: number;
  lastCode: number | null;
  lastError: string | null;
  lastAttemptAt: number | null;
  nextAttemptAt: number | null;
  payload: string;
  payloadHash: string;
  createdAt: number;
}

export interface EchoRecord {
  seq?: number;
  token: string;
  receivedAt: number;
  deliveryId: string | null;
  eventType: string | null;
  signatureValid: boolean;
  verification: string;
  body: string;
  headers: Record<string, string>;
}

export interface WebhookStore {
  createWebhook(r: WebhookRecord): Promise<void>;
  listWebhooks(partnerId: string): Promise<WebhookRecord[]>;
  getWebhook(id: string): Promise<WebhookRecord | null>;
  /** Soft delete: the endpoint stops receiving; its delivery history stays. False when there was no such active webhook. */
  deactivateWebhook(partnerId: string, id: string): Promise<boolean>;
  countWebhooks(partnerId: string): Promise<number>;
  /** False when the dedupe key was already ingested. */
  insertEvent(r: EventRecord): Promise<boolean>;
  listEvents(partnerId: string, limit: number): Promise<EventRecord[]>;
  insertDelivery(r: DeliveryRecord): Promise<void>;
  getDelivery(id: string): Promise<DeliveryRecord | null>;
  listDeliveries(webhookId: string, limit: number): Promise<DeliveryRecord[]>;
  lastDelivery(webhookId: string): Promise<DeliveryRecord | null>;
  dueDeliveries(now: number, limit: number): Promise<DeliveryRecord[]>;
  updateDelivery(id: string, f: Pick<DeliveryRecord, "status" | "attempts" | "lastCode" | "lastError" | "lastAttemptAt" | "nextAttemptAt">): Promise<void>;
  saveEcho(r: EchoRecord, keep: number): Promise<void>;
  listEcho(token: string, limit: number): Promise<EchoRecord[]>;
  getCursor(source: string): Promise<number | null>;
  putCursor(source: string, lastBlock: number, now: number): Promise<void>;
}

// ---------------------------------------------------------------- D1

export const WSQL = {
  INSERT_WEBHOOK: "INSERT INTO webhooks (id, partner_id, url, events_json, description, secret, active, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  LIST_WEBHOOKS:
    "SELECT id, partner_id, url, events_json, description, secret, active, created_at FROM webhooks WHERE partner_id = ?1 AND active = 1 ORDER BY created_at DESC, id DESC",
  GET_WEBHOOK: "SELECT id, partner_id, url, events_json, description, secret, active, created_at FROM webhooks WHERE id = ?1",
  DEACTIVATE_WEBHOOK: "UPDATE webhooks SET active = 0 WHERE partner_id = ?1 AND id = ?2 AND active = 1",
  COUNT_WEBHOOKS: "SELECT COUNT(*) AS n FROM webhooks WHERE partner_id = ?1 AND active = 1",
  INSERT_EVENT:
    "INSERT OR IGNORE INTO webhook_events (id, partner_id, type, chain_id, source, at, line_id, borrower, tx_hash, decision_hash, data_json, dedupe_key, backfill, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
  LIST_EVENTS:
    "SELECT id, partner_id, type, chain_id, source, at, line_id, borrower, tx_hash, decision_hash, data_json, dedupe_key, backfill, created_at FROM webhook_events WHERE partner_id = ?1 ORDER BY at DESC, created_at DESC, id DESC LIMIT ?2",
  INSERT_DELIVERY:
    "INSERT OR IGNORE INTO webhook_deliveries (id, webhook_id, event_id, partner_id, type, status, attempts, last_code, last_error, last_attempt_at, next_attempt_at, payload, payload_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
  GET_DELIVERY:
    "SELECT id, webhook_id, event_id, partner_id, type, status, attempts, last_code, last_error, last_attempt_at, next_attempt_at, payload, payload_hash, created_at FROM webhook_deliveries WHERE id = ?1",
  LIST_DELIVERIES:
    "SELECT id, webhook_id, event_id, partner_id, type, status, attempts, last_code, last_error, last_attempt_at, next_attempt_at, payload, payload_hash, created_at FROM webhook_deliveries WHERE webhook_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2",
  LAST_DELIVERY:
    "SELECT id, webhook_id, event_id, partner_id, type, status, attempts, last_code, last_error, last_attempt_at, next_attempt_at, payload, payload_hash, created_at FROM webhook_deliveries WHERE webhook_id = ?1 AND last_attempt_at IS NOT NULL ORDER BY last_attempt_at DESC, id DESC LIMIT 1",
  DUE_DELIVERIES:
    "SELECT id, webhook_id, event_id, partner_id, type, status, attempts, last_code, last_error, last_attempt_at, next_attempt_at, payload, payload_hash, created_at FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ?1 ORDER BY next_attempt_at, created_at LIMIT ?2",
  UPDATE_DELIVERY:
    "UPDATE webhook_deliveries SET status = ?2, attempts = ?3, last_code = ?4, last_error = ?5, last_attempt_at = ?6, next_attempt_at = ?7 WHERE id = ?1",
  INSERT_ECHO:
    "INSERT INTO webhook_echo (token, received_at, delivery_id, event_type, signature_valid, verification, body, headers_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  PRUNE_ECHO: "DELETE FROM webhook_echo WHERE token = ?1 AND seq NOT IN (SELECT seq FROM webhook_echo WHERE token = ?1 ORDER BY seq DESC LIMIT ?2)",
  LIST_ECHO:
    "SELECT seq, token, received_at, delivery_id, event_type, signature_valid, verification, body, headers_json FROM webhook_echo WHERE token = ?1 ORDER BY seq DESC LIMIT ?2",
  GET_CURSOR: "SELECT source, last_block, updated_at FROM poll_cursors WHERE source = ?1",
  PUT_CURSOR: "INSERT OR REPLACE INTO poll_cursors (source, last_block, updated_at) VALUES (?1, ?2, ?3)",
} as const;

interface WebhookRow { id: string; partner_id: string; url: string; events_json: string; description: string; secret: string; active: number; created_at: number }
interface EventRow {
  id: string; partner_id: string; type: string; chain_id: number; source: string; at: number; line_id: string | null; borrower: string | null;
  tx_hash: string | null; decision_hash: string | null; data_json: string; dedupe_key: string; backfill: number; created_at: number;
}
interface DeliveryRow {
  id: string; webhook_id: string; event_id: string; partner_id: string; type: string; status: string; attempts: number; last_code: number | null;
  last_error: string | null; last_attempt_at: number | null; next_attempt_at: number | null; payload: string; payload_hash: string; created_at: number;
}
interface EchoRow { seq: number; token: string; received_at: number; delivery_id: string | null; event_type: string | null; signature_valid: number; verification: string; body: string; headers_json: string }

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function webhookOf(r: WebhookRow): WebhookRecord {
  return { id: r.id, partnerId: r.partner_id, url: r.url, events: JSON.parse(r.events_json) as string[], description: r.description, secret: r.secret, active: Number(r.active) === 1, createdAt: Number(r.created_at) };
}
function eventOf(r: EventRow): EventRecord {
  return {
    id: r.id, partnerId: r.partner_id, type: r.type as AnyEventType, chainId: Number(r.chain_id), source: r.source as EventRecord["source"], at: Number(r.at),
    lineId: r.line_id ?? null, borrower: r.borrower ?? null, txHash: r.tx_hash ?? null, decisionHash: r.decision_hash ?? null,
    data: JSON.parse(r.data_json) as EventRecord["data"], dedupeKey: r.dedupe_key, backfill: Number(r.backfill) === 1, createdAt: Number(r.created_at),
  };
}
function deliveryOf(r: DeliveryRow): DeliveryRecord {
  return {
    id: r.id, webhookId: r.webhook_id, eventId: r.event_id, partnerId: r.partner_id, type: r.type as AnyEventType, status: r.status as DeliveryStatus,
    attempts: Number(r.attempts), lastCode: num(r.last_code), lastError: r.last_error ?? null, lastAttemptAt: num(r.last_attempt_at), nextAttemptAt: num(r.next_attempt_at),
    payload: r.payload, payloadHash: r.payload_hash, createdAt: Number(r.created_at),
  };
}
function echoOf(r: EchoRow): EchoRecord {
  return {
    seq: Number(r.seq), token: r.token, receivedAt: Number(r.received_at), deliveryId: r.delivery_id ?? null, eventType: r.event_type ?? null,
    signatureValid: Number(r.signature_valid) === 1, verification: r.verification, body: r.body, headers: JSON.parse(r.headers_json) as Record<string, string>,
  };
}

/** Rows changed by a D1 `run()` (0 for an ignored INSERT OR IGNORE). */
function changes(res: unknown): number {
  const meta = (res as { meta?: { changes?: number } } | null)?.meta;
  return typeof meta?.changes === "number" ? meta.changes : 1;
}

export function createD1WebhookStore(db: Db): WebhookStore {
  return {
    async createWebhook(r) {
      await db.prepare(WSQL.INSERT_WEBHOOK).bind(r.id, r.partnerId, r.url, JSON.stringify(r.events), r.description, r.secret, r.active ? 1 : 0, r.createdAt).run();
    },
    async listWebhooks(partnerId) {
      return (await db.prepare(WSQL.LIST_WEBHOOKS).bind(partnerId).all<WebhookRow>()).results.map(webhookOf);
    },
    async getWebhook(id) {
      const row = await db.prepare(WSQL.GET_WEBHOOK).bind(id).first<WebhookRow>();
      return row ? webhookOf(row) : null;
    },
    async deactivateWebhook(partnerId, id) {
      return changes(await db.prepare(WSQL.DEACTIVATE_WEBHOOK).bind(partnerId, id).run()) > 0;
    },
    async countWebhooks(partnerId) {
      const row = await db.prepare(WSQL.COUNT_WEBHOOKS).bind(partnerId).first<{ n: number }>();
      return Number(row?.n ?? 0);
    },
    async insertEvent(r) {
      const res = await db
        .prepare(WSQL.INSERT_EVENT)
        .bind(r.id, r.partnerId, r.type, r.chainId, r.source, r.at, r.lineId, r.borrower, r.txHash, r.decisionHash, JSON.stringify(r.data), r.dedupeKey, r.backfill ? 1 : 0, r.createdAt)
        .run();
      return changes(res) > 0;
    },
    async listEvents(partnerId, limit) {
      return (await db.prepare(WSQL.LIST_EVENTS).bind(partnerId, limit).all<EventRow>()).results.map(eventOf);
    },
    async insertDelivery(r) {
      await db
        .prepare(WSQL.INSERT_DELIVERY)
        .bind(r.id, r.webhookId, r.eventId, r.partnerId, r.type, r.status, r.attempts, r.lastCode, r.lastError, r.lastAttemptAt, r.nextAttemptAt, r.payload, r.payloadHash, r.createdAt)
        .run();
    },
    async getDelivery(id) {
      const row = await db.prepare(WSQL.GET_DELIVERY).bind(id).first<DeliveryRow>();
      return row ? deliveryOf(row) : null;
    },
    async listDeliveries(webhookId, limit) {
      return (await db.prepare(WSQL.LIST_DELIVERIES).bind(webhookId, limit).all<DeliveryRow>()).results.map(deliveryOf);
    },
    async lastDelivery(webhookId) {
      const row = await db.prepare(WSQL.LAST_DELIVERY).bind(webhookId).first<DeliveryRow>();
      return row ? deliveryOf(row) : null;
    },
    async dueDeliveries(now, limit) {
      return (await db.prepare(WSQL.DUE_DELIVERIES).bind(now, limit).all<DeliveryRow>()).results.map(deliveryOf);
    },
    async updateDelivery(id, f) {
      await db.prepare(WSQL.UPDATE_DELIVERY).bind(id, f.status, f.attempts, f.lastCode, f.lastError, f.lastAttemptAt, f.nextAttemptAt).run();
    },
    async saveEcho(r, keep) {
      await db.prepare(WSQL.INSERT_ECHO).bind(r.token, r.receivedAt, r.deliveryId, r.eventType, r.signatureValid ? 1 : 0, r.verification, r.body, JSON.stringify(r.headers)).run();
      await db.prepare(WSQL.PRUNE_ECHO).bind(r.token, keep).run();
    },
    async listEcho(token, limit) {
      return (await db.prepare(WSQL.LIST_ECHO).bind(token, limit).all<EchoRow>()).results.map(echoOf);
    },
    async getCursor(source) {
      const row = await db.prepare(WSQL.GET_CURSOR).bind(source).first<{ last_block: number }>();
      return row ? Number(row.last_block) : null;
    },
    async putCursor(source, lastBlock, now) {
      await db.prepare(WSQL.PUT_CURSOR).bind(source, lastBlock, now).run();
    },
  };
}

/** The same semantics in memory, for tests. */
export function createMemoryWebhookStore(): WebhookStore & { webhooks: WebhookRecord[]; events: EventRecord[]; deliveries: DeliveryRecord[]; echo: EchoRecord[]; cursors: Map<string, number> } {
  const webhooks: WebhookRecord[] = [];
  const events: EventRecord[] = [];
  const deliveries: DeliveryRecord[] = [];
  const echo: EchoRecord[] = [];
  const cursors = new Map<string, number>();
  let seq = 0;
  const desc = <T extends { createdAt: number; id: string }>(a: T, b: T) => b.createdAt - a.createdAt || (b.id > a.id ? 1 : -1);
  return {
    webhooks, events, deliveries, echo, cursors,
    async createWebhook(r) { webhooks.push({ ...r }); },
    async listWebhooks(partnerId) { return webhooks.filter((w) => w.partnerId === partnerId && w.active).sort(desc).map((w) => ({ ...w })); },
    async getWebhook(id) { const w = webhooks.find((x) => x.id === id); return w ? { ...w } : null; },
    async deactivateWebhook(partnerId, id) {
      const w = webhooks.find((x) => x.id === id && x.partnerId === partnerId && x.active);
      if (!w) return false;
      w.active = false;
      return true;
    },
    async countWebhooks(partnerId) { return webhooks.filter((w) => w.partnerId === partnerId && w.active).length; },
    async insertEvent(r) {
      if (events.some((e) => e.dedupeKey === r.dedupeKey)) return false;
      events.push({ ...r });
      return true;
    },
    async listEvents(partnerId, limit) {
      return events.filter((e) => e.partnerId === partnerId).sort((a, b) => b.at - a.at || b.createdAt - a.createdAt || (b.id > a.id ? 1 : -1)).slice(0, limit).map((e) => ({ ...e }));
    },
    async insertDelivery(r) { if (!deliveries.some((d) => d.webhookId === r.webhookId && d.eventId === r.eventId)) deliveries.push({ ...r }); },
    async getDelivery(id) { const d = deliveries.find((x) => x.id === id); return d ? { ...d } : null; },
    async listDeliveries(webhookId, limit) { return deliveries.filter((d) => d.webhookId === webhookId).sort(desc).slice(0, limit).map((d) => ({ ...d })); },
    async lastDelivery(webhookId) {
      const d = deliveries.filter((x) => x.webhookId === webhookId && x.lastAttemptAt !== null).sort((a, b) => (b.lastAttemptAt ?? 0) - (a.lastAttemptAt ?? 0) || (b.id > a.id ? 1 : -1))[0];
      return d ? { ...d } : null;
    },
    async dueDeliveries(now, limit) {
      return deliveries.filter((d) => d.status === "pending" && (d.nextAttemptAt ?? Infinity) <= now).sort((a, b) => (a.nextAttemptAt ?? 0) - (b.nextAttemptAt ?? 0) || a.createdAt - b.createdAt).slice(0, limit).map((d) => ({ ...d }));
    },
    async updateDelivery(id, f) { const d = deliveries.find((x) => x.id === id); if (d) Object.assign(d, f); },
    async saveEcho(r, keep) {
      echo.push({ ...r, seq: ++seq });
      const mine = echo.filter((e) => e.token === r.token).sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
      for (const old of mine.slice(keep)) echo.splice(echo.indexOf(old), 1);
    },
    async listEcho(token, limit) { return echo.filter((e) => e.token === token).sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0)).slice(0, limit).map((e) => ({ ...e })); },
    async getCursor(source) { return cursors.has(source) ? (cursors.get(source) as number) : null; },
    async putCursor(source, lastBlock) { cursors.set(source, lastBlock); },
  };
}

// ---------------------------------------------------------------- signatures

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** `t=<unix>,v1=<hex>` over `t + "." + body`. */
export async function signatureHeader(secret: string, t: number, body: string): Promise<string> {
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`;
}

export function parseSignatureHeader(header: string | null | undefined): { t: number; v1: string[] } | null {
  if (!header) return null;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((x) => x.trim());
    if (k === "t" && v && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && v && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
  }
  return t === null || v1.length === 0 ? null : { t, v1 };
}

function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** "valid", or why not: the receiver side of the scheme, exactly what a partner implements. */
export async function verifySignature(secret: string, header: string | null | undefined, body: string, now: number, toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS): Promise<string> {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return "bad signature header";
  if (Math.abs(now - parsed.t) > toleranceSeconds) return "timestamp outside tolerance";
  const expected = await hmacSha256Hex(secret, `${parsed.t}.${body}`);
  return parsed.v1.some((v) => equalHex(v, expected)) ? "valid" : "signature mismatch";
}

export function newWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------- validation

export function validWebhookUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.length > 0 && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

export function parseWebhookBody(body: Record<string, unknown>): { url: string; events: string[]; description: string } | { error: string } {
  const url = validWebhookUrl(body.url);
  if (!url) return { error: "url must be an https URL of at most 2048 characters" };
  if (!Array.isArray(body.events) || body.events.length === 0) return { error: `events must be a non-empty array of ${[...EVENT_TYPES, "*"].join(", ")}` };
  const events: string[] = [];
  for (const e of body.events) {
    if (typeof e !== "string" || (e !== "*" && !(EVENT_TYPES as readonly string[]).includes(e))) return { error: `unknown event ${String(e)}: use ${[...EVENT_TYPES, "*"].join(", ")}` };
    if (!events.includes(e)) events.push(e);
  }
  if (events.includes("*") && events.length > 1) return { error: "\"*\" already subscribes to every event; give it alone" };
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (description.length > MAX_DESCRIPTION) return { error: `description must be at most ${MAX_DESCRIPTION} characters` };
  return { url, events, description };
}

function subscribed(w: WebhookRecord, type: AnyEventType): boolean {
  return w.active && (type === "ping" || w.events.includes("*") || w.events.includes(type));
}

type Primitive = string | number | boolean | null;

/** Validates what the keeper sent; data values must be primitives (the envelope is JSON, not a nested document). */
export function validateKeeperEvent(evt: unknown): KeeperEvent | { error: string } {
  if (!evt || typeof evt !== "object" || Array.isArray(evt)) return { error: "event must be an object" };
  const e = evt as Record<string, unknown>;
  if (typeof e.type !== "string" || !(EVENT_TYPES as readonly string[]).includes(e.type)) return { error: `type must be one of ${EVENT_TYPES.join(", ")}` };
  if (typeof e.chainId !== "number" || !Number.isInteger(e.chainId) || e.chainId <= 0) return { error: "chainId must be a positive integer" };
  if (typeof e.at !== "number" || !Number.isInteger(e.at) || e.at <= 0) return { error: "at must be unix seconds" };
  if (e.source !== "keeper" && e.source !== "indexer") return { error: "source must be keeper or indexer" };
  if (e.lineId !== undefined && (typeof e.lineId !== "string" || !/^[1-9][0-9]{0,30}$/.test(e.lineId))) return { error: "lineId must be a decimal string" };
  if (e.borrower !== undefined && (typeof e.borrower !== "string" || !ADDRESS.test(e.borrower))) return { error: "borrower must be an address" };
  if (e.txHash !== undefined && (typeof e.txHash !== "string" || !BYTES32.test(e.txHash))) return { error: "txHash must be bytes32 hex" };
  if (e.decisionHash !== undefined && (typeof e.decisionHash !== "string" || !BYTES32.test(e.decisionHash))) return { error: "decisionHash must be bytes32 hex" };
  if (!e.data || typeof e.data !== "object" || Array.isArray(e.data)) return { error: "data must be an object" };
  const data: Record<string, Primitive> = {};
  for (const [k, v] of Object.entries(e.data as Record<string, unknown>)) {
    if (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) data[k] = v as Primitive;
    else return { error: `data.${k} must be a string, number, boolean or null` };
  }
  return {
    type: e.type as EventType,
    chainId: e.chainId,
    at: e.at,
    source: e.source,
    ...(e.lineId !== undefined ? { lineId: e.lineId as string } : {}),
    ...(e.borrower !== undefined ? { borrower: e.borrower as string } : {}),
    ...(e.txHash !== undefined ? { txHash: e.txHash as string } : {}),
    ...(e.decisionHash !== undefined ? { decisionHash: e.decisionHash as string } : {}),
    data,
  };
}

/**
 * Idempotency for keeper events: the same transaction is one event whatever the keeper's clock said; without a
 * transaction, the keeper's own `at` separates two grace transitions, and a re-sent identical event is a duplicate.
 */
export async function keeperDedupeKey(e: KeeperEvent): Promise<string> {
  const core = {
    type: e.type,
    chainId: e.chainId,
    source: e.source,
    lineId: e.lineId ?? null,
    borrower: e.borrower?.toLowerCase() ?? null,
    txHash: e.txHash?.toLowerCase() ?? null,
    decisionHash: e.decisionHash?.toLowerCase() ?? null,
    ...(e.txHash ? {} : { at: e.at }),
    data: Object.fromEntries(Object.keys(e.data).sort().map((k) => [k, e.data[k]])),
  };
  return `keeper:${await sha256Hex(JSON.stringify(core))}`;
}

/** The keeper's event through the RPC entrypoint: validated, deduplicated, logged per partner, delivered. */
export async function ingestKeeperEvent(rt: WebhookRuntime, evt: unknown): Promise<{ accepted: boolean; id: string; deliveries: number; duplicate?: boolean; error?: string }> {
  const v = validateKeeperEvent(evt);
  if ("error" in v) return { accepted: false, id: "", deliveries: 0, error: v.error };
  const r = await ingest(rt, {
    type: v.type,
    chainId: v.chainId,
    at: v.at,
    source: v.source,
    lineId: v.lineId ?? null,
    borrower: v.borrower ?? null,
    txHash: v.txHash ?? null,
    decisionHash: v.decisionHash ?? null,
    data: v.data,
    dedupeKey: await keeperDedupeKey(v),
  });
  return { accepted: r.accepted, id: r.id, deliveries: r.deliveries, ...(r.duplicate ? { duplicate: true } : {}) };
}

// ---------------------------------------------------------------- the engine

export interface LineHead {
  partnerId: Hex;
  user: string;
  marketId: Hex;
}

export interface WebhookRuntime {
  store: WebhookStore;
  lines: Pick<Store, "getLine" | "listLinesByUser" | "rememberLine">;
  /** The desk's `line(lineId)` head for lines this API has not seen; null when unknown or unreadable. */
  readLine?: (lineId: bigint) => Promise<LineHead | null>;
  now: () => number;
  uuid: () => string;
  /** Sends one delivery: the global fetch for outside URLs, the app itself for its own echo receiver. */
  send: (url: string, init: RequestInit) => Promise<Response>;
  /** Work after the response (ctx.waitUntil). */
  defer: (p: Promise<unknown>) => void;
  log?: (line: string) => void;
  /** Attribution memo for one cron tick (lineId → partners): the same few lines recur in every poll. */
  lineCache?: Map<string, string[]>;
}

export interface IngestInput {
  type: AnyEventType;
  chainId: number;
  at: number;
  source: EventRecord["source"];
  lineId?: string | null;
  borrower?: string | null;
  /** When the event itself names the partner (the vault's Protected carries partnerId). */
  partnerId?: string | null;
  txHash?: string | null;
  decisionHash?: string | null;
  data: Record<string, Primitive>;
  dedupeKey: string;
  backfill?: boolean;
  /** Only this webhook gets a delivery (the `test` ping). */
  onlyWebhookId?: string;
  /** False queues the deliveries for the cron's retry pass instead of sending them in this invocation (the cron's own poll). */
  deliverNow?: boolean;
}

export interface IngestResult {
  accepted: boolean;
  id: string;
  deliveries: number;
  deliveryIds: string[];
  duplicate?: boolean;
  partners: string[];
  error?: string;
}

/** Which partners an event belongs to: named, by line (this API's records, else the desk), or by the borrower's lines. */
export async function attribute(rt: WebhookRuntime, input: IngestInput): Promise<string[]> {
  if (input.partnerId) return [input.partnerId.toLowerCase()];
  if (input.lineId && rt.lineCache?.has(input.lineId)) return rt.lineCache.get(input.lineId) as string[];
  if (input.lineId) {
    const partners = await attributeLine(rt, input.lineId);
    rt.lineCache?.set(input.lineId, partners);
    return partners;
  }
  if (input.borrower) {
    const partners = [...new Set((await rt.lines.listLinesByUser(input.borrower, 50)).map((l) => l.partnerId.toLowerCase()))];
    return partners.length ? partners : [""];
  }
  return [""];
}

/** The partner of a desk line: this API's records first, else the desk's `line()` (remembered for next time). */
async function attributeLine(rt: WebhookRuntime, lineId: string): Promise<string[]> {
  const known = await rt.lines.getLine(lineId);
  if (known) return [known.partnerId.toLowerCase()];
  if (rt.readLine) {
    try {
      const head = await rt.readLine(BigInt(lineId));
      if (head && !/^0x0{64}$/.test(head.partnerId)) {
        const rec: LineRecord = { lineId, partnerId: head.partnerId.toLowerCase() as Hex, user: head.user, marketId: head.marketId, firstSeen: rt.now() };
        await rt.lines.rememberLine(rec);
        return [rec.partnerId];
      }
    } catch (err) {
      rt.log?.(`webhooks: line ${lineId} unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return [""];
}

function envelope(e: EventRecord): string {
  return JSON.stringify({
    id: e.id,
    type: e.type,
    createdAt: e.createdAt,
    at: e.at,
    chainId: e.chainId,
    partnerId: e.partnerId,
    source: e.source,
    ...(e.lineId ? { lineId: e.lineId } : {}),
    ...(e.borrower ? { borrower: e.borrower } : {}),
    data: e.data,
    ...(e.txHash ? { txHash: e.txHash } : {}),
    ...(e.decisionHash ? { decisionHash: e.decisionHash } : {}),
  });
}

/** Logs the event for each partner it belongs to and queues a delivery per subscribed webhook (sent after the response). */
export async function ingest(rt: WebhookRuntime, input: IngestInput): Promise<IngestResult> {
  const partners = await attribute(rt, input);
  const now = rt.now();
  let firstId = "";
  let deliveries = 0;
  const deliveryIds: string[] = [];
  let inserted = 0;
  for (const partnerId of partners) {
    const e: EventRecord = {
      id: rt.uuid(),
      partnerId,
      type: input.type,
      chainId: input.chainId,
      source: input.source,
      at: input.at,
      lineId: input.lineId ?? null,
      borrower: input.borrower ? input.borrower.toLowerCase() : null,
      txHash: input.txHash ? input.txHash.toLowerCase() : null,
      decisionHash: input.decisionHash ? input.decisionHash.toLowerCase() : null,
      data: input.data,
      dedupeKey: partners.length > 1 ? `${input.dedupeKey}:${partnerId}` : input.dedupeKey,
      backfill: input.backfill === true,
      createdAt: now,
    };
    if (!(await rt.store.insertEvent(e))) continue;
    inserted += 1;
    if (!firstId) firstId = e.id;
    if (e.backfill || !partnerId) continue;
    const hooks = (await rt.store.listWebhooks(partnerId)).filter((w) => subscribed(w, e.type) && (!input.onlyWebhookId || w.id === input.onlyWebhookId));
    const payload = envelope(e);
    const payloadHash = await sha256Hex(payload);
    for (const w of hooks) {
      const d: DeliveryRecord = {
        id: rt.uuid(), webhookId: w.id, eventId: e.id, partnerId, type: e.type, status: "pending", attempts: 0, lastCode: null, lastError: null,
        lastAttemptAt: null, nextAttemptAt: now, payload, payloadHash, createdAt: now,
      };
      await rt.store.insertDelivery(d);
      deliveries += 1;
      deliveryIds.push(d.id);
      if (input.deliverNow === false) continue;
      rt.defer(attemptDelivery(rt, d, w).catch((err: unknown) => rt.log?.(`webhooks: delivery ${d.id} crashed: ${err instanceof Error ? err.message : String(err)}`)));
    }
  }
  if (inserted === 0) return { accepted: true, id: "", deliveries: 0, deliveryIds, duplicate: true, partners };
  return { accepted: true, id: firstId, deliveries, deliveryIds, partners };
}

/** One attempt: sign with a fresh timestamp, POST, record the outcome and when to try again. */
export async function attemptDelivery(rt: WebhookRuntime, d: DeliveryRecord, w: WebhookRecord): Promise<DeliveryRecord> {
  const now = rt.now();
  let code: number | null = null;
  let error: string | null = null;
  if (!w.active) {
    error = "webhook deleted";
  } else {
    try {
      const headers = {
        "content-type": "application/json",
        "user-agent": "Boundline-Webhooks/1",
        "boundline-event": d.type,
        "boundline-delivery": d.id,
        "boundline-signature": await signatureHeader(w.secret, now, d.payload),
      };
      const res = await rt.send(w.url, { method: "POST", headers, body: d.payload, signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) });
      code = res.status;
      if (code < 200 || code >= 300) error = `answered ${code}`;
      // Drain the body so the connection is released; its content is not ours to keep.
      await res.arrayBuffer().catch(() => undefined);
    } catch (err) {
      error = err instanceof Error ? err.message.split("\n")[0] ?? "send failed" : String(err);
    }
  }
  const attempts = d.attempts + 1;
  const delivered = error === null;
  const giveUp = !delivered && (attempts >= MAX_ATTEMPTS || !w.active);
  const next: DeliveryRecord = {
    ...d,
    attempts,
    lastCode: code,
    lastError: error,
    lastAttemptAt: now,
    status: delivered ? "delivered" : giveUp ? "failed" : "pending",
    nextAttemptAt: delivered || giveUp ? null : now + (BACKOFF_MINUTES[attempts - 1] ?? 16) * 60,
  };
  await rt.store.updateDelivery(d.id, next);
  rt.log?.(`webhooks: ${d.id} ${d.type} → ${w.url} attempt ${attempts}: ${next.status}${code !== null ? ` ${code}` : ""}${error ? ` (${error})` : ""}`);
  return next;
}

/** The cron's retry pass: deliveries whose backoff has elapsed. */
export async function retryDue(rt: WebhookRuntime, limit = 2): Promise<{ attempted: number; delivered: number; failed: number }> {
  const due = await rt.store.dueDeliveries(rt.now(), limit);
  let delivered = 0;
  let failed = 0;
  for (const d of due) {
    const w = await rt.store.getWebhook(d.webhookId);
    const out = await attemptDelivery(rt, d, w ?? { id: d.webhookId, partnerId: d.partnerId, url: "", events: [], description: "", secret: "", active: false, createdAt: 0 });
    if (out.status === "delivered") delivered += 1;
    if (out.status === "failed") failed += 1;
  }
  return { attempted: due.length, delivered, failed };
}

// ---------------------------------------------------------------- the indexer poll

export interface IndexerEventJson {
  chainId: number;
  blockNumber: number;
  blockTime: number;
  txHash: string;
  logIndex: number;
  address: string;
  name: string;
  args: Record<string, unknown>;
}

export const POLL_SOURCES = ["credit-desk", "sepolia-protection"] as const;
const POLL_PAGE = 100;
const POLL_MAX_PAGES = 3;
/**
 * New events one cron tick takes, oldest first; the rest wait for the next tick. A scheduled invocation on the Workers
 * Free plan is killed at 10 ms of CPU (the indexer's ticks died exactly there on 8 Oct 2026), and a cold first tick of
 * this poller measured 14.25 ms in Node with real SQL before any D1 binding overhead, so a tick is small by
 * construction: a source's first poll only primes its cursor, one source is polled per tick, at most this many new
 * events are taken, deliveries go out on the next tick's retry pass, and the cursor moves as it goes.
 */
export const POLL_MAX_NEW_PER_TICK = 4;
const CURSOR_EVERY = 2;
/**
 * Events older than this when they reach the poll are logged, never delivered: an indexer that adds a source later
 * backfills its history range by range, and a partner must not receive a week-old repay as if it had just happened.
 */
export const MAX_DELIVERY_AGE_SECONDS = 24 * 3600;

function actionText(v: unknown): string {
  if (typeof v !== "string" || !BYTES32.test(v)) return String(v ?? "");
  let out = "";
  for (let i = 2; i < v.length; i += 2) {
    const code = parseInt(v.slice(i, i + 2), 16);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return /^[\x20-\x7e]+$/.test(out) ? out : v;
}

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const usdc = (v: unknown): string => {
  try {
    return formatUsdc(BigInt(s(v) || "0"));
  } catch {
    return s(v);
  }
};

/** An indexer row → the webhook event it is, or null when it is not one partners subscribe to. */
export function mapIndexerEvent(source: string, e: IndexerEventJson): IngestInput | null {
  const a = e.args ?? {};
  const base = { chainId: e.chainId, at: e.blockTime, source: "indexer" as const, txHash: e.txHash, dedupeKey: `idx:${e.chainId}:${e.txHash.toLowerCase()}:${e.logIndex}` };
  const where = { contract: e.address.toLowerCase(), event: e.name, blockNumber: e.blockNumber, logIndex: e.logIndex };
  if (source === "credit-desk") {
    if (e.name !== "Decision") return null;
    const action = actionText(a.action);
    const type = action === "HOLD" ? "hold" : action === "RELEASE" ? "release" : null;
    if (!type) return null;
    return { ...base, type, lineId: s(a.lineId) || null, decisionHash: s(a.decisionHash) || null, data: { ...where, action, amount: s(a.amount) } };
  }
  if (source === "sepolia-protection") {
    if (e.name === "Protected" && a.lineId !== undefined) {
      return {
        ...base, type: "protect", lineId: s(a.lineId), borrower: s(a.user) || null, partnerId: s(a.partnerId) || null, decisionHash: s(a.decisionHash) || null,
        data: { ...where, venue: "desk", action: "protective repay (DeskProtectionVault)", repaidUsdc: usdc(a.repaid), fromUserUsdc: usdc(a.fromUser), fromPartnerUsdc: usdc(a.fromPartner), fromAdvanceUsdc: usdc(a.fromAdvance), debtBeforeUsdc: usdc(a.debtBefore), debtAfterUsdc: usdc(a.debtAfter) },
      };
    }
    if (e.name === "Protected" && a.borrower !== undefined) {
      return {
        ...base, type: "protect", borrower: s(a.borrower), decisionHash: s(a.decisionHash) || null,
        data: { ...where, venue: "morpho", action: "shadow pre-liquidation (Protector)", preLiquidation: s(a.preLiquidation), seizedAssets: s(a.seizedAssets), repaidUsdc: usdc(a.repaidAssets), collateralSold: s(a.collateralSold), venuePrice36: s(a.venuePrice36), shadowPrice36: s(a.shadowPrice36) },
      };
    }
    if (e.name === "AdvanceSettled") {
      return { ...base, type: "settle", lineId: s(a.lineId), decisionHash: s(a.decisionHash) || null, data: { ...where, payer: s(a.payer), principalUsdc: usdc(a.principal), feeUsdc: usdc(a.fee), outstandingAfterUsdc: usdc(a.outstandingAfter) } };
    }
    if (e.name === "CollateralRecovered" && a.price8 !== undefined) {
      return { ...base, type: "recovery", lineId: s(a.lineId), borrower: s(a.user) || null, decisionHash: s(a.decisionHash) || null, data: { ...where, token: s(a.token), amount: s(a.amount), price8: s(a.price8) } };
    }
  }
  return null;
}

export type IndexerGet = (path: string) => Promise<{ ok: true; data: unknown } | { ok: false; status: number; detail: string } | null>;

export interface PollResult {
  source: string;
  status: "ok" | "initialised" | "partial" | "unavailable" | "error";
  fetched: number;
  ingested: number;
  deliveries: number;
  cursor: number | null;
  detail?: string;
}

/**
 * One indexer source. The first poll only primes the cursor at the source's newest event (history is not replayed to
 * partners); later polls take the events from the cursor block on, oldest first, deduplicated by log, at most
 * POLL_MAX_NEW_PER_TICK new ones, the cursor saved as they go. Deliveries are queued for the retry pass. Events older
 * than a day are logged and never delivered.
 */
export async function pollSource(rt: WebhookRuntime, source: string, chainId: number, indexerGet: IndexerGet): Promise<PollResult> {
  const cursor = await rt.store.getCursor(source);
  const out: PollResult = { source, status: "ok", fetched: 0, ingested: 0, deliveries: 0, cursor };
  if (cursor === null) {
    const res = await indexerGet(`/v1/events?chainId=${chainId}&source=${source}&limit=1`);
    if (res === null) return { ...out, status: "unavailable", detail: "no indexer bound" };
    if (!res.ok) return { ...out, status: res.status === 404 ? "unavailable" : "error", detail: res.detail };
    const newest = ((res.data as { events?: IndexerEventJson[] }).events ?? [])[0];
    const primed = newest ? newest.blockNumber : 0;
    await rt.store.putCursor(source, primed, rt.now());
    return { ...out, status: "initialised", fetched: newest ? 1 : 0, cursor: primed };
  }
  const rows: IndexerEventJson[] = [];
  let before: string | null = null;
  for (let page = 0; page < POLL_MAX_PAGES; page += 1) {
    const q = `/v1/events?chainId=${chainId}&source=${source}&limit=${POLL_PAGE}&from=${cursor}${before ? `&before=${before}` : ""}`;
    const res = await indexerGet(q);
    if (res === null) return { ...out, status: "unavailable", detail: "no indexer bound" };
    if (!res.ok) return { ...out, status: res.status === 404 ? "unavailable" : "error", detail: res.detail };
    const data = res.data as { events?: IndexerEventJson[]; next?: string | null };
    const events = Array.isArray(data.events) ? data.events : [];
    rows.push(...events);
    before = data.next ?? null;
    if (!before) break;
  }
  out.fetched = rows.length;
  rows.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
  const tick: WebhookRuntime = { ...rt, lineCache: rt.lineCache ?? new Map() };
  const now = rt.now();
  let maxBlock = cursor;
  let processed = 0;
  for (const e of rows) {
    const input = mapIndexerEvent(source, e);
    if (input) {
      const r = await ingest(tick, { ...input, backfill: e.blockTime < now - MAX_DELIVERY_AGE_SECONDS, deliverNow: false });
      if (!r.duplicate) out.ingested += 1;
      out.deliveries += r.deliveries;
    }
    maxBlock = Math.max(maxBlock, e.blockNumber);
    processed += 1;
    if (out.ingested >= POLL_MAX_NEW_PER_TICK) {
      out.status = "partial";
      break;
    }
    if (processed % CURSOR_EVERY === 0) await rt.store.putCursor(source, maxBlock, now);
  }
  if (maxBlock !== cursor || processed > 0) await rt.store.putCursor(source, maxBlock, now);
  out.cursor = maxBlock;
  return out;
}

// ---------------------------------------------------------------- the echo receiver

const ECHO_TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const ECHO_HEADERS = ["boundline-event", "boundline-delivery", "boundline-signature", "content-type", "user-agent"];

export function validEchoToken(token: string): boolean {
  return ECHO_TOKEN.test(token);
}

/**
 * Receives a delivery like a partner would: finds the webhook by the delivery id, verifies the signature, keeps the
 * last 20. It is public (deliveries carry a signature, not a key), so it stores only Boundline's own deliveries, and
 * only on the token in that webhook's URL: anything else is answered and dropped, never written.
 */
export async function receiveEcho(rt: WebhookRuntime, token: string, body: string, headers: Headers): Promise<EchoRecord & { stored: boolean }> {
  const deliveryId = headers.get("boundline-delivery");
  let verification = "no Boundline-Delivery header";
  let known = false;
  if (deliveryId) {
    const d = await rt.store.getDelivery(deliveryId);
    const w = d ? await rt.store.getWebhook(d.webhookId) : null;
    if (!d) verification = "unknown delivery";
    else if (!w) verification = "webhook not found";
    else if (!w.url.endsWith(`/v1/webhooks/echo/${token}`)) verification = "this delivery belongs to another endpoint";
    else {
      known = true;
      verification = await verifySignature(w.secret, headers.get("boundline-signature"), body, rt.now());
    }
  }
  const kept: Record<string, string> = {};
  for (const h of ECHO_HEADERS) {
    const v = headers.get(h);
    if (v !== null) kept[h] = v;
  }
  const rec: EchoRecord = { token, receivedAt: rt.now(), deliveryId, eventType: headers.get("boundline-event"), signatureValid: verification === "valid", verification, body: body.slice(0, 16_384), headers: kept };
  if (known) await rt.store.saveEcho(rec, ECHO_KEEP);
  return { ...rec, stored: known };
}

// ---------------------------------------------------------------- JSON views

export function webhookJson(w: WebhookRecord, last: DeliveryRecord | null): Record<string, unknown> {
  return {
    id: w.id,
    url: w.url,
    events: w.events,
    description: w.description,
    active: w.active,
    createdAt: w.createdAt,
    lastDelivery: last ? { status: last.status, at: last.lastAttemptAt, code: last.lastCode } : null,
  };
}

export function deliveryJson(d: DeliveryRecord): Record<string, unknown> {
  return {
    id: d.id,
    eventId: d.eventId,
    type: d.type,
    status: d.status,
    attempts: d.attempts,
    lastCode: d.lastCode,
    lastError: d.lastError,
    lastAttemptAt: d.lastAttemptAt,
    nextAttemptAt: d.nextAttemptAt,
    payloadHash: d.payloadHash,
  };
}

export function eventJson(e: EventRecord): Record<string, unknown> {
  return {
    id: e.id,
    type: e.type,
    chainId: e.chainId,
    at: e.at,
    source: e.source,
    ...(e.lineId ? { lineId: e.lineId } : {}),
    ...(e.borrower ? { borrower: e.borrower } : {}),
    ...(e.txHash ? { txHash: e.txHash } : {}),
    ...(e.decisionHash ? { decisionHash: e.decisionHash } : {}),
    data: e.data,
    backfill: e.backfill,
    createdAt: e.createdAt,
  };
}

export function echoJson(r: EchoRecord): Record<string, unknown> {
  let parsed: unknown = r.body;
  try {
    parsed = JSON.parse(r.body);
  } catch {
    // not JSON: keep the text
  }
  return { receivedAt: r.receivedAt, deliveryId: r.deliveryId, type: r.eventType, signatureValid: r.signatureValid, verification: r.verification, headers: r.headers, body: parsed };
}
