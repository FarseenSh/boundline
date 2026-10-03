import { describe, expect, it } from "vitest";
import { call, world } from "./helpers.js";

describe("correlation ids", () => {
  it("echoes the caller's id on success and failure", async () => {
    const { app } = await world();
    const ok = await call(app, "GET", "/v1/obligations", { headers: { "x-correlation-id": "req-77" } });
    expect(ok.res.headers.get("x-correlation-id")).toBe("req-77");
    expect(ok.json.correlationId).toBe("req-77");
    const unauth = await call(app, "GET", "/v1/obligations", { key: null, headers: { "x-correlation-id": "req-78" } });
    expect(unauth.res.headers.get("x-correlation-id")).toBe("req-78");
    expect(unauth.json.correlationId).toBe("req-78");
    const missing = await call(app, "GET", "/v1/lines/999", { headers: { "x-correlation-id": "req-79" } });
    expect(missing.json.correlationId).toBe("req-79");
  });

  it("generates one when the caller sends none", async () => {
    const { app } = await world();
    const a = await call(app, "GET", "/health", { key: null });
    const b = await call(app, "GET", "/health", { key: null });
    expect(a.res.headers.get("x-correlation-id")).toBe("uuid-1");
    expect(b.res.headers.get("x-correlation-id")).toBe("uuid-2");
  });

  it("keeps the id on an unhandled error", async () => {
    const { app, store } = await world();
    store.listLines = async () => {
      throw new Error("boom");
    };
    const { res, json } = await call(app, "GET", "/v1/obligations", { headers: { "x-correlation-id": "req-80" } });
    expect(res.status).toBe(500);
    expect(json.correlationId).toBe("req-80");
    expect(json.detail).toBe("boom");
  });
});
