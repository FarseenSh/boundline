import { describe, expect, it } from "vitest";
import { AAVE_CHAIN_ID, type AavePositionRow } from "../src/aave-positions.js";
import { KV_ASSURANCE } from "../src/assurance.js";
import type { Env } from "../src/env.js";
import { KV_GAPS, type GapsPanel, type IndexerRoundsBody } from "../src/gaps.js";
import { aaveDue, createApp, gapsDue, positionsDue, type IndexerClient } from "../src/index.js";
import type { PositionRow } from "../src/positions.js";
import { buildSnapshot } from "../src/snapshot.js";
import { memoryStores } from "../src/stores.js";
import { BORROWER, META } from "./aave-fixtures.js";
import { RUN } from "./assurance.test.js";
import { REOPEN, weekendCalendar } from "./capture.test.js";
import { pool, reads, token } from "./fixtures.js";

const cal = weekendCalendar();
const CLOSE = REOPEN - 48 * 3600;
const NOW = REOPEN + 3 * 3600; // Sunday evening after the reopen
const snapshot = buildSnapshot(reads([token()], [pool()]), cal, NOW);

function fakeEnv(kvSeed: Record<string, unknown> = {}) {
  const store = new Map<string, string>(Object.entries(kvSeed).map(([k, v]) => [k, JSON.stringify(v)]));
  store.set("latest", JSON.stringify(snapshot));
  const puts: string[] = [];
  const kv = {
    async get(key: string) {
      const v = store.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
    async getWithMetadata() {
      return { value: null, metadata: null };
    },
    async put(key: string, value: string) {
      puts.push(key);
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  const env: Env = { SNAPSHOTS: kv, DB: {} as D1Database, BASE_RPC_URL: "" };
  return { env, puts, store };
}

const roundsBody: IndexerRoundsBody = {
  symbol: "AAPLc",
  rounds: [
    { roundId: "250", answer: "34024000000", updatedAt: REOPEN + 45 },
    { roundId: "249", answer: "34151300000", updatedAt: CLOSE - 1800 },
  ],
  gaps: [{ fromUpdatedAt: CLOSE - 1800, toUpdatedAt: REOPEN + 45, heldAnswer: "34151300000", nextAnswer: "34024000000", moveBps: -37.28 }],
};

function fakeIndexer(calls: string[] = []): IndexerClient {
  return {
    async json<T>(path: string): Promise<T> {
      calls.push(path);
      if (path.startsWith("/v1/feeds/AAPLc/rounds")) return roundsBody as unknown as T;
      if (path.startsWith("/v1/feeds/")) return { symbol: "x", rounds: [], gaps: [] } as unknown as T;
      throw new Error(`indexer answered 503 for ${path}`);
    },
  };
}

const aaveRow: AavePositionRow = {
  chainId: AAVE_CHAIN_ID,
  venue: "aave",
  spoke: "0x17905Db0e4A3514467539956c084180616AE7B8D",
  address: BORROWER,
  takenAt: NOW - 120,
  blockNumber: 52295129,
  debtUsdc: "3099171323",
  debtValueUsd: 3098.7,
  collateralValueUsd: 7159.39,
  shadowCollateralValueUsd: 6000,
  shadowCoverage: 0.13,
  collateral: [{ reserveId: 5, symbol: "NVDAc", raw: "420066094", amount: 4.20066094, collateralFactor: 0.7, venuePrice: 238.15, shadowPrice: 120, venueValueUsd: 1000.4, shadowValueUsd: 504 }],
  venueHf: 1.6809,
  modelHf: 1.6809,
  shadowHf: 0.98,
  protectionCase: true,
  riskPremiumBps: 0,
  avgCollateralFactor: 0.7275,
};

const morphoRow: PositionRow = {
  chainId: 8453,
  marketId: "0xae1a30486234bf7e7ac166c7c03d9bc5f2cd8a39be2c48e73c665ac7148c3c28",
  address: BORROWER,
  takenAt: NOW - 60,
  blockNumber: 52295130,
  collateralSymbol: "AAPLc",
  lltv: 0.625,
  collateral: "1000000000",
  borrowShares: "1",
  debtAssets: "1500000000",
  venuePrice: 333.66,
  shadowPrice: 330,
  venueHf: 1.39,
  shadowHf: 1.37,
  protectionCase: false,
};

function appWith(seed: Parameters<typeof memoryStores>[0] = {}, kvSeed: Record<string, unknown> = {}, indexerCalls: string[] = []) {
  const stores = memoryStores(seed);
  const { app } = createApp({ stores: () => stores, calendar: cal, markets: async () => [], indexer: () => fakeIndexer(indexerCalls), aaveMeta: async () => META });
  return { app, stores, ...fakeEnv(kvSeed) };
}

describe("/v1/venues/aave/positions", () => {
  it("serves the latest row per borrower with the reserve table from the KV meta", async () => {
    const older = { ...aaveRow, takenAt: aaveRow.takenAt - 600, shadowHf: 1.3, protectionCase: false };
    const { app, env } = appWith({ aavePositions: [older, aaveRow], aaveBorrowers: [{ chainId: AAVE_CHAIN_ID, address: BORROWER, firstSeenBlock: 1, lastSeenBlock: 2, reserveIds: [7], source: "indexer", updatedAt: 1 }] }, { "aave-reserve-meta": META });
    const body = (await (await app.request("/v1/venues/aave/positions", {}, env)).json()) as { count: number; protectionCases: number; borrowersKnown: number; takenAt: number; reserves: Array<{ symbol: string; collateralFactor: number }>; positions: AavePositionRow[] };
    expect(body.count).toBe(1);
    expect(body.protectionCases).toBe(1);
    expect(body.borrowersKnown).toBe(1);
    expect(body.takenAt).toBe(aaveRow.takenAt);
    expect(body.positions[0]?.shadowHf).toBe(0.98);
    expect(body.reserves.find((r) => r.symbol === "AAPLc")?.collateralFactor).toBe(0.78);
  });

  it("answers an empty book without the meta", async () => {
    const { app, env } = appWith();
    const body = (await (await app.request("/v1/venues/aave/positions", {}, env)).json()) as { count: number; takenAt: number | null; reserves: null };
    expect(body).toMatchObject({ count: 0, takenAt: null, reserves: null });
  });
});

describe("/v1/positions/:addr/shadow across venues", () => {
  it("lists the Morpho rows and the latest Aave row, and protects when either says so", async () => {
    const { app, env } = appWith({ positions: [morphoRow], aavePositions: [aaveRow] });
    const body = (await (await app.request(`/v1/positions/${BORROWER}/shadow`, {}, env)).json()) as { decision: string; history: number; positions: Array<{ venue: string; protectionCase: boolean }> };
    expect(body.positions.map((p) => p.venue)).toEqual(["morpho", "aave"]);
    expect(body.decision).toBe("PROTECT");
    expect(body.history).toBe(2);
    const aaveOnly = appWith({ aavePositions: [{ ...aaveRow, protectionCase: false, shadowHf: 1.4 }] });
    const b2 = (await (await aaveOnly.app.request(`/v1/positions/${BORROWER}/shadow`, {}, aaveOnly.env)).json()) as { decision: string; positions: Array<{ venue: string }> };
    expect(b2.decision).toBe("ALLOW");
    expect(b2.positions).toEqual([expect.objectContaining({ venue: "aave" })]);
  });
});

describe("/v1/gaps", () => {
  it("computes the panel from the indexer, the evidence and the captures, caches it in KV, then serves the cache", async () => {
    const calls: string[] = [];
    const { app, env, puts } = appWith({}, {}, calls);
    const body = (await (await app.request("/v1/gaps", {}, env)).json()) as GapsPanel;
    expect(calls.filter((c) => c.startsWith("/v1/feeds/"))).toHaveLength(10);
    expect(body.weekends[0]?.reopenAt).toBe(REOPEN);
    expect(body.weekends[0]?.sources).toEqual(["evidence", "indexer"]);
    expect(body.weekends[0]?.feeds.find((f) => f.symbol === "AAPLc")?.source).toBe("evidence"); // the evidence and the fake share the 4 Oct reopen
    expect(body.indexer.symbols).toBe(10);
    expect(puts).toContain(KV_GAPS);
    const again = (await (await app.request("/v1/gaps", {}, env)).json()) as GapsPanel;
    expect(again.computedAt).toBe(body.computedAt);
    expect(calls.filter((c) => c.startsWith("/v1/feeds/"))).toHaveLength(10); // served from KV: no second round of fetches
  });

  it("still answers with the evidence when there is no indexer binding", async () => {
    const stores = memoryStores();
    const { app } = createApp({ stores: () => stores, calendar: cal, markets: async () => [], indexer: () => null, aaveMeta: async () => META });
    const { env } = fakeEnv();
    const body = (await (await app.request("/v1/gaps", {}, env)).json()) as GapsPanel;
    expect(body.weekends).toHaveLength(1);
    expect(body.indexer).toEqual({ symbols: 0, through: null, errors: [] });
  });
});

describe("/v1/assurance", () => {
  it("says no run yet, then serves the run the harness wrote", async () => {
    const empty = appWith();
    expect(await (await empty.app.request("/v1/assurance", {}, empty.env)).json()).toEqual({ status: "no run yet" });
    const withRun = appWith({}, { [KV_ASSURANCE]: RUN });
    const body = (await (await withRun.app.request("/v1/assurance", {}, withRun.env)).json()) as { summary: { pass: boolean }; evidenceHash: string };
    expect(body.summary.pass).toBe(true);
    expect(body.evidenceHash).toBe("0xabc");
    const bad = appWith({}, { [KV_ASSURANCE]: { version: 1 } });
    expect(await (await bad.app.request("/v1/assurance", {}, bad.env)).json()).toEqual({ status: "malformed", detail: "ranAt missing" });
  });
});

describe("the page", () => {
  it("renders the three new panels with their data", async () => {
    const { app, env } = appWith({ aavePositions: [aaveRow] }, { [KV_ASSURANCE]: RUN });
    const html = await (await app.request("/", {}, env)).text();
    expect(html).toContain("Aave V4 positions");
    expect(html).toContain("0x84c4…d980");
    expect(html).toContain("shadow HF &lt; 1.05");
    expect(html).toContain("4.20 NVDAc");
    expect(html).toContain("Weekend gaps");
    expect(html).toContain("Oct 04"); // the evidence reopen, Sun 4 Oct 20:00 ET
    expect(html).toContain("-7.5 bps");
    expect(html).toContain("Nightly assurance");
    expect(html).toContain("pre-repay saturday");
    expect(html).toContain("0xabc");
    expect(html).toContain('href="/v1/gaps"');
    expect(html).toContain('href="/v1/assurance"');
  });

  it("degrades to the empty states", async () => {
    const { app, env } = appWith();
    const html = await (await app.request("/", {}, env)).text();
    expect(html).toContain("No MAG7 spoke borrowers read yet");
    expect(html).toContain("No run yet");
    expect(html).toContain("Reopen <b>Sun, Oct 04");
  });
});

describe("tick schedule", () => {
  it("gapsDue is minute 2 of every ten", () => {
    const t = Date.UTC(2026, 9, 7, 12, 2, 10) / 1000;
    expect(gapsDue(t)).toBe(true);
    expect(gapsDue(t + 60)).toBe(false);
    expect(gapsDue(t + 600)).toBe(true);
    expect(gapsDue(Date.UTC(2026, 9, 7, 12, 5, 0) / 1000)).toBe(false);
  });

  it("aaveDue is minute 1 of every five, and the three jobs never share a tick", () => {
    const t = Date.UTC(2026, 9, 7, 12, 1, 30) / 1000;
    expect(aaveDue(t)).toBe(true);
    expect(aaveDue(t + 300)).toBe(true);
    expect(aaveDue(t - 60)).toBe(false);
    expect(aaveDue(t + 60)).toBe(false);
    for (let m = 0; m < 60; m += 1) {
      const at = Date.UTC(2026, 9, 7, 13, m, 0) / 1000;
      expect(Number(positionsDue(at)) + Number(aaveDue(at)) + Number(gapsDue(at))).toBeLessThanOrEqual(1);
    }
  });
});
