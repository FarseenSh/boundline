import { describe, expect, it } from "vitest";
import { MARKET_ID, NVDAT, NVDA_MARKET_ID, OTHER_PARTNER_ID, PARTNER_ID, PRE_LIQ, PROTECTOR, USER, call, encodeSizingReturn, makeDesk, sampleLine, world } from "./helpers.js";

const INDEXER = "https://indexer.local";
const OTHER_USER = "0xc709E654f322714261b65280A0f7121B3a0F0BE8";

describe("GET /v1/positions/:addr/shadow", () => {
  it("finds the partner's lines through lineOf, reads the Protector's sizing and decides PROTECT inside the band", async () => {
    const seen: string[] = [];
    const inBand = encodeSizingReturn({ standing: 3n, shadowLtvWad: 601_200_000_000_000_000n, venueLtvWad: 601_200_000_000_000_000n, maxSeizedAssets: 52_273n, maxRepaidAssets: 171_377n, preLifWad: 1_014_700_000_000_000_000n });
    const { app } = await world({
      desk: makeDesk({
        lineOf: async (_p, _u, marketId) => (marketId === MARKET_ID ? 1n : 0n),
        ethCall: async (to, data) => {
          seen.push(`${to}:${data.slice(0, 10)}`);
          return inBand;
        },
      }),
    });
    const { res, json } = await call(app, "GET", `/v1/positions/${USER}/shadow`);
    expect(res.status).toBe(200);
    expect(json.decision).toBe("PROTECT");
    expect(json.count).toBe(1);
    expect(json.metered).toBe(false);
    expect(json.lines[0]).toMatchObject({ lineId: "1", symbol: "AAPLt", status: "OPEN", obligationStatus: "OPEN", marketId: MARKET_ID });
    expect(json.lines[0].quote.reason).toBe("NONE");
    expect(json.lines[0].protection).toMatchObject({ preLiquidation: PRE_LIQ, protector: PROTECTOR, standing: "IN_BAND", keeperAction: "partial pre-liquidation to the target LTV" });
    expect(json.lines[0].protection.shadowLtv).toEqual({ wad: "601200000000000000", ratio: 0.6012 });
    expect(json.lines[0].protection.maxRepaidAssets).toEqual({ baseUnits: "171377", usdc: "0.171377" });
    expect(seen).toEqual([`${PROTECTOR}:0x94eb1b61`]);
    expect(json.sources.desk).toBe("lineOf per configured market");
  });

  it("decides ALLOW below the band and leaves protection null where no pre-liquidation exists", async () => {
    const { app } = await world({
      desk: makeDesk({
        lineOf: async (_p, _u, marketId) => (marketId === MARKET_ID ? 1n : marketId === NVDA_MARKET_ID ? 2n : 0n),
        line: async (id) => (id === 2n ? sampleLine({ marketId: NVDA_MARKET_ID, collateral: NVDAT }) : sampleLine()),
      }),
    });
    const { json } = await call(app, "GET", `/v1/positions/${USER}/shadow`);
    expect(json.decision).toBe("ALLOW");
    expect(json.lines.map((l: { lineId: string }) => l.lineId)).toEqual(["1", "2"]);
    expect(json.lines[0].protection.standing).toBe("BELOW_BAND");
    expect(json.lines[0].protection.keeperAction).toBe("none");
    expect(json.lines[1]).toMatchObject({ symbol: "NVDAt", protection: null });
  });

  it("answers UNKNOWN with no lines, hides another partner's line, and dedupes the indexer and cache sources", async () => {
    const { app: empty } = await world({ desk: makeDesk({ lineOf: async () => 0n }) });
    const none = await call(empty, "GET", `/v1/positions/${USER}/shadow`);
    expect(none.json).toMatchObject({ decision: "UNKNOWN", count: 0 });

    const seen: string[] = [];
    const indexer = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ lines: [{ lineId: "1", user: USER.toLowerCase(), marketId: MARKET_ID }, { lineId: "3", user: OTHER_USER, marketId: MARKET_ID }, { lineId: "4", user: USER, marketId: MARKET_ID }] }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const { app, store } = await world({
      indexerUrl: INDEXER,
      fetchImpl: indexer,
      desk: makeDesk({
        lineOf: async () => 0n,
        line: async (id) => (id === 4n ? sampleLine({ partnerId: OTHER_PARTNER_ID }) : sampleLine()),
      }),
    });
    await store.rememberLine({ lineId: "1", partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, firstSeen: 1 });
    const { json } = await call(app, "GET", `/v1/positions/${USER}/shadow`);
    expect(seen[0]).toBe(`${INDEXER}/v1/desk/lines?chainId=84532&partnerId=${PARTNER_ID}&limit=100`);
    expect(json.lines.map((l: { lineId: string }) => l.lineId)).toEqual(["1"]); // 3 is another user's, 4 is another partner's
    expect(json.sources.indexer).toBe("LineOpened events");
  });

  it("reports a sizing read failure without failing the line, validates the address and needs the desk", async () => {
    const { app } = await world({ desk: makeDesk({ lineOf: async (_p, _u, m) => (m === MARKET_ID ? 1n : 0n), ethCall: async () => { throw new Error("execution reverted"); } }) });
    const { json } = await call(app, "GET", `/v1/positions/${USER}/shadow`);
    expect(json.lines[0].protection).toMatchObject({ standing: "UNKNOWN", detail: "execution reverted" });
    expect(json.decision).toBe("ALLOW");
    expect((await call(app, "GET", "/v1/positions/nope/shadow")).res.status).toBe(400);
    const { app: noDesk } = await world({ desk: null });
    expect((await call(noDesk, "GET", `/v1/positions/${USER}/shadow`)).res.status).toBe(503);
  });
});
