import { describe, expect, it } from "vitest";
import { bearerOf, routeApi, type RouteEnv, type Upstream } from "../worker/route.js";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function upstream(status = 200, body: unknown = { ok: true }, extraHeaders: Record<string, string> = {}): { fetcher: Upstream; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetcher: Upstream = {
    async fetch(url, init) {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      seen.push({ url, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : null });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-correlation-id": "c-1", "x-policy-version": "4", "set-cookie": "nope", ...extraHeaders } });
    },
  };
  return { fetcher, seen };
}

function env(overrides: Partial<RouteEnv> = {}): RouteEnv & { api: Seen[]; indexer: Seen[]; observatory: Seen[] } {
  const api = upstream();
  const indexer = upstream(200, { count: 0 });
  const observatory = upstream(200, { state: "PRE" });
  return { API: api.fetcher, INDEXER: indexer.fetcher, OBSERVATORY: observatory.fetcher, PARTNER_API_KEY: "secret-key", PARTNER_ID: "boundline-app", ...overrides, api: api.seen, indexer: indexer.seen, observatory: observatory.seen };
}

describe("console Worker routing", () => {
  it("leaves non-API paths to the assets", async () => {
    expect(await routeApi(new Request("https://console/policy"), env())).toBeNull();
    expect(await routeApi(new Request("https://console/"), env())).toBeNull();
  });
  it("adds the Worker's key when the browser sent none", async () => {
    const e = env();
    const res = await routeApi(new Request("https://console/api/v1/obligations?limit=5", { headers: { accept: "application/json" } }), e);
    expect(res?.status).toBe(200);
    expect(e.api[0]?.url).toBe("https://api/v1/obligations?limit=5");
    expect(e.api[0]?.headers.authorization).toBe("Bearer secret-key");
    expect(e.api[0]?.headers.accept).toBe("application/json");
    expect(res?.headers.get("x-correlation-id")).toBe("c-1");
    expect(res?.headers.get("x-policy-version")).toBe("4");
    expect(res?.headers.get("set-cookie")).toBeNull();
    expect(res?.headers.get("cache-control")).toBe("no-store");
  });
  it("forwards a pasted partner key instead of its own", async () => {
    const e = env();
    await routeApi(new Request("https://console/api/v1/policy", { headers: { authorization: "Bearer pasted-key" } }), e);
    expect(e.api[0]?.headers.authorization).toBe("Bearer pasted-key");
  });
  it("forwards POST bodies and the idempotency key", async () => {
    const e = env();
    const res = await routeApi(new Request("https://console/api/v1/policy/versions", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "k-1", "x-secret": "no" }, body: '{"note":"n"}' }), e);
    expect(res?.status).toBe(200);
    expect(e.api[0]?.method).toBe("POST");
    expect(e.api[0]?.body).toBe('{"note":"n"}');
    expect(e.api[0]?.headers["idempotency-key"]).toBe("k-1");
    expect(e.api[0]?.headers["x-secret"]).toBeUndefined();
  });
  it("answers 503 with neither a pasted nor a configured key", async () => {
    const e = env({ PARTNER_API_KEY: undefined });
    const res = await routeApi(new Request("https://console/api/v1/obligations"), e);
    expect(res?.status).toBe(503);
    expect(e.api).toHaveLength(0);
  });
  it("routes the indexer without any key, and refuses paths outside /v1", async () => {
    const e = env();
    const ok = await routeApi(new Request("https://console/api/indexer/v1/sources", { headers: { authorization: "Bearer pasted-key" } }), e);
    expect(ok?.status).toBe(200);
    expect(e.indexer[0]?.url).toBe("https://indexer/v1/sources");
    expect(e.indexer[0]?.headers.authorization).toBeUndefined();
    const bad = await routeApi(new Request("https://console/api/indexer/admin"), e);
    expect(bad?.status).toBe(404);
  });
  it("reads the Observatory's public JSON through its binding, GET only, without a key", async () => {
    const e = env();
    const res = await routeApi(new Request("https://console/api/observatory/v1/sessions", { headers: { authorization: "Bearer pasted-key" } }), e);
    expect(res?.status).toBe(200);
    expect(e.observatory[0]?.url).toBe("https://observatory/v1/sessions");
    expect(e.observatory[0]?.headers.authorization).toBeUndefined();
    expect((await routeApi(new Request("https://console/api/observatory/v1/sessions", { method: "POST" }), e))?.status).toBe(404);
    expect((await routeApi(new Request("https://console/api/observatory/admin"), e))?.status).toBe(404);
    expect((await routeApi(new Request("https://console/api/observatory/v1/sessions"), env({ OBSERVATORY: undefined })))?.status).toBe(503);
  });

  it("reports the key source in /api/config", async () => {
    const e = env();
    expect(await (await routeApi(new Request("https://console/api/config"), e))!.json()).toEqual({ partnerId: "boundline-app", hasPartnerKey: true, keySource: "console" });
    expect(await (await routeApi(new Request("https://console/api/config", { headers: { authorization: "Bearer x" } }), e))!.json()).toMatchObject({ keySource: "pasted" });
    expect(await (await routeApi(new Request("https://console/api/config"), env({ PARTNER_API_KEY: undefined })))!.json()).toMatchObject({ hasPartnerKey: false, keySource: "none" });
  });
  it("rejects other methods and unknown API paths, and reports an unreachable upstream as 502", async () => {
    const e = env();
    expect((await routeApi(new Request("https://console/api/v1/x", { method: "DELETE" }), e))?.status).toBe(405);
    expect((await routeApi(new Request("https://console/api/nope"), e))?.status).toBe(404);
    const down: Upstream = { fetch: async () => { throw new Error("binding down"); } };
    const res = await routeApi(new Request("https://console/api/v1/obligations"), env({ API: down }));
    expect(res?.status).toBe(502);
    expect(await res!.json()).toMatchObject({ error: "upstream unavailable", detail: "binding down" });
  });
  it("forwards DELETE only for webhook removal, with the key and no body", async () => {
    const e = env();
    const res = await routeApi(new Request("https://console/api/v1/webhooks/wh_1", { method: "DELETE" }), e);
    expect(res?.status).toBe(200);
    expect(e.api[0]?.url).toBe("https://api/v1/webhooks/wh_1");
    expect(e.api[0]?.method).toBe("DELETE");
    expect(e.api[0]?.headers.authorization).toBe("Bearer secret-key");
    expect(e.api[0]?.body ?? "").toBe("");
    expect((await routeApi(new Request("https://console/api/v1/policy/versions/pv_1", { method: "DELETE" }), e))?.status).toBe(405);
    expect((await routeApi(new Request("https://console/api/indexer/v1/events", { method: "DELETE" }), e))?.status).toBe(405);
    expect((await routeApi(new Request("https://console/api/v1/webhooks/wh_1", { method: "PUT" }), e))?.status).toBe(405);
  });
  it("parses bearers strictly", () => {
    expect(bearerOf(new Request("https://x", { headers: { authorization: "Bearer abc" } }))).toBe("abc");
    expect(bearerOf(new Request("https://x", { headers: { authorization: "bearer  abc " } }))).toBe("abc");
    expect(bearerOf(new Request("https://x", { headers: { authorization: "Basic abc" } }))).toBeNull();
    expect(bearerOf(new Request("https://x"))).toBeNull();
  });
});
