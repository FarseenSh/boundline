// The console Worker's routing, free of Workers types so the tests drive it with plain objects. The browser
// never needs the console's own partner key: /api/v1/* goes to the partner API with either the bearer the
// partner pasted into the console (forwarded as is) or the Worker's secret; /api/indexer/* goes to the indexer.
export interface Upstream {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface RouteEnv {
  API: Upstream;
  INDEXER: Upstream;
  /** The Observatory sends no CORS headers, so its public JSON is read through this binding. */
  OBSERVATORY?: Upstream | undefined;
  PARTNER_API_KEY?: string | undefined;
  PARTNER_ID: string;
}

const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "idempotency-key", "x-correlation-id"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "content-disposition", "x-correlation-id", "x-policy-version", "x-quote-hash", "x-idempotent-replay"];
const METHODS = new Set(["GET", "POST", "HEAD", "DELETE"]);

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function pick(from: Headers, names: readonly string[]): Headers {
  const out = new Headers();
  for (const n of names) {
    const v = from.get(n);
    if (v !== null) out.set(n, v);
  }
  return out;
}

async function proxy(target: Upstream, url: string, request: Request, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const headers = pick(request.headers, FORWARDED_REQUEST_HEADERS);
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.text();
  let upstream: Response;
  try {
    upstream = await target.fetch(url, init);
  } catch (err) {
    return json({ error: "upstream unavailable", detail: err instanceof Error ? err.message : String(err) }, 502);
  }
  const out = pick(upstream.headers, FORWARDED_RESPONSE_HEADERS);
  out.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/** A pasted partner key arrives as `Authorization: Bearer <key>`; anything else is ignored. */
export function bearerOf(request: Request): string | null {
  const raw = request.headers.get("authorization");
  if (!raw) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return m?.[1] ?? null;
}

/** Null when the path is not an API route (the caller serves the static asset instead). */
export async function routeApi(request: Request, env: RouteEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/")) return null;
  if (!METHODS.has(request.method)) return json({ error: "method not allowed" }, 405);
  // DELETE exists for one thing (removing a webhook), so it only ever goes to the partner API's webhook routes.
  if (request.method === "DELETE" && !path.startsWith("/api/v1/webhooks/")) return json({ error: "method not allowed" }, 405);

  if (path === "/api/health") return proxy(env.API, "https://api/health", request);
  if (path === "/api/config") {
    return json({ partnerId: env.PARTNER_ID, hasPartnerKey: Boolean(env.PARTNER_API_KEY), keySource: bearerOf(request) ? "pasted" : env.PARTNER_API_KEY ? "console" : "none" });
  }
  if (path.startsWith("/api/indexer/")) {
    const rest = path.slice("/api/indexer".length);
    if (!rest.startsWith("/v1/") && rest !== "/health") return json({ error: "not found" }, 404);
    return proxy(env.INDEXER, `https://indexer${rest}${url.search}`, request);
  }
  if (path.startsWith("/api/observatory/")) {
    const rest = path.slice("/api/observatory".length);
    if (request.method !== "GET" || !rest.startsWith("/v1/")) return json({ error: "not found" }, 404);
    if (!env.OBSERVATORY) return json({ error: "no Observatory binding on this Worker" }, 503);
    return proxy(env.OBSERVATORY, `https://observatory${rest}${url.search}`, request);
  }
  if (path.startsWith("/api/v1/")) {
    const pasted = bearerOf(request);
    const key = pasted ?? env.PARTNER_API_KEY;
    if (!key) return json({ error: "no partner key: paste yours in the console, or configure PARTNER_API_KEY on the Worker" }, 503);
    return proxy(env.API, `https://api${path.slice("/api".length)}${url.search}`, request, { authorization: `Bearer ${key}` });
  }
  return json({ error: "not found" }, 404);
}
