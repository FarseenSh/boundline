// The agent Worker: MCP over streamable HTTP at POST /mcp, REST aliases under /v1/tools for curl, a tool list at
// GET /v1/tools. Reaches the other Boundline Workers through service bindings; holds the partner key as a secret.
import { handleMcpBody, callTool, toJson, PROTOCOL_VERSION, SERVER_INFO } from "./mcp.js";
import { makeTools, type Deps } from "./tools.js";

export interface Env {
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const tools = makeTools(depsFor(env));

    if (path === "/" || path === "/health") {
      return json({ ok: true, service: SERVER_INFO.name, version: SERVER_INFO.version, mcp: { endpoint: "/mcp", transport: "streamable-http", protocolVersion: PROTOCOL_VERSION }, rest: { list: "/v1/tools", call: "POST /v1/tools/:name" }, tools: [...tools.keys()], partner: env.PARTNER_ID, hasPartnerKey: Boolean(env.PARTNER_API_KEY) });
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
      const out = await handleMcpBody(body, tools);
      if (out === null) return new Response(null, { status: 202 });
      return json(out);
    }
    if (path === "/v1/tools" && request.method === "GET") {
      return json({ tools: [...tools.values()].map((t) => t.definition) });
    }
    const m = /^\/v1\/tools\/([a-zA-Z]+)$/.exec(path);
    if (m && m[1]) {
      if (request.method !== "POST") return json({ error: "POST the tool's arguments as JSON" }, 405, { allow: "POST" });
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
      const result = await callTool(tools, m[1], args);
      return json(result.isError ? { error: result.content[0]?.text } : result.structuredContent, result.isError ? (tools.has(m[1]) ? 400 : 404) : 200);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
