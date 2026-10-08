import type { Address, Hex } from "viem";
import { planRanges } from "./cursor.js";
import { decodeLog, quantity, type EventRow, type RawLog } from "./decode.js";
import { headerFields, rawRpc, splitUrls, type RawRpc } from "./rpc.js";
import type { Source } from "./sources.js";
import type { CursorRow, Store } from "./store.js";

export interface LogFilter {
  addresses: Address[];
  topics: (Hex | Hex[] | null)[];
  fromBlock: number;
  toBlock: number;
}

/** The three RPC reads ingestion needs; `rawLogClient` is the real one, tests pass a fake. */
export interface LogClient {
  getBlockNumber(): Promise<number>;
  getLogs(filter: LogFilter): Promise<RawLog[]>;
  getBlockTime(blockNumber: number): Promise<number>;
  /** Several ranges in one request (a JSON-RPC batch); each item is the logs or the Error that range answered. */
  getLogsMany?(filters: readonly LogFilter[]): Promise<(RawLog[] | Error)[]>;
}

function logsParams(f: LogFilter): unknown[] {
  return [
    {
      address: f.addresses,
      fromBlock: hex(f.fromBlock),
      toBlock: hex(f.toBlock),
      ...(f.topics.length > 0 ? { topics: f.topics } : {}),
    },
  ];
}

const hex = (n: number): Hex => `0x${n.toString(16)}`;

/**
 * The JSON-RPC log client for one chain and ONE tick: the head and block times are memoised for the client's life, so
 * eight sources on a chain cost one `eth_blockNumber`, and sources that end at the same block one header read.
 */
export function rawLogClient(rpc: RawRpc | string): LogClient {
  const client = typeof rpc === "string" ? rawRpc(splitUrls(rpc)) : rpc;
  let head: Promise<number> | null = null;
  const times = new Map<number, Promise<number>>();
  return {
    getBlockNumber: () => (head ??= client.call<Hex>("eth_blockNumber", []).then((h) => Number.parseInt(h, 16))),
    getLogs: (f) => client.call<RawLog[]>("eth_getLogs", logsParams(f)),
    // One batch for the happy path; an item the first URL refused (a rate limit counts every item, 8 Oct 2026:
    // `-32016 over rate limit`) is retried alone through the whole fallback list, as a single call would be.
    getLogsMany: async (filters) => {
      const out = await client.batch<RawLog[]>(filters.map((f) => ({ method: "eth_getLogs", params: logsParams(f) })));
      return Promise.all(
        out.map(async (item, i) => {
          if (!(item instanceof Error)) return item;
          try {
            return await client.call<RawLog[]>("eth_getLogs", logsParams(filters[i]!));
          } catch (err) {
            return err instanceof Error ? err : new Error(String(err));
          }
        }),
      );
    },
    getBlockTime: (n) => {
      let t = times.get(n);
      if (!t) {
        t = client.text("eth_getBlockByNumber", [hex(n), false]).then((text) => headerFields(text).timestamp);
        // a failed read must not poison the memo
        t.catch(() => times.delete(n));
        times.set(n, t);
      }
      return t;
    },
  };
}

/**
 * A per-tick allowance shared by every source: ranges left to scan and logs left to decode. A range that starts is
 * always finished, so `logs` can go negative by one range's worth; no further range starts once either reaches zero.
 * Keeps a tick inside the Workers Free plan's 10 ms of CPU.
 */
export interface TickBudget {
  ranges: number;
  logs: number;
}

/** Blocks behind the head a scan stops at: load-balanced RPC nodes disagree on the head by a block or two. */
export const CONFIRMATIONS = 3;

export interface IngestOptions {
  /** Blocks per `eth_getLogs` call. */
  range: number;
  maxRanges: number;
  confirmations?: number;
  /** Absolute `Date.now()` after which no new range starts. */
  deadlineMs: number;
  now: () => number;
  /** Shared across the sources of one tick; omitted means unlimited. */
  budget?: TickBudget;
}

export interface IngestResult {
  source: string;
  chainId: number;
  head: number;
  cursorBefore: number;
  cursorAfter: number;
  ranges: number;
  logs: number;
  inserted: number;
  names: Record<string, number>;
  /** True when the tick's shared budget stopped this source before its ranges were done. */
  budgetExhausted?: boolean;
  error?: string;
}

export interface ScanResult {
  result: IngestResult;
  /** Decoded rows of the ranges the cursor may move over (a contiguous prefix of the plan). */
  rows: EventRow[];
  /** The cursor row to write, or null when nothing was scanned (or the end time could not be read). */
  cursor: CursorRow | null;
}

/**
 * Scans one source forward from `cursorBefore` without touching storage: the planned ranges are fetched in parallel,
 * decoded, and the cursor may move to the end of the last range of the contiguous successful prefix. Block times come
 * from the logs' `blockTimestamp`; one header read (memoised per chain and tick) gives the cursor's block time. The tick
 * writes every source's rows and cursors in one D1 batch (see tick.ts): on Workers each D1 call costs CPU.
 */
export async function scanSource(client: LogClient, source: Source, cursorBefore: number, opts: IngestOptions): Promise<ScanResult> {
  const result: IngestResult = {
    source: source.id,
    chainId: source.chainId,
    head: 0,
    cursorBefore,
    cursorAfter: cursorBefore,
    ranges: 0,
    logs: 0,
    inserted: 0,
    names: {},
  };
  const rows: EventRow[] = [];
  let cursor: CursorRow | null = null;
  try {
    result.head = await client.getBlockNumber();
    let ranges = planRanges(cursorBefore, result.head, {
      range: opts.range,
      maxRanges: opts.maxRanges,
      confirmations: opts.confirmations ?? CONFIRMATIONS,
    });
    if (ranges.length === 0) return { result, rows, cursor };
    if (Date.now() > opts.deadlineMs) return { result, rows, cursor };
    if (opts.budget) {
      if (opts.budget.ranges <= 0 || opts.budget.logs <= 0) {
        result.budgetExhausted = true;
        return { result, rows, cursor };
      }
      if (ranges.length > opts.budget.ranges) {
        ranges = ranges.slice(0, opts.budget.ranges);
        result.budgetExhausted = true;
      }
    }
    const filters = ranges.map((r) => ({ addresses: source.addresses, topics: source.topics, fromBlock: r.from, toBlock: r.to }));
    // one request for the source's ranges when the client batches (each fetch costs CPU on Workers); else in parallel
    let fetched: PromiseSettledResult<RawLog[]>[] | null = null;
    if (client.getLogsMany && filters.length > 1) {
      try {
        fetched = (await client.getLogsMany(filters)).map((x) => (x instanceof Error ? { status: "rejected", reason: x } : { status: "fulfilled", value: x }));
      } catch {
        fetched = null; // the batch itself failed on every URL: fall back to one call per range
      }
    }
    fetched ??= await Promise.allSettled(filters.map((f) => client.getLogs(f)));
    let endTime: number | null = null;
    for (let i = 0; i < ranges.length; i += 1) {
      const f = fetched[i]!;
      if (f.status === "rejected") {
        result.error = f.reason instanceof Error ? f.reason.message : String(f.reason);
        break;
      }
      const r = ranges[i]!;
      endTime = null;
      for (const log of f.value) {
        const block = quantity(log.blockNumber);
        const time = log.blockTimestamp !== undefined && log.blockTimestamp !== null ? quantity(log.blockTimestamp) : await client.getBlockTime(block);
        if (block === r.to) endTime = time;
        const row = decodeLog(source.abi, log, source.chainId, time);
        result.names[row.name] = (result.names[row.name] ?? 0) + 1;
        rows.push(row);
      }
      result.logs += f.value.length;
      result.ranges += 1;
      result.cursorAfter = r.to;
    }
    if (opts.budget) {
      opts.budget.ranges -= ranges.length;
      opts.budget.logs -= result.logs;
    }
    if (result.cursorAfter > cursorBefore) {
      try {
        const time = endTime ?? (await client.getBlockTime(result.cursorAfter));
        cursor = { chainId: source.chainId, source: source.id, lastBlock: result.cursorAfter, lastBlockTime: time, updatedAt: opts.now() };
      } catch (err) {
        // the rows are stored (idempotent); the cursor waits for the next tick's header read
        result.error ??= err instanceof Error ? err.message : String(err);
        result.cursorAfter = cursorBefore;
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return { result, rows, cursor };
}

/** Scan one source and store it (one commit): the single-source form of a tick, for scripts and tests. */
export async function ingestSource(store: Store, client: LogClient, source: Source, opts: IngestOptions): Promise<IngestResult> {
  const before = (await store.getCursor(source.chainId, source.id))?.lastBlock ?? source.startBlock - 1;
  const { result, rows, cursor } = await scanSource(client, source, before, opts);
  if (rows.length > 0 || cursor) {
    const added = await store.commit([{ key: source.id, events: rows }], cursor ? [cursor] : []);
    result.inserted = added[source.id] ?? 0;
  }
  return result;
}
