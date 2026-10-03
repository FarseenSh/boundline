import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/db.js";
import { IDEMPOTENCY_TTL_SECONDS, requestHash, runIdempotent } from "../src/idempotency.js";
import { PARTNER_ID, call, makeDesk, sampleQuote, world } from "./helpers.js";

describe("runIdempotent", () => {
  it("runs once, replays, conflicts on a different request and expires after a day", async () => {
    const store = createMemoryStore();
    let runs = 0;
    const handler = async () => ({ status: 200, body: { n: ++runs } });
    const h1 = await requestHash("POST", "/v1/quotes", '{"a":1}');
    const h2 = await requestHash("POST", "/v1/quotes", '{"a":2}');
    expect(h1).not.toBe(h2);
    expect(await requestHash("post", "/v1/quotes", '{"a":1}')).toBe(h1);

    const first = await runIdempotent(store, PARTNER_ID, "k", h1, 1000, handler);
    expect(first).toEqual({ status: 200, body: { n: 1 }, replayed: false, conflict: false });
    const again = await runIdempotent(store, PARTNER_ID, "k", h1, 1500, handler);
    expect(again).toEqual({ status: 200, body: { n: 1 }, replayed: true, conflict: false });
    const other = await runIdempotent(store, PARTNER_ID, "k", h2, 1500, handler);
    expect(other.conflict).toBe(true);
    expect(other.status).toBe(422);
    const later = await runIdempotent(store, PARTNER_ID, "k", h1, 1000 + IDEMPOTENCY_TTL_SECONDS + 1, handler);
    expect(later).toEqual({ status: 200, body: { n: 2 }, replayed: false, conflict: false });
    expect(runs).toBe(2);
  });
});

describe("POST idempotency over the API", () => {
  it("requires the header", async () => {
    const { app } = await world();
    const { res, json } = await call(app, "POST", "/v1/quotes", { body: { lineId: "1" } });
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/Idempotency-Key/);
  });

  it("replays the same request and refuses a different one under the same key", async () => {
    let quotes = 0;
    const desk = makeDesk({
      quote: async () => {
        quotes++;
        return sampleQuote();
      },
    });
    const { app, clock } = await world({ desk });
    const headers = { "idempotency-key": "abc" };
    const a = await call(app, "POST", "/v1/quotes", { body: { lineId: "1", draw: "100000000" }, headers });
    expect(a.res.status).toBe(200);
    expect(a.res.headers.get("x-idempotent-replay")).toBe("false");
    const b = await call(app, "POST", "/v1/quotes", { body: { lineId: "1", draw: "100000000" }, headers });
    expect(b.res.status).toBe(200);
    expect(b.res.headers.get("x-idempotent-replay")).toBe("true");
    expect(b.json.quoteHash).toBe(a.json.quoteHash);
    expect(b.res.headers.get("x-quote-hash")).toBe(a.json.quoteHash);
    expect(b.json.correlationId).not.toBe(a.json.correlationId);
    expect(quotes).toBe(1);

    const c = await call(app, "POST", "/v1/quotes", { body: { lineId: "1", draw: "200000000" }, headers });
    expect(c.res.status).toBe(422);

    clock.now += 86_401;
    const d = await call(app, "POST", "/v1/quotes", { body: { lineId: "1", draw: "100000000" }, headers });
    expect(d.res.headers.get("x-idempotent-replay")).toBe("false");
    expect(quotes).toBe(2);
  });

  it("rejects a body that is not a JSON object", async () => {
    const { app } = await world();
    const headers = { "idempotency-key": "x" };
    expect((await call(app, "POST", "/v1/quotes", { body: "{not json", headers })).res.status).toBe(400);
    expect((await call(app, "POST", "/v1/quotes", { body: [1, 2], headers })).res.status).toBe(400);
  });
});
