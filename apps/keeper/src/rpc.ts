// Minimal JSON-RPC over fetch with an ordered fallback list, for the cron's hot path.
//
// Why not viem's transport: on a cold isolate every function on the path is compiled the first time it runs, and
// viem's request stack (fallback transport, http transport, retry, uid, stringify with a bigint replacer) is a lot of
// code. Measured 8 Oct 2026 (scripts/bench-cpu.ts, Node): a cold tick through viem's transport cost 26–36 ms of CPU
// against 0.7–4 ms warm, and the Workers Free plan allows 10 ms. This file is the whole request path: one fetch per
// call or batch, the URLs tried in order, the first well-formed answer wins.
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

/** A JSON-RPC error inside an otherwise good answer (a revert, an invalid param): not retried on the next URL. */
export class RpcCallError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;
  constructor(method: string, error: { code?: number; message?: string; data?: unknown }) {
    super(`${method}: ${error.code ?? "?"} ${error.message ?? ""}`.trim());
    this.name = "RpcCallError";
    this.code = error.code;
    this.data = error.data;
  }
}

export interface RpcCall {
  method: string;
  params: readonly unknown[];
}

/** One entry of a batch: the result, or the node's error for that entry (with its `data`: a revert's payload). */
export type RpcOutcome = { ok: true; result: unknown } | { ok: false; error: string; data?: unknown };

export interface RpcClient {
  /** One call; the URLs in order until one answers. A JSON-RPC error from a node that answered throws RpcCallError. */
  call<T = unknown>(method: string, params: readonly unknown[]): Promise<T>;
  /** Several calls in one HTTP request (a JSON-RPC batch), outcomes in call order. */
  batch(calls: readonly RpcCall[]): Promise<RpcOutcome[]>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const RPC_TIMEOUT_MS = 12_000;

function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
  return m?.[1] ?? "invalid-url";
}

interface RawAnswer {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** A client over `urls` (tried in order). `fetchImpl` is injectable for tests and the module-scope warm-up (timeoutMs 0: no timer). */
export function rpcClient(urls: readonly string[], fetchImpl?: FetchLike, timeoutMs: number = RPC_TIMEOUT_MS): RpcClient {
  const list = urls.filter((u) => u.length > 0);
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    async call<T>(method: string, params: readonly unknown[]): Promise<T> {
      // A node that answers with a JSON-RPC error for a reason of its own (rate limit, -32000 "header not found") is
      // skipped like a dead one; an execution error (a revert, code 3) is the chain's answer and is returned at once.
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
      if (list.length === 0) throw new RpcError(method, [{ host: "-", error: "no RPC URL configured" }]);
      const attempts: RpcAttempt[] = [];
      for (const url of list) {
        let json: RawAnswer;
        try {
          const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}) });
          if (!res.ok) {
            attempts.push({ host: hostOf(url), error: `http ${res.status}` });
            continue;
          }
          json = (await res.json()) as RawAnswer;
        } catch (err) {
          attempts.push({ host: hostOf(url), error: err instanceof Error ? err.message : String(err) });
          continue;
        }
        if (json.error) {
          if (json.error.code === 3 || /revert/i.test(json.error.message ?? "")) throw new RpcCallError(method, json.error);
          attempts.push({ host: hostOf(url), error: `rpc ${json.error.code ?? "?"} ${json.error.message ?? ""}`.trim() });
          continue;
        }
        if (json.result === undefined) {
          attempts.push({ host: hostOf(url), error: "no result" });
          continue;
        }
        return json.result as T;
      }
      throw new RpcError(method, attempts);
    },

    async batch(calls: readonly RpcCall[]): Promise<RpcOutcome[]> {
      if (calls.length === 0) return [];
      const label = calls.map((c) => c.method).join("+");
      if (list.length === 0) throw new RpcError(label, [{ host: "-", error: "no RPC URL configured" }]);
      const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params })));
      const attempts: RpcAttempt[] = [];
      for (const url of list) {
        let json: unknown;
        try {
          const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}) });
          if (!res.ok) {
            attempts.push({ host: hostOf(url), error: `http ${res.status}` });
            continue;
          }
          json = await res.json();
        } catch (err) {
          attempts.push({ host: hostOf(url), error: err instanceof Error ? err.message : String(err) });
          continue;
        }
        if (!Array.isArray(json)) {
          // Some gateways answer a batch with one error object (rate limit, batches disabled): next URL.
          const e = (json as RawAnswer | null)?.error;
          attempts.push({ host: hostOf(url), error: e ? `rpc ${e.code ?? "?"} ${e.message ?? ""}`.trim() : "batch answer is not an array" });
          continue;
        }
        const byId = new Map<number, RawAnswer>();
        for (const a of json as RawAnswer[]) if (a && typeof a.id === "number") byId.set(a.id, a);
        const out = calls.map((_, i): RpcOutcome => {
          const a = byId.get(i + 1);
          if (!a) return { ok: false, error: "missing from the batch answer" };
          if (a.error) return { ok: false, error: `rpc ${a.error.code ?? "?"} ${a.error.message ?? ""}`.trim(), ...(a.error.data !== undefined ? { data: a.error.data } : {}) };
          return a.result === undefined ? { ok: false, error: "no result" } : { ok: true, result: a.result };
        });
        // A node that rate-limits part of a batch (sepolia.base.org answers -32007 "25/second request limit reached"
        // per entry, seen 9 Oct 2026) is skipped like a dead one while another URL is left; the last URL's answer stands.
        const limited = out.find((o) => !o.ok && RATE_LIMITED.test(o.error));
        if (limited && url !== list[list.length - 1]) {
          attempts.push({ host: hostOf(url), error: limited.ok ? "" : limited.error });
          continue;
        }
        return out;
      }
      throw new RpcError(label, attempts);
    },
  };
}

/** Per-entry errors that mean "this node, not this call": a rate limit. */
const RATE_LIMITED = /rpc (-32007|-32005|429)\b|request limit|rate limit|too many requests/i;

const clients = new Map<string, RpcClient>();
/** Memoised per isolate by the comma list (secrets first: see env.ts). */
export function rpcFor(commaList: string): RpcClient {
  let c = clients.get(commaList);
  if (!c) {
    c = rpcClient(
      commaList
        .split(",")
        .map((u) => u.trim())
        .filter((u) => u.length > 0),
    );
    clients.set(commaList, c);
  }
  return c;
}
