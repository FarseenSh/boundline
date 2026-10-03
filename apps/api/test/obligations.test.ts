import { describe, expect, it } from "vitest";
import { MARKET_ID, PARTNER_ID, USER, call, makeDesk, world } from "./helpers.js";

describe("GET /v1/obligations", () => {
  it("lists the lines this API has seen, newest first, with live statuses", async () => {
    const { app, store } = await world({ desk: makeDesk({ obligationStatus: async (id) => (id === 2n ? 6 : 1) }) });
    const empty = await call(app, "GET", "/v1/obligations");
    expect(empty.json.count).toBe(0);
    await store.rememberLine({ lineId: "1", partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, firstSeen: 100 });
    await store.rememberLine({ lineId: "2", partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, firstSeen: 200 });
    await store.rememberLine({ lineId: "3", partnerId: "0x" + "ab".repeat(32) as `0x${string}`, user: USER, marketId: MARKET_ID, firstSeen: 300 });
    const { res, json } = await call(app, "GET", "/v1/obligations?partnerId=boundline-app");
    expect(res.status).toBe(200);
    expect(json.count).toBe(2);
    expect(json.obligations.map((o: { lineId: string }) => o.lineId)).toEqual(["2", "1"]);
    expect(json.obligations[0].obligationStatus).toBe("HOLD_KEEPER");
    expect(json.obligations[1].obligationStatus).toBe("OPEN");
    expect(json.source).toMatch(/no enumeration/);
    const limited = await call(app, "GET", "/v1/obligations?limit=1");
    expect(limited.json.count).toBe(1);
  });

  it("refuses another partner's id and tolerates a missing desk", async () => {
    const { app, store } = await world({ desk: null });
    expect((await call(app, "GET", "/v1/obligations?partnerId=someone-else")).res.status).toBe(403);
    await store.rememberLine({ lineId: "1", partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, firstSeen: 100 });
    const { json } = await call(app, "GET", "/v1/obligations");
    expect(json.obligations[0].obligationStatus).toBe("UNKNOWN");
  });
});
