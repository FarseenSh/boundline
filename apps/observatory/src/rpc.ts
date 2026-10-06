// Minimal JSON-RPC over fetch with an ordered fallback list. viem's transport does the same job through a much
// larger code path; on a cold isolate every function compiled on the hot path costs CPU the Workers Free plan does
// not have (10 ms per invocation), so the per-minute reads go through this. viem stays for request-driven reads.
import type { Address, Hex } from "viem";

export interface RpcAttempt {
  host: string;
  error: string;
}

export class RpcError extends Error {
  readonly attempts: RpcAttempt[];
  constructor(method: string, attempts: RpcAttempt[]) {
    super(`${method} failed on ${attempts.length} RPC(s): ${attempts.map((a) => `${a.host}: ${a.error}`).join("; ")}`);
    this.name = "RpcError";
    this.attempts = attempts;
  }
}

export interface RpcOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_RPC_TIMEOUT_MS = 20_000;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

/** One JSON-RPC call, trying each URL in order until one answers with a result. */
export async function jsonRpc<T>(urls: readonly string[], method: string, params: readonly unknown[], opts: RpcOptions = {}): Promise<T> {
  if (urls.length === 0) throw new RpcError(method, [{ host: "-", error: "no RPC URL configured" }]);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const attempts: RpcAttempt[] = [];
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS),
      });
      if (!res.ok) {
        const snippet = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
        attempts.push({ host: hostOf(url), error: snippet ? `http ${res.status}: ${snippet}` : `http ${res.status}` });
        continue;
      }
      const json = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
      if (json.error) {
        attempts.push({ host: hostOf(url), error: `rpc ${json.error.code ?? "?"} ${json.error.message ?? ""}`.trim() });
        continue;
      }
      if (json.result === undefined || json.result === null) {
        attempts.push({ host: hostOf(url), error: "empty result" });
        continue;
      }
      if (attempts.length > 0) console.warn(`${method}: ${hostOf(url)} answered after ${attempts.map((a) => `${a.host} (${a.error})`).join(", ")}`);
      return json.result;
    } catch (err) {
      attempts.push({ host: hostOf(url), error: err instanceof Error ? err.message : String(err) });
    }
  }
  throw new RpcError(method, attempts);
}

/** `eth_call(to, data)` at the latest block. */
export type EthCall = (to: Address, data: Hex) => Promise<Hex>;

/** An EthCall over the fallback list. */
export function ethCaller(urls: readonly string[], opts: RpcOptions = {}): EthCall {
  return (to, data) => jsonRpc<Hex>(urls, "eth_call", [{ to, data }, "latest"], opts);
}

/** One `eth_getLogs` filter; block numbers as plain integers. */
export interface LogFilter {
  address: Address;
  topics: (Hex | Hex[] | null)[];
  fromBlock: number;
  toBlock: number;
}

/** A log as the node returns it; only what the scans read. */
export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
}

export type GetLogs = (filter: LogFilter) => Promise<RawLog[]>;

const toHexQuantity = (n: number): Hex => `0x${n.toString(16)}`;

/** A GetLogs over the fallback list. */
export function logsGetter(urls: readonly string[], opts: RpcOptions = {}): GetLogs {
  return (f) =>
    jsonRpc<RawLog[]>(urls, "eth_getLogs", [{ address: f.address, topics: f.topics, fromBlock: toHexQuantity(f.fromBlock), toBlock: toHexQuantity(f.toBlock) }], opts);
}
