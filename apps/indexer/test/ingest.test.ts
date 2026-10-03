import { describe, expect, it } from "vitest";
import { morphoEventsAbi } from "../src/abis.js";
import type { RawLog } from "../src/decode.js";
import { ingestSource, type LogClient, type LogFilter } from "../src/ingest.js";
import type { Source } from "../src/sources.js";
import { MemoryStore } from "../src/store-memory.js";
import { BORROWER, CHAIN, MARKET, MORPHO, makeLog } from "./fixtures.js";

const source: Source = { id: "morpho-market-test", chainId: 84532, addresses: [MORPHO], topics: [], abi: morphoEventsAbi, startBlock: 1_000 };

function fakeClient(head: number, logs: RawLog[], calls: LogFilter[] = []): LogClient & { calls: LogFilter[] } {
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
    getBlockTime: async (n) => 1_700_000_000 + n * 2,
  };
}

const opts = { range: 2000, maxRanges: 3, deadlineMs: Date.now() + 60_000, now: () => 123 };

describe("ingestSource", () => {
  const logs = [
    makeLog({ abi: morphoEventsAbi, eventName: "SupplyCollateral", args: { id: MARKET, caller: BORROWER, onBehalf: BORROWER, assets: 10n }, address: MORPHO, blockNumber: 1_500, logIndex: 0 }),
    makeLog({ abi: morphoEventsAbi, eventName: "Borrow", args: { id: MARKET, caller: BORROWER, onBehalf: BORROWER, receiver: BORROWER, assets: 5n, shares: 5n }, address: MORPHO, blockNumber: 3_500, logIndex: 2 }),
  ];

  it("starts at startBlock, scans ranges, stores decoded rows and advances the cursor with its block time", async () => {
    const store = new MemoryStore();
    const client = fakeClient(10_000, logs);
    const r = await ingestSource(store, client, source, opts);
    expect(r.error).toBeUndefined();
    expect(r.cursorBefore).toBe(999);
    expect(client.calls.map((c) => [c.fromBlock, c.toBlock])).toEqual([
      [1_000, 2_999],
      [3_000, 4_999],
      [5_000, 6_999],
    ]);
    expect(r.cursorAfter).toBe(6_999);
    expect(r.inserted).toBe(2);
    expect(r.names).toEqual({ SupplyCollateral: 1, Borrow: 1 });
    const cursor = await store.getCursor(CHAIN, source.id);
    expect(cursor).toMatchObject({ lastBlock: 6_999, lastBlockTime: 1_700_000_000 + 6_999 * 2, updatedAt: 123 });
    const stored = await store.queryEvents({ chainId: CHAIN, limit: 10 });
    expect(stored.map((e) => e.name)).toEqual(["Borrow", "SupplyCollateral"]);
    expect(stored[0]?.blockTime).toBe(1_700_000_000 + 3_500 * 2);
  });

  it("continues from the stored cursor and ignores duplicates", async () => {
    const store = new MemoryStore();
    const client = fakeClient(10_000, logs);
    await ingestSource(store, client, source, opts);
    const again = await ingestSource(store, client, source, opts);
    expect(again.cursorBefore).toBe(6_999);
    expect(again.cursorAfter).toBe(9_999);
    expect(again.inserted).toBe(0);
    // a re-scan of an old range inserts nothing new
    await store.setCursor({ chainId: CHAIN, source: source.id, lastBlock: 999, lastBlockTime: 0, updatedAt: 0 });
    const rescan = await ingestSource(store, client, source, opts);
    expect(rescan.logs).toBe(2);
    expect(rescan.inserted).toBe(0);
  });

  it("does nothing when the head is not far enough ahead", async () => {
    const store = new MemoryStore();
    await store.setCursor({ chainId: CHAIN, source: source.id, lastBlock: 5_000, lastBlockTime: 1, updatedAt: 1 });
    const client = fakeClient(5_001, logs);
    const r = await ingestSource(store, client, source, opts);
    expect(r.ranges).toBe(0);
    expect(client.calls).toHaveLength(0);
    expect((await store.getCursor(CHAIN, source.id))?.lastBlock).toBe(5_000);
  });

  it("stops at the deadline and reports RPC errors without throwing", async () => {
    const store = new MemoryStore();
    const r = await ingestSource(store, fakeClient(10_000, logs), source, { ...opts, deadlineMs: Date.now() - 1 });
    expect(r.ranges).toBe(0);
    const failing: LogClient = { getBlockNumber: async () => 10_000, getLogs: async () => { throw new Error("rate limited"); }, getBlockTime: async () => 0 };
    const e = await ingestSource(store, failing, source, opts);
    expect(e.error).toBe("rate limited");
    expect(e.cursorAfter).toBe(999);
    expect(await store.getCursor(CHAIN, source.id)).toBeNull();
  });
});
