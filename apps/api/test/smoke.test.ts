import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.js";
import { call, fakeD1, world } from "./helpers.js";

describe("boundline-api", () => {
  it("answers /health without auth", async () => {
    const { app } = await world();
    const { res, json } = await call(app, "GET", "/health", { key: null });
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, service: "boundline-api" });
  });

  it("the worker entry builds the app from the env and answers 503 while the desk is unset", async () => {
    const env = { DB: fakeD1(), CHAIN_ID: "84532", BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org", CREDIT_DESK: "", MORPHO: "", SESSION_GATE: "" } as unknown as Env;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const health = await worker.fetch(new Request("http://api.local/health"), env, ctx);
    expect(health.status).toBe(200);
    const unauth = await worker.fetch(new Request("http://api.local/v1/obligations"), env, ctx);
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("x-correlation-id")).toBeTruthy();
  });
});
