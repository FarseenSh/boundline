import { describe, expect, it } from "vitest";
import { morphoEventsAbi } from "../src/abis.js";
import type { RawLog } from "../src/decode.js";
import { CONFIRMATIONS, ingestSource, rawLogClient, type LogClient, type LogFilter } from "../src/ingest.js";
import { rawRpc } from "../src/rpc.js";
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
    // the scan stops CONFIRMATIONS (3) blocks behind the head: load-balanced RPC nodes disagree on it by a block or two
    expect(again.cursorAfter).toBe(10_000 - CONFIRMATIONS);
    expect(again.inserted).toBe(0);
    // a re-scan of an old range inserts nothing new
    await store.setCursor({ chainId: CHAIN, source: source.id, lastBlock: 999, lastBlockTime: 0, updatedAt: 0 });
    const rescan = await ingestSource(store, client, source, opts);
    expect(rescan.logs).toBe(2);
    expect(rescan.inserted).toBe(0);
  });

  it("takes block times from the logs' blockTimestamp and reads one header, for the cursor, per source and tick", async () => {
    const store = new MemoryStore();
    const stamped = logs.map((l, i) => ({ ...l, blockTimestamp: `0x${(1_800_000_000 + i).toString(16)}` as `0x${string}` }));
    const timeCalls: number[] = [];
    const client = { ...fakeClient(10_000, stamped), getBlockTime: async (n: number) => (timeCalls.push(n), 1_700_000_000 + n * 2) };
    const r = await ingestSource(store, client, source, opts);
    expect(r.inserted).toBe(2);
    const rows = await store.queryEvents({ chainId: CHAIN, limit: 10 });
    expect(rows.map((e) => e.blockTime).sort()).toEqual([1_800_000_000, 1_800_000_001]);
    // three ranges scanned, one header read: the end of the last range, for the cursor's block time
    expect(timeCalls).toEqual([6_999]);
    expect(await store.getCursor(CHAIN, source.id)).toMatchObject({ lastBlock: 6_999, lastBlockTime: 1_700_000_000 + 6_999 * 2 });
  });

  it("keeps the ranges before a failed one and moves the cursor over them; the failed range is scanned next tick", async () => {
    const store = new MemoryStore();
    let n = 0;
    const client: LogClient = {
      ...fakeClient(10_000, logs),
      getLogs: async (f) => {
        n += 1;
        if (n === 3) throw new Error("rate limited");
        return logs.filter((l) => {
          const b = Number.parseInt(l.blockNumber as string, 16);
          return b >= f.fromBlock && b <= f.toBlock;
        });
      },
    };
    const r = await ingestSource(store, client, source, opts);
    expect(r.error).toBe("rate limited");
    expect(r.inserted).toBe(2);
    expect(r.ranges).toBe(2);
    expect(r.cursorAfter).toBe(4_999);
    expect(await store.getCursor(CHAIN, source.id)).toMatchObject({ lastBlock: 4_999, lastBlockTime: 1_700_000_000 + 4_999 * 2 });
  });

  it("rawLogClient memoises the head and header times for the tick and parses timestamps without the transaction list", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      calls.push(body.method);
      if (body.method === "eth_blockNumber") return new Response('{"jsonrpc":"2.0","id":1,"result":"0x2710"}');
      if (body.method === "eth_getBlockByNumber")
        return new Response(`{"jsonrpc":"2.0","id":1,"result":{"number":"${(body.params[0] as string)}","timestamp":"0x6abfce8d","transactions":["0x${"ab".repeat(32)}"]}}`);
      return new Response('{"jsonrpc":"2.0","id":1,"result":[]}');
    }) as typeof fetch;
    const c = rawLogClient(rawRpc(["https://rpc.example"], { fetchImpl }));
    expect(await c.getBlockNumber()).toBe(10_000);
    expect(await c.getBlockNumber()).toBe(10_000);
    expect(await c.getBlockTime(9_997)).toBe(0x6abfce8d);
    expect(await c.getBlockTime(9_997)).toBe(0x6abfce8d);
    expect(await c.getLogs({ addresses: [MORPHO], topics: [], fromBlock: 1, toBlock: 2 })).toEqual([]);
    expect(calls).toEqual(["eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs"]);
  });

  it("rawRpc batches calls in one request, keeps per-item errors, and moves to the next URL on a non-batch answer", async () => {
    const hosts: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      hosts.push(new URL(String(url)).host);
      const body = JSON.parse(String(init?.body)) as { id: number; method: string }[];
      if (String(url).includes("first")) return new Response('{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"batch not supported"}}');
      return new Response(JSON.stringify(body.map((b) => (b.id === 2 ? { jsonrpc: "2.0", id: 2, error: { code: -32005, message: "range too large" } } : { jsonrpc: "2.0", id: b.id, result: [] }))));
    }) as typeof fetch;
    const rpc = rawRpc(["https://first.example", "https://second.example"], { fetchImpl });
    const out = await rpc.batch<unknown[]>([
      { method: "eth_getLogs", params: [] },
      { method: "eth_getLogs", params: [] },
      { method: "eth_getLogs", params: [] },
    ]);
    expect(hosts).toEqual(["first.example", "second.example"]);
    expect(out[0]).toEqual([]);
    expect(out[1]).toBeInstanceOf(Error);
    expect((out[1] as Error).message).toContain("range too large");
    expect(out[2]).toEqual([]);
  });

  it("rawLogClient retries a batch item the first URL refused through the fallback list", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const host = new URL(String(url)).host;
      const body = JSON.parse(String(init?.body)) as { id: number; method: string } | { id: number; method: string }[];
      seen.push(`${host}:${Array.isArray(body) ? `batch${body.length}` : body.method}`);
      if (Array.isArray(body)) return new Response(JSON.stringify(body.map((b) => (b.id === 1 ? { jsonrpc: "2.0", id: 1, error: { code: -32016, message: "over rate limit" } } : { jsonrpc: "2.0", id: b.id, result: [] }))));
      if (host === "first.example") return new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32016,"message":"over rate limit"}}');
      return new Response('{"jsonrpc":"2.0","id":1,"result":[]}');
    }) as typeof fetch;
    const c = rawLogClient(rawRpc(["https://first.example", "https://second.example"], { fetchImpl }));
    const out = await c.getLogsMany!([
      { addresses: [MORPHO], topics: [], fromBlock: 1, toBlock: 2 },
      { addresses: [MORPHO], topics: [], fromBlock: 3, toBlock: 4 },
    ]);
    expect(out).toEqual([[], []]);
    expect(seen).toEqual(["first.example:batch2", "first.example:eth_getLogs", "second.example:eth_getLogs"]);
  });

  it("a source's ranges go out as one batch; an item error keeps the prefix; a failed batch falls back to single calls", async () => {
    const store = new MemoryStore();
    const batches: number[] = [];
    let singles = 0;
    const base = fakeClient(10_000, logs);
    const batching: LogClient = {
      ...base,
      getLogs: async (f) => ((singles += 1), base.getLogs(f)),
      getLogsMany: async (filters) => {
        batches.push(filters.length);
        return Promise.all(filters.map((f, i) => (i === 2 ? Promise.resolve(new Error("range too large")) : base.getLogs(f))));
      },
    };
    const r = await ingestSource(store, batching, source, opts);
    expect(batches).toEqual([3]);
    expect(singles).toBe(0);
    expect(r.ranges).toBe(2);
    expect(r.error).toBe("range too large");
    expect(r.cursorAfter).toBe(4_999);
    const failing: LogClient = { ...base, getLogs: async (f) => ((singles += 1), base.getLogs(f)), getLogsMany: async () => { throw new Error("batch refused"); } };
    const r2 = await ingestSource(new MemoryStore(), failing, source, opts);
    expect(singles).toBe(3);
    expect(r2.ranges).toBe(3);
    expect(r2.error).toBeUndefined();
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
