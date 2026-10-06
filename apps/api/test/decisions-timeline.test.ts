import { describe, expect, it } from "vitest";
import { OTHER_PARTNER_ID, call, makeDesk, sampleLine, world } from "./helpers.js";

const INDEXER = "https://indexer.local";
const OPEN = "0x4f50454e00000000000000000000000000000000000000000000000000000000"; // bytes32("OPEN")
const DRAW = "0x4452415700000000000000000000000000000000000000000000000000000000"; // bytes32("DRAW")

const timeline = [
  { name: "LineOpened", blockNumber: 500, blockTime: 1_791_050_000, txHash: "0x01", logIndex: 0, args: { lineId: "1", decisionHash: "0xaa", user: "0xb7" } },
  { name: "Decision", blockNumber: 500, blockTime: 1_791_050_000, txHash: "0x01", logIndex: 1, args: { lineId: "1", action: OPEN, decisionHash: "0xaa", amount: "0", price8: "0" } },
  { name: "Drawn", blockNumber: 600, blockTime: 1_791_060_000, txHash: "0x02", logIndex: 0, args: { lineId: "1", amount: "5000000", price8: "33267000000", session: 1, decisionHash: "0xbb" } },
  { name: "Decision", blockNumber: 600, blockTime: 1_791_060_000, txHash: "0x02", logIndex: 1, args: { lineId: "1", action: DRAW, decisionHash: "0xbb", amount: "5000000", price8: "33267000000" } },
];

function indexerTimeline(events: unknown[], seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ chainId: 84532, lineId: "1", count: events.length, events }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("GET /v1/lines/:id/decisions", () => {
  it("returns the line's decisions with readable actions and the typed events beside them", async () => {
    const seen: string[] = [];
    const { app } = await world({ indexerUrl: INDEXER, fetchImpl: indexerTimeline(timeline, seen) });
    const { res, json } = await call(app, "GET", "/v1/lines/1/decisions");
    expect(res.status).toBe(200);
    expect(seen[0]).toBe(`${INDEXER}/v1/desk/lines/1/timeline?chainId=84532`);
    expect(json.count).toBe(2);
    expect(json.decisions).toEqual([
      { action: "OPEN", hash: "0xaa", amount: "0", price8: "0", blockNumber: 500, blockTime: 1_791_050_000, txHash: "0x01", logIndex: 1 },
      { action: "DRAW", hash: "0xbb", amount: "5000000", price8: "33267000000", blockNumber: 600, blockTime: 1_791_060_000, txHash: "0x02", logIndex: 1 },
    ]);
    expect(json.timeline.map((e: { event: string; hash: string }) => [e.event, e.hash])).toEqual([
      ["LineOpened", "0xaa"],
      ["Drawn", "0xbb"],
    ]);
    expect(json.status).toBe("OPEN");
    expect(json.source).toBe("indexer");
    expect(res.headers.get("x-policy-version")).toBe("3");
  });

  it("hides other partners' lines, validates the id, and maps indexer trouble to 501/502", async () => {
    const { app } = await world({ indexerUrl: INDEXER, fetchImpl: indexerTimeline(timeline), desk: makeDesk({ line: async () => sampleLine({ partnerId: OTHER_PARTNER_ID }) }) });
    expect((await call(app, "GET", "/v1/lines/1/decisions")).res.status).toBe(404);
    expect((await call(app, "GET", "/v1/lines/x/decisions")).res.status).toBe(400);
    const { app: unbound } = await world();
    expect((await call(unbound, "GET", "/v1/lines/1/decisions")).res.status).toBe(501);
    const down = (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch;
    const { app: broken } = await world({ indexerUrl: INDEXER, fetchImpl: down });
    expect((await call(broken, "GET", "/v1/lines/1/decisions")).res.status).toBe(502);
    const { app: noDesk } = await world({ desk: null, indexerUrl: INDEXER, fetchImpl: indexerTimeline(timeline) });
    expect((await call(noDesk, "GET", "/v1/lines/1/decisions")).res.status).toBe(503);
  });
});
