import { describe, expect, it } from "vitest";
import { createApiClient } from "../src/api.js";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function fakeFetch(routes: Record<string, { status: number; body: unknown; headers?: Record<string, string> }>) {
  const seen: Seen[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname + new URL(url).search;
    const hdrs: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) hdrs[k.toLowerCase()] = v;
    seen.push({ url, method: init?.method ?? "GET", headers: hdrs, body: typeof init?.body === "string" ? init.body : null });
    const route = routes[path];
    if (!route) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    const body = route.status === 204 ? null : typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(body, { status: route.status, headers: { "content-type": "application/json", ...(route.headers ?? {}) } });
  };
  return { fetchImpl, seen };
}

describe("partner API client", () => {
  it("lifts correlation id, policy version and quote hash from the headers", async () => {
    const { fetchImpl, seen } = fakeFetch({
      "/api/v1/quotes": { status: 200, body: { reason: "NONE", available: "1663350000" }, headers: { "x-correlation-id": "corr-1", "x-policy-version": "1", "x-quote-hash": "0xabc", "x-idempotent-replay": "false" } },
    });
    const api = createApiClient({ baseUrl: "https://app.example/api/", fetch: fetchImpl, newIdempotencyKey: () => "idem-1" });
    const r = await api.quote({ lineId: 1n, draw: 5_000_000n });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ reason: "NONE", available: "1663350000" });
    expect(r.correlationId).toBe("corr-1");
    expect(r.policyVersion).toBe(1);
    expect(r.quoteHash).toBe("0xabc");
    expect(r.idempotentReplay).toBe(false);
    expect(seen[0]!.url).toBe("https://app.example/api/v1/quotes");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers["idempotency-key"]).toBe("idem-1");
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(JSON.parse(seen[0]!.body!)).toEqual({ lineId: "1", draw: "5000000" });
  });
  it("sends the bearer key on a server and the line fields as strings", async () => {
    const { fetchImpl, seen } = fakeFetch({ "/v1/lines": { status: 200, body: { nonce: "0" } } });
    const api = createApiClient({ baseUrl: "https://api.example", fetch: fetchImpl, apiKey: "k" });
    await api.prepareLine({ partnerId: "boundline-app", user: "0xB789aD318945B37566E2549F65526Cc269a482Fc", marketId: "0x4a03", deadline: 1_800_000_000 });
    expect(seen[0]!.headers.authorization).toBe("Bearer k");
    expect(JSON.parse(seen[0]!.body!).deadline).toBe("1800000000");
  });
  it("decisions returns null while the route does not exist", async () => {
    const { fetchImpl } = fakeFetch({ "/v1/lines/1": { status: 200, body: { line: { lineId: "1" } } } });
    const api = createApiClient({ baseUrl: "https://api.example", fetch: fetchImpl });
    expect(await api.decisions(1n)).toBeNull();
    expect((await api.getLine(1)).data).toEqual({ line: { lineId: "1" } });
    expect((await api.obligations(10)).status).toBe(404);
  });
  it("tolerates a non-JSON body", async () => {
    const { fetchImpl } = fakeFetch({ "/health": { status: 502, body: "<html>bad gateway</html>" } });
    const api = createApiClient({ baseUrl: "https://api.example", fetch: fetchImpl });
    const r = await api.health();
    expect(r.ok).toBe(false);
    expect((r.data as unknown as { error: string }).error).toBe("non-JSON response");
  });
});

describe("partner API client: route, webhooks, events", () => {
  const plan = {
    version: 1,
    user: "0xB789aD318945B37566E2549F65526Cc269a482Fc",
    collateral: "0xB2000000000000000000000E063E65377cA34141",
    requested: "3000000",
    chosen: { venue: "morpho", chainId: 84532, marketId: "0x4a03", amount: "3000000", capacity: "3356000", ltvWad: "447000000000000000", maxLtvWad: "500000000000000000", expectedRateWad: "0", protection: "pre-liquidation", price8: "33568300000", priceSource: "feed", session: "open", notes: ["PROTECTED"] },
    alternatives: [],
    rejected: [{ venue: "morpho", marketId: "0x7cb7", reason: "COLLATERAL_MISMATCH" }],
    createdAt: 1791441345,
    validUntil: 1791441465,
    reasonCodes: ["ROUTED"],
  };

  it("posts a route request as JSON with an idempotency key", async () => {
    const { fetchImpl, seen } = fakeFetch({ "/api/v1/route": { status: 200, body: { plan, planHash: "0xph", typedData: {}, signature: null, signer: null, note: "route signer not configured", policyVersion: 2, correlationId: "c" } } });
    const api = createApiClient({ baseUrl: "/api".replace(/^/, "https://app.example"), fetch: fetchImpl, newIdempotencyKey: () => "idem-r" });
    const r = await api.route({ chainId: 84532, borrower: plan.user, collateral: [{ symbol: "AAPLt", amount: "0.02" }], amountUsdc: "3.00", preferProtection: true, lineId: "4" });
    expect(r.ok).toBe(true);
    expect(r.data.plan.chosen?.protection).toBe("pre-liquidation");
    expect(r.data.signature).toBeNull();
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers["idempotency-key"]).toBe("idem-r");
    expect(JSON.parse(seen[0]!.body!)).toEqual({ chainId: 84532, borrower: plan.user, collateral: [{ symbol: "AAPLt", amount: "0.02" }], amountUsdc: "3.00", preferProtection: true, lineId: "4" });
  });

  it("lineRoute is null when the line has no stored plan", async () => {
    const { fetchImpl } = fakeFetch({ "/v1/lines/1/route": { status: 200, body: { plan, planHash: "0xph", typedData: {}, signature: null, signer: null, policyVersion: 2, correlationId: "c" } } });
    const api = createApiClient({ baseUrl: "https://api.example", fetch: fetchImpl });
    expect((await api.lineRoute(1n))?.data.planHash).toBe("0xph");
    expect(await api.lineRoute(2)).toBeNull();
  });

  it("registers, lists, tests and deletes webhooks; DELETE carries no body", async () => {
    const hook = { id: "wh_1", url: "https://partner.example/hooks", events: ["protect", "grace"], description: "ops", active: true, createdAt: 1791441345, lastDelivery: null };
    const { fetchImpl, seen } = fakeFetch({
      "/v1/webhooks": { status: 201, body: { ...hook, secret: "whsec_once" } },
      "/v1/webhooks/wh_1": { status: 204, body: "" },
      "/v1/webhooks/wh_1/test": { status: 202, body: { deliveryId: "dl_1" } },
      "/v1/webhooks/wh_1/deliveries?limit=20": { status: 200, body: { deliveries: [{ id: "dl_1", eventId: "ev_1", type: "ping", status: "delivered", attempts: 1, lastCode: 200, lastAttemptAt: 1791441346, nextAttemptAt: null, payloadHash: "0x01" }] } },
      "/v1/events?limit=10": { status: 200, body: { events: [{ id: "ev_2", type: "grace", chainId: 84532, at: 1791441345, source: "keeper", lineId: "4", data: { shadowLtvBps: 5310 } }] } },
      "/v1/webhooks/echo/abc123": { status: 200, body: { deliveries: [{ type: "ping", verified: true }] } },
    });
    const api = createApiClient({ baseUrl: "https://api.example", fetch: fetchImpl, apiKey: "k" });
    const created = await api.createWebhook({ url: hook.url, events: ["protect", "grace"], description: "ops" });
    expect(created.status).toBe(201);
    expect(created.data.secret).toBe("whsec_once");
    expect((await api.testWebhook("wh_1")).data.deliveryId).toBe("dl_1");
    expect((await api.webhookDeliveries("wh_1", 20)).data.deliveries[0]!.status).toBe("delivered");
    expect((await api.events(10)).data.events[0]!.type).toBe("grace");
    expect((await api.echoReceived("abc123")).data.deliveries?.[0]?.verified).toBe(true);
    const del = await api.deleteWebhook("wh_1");
    expect(del.status).toBe(204);
    expect(del.data).toBeNull();
    const d = seen.find((s) => s.method === "DELETE")!;
    expect(d.url).toBe("https://api.example/v1/webhooks/wh_1");
    expect(d.body).toBeNull();
    expect(d.headers.authorization).toBe("Bearer k");
    expect(d.headers["idempotency-key"]).toBeUndefined();
  });
});
