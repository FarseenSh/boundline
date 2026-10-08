// A small client for the Boundline partner API. In a browser the base URL is the app Worker's /api
// proxy, which adds the partner key server-side; on a server pass `apiKey`. Every call returns the
// body with the response's correlation id, policy version and quote hash lifted from the headers.
import type { RouteRequestBody, RouteResponse } from "./route.js";
import type { PartnerEvent, WebhookCreated, WebhookCreateRequest, WebhookDelivery, WebhookSummary } from "./webhooks.js";
export interface ApiEnvelope<T> {
  ok: boolean;
  status: number;
  data: T;
  correlationId: string | null;
  policyVersion: number | null;
  quoteHash: string | null;
  idempotentReplay: boolean | null;
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  apiKey?: string;
  /** Idempotency keys for POSTs; defaults to crypto.randomUUID(). */
  newIdempotencyKey?: () => string;
}

export interface PrepareLineRequest {
  partnerId: string;
  user: string;
  marketId: string;
  /** Unix seconds; the API refuses past deadlines. */
  deadline: bigint | number | string;
}

export interface PreparedLineResponse {
  policyVersion: number;
  chainId: number;
  desk: string;
  partnerId: string;
  partnerActive: boolean;
  user: string;
  marketId: string;
  nonce: string;
  deadline: string;
  existingLineId: string | null;
  signatureRequired: boolean;
  signer: string | null;
  digest: string;
  typedData: unknown;
  call: { to: string; data: string; note: string };
  correlationId?: string;
}

export interface QuoteRequest {
  lineId: bigint | number | string;
  /** USDC base units; omit for a capacity quote. */
  draw?: bigint | number | string;
}

/** What the API's built-in echo receiver kept (the last deliveries it received); fields beyond `deliveries` vary. */
export interface EchoReceived {
  deliveries?: EchoDelivery[];
  [k: string]: unknown;
}

export interface EchoDelivery {
  receivedAt?: number;
  type?: string;
  event?: string;
  deliveryId?: string;
  signature?: string | null;
  /** The receiver's own check of the signature with the webhook's secret (the API's echo receiver names it `signatureValid`). */
  verified?: boolean | null;
  signatureValid?: boolean;
  /** The receiver's verdict in words: "valid", "signature mismatch", "timestamp outside tolerance", "unknown delivery", … */
  verification?: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  [k: string]: unknown;
}

export interface ApiClient {
  health(): Promise<ApiEnvelope<{ ok: boolean; service: string; features?: string[] }>>;
  prepareLine(req: PrepareLineRequest): Promise<ApiEnvelope<PreparedLineResponse>>;
  quote(req: QuoteRequest): Promise<ApiEnvelope<Record<string, unknown>>>;
  getLine(lineId: bigint | number | string): Promise<ApiEnvelope<Record<string, unknown>>>;
  obligations(limit?: number): Promise<ApiEnvelope<Record<string, unknown>>>;
  /** Decision timeline for a line; null when the API has no such route yet (404/501). */
  decisions(lineId: bigint | number | string): Promise<ApiEnvelope<Record<string, unknown>> | null>;
  decision(hash: string): Promise<ApiEnvelope<Record<string, unknown>>>;
  /** The credit router's plan for a draw: chosen venue and market, alternatives, rejections with reasons, signed when the API has a route signer. */
  route(req: RouteRequestBody): Promise<ApiEnvelope<RouteResponse>>;
  /** The plan stored on a line's obligation record; null when there is none (404) or the route is not live (501). */
  lineRoute(lineId: bigint | number | string): Promise<ApiEnvelope<RouteResponse> | null>;
  createWebhook(req: WebhookCreateRequest): Promise<ApiEnvelope<WebhookCreated>>;
  listWebhooks(): Promise<ApiEnvelope<{ webhooks: WebhookSummary[] }>>;
  deleteWebhook(id: string): Promise<ApiEnvelope<null>>;
  /** Queue a `ping` delivery to the webhook's URL. */
  testWebhook(id: string): Promise<ApiEnvelope<{ deliveryId: string }>>;
  webhookDeliveries(id: string, limit?: number): Promise<ApiEnvelope<{ deliveries: WebhookDelivery[] }>>;
  /** The partner's event log (grace, protect, hold, release, recovery, settle), newest first. */
  events(limit?: number): Promise<ApiEnvelope<{ events: PartnerEvent[] }>>;
  /** What the API's built-in echo receiver has received for `token`. */
  echoReceived(token: string): Promise<ApiEnvelope<EchoReceived>>;
}

const str = (v: bigint | number | string): string => (typeof v === "string" ? v : v.toString());

function headerNumber(h: Headers, name: string): number | null {
  const v = h.get(name);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const newKey = opts.newIdempotencyKey ?? (() => globalThis.crypto.randomUUID());

  async function send<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<ApiEnvelope<T>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    if (method === "POST") {
      headers["content-type"] = "application/json";
      headers["idempotency-key"] = newKey();
    }
    const init: RequestInit = { method, headers };
    if (method === "POST") init.body = JSON.stringify(body ?? {});
    const res = await fetchImpl(`${base}${path}`, init);
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text.length ? JSON.parse(text) : null;
    } catch {
      data = { error: "non-JSON response", body: text.slice(0, 500) };
    }
    const replay = res.headers.get("x-idempotent-replay");
    return {
      ok: res.ok,
      status: res.status,
      data: data as T,
      correlationId: res.headers.get("x-correlation-id"),
      policyVersion: headerNumber(res.headers, "x-policy-version"),
      quoteHash: res.headers.get("x-quote-hash"),
      idempotentReplay: replay === null ? null : replay === "true",
    };
  }

  return {
    health: () => send("GET", "/health"),
    prepareLine: (req) => send("POST", "/v1/lines", { partnerId: req.partnerId, user: req.user, marketId: req.marketId, deadline: str(req.deadline) }),
    quote: (req) => send("POST", "/v1/quotes", { lineId: str(req.lineId), draw: req.draw === undefined ? "0" : str(req.draw) }),
    getLine: (lineId) => send("GET", `/v1/lines/${str(lineId)}`),
    obligations: (limit = 50) => send("GET", `/v1/obligations?limit=${limit}`),
    async decisions(lineId) {
      const r = await send<Record<string, unknown>>("GET", `/v1/lines/${str(lineId)}/decisions`);
      return r.status === 404 || r.status === 501 ? null : r;
    },
    decision: (hash) => send("GET", `/v1/decisions/${hash}`),
    route: (req) => send("POST", "/v1/route", req),
    async lineRoute(lineId) {
      const r = await send<RouteResponse>("GET", `/v1/lines/${str(lineId)}/route`);
      return r.status === 404 || r.status === 501 ? null : r;
    },
    createWebhook: (req) => send("POST", "/v1/webhooks", req),
    listWebhooks: () => send("GET", "/v1/webhooks"),
    deleteWebhook: (id) => send("DELETE", `/v1/webhooks/${encodeURIComponent(id)}`),
    testWebhook: (id) => send("POST", `/v1/webhooks/${encodeURIComponent(id)}/test`, {}),
    webhookDeliveries: (id, limit = 50) => send("GET", `/v1/webhooks/${encodeURIComponent(id)}/deliveries?limit=${limit}`),
    events: (limit = 50) => send("GET", `/v1/events?limit=${limit}`),
    echoReceived: (token) => send("GET", `/v1/webhooks/echo/${encodeURIComponent(token)}`),
  };
}
