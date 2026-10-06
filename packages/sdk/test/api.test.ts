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
    const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
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
