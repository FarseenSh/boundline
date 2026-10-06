import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { createApp, positionsDue } from "../src/index.js";
import type { PositionRow } from "../src/positions.js";
import { buildSnapshot } from "../src/snapshot.js";
import { memoryStores, type CaptureRunRecord } from "../src/stores.js";
import { REOPEN, weekendCalendar } from "./capture.test.js";
import { pool, reads, token } from "./fixtures.js";

const cal = weekendCalendar();
const NOW = REOPEN - 20 * 3600; // Saturday, idle weekend

function fakeEnv(snapshot: unknown): Env {
  const kv = {
    async get(key: string) {
      return key === "latest" ? snapshot : null;
    },
    async getWithMetadata() {
      return { value: null, metadata: null };
    },
    async put() {
      return undefined;
    },
  } as unknown as KVNamespace;
  return { SNAPSHOTS: kv, DB: {} as D1Database, BASE_RPC_URL: "" };
}

const snapshot = buildSnapshot(reads([token()], [pool()]), cal, NOW);
const MARKET = "0xae1a30486234bf7e7ac166c7c03d9bc5f2cd8a39be2c48e73c665ac7148c3c28";
const position: PositionRow = {
  chainId: 8453,
  marketId: MARKET,
  address: "0x1111111111111111111111111111111111111111",
  takenAt: NOW - 120,
  blockNumber: 52117500,
  collateralSymbol: "AAPLc",
  lltv: 0.625,
  collateral: "1000000000",
  borrowShares: "1500000000000000",
  debtAssets: "1500000001",
  venuePrice: 333.66,
  shadowPrice: 230,
  venueHf: 1.39,
  shadowHf: 0.96,
  protectionCase: true,
};
const run: CaptureRunRecord = {
  transitionAt: REOPEN - 7 * 86400,
  fromSession: "WEEKEND",
  toSession: "OVERNIGHT",
  kind: "reopen",
  armedAt: REOPEN - 7 * 86400 - 900,
  firstUpdateAt: REOPEN - 7 * 86400 + 190,
  completedAt: REOPEN - 7 * 86400 + 5400,
  summary: { perToken: { AAPLc: { heldAnswer: "33000000000", heldUpdatedAt: REOPEN - 9 * 86400, first: { feedUpdatedAt: REOPEN - 7 * 86400 + 190, seenAt: REOPEN - 7 * 86400 + 240, block: 1, roundId: "9", answer: "33500000000", lagSeconds: 190, gapBps: 151.5 } } }, ticks: 106, lastTickAt: REOPEN - 7 * 86400 + 5400 },
};

function appWith(seed: Parameters<typeof memoryStores>[0]) {
  const stores = memoryStores(seed);
  const { app } = createApp({ stores: () => stores, calendar: cal, markets: async () => [] });
  return { app, stores, env: fakeEnv(snapshot) };
}

describe("page", () => {
  it("renders the idle capture panel with the countdown and the empty positions panel", async () => {
    const { app, env } = appWith({});
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Reopen capture");
    expect(html).toContain("WEEKEND → OVERNIGHT");
    expect(html).toContain("in 20h 0m");
    expect(html).toContain("No capture recorded yet");
    expect(html).toContain("No borrowers discovered yet");
  });

  it("renders the latest run and the protection case", async () => {
    const { app, env } = appWith({ runs: [run], positions: [position] });
    const html = await (await app.request("/", {}, env)).text();
    expect(html).toContain("complete");
    expect(html).toContain("+151.5 bps");
    expect(html).toContain("335.00");
    expect(html).toContain("<td>3m</td>"); // the 190 s lag renders through fmtAge
    expect(html).toContain("shadow &lt; 1, venue says healthy");
    expect(html).toContain("0x1111…1111");
    expect(html).toContain("0.960");
  });
});

describe("json routes", () => {
  it("/v1/captures lists runs with the next feed transition", async () => {
    const { app, env } = appWith({ runs: [run] });
    const body = (await (await app.request("/v1/captures", {}, env)).json()) as { runs: CaptureRunRecord[]; nextFeedTransition: { at: number } | null };
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]?.summary.perToken["AAPLc"]?.first?.lagSeconds).toBe(190);
    expect(body.nextFeedTransition).not.toBeNull();
  });

  it("/v1/captures/:at returns the rows or 404", async () => {
    const { app, env, stores } = appWith({ runs: [run] });
    await stores.capture.addRows([
      { transitionAt: run.transitionAt, fromSession: "WEEKEND", toSession: "OVERNIGHT", tokenSymbol: "AAPLc", phase: "before", takenAt: run.armedAt, blockNumber: 1, feedRoundId: "8", feedAnswer: "33000000000", feedUpdatedAt: REOPEN - 9 * 86400, dexPrice: 331, twapPrice: 331.5, note: null },
    ]);
    const ok = (await (await app.request(`/v1/captures/${run.transitionAt}`, {}, env)).json()) as { run: CaptureRunRecord; rows: unknown[] };
    expect(ok.run.kind).toBe("reopen");
    expect(ok.rows).toHaveLength(1);
    expect((await app.request("/v1/captures/123", {}, env)).status).toBe(404);
    expect((await app.request("/v1/captures/abc", {}, env)).status).toBe(400);
  });

  it("/v1/positions and the shadow route serve the latest rows", async () => {
    const older = { ...position, takenAt: position.takenAt - 600, shadowHf: 1.2, protectionCase: false };
    const { app, env } = appWith({ positions: [older, position] });
    const all = (await (await app.request("/v1/positions", {}, env)).json()) as { count: number; protectionCases: number; positions: PositionRow[] };
    expect(all.count).toBe(1);
    expect(all.protectionCases).toBe(1);
    expect(all.positions[0]?.takenAt).toBe(position.takenAt);
    const one = (await (await app.request(`/v1/positions/${position.address}/shadow`, {}, env)).json()) as { decision: string; positions: PositionRow[]; history: number };
    expect(one.decision).toBe("PROTECT");
    expect(one.positions).toHaveLength(1);
    expect(one.history).toBe(2);
    const none = (await (await app.request("/v1/positions/0x9999999999999999999999999999999999999999/shadow", {}, env)).json()) as { decision: string };
    expect(none.decision).toBe("UNKNOWN");
    expect((await app.request("/v1/positions/nope/shadow", {}, env)).status).toBe(400);
  });

  it("/v1/sessions carries the next feed transition", async () => {
    const { app, env } = appWith({});
    const body = (await (await app.request("/v1/sessions", {}, env)).json()) as { state: string; nextFeedTransition: { at: number; kind: string } };
    expect(body.state).toBe("WEEKEND");
    expect(body.nextFeedTransition).toEqual({ at: REOPEN, from: "WEEKEND", to: "OVERNIGHT", kind: "reopen" });
  });
});

describe("positionsDue", () => {
  it("is true on wall-clock minutes divisible by five, whatever the second", () => {
    const t = Date.UTC(2026, 9, 6, 12, 5, 30) / 1000;
    expect(positionsDue(t)).toBe(true);
    expect(positionsDue(t + 60)).toBe(false); // 12:06:30
    expect(positionsDue(t + 3 * 60)).toBe(false); // 12:08:30
    expect(positionsDue(t + 4 * 60 + 59)).toBe(true); // 12:10:29
  });
});
