import { describe, expect, it } from "vitest";
import { morphoEventsAbi } from "../src/abis.js";
import type { RawLog } from "../src/decode.js";
import { ingestSource, type LogClient, type LogFilter } from "../src/ingest.js";
import { ZERO_ROOT, chainRoot, dayEnd, dayStart } from "../src/roots.js";
import type { Source } from "../src/sources.js";
import { MemoryStore } from "../src/store-memory.js";
import { ROOTS_EVERY_SECONDS, TICK_CURSOR, TICK_DONE_CURSOR, TICK_LEASE_SECONDS, TICK_MIN_GAP_SECONDS, rotateSources, runTick } from "../src/tick.js";
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
  it("the range allowance caps the ranges a source fetches (in parallel); the log allowance stops the next source", async () => {
    const store = new MemoryStore();
    const logs = [logAt(1_100), logAt(1_200), logAt(3_100)];
    const budget = { ranges: 2, logs: 2 };
    const c = client(20_000, logs);
    const r = await ingestSource(store, c, src("s"), { range: 2000, maxRanges: 5, deadlineMs: Date.now() + 10_000, now: () => 1, budget });
    // two of the five planned ranges fit the range allowance; both are fetched at once and all three logs are kept
    expect(r.ranges).toBe(2);
    expect(r.inserted).toBe(3);
    expect(r.budgetExhausted).toBe(true);
    expect(budget).toEqual({ ranges: 0, logs: -1 });
    expect(c.calls.map((f) => [f.fromBlock, f.toBlock])).toEqual([
      [1_000, 2_999],
      [3_000, 4_999],
    ]);
    // a spent allowance starts nothing
    const next = await ingestSource(store, client(20_000, logs), src("t"), { range: 2000, maxRanges: 5, deadlineMs: Date.now() + 10_000, now: () => 1, budget });
    expect(next.ranges).toBe(0);
    expect(next.budgetExhausted).toBe(true);
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

  it("a tick killed mid-run (no completion marker) blocks the next one only while its heartbeat is fresh", async () => {
    const store = new MemoryStore();
    const c = client(50_000, []);
    let now = 600;
    const deps = { store, clientFor: () => c, readerFor: () => reader, now: () => now, log: () => {} };
    const config = { sources: [src("a")], markets: [], maxRanges: 1 };
    // what a tick killed by exceededCpu leaves behind: a heartbeat at its start, no completion
    await store.setCursor({ chainId: 0, source: TICK_CURSOR, lastBlock: 600, lastBlockTime: 0, updatedAt: 600 });
    now = 600 + TICK_LEASE_SECONDS - 1; // still within the lease: it might be alive
    expect((await runTick(deps, config)).ran).toBe(false);
    now = 600 + TICK_LEASE_SECONDS; // the Observatory's kick 5 s later runs (before 8 Oct it was skipped for 40 s)
    const r = await runTick(deps, config);
    expect(r.ran).toBe(true);
    expect(await store.getCursor(0, TICK_DONE_CURSOR)).toMatchObject({ lastBlock: now, updatedAt: now });
    expect(await store.getCursor(0, TICK_CURSOR)).toMatchObject({ lastBlock: now });
  });

  it("two ticks that start together (the cron and the Observatory's kick): exactly one claims the lease and runs", async () => {
    const store = new MemoryStore();
    const c = client(50_000, []);
    const deps = { store, clientFor: () => c, readerFor: () => reader, now: () => 7_200, log: () => {} };
    const config = { sources: [src("a")], markets: [], maxRanges: 1 };
    const [x, y] = await Promise.all([runTick(deps, config), runTick(deps, config)]);
    expect([x.ran, y.ran].sort()).toEqual([false, true]);
    expect(c.calls).toHaveLength(1);
  });

  it("a tick makes few store round trips: one cursor read, the claim, one commit carrying the completion marker", async () => {
    const store = new MemoryStore();
    const c = client(50_000, [logAt(1_100), logAt(1_300)]);
    const now = 9_000;
    const deps = { store, clientFor: () => c, readerFor: () => reader, now: () => now, log: () => {} };
    // roots and reconciliation are not due (fresh cursors), so only the ingest path runs
    await store.setCursor({ chainId: CHAIN, source: "roots", lastBlock: 0, lastBlockTime: 0, updatedAt: now });
    const summary = await runTick(deps, { sources: [src("a"), src("b")], markets: [], maxRanges: 3 });
    expect(summary.ran).toBe(true);
    expect(summary.storeCalls).toBe(3);
    expect(summary.ingest.map((r) => r.inserted)).toEqual([2, 0]); // the same logs: the second source's copies are duplicates
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

  it("roots complete days every ten minutes (not on every tick that stored events)", async () => {
    const store = new MemoryStore();
    const logs = [logAt(1_100)];
    let head = 2_500;
    const c: LogClient = {
      getBlockNumber: async () => head,
      getLogs: async (f) => logs.filter((l) => Number.parseInt(l.blockNumber as string, 16) >= f.fromBlock && Number.parseInt(l.blockNumber as string, 16) <= f.toBlock),
      // block 1,100 (the event) falls inside 2026-10-06; the cursor block 2,497 is already in 2026-10-07, which closes the 6th
      getBlockTime: async (n) => dayStart("2026-10-06") + n * 40,
    };
    let now = dayEnd("2026-10-06") + 1_000;
    const deps = { store, clientFor: () => c, readerFor: () => reader, now: () => now, log: () => {} };
    const config = { sources: [src("a")], markets: [], maxRanges: 5 };
    const first = await runTick(deps, config);
    expect(first.ingest[0]?.inserted).toBe(1);
    expect(first.rootsChecked).toEqual([CHAIN]);
    expect(first.roots.map((r) => r.day)).toEqual(["2026-10-06"]); // the event's day, closed by the cursor's block time
    // a minute later: nothing new to scan (the source is within MIN_LAG_BLOCKS of the head); having rooted a day, the
    // root step looks once more for a next day ready, finds none and goes idle
    now += 60;
    const second = await runTick(deps, config);
    expect(second.ran).toBe(true);
    expect(second.ingest).toEqual([]);
    expect(second.rootsChecked).toEqual([CHAIN]);
    expect(second.roots).toEqual([]);
    now += 60;
    expect((await runTick(deps, config)).rootsChecked).toEqual([]);
    // ten minutes later they are checked again
    now += ROOTS_EVERY_SECONDS;
    head = 2_600;
    const third = await runTick(deps, config);
    expect(third.rootsChecked).toEqual([CHAIN]);
    expect((await store.getCursor(CHAIN, "roots"))?.updatedAt).toBe(now);
  });

  it("a configured source that has never scanned holds back day closure (no root without its events)", async () => {
    const store = new MemoryStore();
    const c: LogClient = {
      getBlockNumber: async () => 2_500,
      getLogs: async (f) => [logAt(1_100)].filter((l) => Number.parseInt(l.blockNumber as string, 16) >= f.fromBlock && Number.parseInt(l.blockNumber as string, 16) <= f.toBlock),
      getBlockTime: async (n) => dayStart("2026-10-06") + n * 40,
    };
    const now = dayEnd("2026-10-06") + 1_000;
    const deps = { store, clientFor: () => c, readerFor: () => reader, now: () => now, log: () => {} };
    // "late" exists in the config but the shared range budget stops it before its first scan
    const r = await runTick(deps, { sources: [src("a"), src("late")], markets: [], maxRanges: 5, maxRangesTotal: 1 });
    expect(r.ingest.map((x) => [x.source, x.ranges])).toEqual([
      ["a", 1],
      ["late", 0],
    ]);
    expect(r.rootsChecked).toEqual([CHAIN]);
    expect(r.roots).toEqual([]);
  });

  it("hashes a heavy day a few events per tick and roots it once all are hashed, with the same root as hashing it at once", async () => {
    const store = new MemoryStore();
    const day = "2026-10-06";
    const logs = Array.from({ length: 23 }, (_, i) => logAt(1_100 + i, i % 3));
    const c: LogClient = {
      getBlockNumber: async () => 2_500,
      getLogs: async (f) => logs.filter((l) => Number.parseInt(l.blockNumber as string, 16) >= f.fromBlock && Number.parseInt(l.blockNumber as string, 16) <= f.toBlock),
      getBlockTime: async (n) => (n < 2_000 ? dayStart(day) + n : dayEnd(day) + n),
    };
    let now = dayEnd(day) + 5_000;
    const deps = { store, clientFor: () => c, readerFor: () => reader, now: () => now, log: () => {} };
    const config = { sources: [src("a")], markets: [], maxRanges: 5, rootHashesPerTick: 10 };
    const t1 = await runTick(deps, config);
    expect(t1.ingest[0]?.inserted).toBe(23);
    expect(t1.roots).toEqual([]); // 10 of 23 hashed
    now += TICK_MIN_GAP_SECONDS;
    expect((await runTick(deps, config)).roots).toEqual([]); // 20 of 23
    now += TICK_MIN_GAP_SECONDS;
    const t3 = await runTick(deps, config);
    expect(t3.roots.map((r) => [r.day, r.eventCount])).toEqual([[day, 23]]);
    const reference = chainRoot(ZERO_ROOT, await store.eventsBetween(CHAIN, dayStart(day), dayEnd(day)));
    expect(t3.roots[0]?.root).toBe(reference);
  });

  it("a source near the head waits for MIN_LAG_BLOCKS before scanning again; one further behind scans every tick", async () => {
    const store = new MemoryStore();
    let head = 10_000;
    const c = client(head, []);
    c.getBlockNumber = async () => head;
    let now = 50_000;
    const deps = { store, clientFor: () => c, readerFor: () => reader, now: () => now, log: () => {} };
    await store.setCursor({ chainId: CHAIN, source: "roots", lastBlock: 0, lastBlockTime: 0, updatedAt: now });
    await store.setCursor({ chainId: CHAIN, source: "near", lastBlock: 9_990, lastBlockTime: 1, updatedAt: 1 });
    await store.setCursor({ chainId: CHAIN, source: "far", lastBlock: 5_000, lastBlockTime: 1, updatedAt: 1 });
    const r = await runTick(deps, { sources: [src("near"), src("far")], markets: [], maxRanges: 1 });
    expect(r.ingest.map((x) => x.source)).toEqual(["far"]);
    now += TICK_MIN_GAP_SECONDS;
    head = 10_000 + 45;
    const r2 = await runTick(deps, { sources: [src("near"), src("far")], markets: [], maxRanges: 1 });
    expect(r2.ingest.map((x) => x.source).sort()).toEqual(["far", "near"]);
  });

  it("roots at most one complete day per tick; the next tick roots the next day", async () => {
    const store = new MemoryStore();
    // events on three consecutive days, the cursor already past all of them
    const days = ["2026-10-02", "2026-10-03", "2026-10-04"];
    const logs = days.map((_, i) => logAt(1_100 + i));
    const c: LogClient = {
      getBlockNumber: async () => 2_500,
      getLogs: async (f) => logs.filter((l) => Number.parseInt(l.blockNumber as string, 16) >= f.fromBlock && Number.parseInt(l.blockNumber as string, 16) <= f.toBlock),
      getBlockTime: async (n) => (n < 1_103 ? dayStart(days[n - 1_100]!) + 3600 : dayEnd("2026-10-05") + n),
    };
    let now = dayEnd("2026-10-05") + 10_000;
    const deps = { store, clientFor: () => c, readerFor: () => reader, now: () => now, log: () => {} };
    const config = { sources: [src("a")], markets: [], maxRanges: 5 };
    expect((await runTick(deps, config)).roots.map((r) => r.day)).toEqual(["2026-10-02"]);
    now += TICK_MIN_GAP_SECONDS + ROOTS_EVERY_SECONDS;
    expect((await runTick(deps, config)).roots.map((r) => r.day)).toEqual(["2026-10-03"]);
    now += TICK_MIN_GAP_SECONDS + ROOTS_EVERY_SECONDS;
    expect((await runTick(deps, config)).roots.map((r) => r.day)).toEqual(["2026-10-04"]);
  });
});
