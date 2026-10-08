// A minimal Model Context Protocol server over streamable HTTP: JSON-RPC 2.0 requests in a POST body, JSON responses.
// Implements initialize, ping, tools/list and tools/call (the subset every MCP client needs to call tools); no sessions,
// no server-initiated streams. Spec: modelcontextprotocol.io, transport "Streamable HTTP" (2025-03-26 and later).
export const PROTOCOL_VERSION = "2025-06-18";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface ToolHandler {
  definition: ToolDefinition;
  run(args: Record<string, unknown>): Promise<unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const SERVER_INFO = { name: "boundline-agent", version: "0.1.0" } as const;

/** JSON with bigints as decimal strings, so tool results never throw on serialisation. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export async function callTool(tools: ReadonlyMap<string, ToolHandler>, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = tools.get(name);
  if (!tool) return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  try {
    const out = await tool.run(args ?? {});
    const text = toJson(out);
    return { content: [{ type: "text", text }], structuredContent: JSON.parse(text) };
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

async function handleOne(req: JsonRpcRequest, tools: ReadonlyMap<string, ToolHandler>): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const isNotification = req.id === undefined;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
  switch (req.method) {
    case "initialize":
      return { jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: "Boundline agent surface: read sessions, positions and shadow health, quote a line, see what the keeper would protect, and route a draw across venues. Read-only; nothing here signs. This MCP endpoint is free; the same tools over REST (POST /v1/tools/:name) cost $0.01 USDC on Base Sepolia per call through x402 unless the caller sends a partner key." } };
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: [...tools.values()].map((t) => t.definition) } };
    case "tools/call": {
      const params = req.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
      return { jsonrpc: "2.0", id, result: await callTool(tools, name, args) };
    }
    default:
      if (isNotification) return null;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${req.method}` } };
  }
}

/** Handles a POST body (one request or a batch). Returns null when only notifications were sent (HTTP 202). */
export async function handleMcpBody(body: unknown, tools: ReadonlyMap<string, ToolHandler>): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((b) => handleOne(b as JsonRpcRequest, tools)))).filter((r): r is JsonRpcResponse => r !== null);
    return out.length ? out : null;
  }
  if (!body || typeof body !== "object") return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
  return handleOne(body as JsonRpcRequest, tools);
}
