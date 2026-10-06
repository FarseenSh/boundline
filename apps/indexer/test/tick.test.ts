import { describe, expect, it } from "vitest";
import { morphoEventsAbi } from "../src/abis.js";
import type { RawLog } from "../src/decode.js";
import { ingestSource, type LogClient, type LogFilter } from "../src/ingest.js";
import { dayEnd, dayStart } from "../src/roots.js";
import type { Source } from "../src/sources.js";
import { MemoryStore } from "../src/store-memory.js";
import { ROOTS_EVERY_SECONDS, TICK_MIN_GAP_SECONDS, rotateSources, runTick } from "../src/tick.js";
import { BORROWER, CHAIN, MARKET, MORPHO, makeLog } from "./fixtures.js";

function src(id: string, startBlock = 1_000): Source {
  return { id, chainId: 84532, addresses: [MORPHO], topics: [], abi: morphoEventsAbi, startBlock };
}

function logAt(block: number, logIndex = 0): RawLog {
  return makeLog({ abi: morphoEventsAbi, eventName: "SupplyCollateral", args: { id: MARKET, caller: BORROWER, onBehalf: BORROWER, assets: 1n }, address: MORPHO, blockNumber: block, logIndex });
}

function client(head: number, logs: RawLog[]): LogClient & { calls: LogFilter[] } {
  const calls: LogFilter[] = [];
  return {
    calls,
    getBlockNumber: async () => head,
    getLogs: async (f) => {
      calls.push(f);
      return logs.filter((l) => {
        const n = Number.parseInt(l.blockNumber as string, 16);
        return n >= f.fromBlock && n <= f.toBlock;
      });
    },
    getBlockTime: async (n) => dayStart("2026-10-05") + n,
  };
}

const reader = { position: async () => ({ supplyShares: 0n, borrowShares: 0n, collateral: 0n }), market: async () => ({ totalSupplyAssets: 0n, totalSupplyShares: 0n, totalBorrowAssets: 0n, totalBorrowShares: 0n }) };

describe("rotateSources", () => {
  it("starts from a different source each minute and keeps the cycle", () => {
    const s = ["a", "b", "c"];
    expect(rotateSources(s, 0)).toEqual(["a", "b", "c"]);
    expect(rotateSources(s, 60)).toEqual(["b", "c", "a"]);
    expect(rotateSources(s, 120)).toEqual(["c", "a", "b"]);
    expect(rotateSources(s, 180)).toEqual(["a", "b", "c"]);
    expect(rotateSources([], 60)).toEqual([]);
  });
});

describe("ingestSource with a shared budget", () => {
  it("stops starting ranges once the range or log allowance is spent, finishing the range it started", async () => {
    const store = new MemoryStore();
    const logs = [logAt(1_100), logAt(1_200), logAt(3_100)];
    const budget = { ranges: 5, logs: 2 };
    const r = await ingestSource(store, client(20_000, logs), src("s"), { range: 2000, maxRanges: 5, deadlineMs: Date.now() + 10_000, now: () => 1, budget });
    // first range (1000..2999) holds 2 logs and spends the whole log allowance; no second range starts
    expect(r.ranges).toBe(1);
    expect(r.inserted).toBe(2);
    expect(r.budgetExhausted).toBe(true);
    expect(budget).toEqual({ ranges: 4, logs: 0 });
    const again = await ingestSource(store, client(20_000, logs), src("s"), { range: 2000, maxRanges: 5, deadlineMs: Date.now() + 10_000, now: () => 1, budget: { ranges: 1, logs: 100 } });
    expect(again.ranges).toBe(1);
    expect(again.cursorAfter).toBe(4_999);
    expect(again.inserted).toBe(1);
  });
});

describe("runTick", () => {
  it("skips a tick that starts under 40 s after the previous one (cron and the Observatory kick both fire)", async () => {
    const store = new MemoryStore();
    const c = client(50_000, []);
    let now = 600;
    const deps = { store, clientFor: () => c, readerFor: () => reader, now: () => now, log: () => {} };
    const config = { sources: [src("a")], markets: [], maxRanges: 1 };
    expect((await runTick(deps, config)).ran).toBe(true);
    now += 5;
    const second = await runTick(deps, config);
    expect(second.ran).toBe(false);
    expect(second.ingest).toEqual([]);
    now += TICK_MIN_GAP_SECONDS;
    expect((await runTick(deps, config)).ran).toBe(true);
    expect(c.calls).toHaveLength(2);
  });

  it("visits sources in rotated order, shares the budget across them and reports what was left", async () => {
    const store = new MemoryStore();
    const c = client(50_000, []);
    const deps = { store, clientFor: () => c, readerFor: () => reader, now: () => 60, log: () => {} };
    const summary = await runTick(deps, { sources: [src("a"), src("b"), src("c")], markets: [], maxRanges: 5, maxRangesTotal: 7, maxLogs: 100 });
    expect(summary.order).toEqual(["b", "c", "a"]);
    expect(summary.ingest.map((r) => [r.source, r.ranges])).toEqual([
      ["b", 5],
      ["c", 2],
      ["a", 0],
    ]);
    expect(summary.ingest[2]?.budgetExhausted).toBe(true);
    expect(summary.budget).toEqual({ rangesLeft: 0, logsLeft: 100 });
    expect(c.calls).toHaveLength(7);
  });

  it("recomputes daily roots when events arrived, otherwise only every ten minutes", async () => {
    const store = new MemoryStore();
    const logs = [logAt(1_100)];
    let head = 2_500;
    const c: LogClient = {
      getBlockNumber: async () => head,
      getLogs: async (f) => logs.filter((l) => Number.parseInt(l.blockNumber as string, 16) >= f.fromBlock && Number.parseInt(l.blockNumber as string, 16) <= f.toBlock),
      // block 1,100 (the event) falls inside 2026-10-06; the cursor block 2,499 is already in 2026-10-07, which closes the 6th
      getBlockTime: async (n) => dayStart("2026-10-06") + n * 40,
    };
    let now = dayEnd("2026-10-06") + 1_000;
    const deps = { store, clientFor: () => c, readerFor: () => reader, now: () => now, log: () => {} };
    const config = { sources: [src("a")], markets: [], maxRanges: 5 };
    const first = await runTick(deps, config);
    expect(first.ingest[0]?.inserted).toBe(1);
    expect(first.rootsChecked).toEqual([CHAIN]);
    expect(first.roots.map((r) => r.day)).toEqual(["2026-10-06"]); // the event's day, closed by the cursor's block time
    // nothing new, not yet due: roots are skipped
    now += 60;
    const second = await runTick(deps, config);
    expect(second.ingest[0]?.inserted).toBe(0);
    expect(second.rootsChecked).toEqual([]);
    // ten minutes later they are checked again even with nothing new
    now += ROOTS_EVERY_SECONDS;
    head = 2_600;
    const third = await runTick(deps, config);
    expect(third.rootsChecked).toEqual([CHAIN]);
    expect((await store.getCursor(CHAIN, "roots"))?.updatedAt).toBe(now);
  });
});
