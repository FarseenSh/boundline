// The app Worker: static assets for the SPA, plus a thin proxy under /api so the browser never holds the
// partner key. /api/v1/* and /api/health go to the partner API with the bearer header added; /api/indexer/*
// goes to the indexer as is. Nothing else runs here (Workers Free plan: 10 ms CPU per request).
export interface Env {
  ASSETS: Fetcher;
  API: Fetcher;
  INDEXER: Fetcher;
  PARTNER_API_KEY?: string;
  PARTNER_ID: string;
}

const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "idempotency-key", "x-correlation-id"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "x-correlation-id", "x-policy-version", "x-quote-hash", "x-idempotent-replay"];

function json(body: unknown, status = 200): Response {
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

async function proxy(target: Fetcher, url: string, request: Request, extraHeaders: Record<string, string> = {}): Promise<Response> {
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method !== "GET" && request.method !== "POST" && request.method !== "HEAD") return json({ error: "method not allowed" }, 405);

    if (path === "/api/health") return proxy(env.API, "https://api/health", request);
    if (path === "/api/config") return json({ partnerId: env.PARTNER_ID, hasPartnerKey: Boolean(env.PARTNER_API_KEY) });
    if (path.startsWith("/api/indexer/")) {
      const rest = path.slice("/api/indexer".length);
      if (!rest.startsWith("/v1/") && rest !== "/health") return json({ error: "not found" }, 404);
      return proxy(env.INDEXER, `https://indexer${rest}${url.search}`, request);
    }
    if (path.startsWith("/api/v1/")) {
      if (!env.PARTNER_API_KEY) return json({ error: "partner key not configured on the app Worker" }, 503);
      return proxy(env.API, `https://api${path.slice("/api".length)}${url.search}`, request, { authorization: `Bearer ${env.PARTNER_API_KEY}` });
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
