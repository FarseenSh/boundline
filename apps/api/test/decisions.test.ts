import { describe, expect, it } from "vitest";
import { call, world } from "./helpers.js";

const HASH = "0x" + "7a".repeat(32);

describe("GET /v1/decisions/:hash", () => {
  it("is 501 until an indexer is bound", async () => {
    const { app } = await world();
    const { res, json } = await call(app, "GET", `/v1/decisions/${HASH}`);
    expect(res.status).toBe(501);
    expect(json.plan).toMatch(/indexer/);
    expect((await call(app, "GET", "/v1/decisions/0x12")).res.status).toBe(400);
  });

  it("proxies to the indexer and filters by hash", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ events: [{ name: "Decision", args: { decisionHash: HASH.toUpperCase().replace("0X", "0x"), lineId: "1" } }] }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const { app } = await world({ indexerUrl: "https://indexer.local/", fetchImpl });
    const { res, json } = await call(app, "GET", `/v1/decisions/${HASH}`);
    expect(res.status).toBe(200);
    expect(json.decision.args.lineId).toBe("1");
    expect(seen[0]).toBe(`https://indexer.local/v1/events?name=Decision&decisionHash=${HASH}&limit=50`);
  });

  it("answers 404 when the indexer has no such decision and 502 when it is down", async () => {
    const none = (async () => new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } })) as typeof fetch;
    const { app } = await world({ indexerUrl: "https://indexer.local", fetchImpl: none });
    expect((await call(app, "GET", `/v1/decisions/${HASH}`)).res.status).toBe(404);
    const down = (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch;
    const { app: app2 } = await world({ indexerUrl: "https://indexer.local", fetchImpl: down });
    expect((await call(app2, "GET", `/v1/decisions/${HASH}`)).res.status).toBe(502);
    const bad = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const { app: app3 } = await world({ indexerUrl: "https://indexer.local", fetchImpl: bad });
    expect((await call(app3, "GET", `/v1/decisions/${HASH}`)).res.status).toBe(502);
  });
});
