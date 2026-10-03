import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { ZERO_ROOT, dayStart } from "../src/roots.js";
import { MemoryStore } from "../src/store-memory.js";
import { BORROWER, CHAIN, MORPHO, row, txHash } from "./fixtures.js";

const env = {} as Env;

async function setup() {
  const store = new MemoryStore();
  const rows = [];
  for (let i = 0; i < 7; i++) {
    rows.push(row({ blockNumber: 100 + i, logIndex: i % 2, blockTime: dayStart("2026-10-03") + i, txHash: txHash(100 + i), name: i % 2 === 0 ? "Borrow" : "Repay" }));
  }
  rows.push(row({ blockNumber: 50, logIndex: 0, blockTime: dayStart("2026-10-02") + 1, txHash: txHash(50), address: BORROWER, name: "Decision" }));
  await store.insertEvents(rows);
  await store.setCursor({ chainId: CHAIN, source: "morpho-market-aaplt", lastBlock: 106, lastBlockTime: dayStart("2026-10-03") + 6, updatedAt: 1 });
  await store.putRoot({ chainId: CHAIN, day: "2026-10-02", firstBlock: 50, lastBlock: 50, eventCount: 1, prevRoot: ZERO_ROOT, root: "0x11", computedAt: 1 });
  await store.insertReconciliations([
    { chainId: CHAIN, subject: "market:0x1", checkedAt: 10, blockNumber: 106, expectedJson: '{"a":"1"}', actualJson: '{"a":"1"}', status: "PASS" },
    { chainId: CHAIN, subject: "position:0x1:0x2", checkedAt: 10, blockNumber: 106, expectedJson: '{"c":"1"}', actualJson: '{"c":"2"}', status: "FAIL" },
    { chainId: CHAIN, subject: "market:0x1", checkedAt: 5, blockNumber: 100, expectedJson: "{}", actualJson: "{}", status: "SKIP" },
  ]);
  const app = createApp({ store: () => store, now: () => dayStart("2026-10-03") + 100 });
  const get = async (path: string) => {
    const res = await app.request(path, undefined, env);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { store, get };
}

describe("routes", () => {
  it("/health", async () => {
    const { get } = await setup();
    expect((await get("/health")).body).toEqual({ ok: true, service: "boundline-indexer" });
  });

  it("/v1/events pages newest first with filters", async () => {
    const { get } = await setup();
    const page1 = await get("/v1/events?chain=84532&limit=3");
    const events = page1.body.events as { blockNumber: number; logIndex: number; name: string; args: { id: string } }[];
    expect(page1.body.count).toBe(3);
    expect(events.map((e) => e.blockNumber)).toEqual([106, 105, 104]);
    expect(events[0]?.args.id).toMatch(/^0x4a03/);
    expect(page1.body.next).toBe("104:0");
    const page2 = await get(`/v1/events?chain=84532&limit=3&before=${page1.body.next as string}`);
    expect((page2.body.events as { blockNumber: number }[]).map((e) => e.blockNumber)).toEqual([103, 102, 101]);
    const byName = await get("/v1/events?name=Decision");
    expect(byName.body.count).toBe(1);
    const byAddress = await get(`/v1/events?address=${MORPHO.toUpperCase()}`);
    expect(byAddress.body.count).toBe(7);
    const byRange = await get("/v1/events?from=101&to=102");
    expect((byRange.body.events as { blockNumber: number }[]).map((e) => e.blockNumber)).toEqual([102, 101]);
    const capped = await get("/v1/events?limit=100000");
    expect(capped.body.next).toBeNull();
  });

  it("/v1/cursors", async () => {
    const { get } = await setup();
    const r = await get("/v1/cursors");
    expect((r.body.cursors as { source: string; lastBlock: number }[])[0]).toMatchObject({ source: "morpho-market-aaplt", lastBlock: 106 });
  });

  it("/v1/roots lists stored roots and the rolling root of today", async () => {
    const { get } = await setup();
    const r = await get("/v1/roots?chain=84532");
    expect((r.body.roots as { day: string }[]).map((x) => x.day)).toEqual(["2026-10-02"]);
    const today = r.body.today as { day: string; eventCount: number; prevRoot: string; rootSoFar: string; complete: boolean };
    expect(today.day).toBe("2026-10-03");
    expect(today.eventCount).toBe(7);
    expect(today.prevRoot).toBe("0x11");
    expect(today.rootSoFar).toMatch(/^0x[0-9a-f]{64}$/);
    expect(today.complete).toBe(false);
    expect(typeof r.body.scheme).toBe("string");
  });

  it("/v1/roots/:day", async () => {
    const { get } = await setup();
    expect((await get("/v1/roots/2026-10-02?chain=84532")).body).toMatchObject({ day: "2026-10-02", root: "0x11", eventCount: 1 });
    expect((await get("/v1/roots/2026-10-01")).status).toBe(404);
    expect((await get("/v1/roots/yesterday")).status).toBe(400);
  });

  it("/v1/reconcile/latest returns only the latest run and rolls up its status", async () => {
    const { get } = await setup();
    const r = await get("/v1/reconcile/latest?chain=84532");
    expect(r.body.checkedAt).toBe(10);
    expect(r.body.status).toBe("FAIL");
    const checks = r.body.checks as { subject: string; status: string; actual: { c?: string } }[];
    expect(checks).toHaveLength(2);
    expect(checks[1]?.actual).toEqual({ c: "2" });
    const none = await get("/v1/reconcile/latest?chain=8453");
    expect(none.body.status).toBe("NONE");
  });
});
