// The agent Worker: MCP over streamable HTTP at POST /mcp, REST aliases under /v1/tools for curl, a tool list at
// GET /v1/tools. Reaches the other Boundline Workers through service bindings; holds the partner key as a secret.
// Since 8 Oct 2026 the REST aliases are x402-metered for callers without a partner key ($0.01 USDC on Base Sepolia per
// call, plan M12); a partner key (checked against the partner API's /v1/whoami) is never metered; MCP stays free.
import { handleMcpBody, callTool, toJson, PROTOCOL_VERSION, SERVER_INFO, type ToolHandler } from "./mcp.js";
import { makeTools, type Deps } from "./tools.js";
import { createHttpFacilitator, meter, x402ConfigFrom, type Facilitator, type X402Config, type X402Env } from "./x402.js";

export interface Env extends X402Env {
  API: Fetcher;
  INDEXER: Fetcher;
  OBSERVATORY: Fetcher;
  KEEPER: Fetcher;
  BASE_RPC_URL: string;
  BASE_SEPOLIA_RPC_URL: string;
  BASE_RPC_URL_PRIVATE?: string;
  PARTNER_API_KEY?: string;
  PARTNER_ID: string;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(toJson(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

async function boundJson(service: Fetcher, host: string, path: string): Promise<unknown> {
  const res = await service.fetch(`https://${host}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${host}${path} answered ${res.status}`);
  return res.json();
}

function list(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

export function depsFor(env: Env): Deps {
  return {
    observatory: (path) => boundJson(env.OBSERVATORY, "observatory", path),
    keeper: (path) => boundJson(env.KEEPER, "keeper", path),
    indexer: (path) => boundJson(env.INDEXER, "indexer", path),
    api: async (path, init = {}) => {
      if (!env.PARTNER_API_KEY) return { status: 503, body: { error: "partner key not configured on the agent Worker" } };
      const headers: Record<string, string> = { authorization: `Bearer ${env.PARTNER_API_KEY}`, accept: "application/json" };
      const reqInit: RequestInit = { method: init.method ?? "GET", headers, signal: AbortSignal.timeout(20_000) };
      if (init.body !== undefined) {
        headers["content-type"] = "application/json";
        headers["idempotency-key"] = crypto.randomUUID();
        reqInit.body = JSON.stringify(init.body);
      }
      const res = await env.API.fetch(`https://api${path}`, reqInit);
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // keep the raw text
      }
      return { status: res.status, body };
    },
    rpcs: { mainnet: [...list(env.BASE_RPC_URL_PRIVATE), ...list(env.BASE_RPC_URL)], sepolia: list(env.BASE_SEPOLIA_RPC_URL) },
    fetchImpl: (input, init) => fetch(input, init),
    uuid: () => crypto.randomUUID(),
    now: () => Math.floor(Date.now() / 1000),
  };
}

export interface AgentDeps {
  tools: ReadonlyMap<string, ToolHandler>;
  /** x402 for keyless REST calls; null turns metering off (every REST call is free, as before 8 Oct). */
  x402: { cfg: X402Config; facilitator: Facilitator } | null;
  /** True when a bearer token is a live partner key; throws when the partner API cannot be asked. */
  checkKey: (token: string) => Promise<boolean>;
  partnerId: string;
  hasPartnerKey: boolean;
  log?: (line: string) => void;
}

function bearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? (m[1] as string) : null;
}

const MCP_NOTE = "MCP (POST /mcp) is free. The REST aliases (POST /v1/tools/:name) cost $0.01 USDC on Base Sepolia per call through x402 for callers without a partner key; partner keys are never metered.";

/** The whole HTTP surface, testable without a Worker. */
export async function handleRequest(request: Request, d: AgentDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const pricing = d.x402
    ? { rest: { metered: true, price: { usdc: d.x402.cfg.priceUsdc, atomic: d.x402.cfg.amount, asset: d.x402.cfg.asset, network: d.x402.cfg.network }, payTo: d.x402.cfg.payTo, bypass: "Authorization: Bearer <partner key>" }, mcp: { metered: false } }
    : { rest: { metered: false }, mcp: { metered: false } };

  if (path === "/" || path === "/health") {
    return json({ ok: true, service: SERVER_INFO.name, version: SERVER_INFO.version, mcp: { endpoint: "/mcp", transport: "streamable-http", protocolVersion: PROTOCOL_VERSION }, rest: { list: "/v1/tools", call: "POST /v1/tools/:name" }, tools: [...d.tools.keys()], partner: d.partnerId, hasPartnerKey: d.hasPartnerKey, pricing, note: MCP_NOTE });
  }
  if (path === "/mcp") {
    if (request.method === "GET") return json({ error: "no server-initiated stream; POST JSON-RPC to /mcp" }, 405, { allow: "POST" });
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { allow: "POST" });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
    }
    const out = await handleMcpBody(body, d.tools);
    if (out === null) return new Response(null, { status: 202 });
    return json(out);
  }
  if (path === "/v1/tools" && request.method === "GET") {
    return json({ tools: [...d.tools.values()].map((t) => t.definition), pricing, note: MCP_NOTE });
  }
  const m = /^\/v1\/tools\/([a-zA-Z]+)$/.exec(path);
  if (m && m[1]) {
    const name = m[1];
    if (request.method !== "POST") return json({ error: "POST the tool's arguments as JSON" }, 405, { allow: "POST" });
    // An unknown tool is answered before any payment: nobody pays to learn a name does not exist.
    if (!d.tools.has(name)) return json({ error: `unknown tool: ${name}`, tools: [...d.tools.keys()] }, 404);
    const run = async (): Promise<Response> => {
      let args: Record<string, unknown> = {};
      const text = await request.text();
      if (text.trim().length > 0) {
        try {
          const parsed = JSON.parse(text) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
          else return json({ error: "arguments must be a JSON object" }, 400);
        } catch {
          return json({ error: "arguments must be a JSON object" }, 400);
        }
      }
      const result = await callTool(d.tools, name, args);
      return json(result.isError ? { error: result.content[0]?.text } : result.structuredContent, result.isError ? 400 : 200);
    };
    const token = bearer(request.headers.get("authorization"));
    if (token) {
      let valid: boolean;
      try {
        valid = await d.checkKey(token);
      } catch (err) {
        return json({ error: "the partner key could not be checked", detail: err instanceof Error ? err.message : String(err) }, 503);
      }
      if (!valid) return json({ error: "unauthorized", hint: "the bearer token is not a live partner key; send none to pay per call through x402" }, 401);
      return run();
    }
    if (!d.x402) return run();
    return meter(request, d.x402.cfg, d.x402.facilitator, run, d.log);
  }
  return json({ error: "not found" }, 404);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Valid partner keys seen by this isolate (by hash), five minutes each: one /v1/whoami per key, not one per call. */
const liveKeys = new Map<string, number>();
const KEY_TTL_MS = 5 * 60_000;

export function keyChecker(api: Fetcher, now: () => number = () => Date.now()): (token: string) => Promise<boolean> {
  return async (token) => {
    const h = await sha256Hex(token);
    const until = liveKeys.get(h);
    if (until !== undefined && until > now()) return true;
    const res = await api.fetch("https://api/v1/whoami", { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 200) {
      liveKeys.set(h, now() + KEY_TTL_MS);
      return true;
    }
    if (res.status === 401) return false;
    throw new Error(`the partner API answered ${res.status}`);
  };
}

const x402s = new WeakMap<Env, AgentDeps["x402"]>();

function x402For(env: Env): AgentDeps["x402"] {
  if (x402s.has(env)) return x402s.get(env) ?? null;
  const cfg = x402ConfigFrom(env);
  const value = cfg ? { cfg, facilitator: createHttpFacilitator(env.X402_FACILITATOR || "https://x402.org/facilitator") } : null;
  x402s.set(env, value);
  return value;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, {
      tools: makeTools(depsFor(env)),
      x402: x402For(env),
      checkKey: keyChecker(env.API),
      partnerId: env.PARTNER_ID,
      hasPartnerKey: Boolean(env.PARTNER_API_KEY),
      log: (line) => console.log(line),
    });
  },
} satisfies ExportedHandler<Env>;
