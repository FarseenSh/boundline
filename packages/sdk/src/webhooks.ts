// Partner webhooks: what Boundline posts to a partner when a line enters grace, is protected, held, released,
// recovered or settled, and how a receiver checks that a delivery really came from Boundline. Every delivery carries
//   Boundline-Event: <type>   Boundline-Delivery: <id>   Boundline-Signature: t=<unix>,v1=<hex>
// where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`), the secret being the one shown once when the webhook was registered
// (its UTF-8 bytes are the key). WebCrypto only, so the same check runs in a browser, a Worker and Node 22+.

export type WebhookEventType = "grace" | "grace.cleared" | "protect" | "hold" | "release" | "recovery" | "settle";

export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = Object.freeze(["grace", "grace.cleared", "protect", "hold", "release", "recovery", "settle"]);

export const WEBHOOK_EVENT_COPY: Readonly<Record<WebhookEventType | "ping", string>> = Object.freeze({
  grace: "A line's shadow LTV crossed the grace line at the 24/7 price",
  "grace.cleared": "A line is back under the grace line",
  protect: "A protective action ran: a repay from the vault ladder or a pre-liquidation",
  hold: "The desk put a line on hold",
  release: "A hold was released",
  recovery: "Collateral recovered in an open session to settle an advance",
  settle: "An advance was settled with its fee",
  ping: "A test delivery",
});

export interface WebhookCreateRequest {
  url: string;
  events: (WebhookEventType | "*")[];
  description?: string;
}

export interface WebhookSummary {
  id: string;
  url: string;
  events: (WebhookEventType | "*")[];
  description?: string | null;
  active: boolean;
  createdAt: number;
  lastDelivery: { status: string; at: number | null; code: number | null } | null;
}

/** The registration answer: the only time the signing secret is shown. */
export interface WebhookCreated extends WebhookSummary {
  secret: string;
  /** How deliveries are signed, as the API states it. */
  signing?: { header: string; scheme: string; toleranceSeconds: number; note?: string };
}

export interface WebhookDelivery {
  id: string;
  eventId: string;
  type: WebhookEventType | "ping" | string;
  status: "pending" | "delivered" | "failed" | string;
  attempts: number;
  lastCode: number | null;
  /** Why the last attempt failed (timeout, DNS, a non-2xx), when it did. */
  lastError?: string | null;
  lastAttemptAt: number | null;
  nextAttemptAt: number | null;
  payloadHash: string;
}

/** A partner-scoped event as `GET /v1/events` lists it (the keeper's and the indexer's, in one log). */
export interface PartnerEvent {
  id: string;
  type: WebhookEventType | "ping" | string;
  chainId: number;
  at: number;
  source: "keeper" | "indexer" | string;
  lineId?: string;
  borrower?: string;
  txHash?: string;
  decisionHash?: string;
  data: Record<string, string | number | boolean | null>;
  /** True for events reconstructed from history rather than seen as they happened. */
  backfill?: boolean;
  createdAt?: number;
}

/** What a delivery's JSON body carries. */
export interface WebhookPayload {
  id: string;
  type: WebhookEventType | "ping" | string;
  createdAt: number;
  chainId: number;
  partnerId: string;
  lineId?: string;
  data: Record<string, unknown>;
  txHash?: string;
  decisionHash?: string;
}

export interface ParsedSignature {
  t: number;
  v1: string[];
}

/** `t=1791441345,v1=ab12…` (several v1 values are allowed during a secret rotation); null when malformed. */
export function parseSignatureHeader(header: string | null | undefined): ParsedSignature | null {
  if (!header) return null;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2) as [string, string | undefined];
    if (!v) continue;
    if (k === "t" && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-fA-F]{64}$/.test(v)) v1.push(v.toLowerCase());
  }
  return t !== null && v1.length > 0 ? { t, v1 } : null;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available in this runtime");
  return s;
}

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)): the `v1` a delivery must carry. */
export async function webhookSignature(secret: string, timestamp: number, rawBody: string): Promise<string> {
  const key = await subtle().importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await subtle().sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`)));
}

/** Compares two equal-length hex strings without an early exit. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type VerifyFailure = "missing" | "malformed" | "stale" | "mismatch";

export interface VerifyResult {
  ok: boolean;
  reason?: VerifyFailure;
  /** The signed timestamp, when the header parsed. */
  t?: number;
}

export interface VerifyOptions {
  secret: string;
  /** The Boundline-Signature header as received. */
  header: string | null | undefined;
  /** The body exactly as received, before any JSON parsing. */
  rawBody: string;
  /** Unix seconds; defaults to the clock. */
  now?: number;
  /** How old a signature may be; default 300 s. 0 skips the age check (replaying stored deliveries). */
  toleranceSeconds?: number;
}

/** Checks a delivery: the header parses, the timestamp is recent, and one v1 equals the HMAC of `${t}.${rawBody}`. */
export async function verifyWebhookSignature(opts: VerifyOptions): Promise<VerifyResult> {
  if (!opts.header) return { ok: false, reason: "missing" };
  const parsed = parseSignatureHeader(opts.header);
  if (!parsed) return { ok: false, reason: "malformed" };
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (tolerance > 0 && Math.abs(now - parsed.t) > tolerance) return { ok: false, reason: "stale", t: parsed.t };
  const expected = await webhookSignature(opts.secret, parsed.t, opts.rawBody);
  return parsed.v1.some((v) => sameHex(v, expected)) ? { ok: true, t: parsed.t } : { ok: false, reason: "mismatch", t: parsed.t };
}

/** A fresh token for the API's built-in echo receiver (`/v1/webhooks/echo/:token`): 16 random bytes, hex. */
export function newEchoToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The echo receiver's URL on the partner API's public origin. */
export function echoReceiverUrl(apiPublicUrl: string, token: string): string {
  if (!/^[0-9a-f]{16,64}$/.test(token)) throw new Error("echo token must be 16 to 64 lowercase hex characters");
  return `${apiPublicUrl.replace(/\/+$/, "")}/v1/webhooks/echo/${token}`;
}
