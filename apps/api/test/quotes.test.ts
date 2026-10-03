import { describe, expect, it } from "vitest";
import { validQuote } from "../src/app.js";
import type { DeskQuote } from "../src/desk.js";
import { canonicalJson, quoteHash } from "../src/quote-hash.js";
import { DESK, MARKET_ID, OTHER_PARTNER_ID, USER, call, makeDesk, sampleLine, sampleQuote, world } from "./helpers.js";

const headers = () => ({ "idempotency-key": `k-${Math.random()}` });

describe("POST /v1/quotes", () => {
  it("returns a full quote with capacity rounded down and a stored hash", async () => {
    const { app, store } = await world();
    const { res, json } = await call(app, "POST", "/v1/quotes", { body: { lineId: "1", draw: "100000000" }, headers: headers() });
    expect(res.status).toBe(200);
    expect(json.reason).toBe("NONE");
    expect(json.refused).toBe(false);
    expect(json.session).toBe("REGULAR");
    expect(json.price).toEqual({ answer8: "33366495000", usd: 333.66495 });
    expect(json.available.baseUnits).toBe("1835157225");
    expect(json.capacity).toEqual({ baseUnits: "1835150000", usdc: "1835.150000", rounding: "down to the cent" });
    expect(json.charges.protectionFee).toEqual({ baseUnits: "0", usdc: "0.000000", rounding: "up to the cent" });
    expect(json.effectiveMaxLtv).toEqual({ wad: "550000000000000000", ratio: 0.55 });
    expect(json.lineStatus).toBe("OPEN");
    expect(json.policyVersion).toBe(3);
    expect(res.headers.get("x-policy-version")).toBe("3");
    expect(json.quoteHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.headers.get("x-quote-hash")).toBe(json.quoteHash);
    expect(json.blockNumber).toBe("47635000");
    expect(json.desk).toBe(DESK);
    expect(store.quotes.has(json.quoteHash)).toBe(true);
    expect(store.lines.get("1")).toMatchObject({ user: USER, marketId: MARKET_ID });
  });

  it("names a refusal instead of a number", async () => {
    const { app } = await world({ desk: makeDesk({ quote: async () => sampleQuote({ reason: 6, session: 5, price8: 0n, available: 0n, maxDebt: 0n }) }) });
    const { res, json } = await call(app, "POST", "/v1/quotes", { body: { lineId: "1" }, headers: headers() });
    expect(res.status).toBe(200);
    expect(json.reason).toBe("MARKET_CLOSED");
    expect(json.refused).toBe(true);
    expect(json.session).toBe("WEEKEND");
    expect(json.capacity.baseUnits).toBe("0");
  });

  it("fails closed when the desk reverts", async () => {
    const { app, store } = await world({ desk: makeDesk({ quote: async () => { throw new Error("execution reverted"); } }) });
    const { res, json } = await call(app, "POST", "/v1/quotes", { body: { lineId: "1" }, headers: headers() });
    expect(res.status).toBe(409);
    expect(json.reason).toBe("UNKNOWN");
    expect(json.detail).toMatch(/reverted/);
    expect(json.quoteHash).toBeUndefined();
    expect(store.quotes.size).toBe(0);
  });

  it("fails closed when a field is missing or out of range", async () => {
    const partial = { ...sampleQuote(), available: undefined } as unknown as DeskQuote;
    const { app } = await world({ desk: makeDesk({ quote: async () => partial }) });
    const a = await call(app, "POST", "/v1/quotes", { body: { lineId: "1" }, headers: headers() });
    expect(a.res.status).toBe(409);
    expect(a.json.reason).toBe("UNKNOWN");
    const { app: app2 } = await world({ desk: makeDesk({ quote: async () => sampleQuote({ reason: 99 }) }) });
    const b = await call(app2, "POST", "/v1/quotes", { body: { lineId: "1" }, headers: headers() });
    expect(b.res.status).toBe(409);
  });

  it("answers 404 for an unknown line or another partner's line", async () => {
    const { app } = await world({ desk: makeDesk({ line: async () => { throw new Error("UnknownLine(5)"); } }) });
    expect((await call(app, "POST", "/v1/quotes", { body: { lineId: "5" }, headers: headers() })).res.status).toBe(404);
    const { app: app2 } = await world({ desk: makeDesk({ line: async () => sampleLine({ partnerId: OTHER_PARTNER_ID }) }) });
    expect((await call(app2, "POST", "/v1/quotes", { body: { lineId: "1" }, headers: headers() })).res.status).toBe(404);
  });

  it("resolves the line from partner, user and market", async () => {
    const { app } = await world({ desk: makeDesk({ lineOf: async () => 7n }) });
    const ok = await call(app, "POST", "/v1/quotes", { body: { partnerId: "boundline-app", user: USER, marketId: MARKET_ID, draw: "0" }, headers: headers() });
    expect(ok.res.status).toBe(200);
    expect(ok.json.lineId).toBe("7");
    const { app: app2 } = await world({ desk: makeDesk({ lineOf: async () => 0n }) });
    const none = await call(app2, "POST", "/v1/quotes", { body: { partnerId: "boundline-app", user: USER, marketId: MARKET_ID }, headers: headers() });
    expect(none.res.status).toBe(404);
    const wrong = await call(app2, "POST", "/v1/quotes", { body: { partnerId: "someone-else", user: USER, marketId: MARKET_ID }, headers: headers() });
    expect(wrong.res.status).toBe(403);
  });

  it("validates draw and lineId", async () => {
    const { app } = await world();
    expect((await call(app, "POST", "/v1/quotes", { body: { lineId: "1", draw: "1.5" }, headers: headers() })).res.status).toBe(400);
    expect((await call(app, "POST", "/v1/quotes", { body: { lineId: "0" }, headers: headers() })).res.status).toBe(400);
    expect((await call(app, "POST", "/v1/quotes", { body: {}, headers: headers() })).res.status).toBe(400);
  });

  it("answers 503 while the desk is not deployed", async () => {
    const { app } = await world({ desk: null });
    const { res, json } = await call(app, "POST", "/v1/quotes", { body: { lineId: "1" }, headers: headers() });
    expect(res.status).toBe(503);
    expect(json.error).toBe("desk not deployed");
  });
});

describe("quote hash", () => {
  it("is deterministic over canonical JSON and changes with the inputs", () => {
    const base = { chainId: 84532, desk: DESK, request: { lineId: "1", draw: "5" }, response: { b: 1n, a: [2n, { z: 1, y: undefined }] }, blockNumber: 10n };
    const same = { ...base, response: { a: [2n, { z: 1 }], b: 1n } };
    expect(quoteHash(base)).toBe(quoteHash(same));
    expect(quoteHash({ ...base, request: { lineId: "1", draw: "6" } })).not.toBe(quoteHash(base));
    expect(quoteHash({ ...base, blockNumber: 11n })).not.toBe(quoteHash(base));
    expect(canonicalJson({ b: 2n, a: "x" })).toBe('{"a":"x","b":"2"}');
  });

  it("validQuote accepts the sample and rejects holes", () => {
    expect(validQuote(sampleQuote())).toBe(true);
    expect(validQuote(null)).toBe(false);
    expect(validQuote({ ...sampleQuote(), debt: -1n })).toBe(false);
    expect(validQuote({ ...sampleQuote(), session: 42 })).toBe(false);
    expect(validQuote({ ...sampleQuote(), corporateActionHaircut: "no" as unknown as boolean })).toBe(false);
  });
});
