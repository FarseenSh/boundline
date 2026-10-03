import { toHex, type Address, type Hex } from "viem";
import type { BaseClient } from "@boundline/chain";
import { planRanges } from "./cursor.js";
import { decodeLog, quantity, type RawLog } from "./decode.js";
import type { Source } from "./sources.js";
import type { Store } from "./store.js";

export interface LogFilter {
  addresses: Address[];
  topics: (Hex | Hex[] | null)[];
  fromBlock: number;
  toBlock: number;
}

/** The three RPC reads ingestion needs; `viemLogClient` is the real one, tests pass a fake. */
export interface LogClient {
  getBlockNumber(): Promise<number>;
  getLogs(filter: LogFilter): Promise<RawLog[]>;
  getBlockTime(blockNumber: number): Promise<number>;
}

export function viemLogClient(client: BaseClient): LogClient {
  return {
    getBlockNumber: async () => Number(await client.getBlockNumber()),
    getLogs: async (f) =>
      (await client.request({
        method: "eth_getLogs",
        params: [
          {
            address: f.addresses,
            fromBlock: toHex(f.fromBlock),
            toBlock: toHex(f.toBlock),
            ...(f.topics.length > 0 ? { topics: f.topics } : {}),
          },
        ],
      })) as unknown as RawLog[],
    getBlockTime: async (n) => Number((await client.getBlock({ blockNumber: BigInt(n) })).timestamp),
  };
}

export interface IngestOptions {
  /** Blocks per `eth_getLogs` call. */
  range: number;
  maxRanges: number;
  confirmations?: number;
  /** Absolute `Date.now()` after which no new range starts. */
  deadlineMs: number;
  now: () => number;
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
  error?: string;
}

/** Scans one source forward from its cursor, decoding and inserting logs range by range; the cursor only moves after a range is stored. */
export async function ingestSource(store: Store, client: LogClient, source: Source, opts: IngestOptions): Promise<IngestResult> {
  const cursor = await store.getCursor(source.chainId, source.id);
  const cursorBefore = cursor?.lastBlock ?? source.startBlock - 1;
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
  try {
    result.head = await client.getBlockNumber();
    const ranges = planRanges(cursorBefore, result.head, {
      range: opts.range,
      maxRanges: opts.maxRanges,
      ...(opts.confirmations !== undefined ? { confirmations: opts.confirmations } : {}),
    });
    const times = new Map<number, number>();
    const timeOf = async (n: number): Promise<number> => {
      const hit = times.get(n);
      if (hit !== undefined) return hit;
      const t = await client.getBlockTime(n);
      times.set(n, t);
      return t;
    };
    for (const r of ranges) {
      if (Date.now() > opts.deadlineMs) break;
      const logs = await client.getLogs({ addresses: source.addresses, topics: source.topics, fromBlock: r.from, toBlock: r.to });
      const rows = [];
      for (const log of logs) {
        rows.push(decodeLog(source.abi, log, source.chainId, await timeOf(quantity(log.blockNumber))));
      }
      for (const row of rows) result.names[row.name] = (result.names[row.name] ?? 0) + 1;
      result.inserted += await store.insertEvents(rows);
      result.logs += logs.length;
      await store.setCursor({
        chainId: source.chainId,
        source: source.id,
        lastBlock: r.to,
        lastBlockTime: await timeOf(r.to),
        updatedAt: opts.now(),
      });
      result.cursorAfter = r.to;
      result.ranges += 1;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}
