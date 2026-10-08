import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { seizePanel } from "../src/html.js";
import { aaveDue, createApp, gapsDue, positionsDue, type IndexerClient } from "../src/index.js";
import { KV_SEIZE, isSeizeWatchBody, seizeDue, type SeizeWatchBody } from "../src/seize.js";
import { buildSnapshot } from "../src/snapshot.js";
import { memoryStores } from "../src/stores.js";
import { liveCalendar } from "../src/calendar-impl.js";
import { META } from "./aave-fixtures.js";
import { pool, reads, token } from "./fixtures.js";

// The real calendar (importing another test file would re-run its tests inside this one).
const cal = liveCalendar;
const NOW = 1_791_444_500; // Thu 8 Oct 2026, OVERNIGHT
const snapshot = buildSnapshot(reads([token()], [pool()]), cal, NOW);

/** The shape the indexer's GET /v1/seize-watch answered live on 8 Oct 2026 (block 52,327,536), two stocks kept. */
const BODY: SeizeWatchBody = {
  chainId: 8453,
  asOf: 1_791_444_500,
  live: { block: 52_327_536, error: null },
  coverage: { baseline: { from: 49_145_000, to: 52_327_100, toTime: 1_791_443_547, governanceLogs: 187, method: "full-history eth_getLogs scan" }, tokenEvents: { to: 52_327_494, toTime: 1_791_444_335 } },
  summary: {
    seizeRoleHolders: 0,
    seizeRoleGrantsAllTime: 0,
    seizedAllTime: 0,
    exemptionPolicies: [129],
    venuesNotExempt: [],
    statement: "No account holds SEIZE_ROLE on any of the ten stocks, so no seizure is possible today.",
  },
  policyChanges: [
    { policyId: 129, event: "blocked", accounts: ["0x3f81c5d9378eaeb5051ea0d6cace7e146daef098", "0x35b9ba29c272e9dfd56c8eaa6244e3e7df690564"], block: 52_216_975, time: 1_791_223_297, tx: "0x22b3" },
    { policyId: 129, event: "unblocked", accounts: ["0x3f81c5d9378eaeb5051ea0d6cace7e146daef098", "0x35b9ba29c272e9dfd56c8eaa6244e3e7df690564"], block: 52_217_211, time: 1_791_223_769, tx: "0x4bdb" },
  ],
  tokens: [
    {
      symbol: "AAPLc",
      token: "0xb200000000000000000000C2e324d24d7eEcd1fb",
      verdict: "NO_SEIZE_ROLE",
      seizeRole: { grantsAllTime: 0, holders: [] },
      seizeExemptPolicy: { live: 129, updates: [{ old: 0, new: 129, block: 52_216_682, time: 1_791_222_711, tx: "0xc826" }] },
      seizeReceiverPolicy: { live: 0 },
      seized: 0,
      venues: [
        { name: "Morpho Blue", address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", exempt: true },
        { name: "Aave V4 hub", address: "0xa4d5947Eb727A052bae69C593FfC84247EC9864E", exempt: true },
      ],
    },
    {
      symbol: "NVDAc",
      token: "0xb20000000000000000000078ee7ce2fE4908108C",
      verdict: "SEIZE_ROLE_HELD",
      seizeRole: { grantsAllTime: 1, holders: ["0x00000000000000000000000000000000000000aa"] },
      seizeExemptPolicy: { live: 129, updates: [] },
      seizeReceiverPolicy: { live: 0 },
      seized: 0,
      venues: [{ name: "Morpho Blue", address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", exempt: false }],
    },
  ],
};

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

function indexer(calls: string[], answer: unknown = BODY): IndexerClient {
  return {
    async json<T>(path: string): Promise<T> {
      calls.push(path);
      if (path === "/v1/seize-watch") return answer as T;
      throw new Error(`indexer answered 503 for ${path}`);
    },
  };
}

function appWith(kvSeed: Record<string, unknown> = {}, calls: string[] = [], answer: unknown = BODY) {
  const stores = memoryStores({});
  const built = createApp({ stores: () => stores, calendar: cal, markets: async () => [], indexer: () => indexer(calls, answer), aaveMeta: async () => META });
  return { ...built, ...fakeEnv(kvSeed) };
}

describe("seizeDue", () => {
  it("is minute 3 of every thirty and never shares a tick with positions, Aave or gaps", () => {
    const t = Date.UTC(2026, 9, 8, 12, 3, 0) / 1000;
    expect(seizeDue(t)).toBe(true);
    expect(seizeDue(t + 60)).toBe(false);
    expect(seizeDue(t + 1800)).toBe(true);
    for (let m = 0; m < 24 * 60; m += 1) {
      const at = Date.UTC(2026, 9, 8, 0, 0, 0) / 1000 + m * 60;
      if (seizeDue(at)) expect([positionsDue(at), aaveDue(at), gapsDue(at)]).toEqual([false, false, false]);
    }
  });
});

describe("seizePanel", () => {
  it("renders the statement, the policy changes and one row per stock", () => {
    const html = seizePanel(BODY);
    expect(html).toContain("Seize watch");
    expect(html).toContain("no seizure is possible today");
    expect(html).toContain("policy 129 blocked 2 accounts at block 52216975");
    expect(html).toContain("all 2 exempt");
    expect(html).toContain("Morpho Blue seizable");
    expect(html).toContain("seize role held");
    expect(html).toContain("live at block 52327536");
  });
  it("says so when the indexer has not answered yet", () => {
    expect(seizePanel(null)).toContain("not available yet");
  });
});

describe("/v1/seize-watch and the page", () => {
  it("answers from the indexer on a cache miss, caches in KV, then serves the cache", async () => {
    const calls: string[] = [];
    const { app, env, puts } = appWith({}, calls);
    const first = (await (await app.request("/v1/seize-watch", {}, env)).json()) as SeizeWatchBody;
    expect(first.summary.exemptionPolicies).toEqual([129]);
    expect(puts).toEqual([KV_SEIZE]);
    await app.request("/v1/seize-watch", {}, env);
    expect(calls).toEqual(["/v1/seize-watch"]);
  });
  it("refuses an answer of the wrong shape, and the page still renders", async () => {
    const { app, env, puts } = appWith({}, [], { tokens: "nope" });
    const r = await app.request("/v1/seize-watch", {}, env);
    expect(r.status).toBe(503);
    expect(puts).toEqual([]);
    const page = await (await app.request("/", {}, env)).text();
    expect(page).toContain("Seize watch not available yet");
  });
  it("the page shows the cached panel", async () => {
    const { app, env } = appWith({ [KV_SEIZE]: BODY });
    const page = await (await app.request("/", {}, env)).text();
    expect(page).toContain("No account holds SEIZE_ROLE");
    expect(page).toContain('href="/v1/seize-watch"');
  });
  it("the cron job refreshes it", async () => {
    const calls: string[] = [];
    const { refreshSeize, env, puts } = appWith({}, calls);
    await refreshSeize(env);
    expect(calls).toEqual(["/v1/seize-watch"]);
    expect(puts).toEqual([KV_SEIZE]);
    expect(isSeizeWatchBody(BODY)).toBe(true);
    expect(isSeizeWatchBody({})).toBe(false);
  });
});
