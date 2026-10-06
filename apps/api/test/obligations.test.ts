import { describe, expect, it } from "vitest";
import { MARKET_ID, PARTNER_ID, USER, call, makeDesk, sampleLine, world } from "./helpers.js";

const INDEXER = "https://indexer.local";

function indexerLines(lines: Record<string, unknown>[], seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ chainId: 84532, count: lines.length, lines }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const opened = (lineId: string, user = USER) => ({ lineId, partnerId: PARTNER_ID, user, marketId: MARKET_ID, policyVersion: 3, decisionHash: `0x${lineId.padStart(64, "0")}`, blockNumber: 47_700_000 + Number(lineId), blockTime: 1_791_000_000 + Number(lineId), txHash: `0x${"ab".repeat(32)}` });

describe("GET /v1/obligations", () => {
  it("lists the partner's lines from the indexer with live desk statuses, and caches them", async () => {
    const seen: string[] = [];
    const { app, store } = await world({
      indexerUrl: INDEXER,
      fetchImpl: indexerLines([opened("2"), opened("1")], seen),
      desk: makeDesk({
        obligationStatus: async (id) => (id === 2n ? 6 : 1),
        line: async (id) => sampleLine({ status: id === 2n ? 2 : 1, drawnPrincipal: id === 1n ? 5_000_000n : 0n }),
      }),
    });
    const { res, json } = await call(app, "GET", "/v1/obligations?partnerId=boundline-app&limit=10");
    expect(res.status).toBe(200);
    expect(seen[0]).toBe(`${INDEXER}/v1/desk/lines?chainId=84532&partnerId=${PARTNER_ID}&limit=10`);
    expect(json.source).toBe("indexer");
    expect(json.count).toBe(2);
    expect(json.obligations.map((o: { lineId: string }) => o.lineId)).toEqual(["2", "1"]);
    expect(json.obligations[0]).toMatchObject({ lineId: "2", user: USER, lineStatus: "HELD", obligationStatus: "HOLD_KEEPER", openedBlock: 47_700_002, openTx: `0x${"ab".repeat(32)}`, decisionHash: `0x${"2".padStart(64, "0")}` });
    expect(json.obligations[1]).toMatchObject({ lineId: "1", lineStatus: "OPEN", obligationStatus: "OPEN", drawnPrincipal: { baseUnits: "5000000", usdc: "5.000000" }, policyVersion: 3 });
    expect(res.headers.get("x-policy-version")).toBe("3");
    expect(store.lines.has("2")).toBe(true);
  });

  it("falls back to the lines this API has seen when the indexer is down or unbound", async () => {
    const down = (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch;
    const { app, store } = await world({ indexerUrl: INDEXER, fetchImpl: down });
    await store.rememberLine({ lineId: "1", partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, firstSeen: 100 });
    const { res, json } = await call(app, "GET", "/v1/obligations");
    expect(res.status).toBe(200);
    expect(json.source).toBe("api-cache");
    expect(json.sourceNote).toMatch(/indexer unavailable/);
    expect(json.obligations[0]).toMatchObject({ lineId: "1", openedBlock: null, obligationStatus: "OPEN" });
    const { app: unbound } = await world();
    const r2 = await call(unbound, "GET", "/v1/obligations");
    expect(r2.json.source).toBe("api-cache");
    expect(r2.json.sourceNote).toMatch(/no indexer bound/);
    expect(r2.json.count).toBe(0);
  });

  it("refuses another partner's id and tolerates a missing desk", async () => {
    const { app } = await world({ desk: null, indexerUrl: INDEXER, fetchImpl: indexerLines([opened("1")]) });
    expect((await call(app, "GET", "/v1/obligations?partnerId=someone-else")).res.status).toBe(403);
    const { json } = await call(app, "GET", "/v1/obligations");
    expect(json.count).toBe(1);
    expect(json.obligations[0].obligationStatus).toBe("UNKNOWN");
    expect(json.obligations[0].lineStatus).toBe("UNKNOWN");
  });
});
