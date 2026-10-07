import { describe, expect, it } from "vitest";
import { getDrill, listDrills } from "../src/drills.js";
import { evidenceHash } from "../src/evidence.js";
import { MARKET_ID, PARTNER_ID, USER, call, world } from "./helpers.js";

const INDEXER = "https://indexer.local";
const KEEPER_ACTION = "0x982c7327efa9f0460b92501a4322ec5dc730e5faaca3ce1d87dc80f708dfb695";

describe("drills registry", () => {
  it("lists every drill with numbered steps and the recorded runs", async () => {
    const { app } = await world();
    const { res, json } = await call(app, "GET", "/v1/drills");
    expect(res.status).toBe(200);
    expect(json.count).toBe(11);
    expect(json.drills.map((d: { id: string }) => d.id)).toEqual([
      "weekend-gap", "stale-feed", "registry-pause", "issuer-transfer-pause", "scheduled-multiplier", "ineligible-receiver",
      "venue-halt", "partial-repayment", "bad-debt-probe", "protection", "validity-transactions",
    ]);
    for (const d of json.drills as { steps: { n: number }[]; runs: unknown[] }[]) {
      expect(d.steps.map((s) => s.n)).toEqual(d.steps.map((_, i) => i + 1));
      expect(Array.isArray(d.runs)).toBe(true);
    }
    const protection = json.drills.find((d: { id: string }) => d.id === "protection");
    expect(protection.runs).toHaveLength(1);
    expect(protection.runs[0].txs.map((t: { hash: string }) => t.hash)).toContain(KEEPER_ACTION);
    expect(protection.runs[0].chainId).toBe(84532);
    expect(json.drills.find((d: { id: string }) => d.id === "stale-feed").runs).toEqual([]);
    expect(json.drills.find((d: { id: string }) => d.id === "validity-transactions").runs).toHaveLength(2);
    expect(json.drills.find((d: { id: string }) => d.id === "weekend-gap").runs.map((r: { chainId: number }) => r.chainId)).toEqual([84532, 8453]);
  });

  it("serves one drill, 404s an unknown id and needs a key", async () => {
    const { app } = await world();
    expect((await call(app, "GET", "/v1/drills/protection")).json.drill.title).toMatch(/Protection/);
    const unknown = await call(app, "GET", "/v1/drills/nope");
    expect(unknown.res.status).toBe(404);
    expect(unknown.json.known).toContain("weekend-gap");
    expect((await call(app, "GET", "/v1/drills", { key: null })).res.status).toBe(401);
    expect(getDrill("nope")).toBeNull();
    expect(listDrills().every((d) => d.description.length > 20)).toBe(true);
  });
});

function fakeIndexer(seen: string[], over: Record<string, unknown> = {}, fail = false): typeof fetch {
  const reconcile = { chainId: 84532, checkedAt: 1_791_373_541, blockNumber: 47_763_777, status: "PASS", checks: [{ id: 187, status: "PASS" }] };
  const roots = { chainId: 84532, scheme: "keccak256(prev_root || h1 || ... || hn)", roots: [{ day: "2026-10-06", root: `0x${"9e".repeat(32)}`, eventCount: 54 }] };
  const lines = { lines: [{ lineId: "1", partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, policyVersion: 3, decisionHash: `0x${"56".repeat(32)}`, blockNumber: 47_637_827, blockTime: 1_791_043_942, txHash: `0x${"91".repeat(32)}` }] };
  const timeline = {
    events: [
      { name: "LineOpened", blockNumber: 47_637_827, blockTime: 1_791_043_942, txHash: `0x${"91".repeat(32)}`, logIndex: 1, args: { lineId: "1", decisionHash: `0x${"56".repeat(32)}` } },
      { name: "Decision", blockNumber: 47_637_827, blockTime: 1_791_043_942, txHash: `0x${"91".repeat(32)}`, logIndex: 2, args: { lineId: "1", action: `0x${Buffer.from("OPEN").toString("hex").padEnd(64, "0")}`, decisionHash: `0x${"56".repeat(32)}`, amount: "0", price8: "0" } },
    ],
  };
  const bodies: Record<string, unknown> = { "/v1/reconcile/latest": reconcile, "/v1/roots": roots, ...over };
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (fail) throw new Error("connect ECONNREFUSED");
    const path = url.replace(INDEXER, "").split("?")[0] as string;
    if (path.endsWith("/timeline")) return Response.json(timeline);
    if (path === "/v1/desk/lines") return Response.json(lines);
    const body = bodies[path];
    return body ? Response.json(body) : new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("GET /v1/reconciliation", () => {
  it("combines the indexer's latest reconciliation and daily roots", async () => {
    const seen: string[] = [];
    const { app } = await world({ indexerUrl: INDEXER, fetchImpl: fakeIndexer(seen) });
    const { res, json } = await call(app, "GET", "/v1/reconciliation");
    expect(res.status).toBe(200);
    expect(seen).toEqual([`${INDEXER}/v1/reconcile/latest`, `${INDEXER}/v1/roots`]);
    expect(json.reconcile).toMatchObject({ status: "PASS", blockNumber: 47_763_777 });
    expect(json.roots.roots[0].day).toBe("2026-10-06");
    expect(json.source).toBe("indexer");
  });

  it("answers 501 without an indexer and 502 when it is down", async () => {
    const { app: unbound } = await world();
    expect((await call(unbound, "GET", "/v1/reconciliation")).res.status).toBe(501);
    const { app: down } = await world({ indexerUrl: INDEXER, fetchImpl: fakeIndexer([], {}, true) });
    const r = await call(down, "GET", "/v1/reconciliation");
    expect(r.res.status).toBe(502);
    expect(r.json.stage).toBe("reconcile");
  });
});

describe("GET /v1/evidence/export", () => {
  it("bundles policy, obligations, decisions, reconciliation and drills under a reproducible hash", async () => {
    const seen: string[] = [];
    const { app } = await world({ indexerUrl: INDEXER, fetchImpl: fakeIndexer(seen) });
    const { res, json } = await call(app, "GET", "/v1/evidence/export");
    expect(res.status).toBe(200);
    expect(json.schema).toBe("boundline-evidence/1");
    expect(json.partnerId).toBe(PARTNER_ID);
    expect(json.policy.tickers).toHaveLength(2);
    expect(json.obligations).toMatchObject({ source: "indexer", count: 1 });
    expect(json.obligations.rows[0]).toMatchObject({ lineId: "1", lineStatus: "OPEN", obligationStatus: "OPEN" });
    expect(json.decisions).toHaveLength(1);
    expect(json.decisions[0]).toMatchObject({ lineId: "1", source: "indexer" });
    expect(json.decisions[0].decisions[0]).toMatchObject({ action: "OPEN", hash: `0x${"56".repeat(32)}` });
    expect(json.decisions[0].timeline[0].event).toBe("LineOpened");
    expect(json.reconciliation.reconcile.status).toBe("PASS");
    expect(json.reconciliation.roots.roots).toHaveLength(1);
    expect(json.drills).toHaveLength(11);
    expect(json.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(json.hashScheme).toMatch(/keccak256/);
    // Anyone can recompute: the hash covers everything except itself and the correlation id.
    expect(evidenceHash(json)).toBe(json.hash);
    const again = await call(app, "GET", "/v1/evidence/export");
    expect(again.json.hash).toBe(json.hash);
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("sets a download disposition on request and degrades without an indexer", async () => {
    const { app } = await world();
    const { res, json } = await call(app, "GET", "/v1/evidence/export?format=download");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="boundline-evidence-boundline-app-\d+\.json"$/);
    expect(json.obligations.source).toBe("api-cache");
    expect(json.reconciliation).toEqual({ error: "not implemented" });
    expect(json.decisions).toEqual([]);
    expect(evidenceHash(json)).toBe(json.hash);
  });
});
