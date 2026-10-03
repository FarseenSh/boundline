import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { sha256Hex } from "../src/auth.js";
import { createD1Store } from "../src/db.js";
import { KEY, MARKET_ID, PARTNER_ID, USER, call, fakeD1, makeDesk } from "./helpers.js";

describe("createD1Store over a D1-shaped fake", () => {
  it("round-trips partners, idempotency, quotes and lines through the real SQL", async () => {
    const db = fakeD1();
    const store = createD1Store(db);
    expect(await store.findPartnerByKeyHash("nope")).toBeNull();
    db.tables.partners!.push({ partner_id: PARTNER_ID, name: "P", api_key_hash: "h", policy_version: 2, created_at: 5 });
    expect(await store.findPartnerByKeyHash("h")).toEqual({ partnerId: PARTNER_ID, name: "P", apiKeyHash: "h", policyVersion: 2, createdAt: 5 });

    expect(await store.getIdempotent(PARTNER_ID, "k")).toBeNull();
    await store.putIdempotent({ key: "k", partnerId: PARTNER_ID, requestHash: "r", status: 200, responseJson: "{}", createdAt: 9 });
    expect(await store.getIdempotent(PARTNER_ID, "k")).toMatchObject({ requestHash: "r", status: 200, createdAt: 9 });
    await store.putIdempotent({ key: "k", partnerId: PARTNER_ID, requestHash: "r2", status: 201, responseJson: "{}", createdAt: 10 });
    expect(db.tables.idempotency!.length).toBe(1);
    expect((await store.getIdempotent(PARTNER_ID, "k"))?.requestHash).toBe("r2");

    await store.saveQuote({ quoteHash: "0xq", partnerId: PARTNER_ID, requestJson: "{}", responseJson: "{}", createdAt: 1 });
    await store.saveQuote({ quoteHash: "0xq", partnerId: PARTNER_ID, requestJson: "{}", responseJson: "{}", createdAt: 2 });
    expect(db.tables.quotes!.length).toBe(1);

    await store.rememberLine({ lineId: "1", partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, firstSeen: 1 });
    await store.rememberLine({ lineId: "1", partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, firstSeen: 99 });
    await store.rememberLine({ lineId: "2", partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, firstSeen: 3 });
    const lines = await store.listLines(PARTNER_ID, 10);
    expect(lines.map((l) => l.lineId)).toEqual(["2", "1"]);
    expect(lines[1]?.firstSeen).toBe(1);
    expect((await store.listLines(PARTNER_ID, 1)).length).toBe(1);
  });

  it("serves the whole API over the fake D1", async () => {
    const db = fakeD1();
    db.tables.partners!.push({ partner_id: PARTNER_ID, name: "P", api_key_hash: await sha256Hex(KEY), policy_version: 1, created_at: 0 });
    const app = createApp({ store: createD1Store(db), desk: makeDesk(), chainId: 84532, now: () => 1000, uuid: () => "u" });
    const q = await call(app, "POST", "/v1/quotes", { body: { lineId: "1" }, headers: { "idempotency-key": "a" } });
    expect(q.res.status).toBe(200);
    expect(db.tables.quotes!.length).toBe(1);
    expect(db.tables.lines!.length).toBe(1);
    const replay = await call(app, "POST", "/v1/quotes", { body: { lineId: "1" }, headers: { "idempotency-key": "a" } });
    expect(replay.res.headers.get("x-idempotent-replay")).toBe("true");
    const obligations = await call(app, "GET", "/v1/obligations");
    expect(obligations.json.count).toBe(1);
  });
});
