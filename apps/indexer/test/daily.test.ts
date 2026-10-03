import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { computeDailyRoots, rollingRoot } from "../src/daily.js";
import { ZERO_ROOT, chainRoot, dayEnd, dayStart } from "../src/roots.js";
import { MemoryStore } from "../src/store-memory.js";
import { CHAIN, row, txHash } from "./fixtures.js";

const D1 = "2026-10-03";
const D2 = "2026-10-04";
const D3 = "2026-10-05";

async function seeded() {
  const store = new MemoryStore();
  await store.insertEvents([
    row({ blockNumber: 10, logIndex: 0, blockTime: dayStart(D1) + 100, txHash: txHash(10) }),
    row({ blockNumber: 11, logIndex: 0, blockTime: dayStart(D1) + 200, txHash: txHash(11) }),
    row({ blockNumber: 60, logIndex: 1, blockTime: dayStart(D3) + 5, txHash: txHash(60) }),
  ]);
  return store;
}

describe("computeDailyRoots", () => {
  it("roots nothing until every cursor has passed the day", async () => {
    const store = await seeded();
    await store.setCursor({ chainId: CHAIN, source: "a", lastBlock: 20, lastBlockTime: dayEnd(D1) - 1, updatedAt: 0 });
    expect(await computeDailyRoots(store, CHAIN, dayStart(D3) + 10)).toEqual([]);
  });
  it("roots complete days in order, chaining each to the previous, empty days included", async () => {
    const store = await seeded();
    await store.setCursor({ chainId: CHAIN, source: "a", lastBlock: 50, lastBlockTime: dayEnd(D2) + 30, updatedAt: 0 });
    await store.setCursor({ chainId: CHAIN, source: "b", lastBlock: 55, lastBlockTime: dayEnd(D2) + 40, updatedAt: 0 });
    await store.setCursor({ chainId: CHAIN, source: "reconcile", lastBlock: 0, lastBlockTime: 0, updatedAt: 0 }); // ignored
    const made = await computeDailyRoots(store, CHAIN, dayStart(D3) + 10);
    expect(made.map((r) => [r.day, r.eventCount, r.firstBlock, r.lastBlock])).toEqual([
      [D1, 2, 10, 11],
      [D2, 0, null, null],
    ]);
    const d1 = made[0]!;
    const d2 = made[1]!;
    expect(d1.prevRoot).toBe(ZERO_ROOT);
    expect(d1.root).toBe(chainRoot(ZERO_ROOT, await store.eventsBetween(CHAIN, dayStart(D1), dayEnd(D1))));
    expect(d2.prevRoot).toBe(d1.root);
    expect(d2.root).toBe(keccak256(d1.root));
    // idempotent: nothing new on the next tick
    expect(await computeDailyRoots(store, CHAIN, dayStart(D3) + 10)).toEqual([]);
    expect((await store.listRoots(CHAIN, 10)).map((r) => r.day)).toEqual([D2, D1]);
  });
  it("never roots today", async () => {
    const store = await seeded();
    await store.setCursor({ chainId: CHAIN, source: "a", lastBlock: 70, lastBlockTime: dayEnd(D3) + 1, updatedAt: 0 });
    const made = await computeDailyRoots(store, CHAIN, dayStart(D3) + 10);
    expect(made.map((r) => r.day)).toEqual([D1, D2]);
  });
});

describe("rollingRoot", () => {
  it("hashes today's events so far on top of the last stored root and lists pending days", async () => {
    const store = await seeded();
    await store.putRoot({ chainId: CHAIN, day: D1, firstBlock: 10, lastBlock: 11, eventCount: 2, prevRoot: ZERO_ROOT, root: keccak256("0xaa"), computedAt: 1 });
    const r = await rollingRoot(store, CHAIN, dayStart(D3) + 10);
    expect(r.day).toBe(D3);
    expect(r.eventCount).toBe(1);
    expect(r.prevRoot).toBe(keccak256("0xaa"));
    expect(r.pendingDays).toEqual([D2]);
    expect(r.rootSoFar).toBe(chainRoot(keccak256("0xaa"), await store.eventsBetween(CHAIN, dayStart(D3), dayEnd(D3))));
    expect(r.complete).toBe(false);
  });
});
