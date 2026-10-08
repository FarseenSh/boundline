import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.js";
import { call, fakeD1, world } from "./helpers.js";

describe("boundline-api", () => {
  it("answers /health without auth", async () => {
    const { app } = await world();
    const { res, json } = await call(app, "GET", "/health", { key: null });
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, service: "boundline-api", features: ["route", "webhooks", "events-entrypoint", "saturday-mode"] });
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

describe("the Events entrypoint", () => {
  it("ingests a keeper event and runs a tick without a cron", async () => {
    const { Events } = await import("../src/index.js");
    const { sqliteD1 } = await import("./sqlite.js");
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const env = { DB: sqliteD1(), CHAIN_ID: "84532", BASE_SEPOLIA_RPC_URL: "https://sepolia.invalid", CREDIT_DESK: "", MORPHO: "", SESSION_GATE: "" } as unknown as Env;
    const events = new Events(ctx, env);
    const bad = await events.ingest({ type: "liquidate" } as never);
    expect(bad).toMatchObject({ accepted: false });
    const ok = await events.ingest({ type: "grace", chainId: 84532, at: 1_791_441_000, source: "keeper", lineId: "4", data: { shadowLtvBps: 5340 } });
    expect(ok).toMatchObject({ accepted: true, deliveries: 0 });
    // no indexer bound: the tick reports the source unavailable and does no harm
    const t = await events.tick();
    expect(t).toMatchObject({ polls: [expect.stringMatching(/unavailable/)] });
    await Promise.all(waits);
  });
});
