import { describe, expect, it } from "vitest";
import { handleRequest, keyChecker, type AgentDeps } from "../src/index.js";
import type { ToolHandler } from "../src/mcp.js";
import { b64decodeJson, b64encodeJson, x402ConfigFrom, type Facilitator, type FacilitatorRequest } from "../src/x402.js";

const PAY_TO = "0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const CFG = x402ConfigFrom({ X402_ENABLED: "true", X402_PAY_TO: PAY_TO, X402_NETWORK: "base-sepolia", X402_PRICE_USDC: "0.01" })!;

function tools(): Map<string, ToolHandler> {
  const m = new Map<string, ToolHandler>();
  m.set("session", { definition: { name: "session", description: "s", inputSchema: { type: "object" } }, run: async () => ({ state: "OVERNIGHT" }) });
  m.set("quote", { definition: { name: "quote", description: "q", inputSchema: { type: "object" } }, run: async (args) => { if (!args.lineId) throw new Error("lineId is required"); return { reason: "NONE" }; } });
  return m;
}

function facilitator(): Facilitator & { calls: { kind: string; req: FacilitatorRequest }[] } {
  const calls: { kind: string; req: FacilitatorRequest }[] = [];
  return {
    calls,
    async verify(req) { calls.push({ kind: "verify", req }); return { isValid: true, payer: "0xB789aD318945B37566E2549F65526Cc269a482Fc" }; },
    async settle(req) { calls.push({ kind: "settle", req }); return { success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:84532" }; },
  };
}

function deps(over: Partial<AgentDeps> = {}): AgentDeps & { f: ReturnType<typeof facilitator> } {
  const f = facilitator();
  return { tools: tools(), x402: { cfg: CFG, facilitator: f }, checkKey: async (t) => t === "bl_live", partnerId: "boundline-app", hasPartnerKey: true, f, ...over };
}

/** A v2 payment exactly as an x402 client builds it (the facilitator is faked, so the signature is not checked here). */
function payment(): string {
  return b64encodeJson({
    x402Version: 2,
    accepted: { scheme: "exact", network: "eip155:84532", amount: "10000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } },
    payload: { signature: `0x${"11".repeat(65)}`, authorization: { from: "0xB789aD318945B37566E2549F65526Cc269a482Fc", to: PAY_TO, value: "10000", validAfter: "0", validBefore: "9999999999", nonce: `0x${"22".repeat(32)}` } },
  });
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://agent.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("x402 on the REST aliases", () => {
  it("answers 402 with the requirements to a keyless caller", async () => {
    const d = deps();
    const res = await handleRequest(post("/v1/tools/session", {}), d);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: { network: string; maxAmountRequired: string; payTo: string }[]; price: { usdc: string } };
    expect(body.accepts[0]).toMatchObject({ network: "base-sepolia", maxAmountRequired: "10000", payTo: PAY_TO });
    expect(body.price.usdc).toBe("0.01");
    const v2 = b64decodeJson(res.headers.get("payment-required") as string) as { accepts: { network: string; amount: string }[] };
    expect(v2.accepts[0]).toMatchObject({ network: "eip155:84532", amount: "10000" });
    expect(d.f.calls).toHaveLength(0);
  });

  it("verifies, runs the tool, then settles, and puts the settlement in PAYMENT-RESPONSE", async () => {
    const d = deps();
    const res = await handleRequest(post("/v1/tools/session", {}, { "payment-signature": payment() }), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "OVERNIGHT" });
    expect(d.f.calls.map((c) => c.kind)).toEqual(["verify", "settle"]);
    expect((b64decodeJson(res.headers.get("payment-response") as string) as { success: boolean }).success).toBe(true);
  });

  it("never settles a refusal, and never charges for an unknown tool", async () => {
    const d = deps();
    const bad = await handleRequest(post("/v1/tools/quote", {}, { "payment-signature": payment() }), d);
    expect(bad.status).toBe(400);
    expect(d.f.calls.map((c) => c.kind)).toEqual(["verify"]);
    const unknown = await handleRequest(post("/v1/tools/nope", {}), d);
    expect(unknown.status).toBe(404);
    expect(d.f.calls).toHaveLength(1);
  });

  it("lets a live partner key through unmetered, refuses a dead one, and keeps MCP and the tool list free", async () => {
    const d = deps();
    const ok = await handleRequest(post("/v1/tools/session", {}, { authorization: "Bearer bl_live" }), d);
    expect(ok.status).toBe(200);
    const dead = await handleRequest(post("/v1/tools/session", {}, { authorization: "Bearer bl_dead" }), d);
    expect(dead.status).toBe(401);
    const down = await handleRequest(post("/v1/tools/session", {}, { authorization: "Bearer x" }), deps({ checkKey: async () => { throw new Error("api down"); } }));
    expect(down.status).toBe(503);
    const mcp = await handleRequest(post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "session", arguments: {} } }), d);
    expect(mcp.status).toBe(200);
    const listed = await handleRequest(new Request("https://agent.test/v1/tools"), d);
    expect(((await listed.json()) as { pricing: { rest: { metered: boolean }; mcp: { metered: boolean } } }).pricing).toMatchObject({ rest: { metered: true }, mcp: { metered: false } });
    expect(d.f.calls).toHaveLength(0);
    // with metering off every REST call is free, as before
    expect((await handleRequest(post("/v1/tools/session", {}), deps({ x402: null }))).status).toBe(200);
  });

  it("checks a key once per isolate against the partner API's whoami", async () => {
    let asked = 0;
    const api = { fetch: async (_url: string, init: RequestInit) => { asked += 1; const auth = new Headers(init.headers).get("authorization"); return new Response("{}", { status: auth === "Bearer good" ? 200 : 401 }); } } as unknown as Fetcher;
    let t = 1_000;
    const check = keyChecker(api, () => t);
    expect(await check("good")).toBe(true);
    expect(await check("good")).toBe(true);
    expect(asked).toBe(1);
    expect(await check("bad")).toBe(false);
    t += 6 * 60_000;
    expect(await check("good")).toBe(true);
    expect(asked).toBe(3);
  });

  it("rejects a payment that targets another payee or amount before asking the facilitator", async () => {
    const d = deps();
    const wrong = b64encodeJson({ ...(b64decodeJson(payment()) as Record<string, unknown>), accepted: { scheme: "exact", network: "eip155:84532", amount: "1", asset: USDC, payTo: PAY_TO } });
    const res = await handleRequest(post("/v1/tools/session", {}, { "payment-signature": wrong }), d);
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toMatch(/value_mismatch/);
    expect(d.f.calls).toHaveLength(0);
  });
});
