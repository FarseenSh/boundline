// Minimal JSON-RPC over fetch with an ordered fallback list (the same approach as apps/observatory/src/rpc.ts). viem's
// transport runs a much larger code path per request (retry wrappers, formatters, a fallback ranker); on a cold Workers
// isolate every function compiled during the tick is paid out of the Free plan's 10 ms of CPU, so the cron path goes
// through this instead.

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

export const DEFAULT_RPC_TIMEOUT_MS = 15_000;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

export function splitUrls(list: string): string[] {
  return list
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

export interface RawRpc {
  /** The parsed `result` of a call; a JSON-RPC error or a non-2xx answer moves on to the next URL. */
  call<T>(method: string, params: readonly unknown[]): Promise<T>;
  /** Several calls in one JSON-RPC batch (one HTTP request): each item is its result or the Error it answered. A transport
   *  failure or a non-array answer moves on to the next URL. Every Base RPC we use accepts batches (8 Oct 2026). */
  batch<T>(calls: readonly { method: string; params: readonly unknown[] }[]): Promise<(T | Error)[]>;
  /** The raw response text of a call that answered without a JSON-RPC error (checked by substring, not parsed). */
  text(method: string, params: readonly unknown[]): Promise<string>;
}

/** A JSON-RPC client over `urls` in order. `fetchImpl` is injectable for tests. */
export function rawRpc(urls: readonly string[], opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): RawRpc {
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

  async function send(method: string, params: readonly unknown[], parse: boolean): Promise<{ text: string; json?: { result?: unknown; error?: { code?: number; message?: string } } }> {
    if (urls.length === 0) throw new RpcError(method, [{ host: "-", error: "no RPC URL configured" }]);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const attempts: RpcAttempt[] = [];
    for (const url of urls) {
      try {
        const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
        const text = await res.text();
        if (!res.ok) {
          attempts.push({ host: hostOf(url), error: `http ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 160)}` });
          continue;
        }
        if (!parse) {
          // A raw answer is accepted only if it carries a result and no error object.
          const errAt = text.indexOf('"error"');
          if (errAt >= 0 && text.indexOf('"result"') < 0) {
            attempts.push({ host: hostOf(url), error: text.replace(/\s+/g, " ").slice(0, 160) });
            continue;
          }
          return { text };
        }
        const json = JSON.parse(text) as { result?: unknown; error?: { code?: number; message?: string } };
        if (json.error) {
          attempts.push({ host: hostOf(url), error: `rpc ${json.error.code ?? "?"} ${json.error.message ?? ""}`.trim() });
          continue;
        }
        if (json.result === undefined || json.result === null) {
          attempts.push({ host: hostOf(url), error: "empty result" });
          continue;
        }
        return { text, json };
      } catch (err) {
        attempts.push({ host: hostOf(url), error: err instanceof Error ? err.message : String(err) });
      }
    }
    throw new RpcError(method, attempts);
  }

  async function sendBatch<T>(calls: readonly { method: string; params: readonly unknown[] }[]): Promise<(T | Error)[]> {
    const label = `batch of ${calls.length} (${calls[0]?.method ?? "-"})`;
    if (urls.length === 0) throw new RpcError(label, [{ host: "-", error: "no RPC URL configured" }]);
    const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params })));
    const attempts: RpcAttempt[] = [];
    for (const url of urls) {
      try {
        const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
        const text = await res.text();
        if (!res.ok) {
          attempts.push({ host: hostOf(url), error: `http ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 160)}` });
          continue;
        }
        const json = JSON.parse(text) as unknown;
        if (!Array.isArray(json)) {
          attempts.push({ host: hostOf(url), error: `not a batch answer: ${text.replace(/\s+/g, " ").slice(0, 120)}` });
          continue;
        }
        const byId = new Map<number, { result?: unknown; error?: { code?: number; message?: string } }>();
        for (const item of json as { id?: number; result?: unknown; error?: { code?: number; message?: string } }[]) if (typeof item?.id === "number") byId.set(item.id, item);
        return calls.map((c, i) => {
          const item = byId.get(i + 1);
          if (!item) return new Error(`${c.method}: no answer in the batch from ${hostOf(url)}`);
          if (item.error) return new Error(`${c.method}: rpc ${item.error.code ?? "?"} ${item.error.message ?? ""}`.trim());
          if (item.result === undefined || item.result === null) return new Error(`${c.method}: empty result`);
          return item.result as T;
        });
      } catch (err) {
        attempts.push({ host: hostOf(url), error: err instanceof Error ? err.message : String(err) });
      }
    }
    throw new RpcError(label, attempts);
  }

  return {
    async call<T>(method: string, params: readonly unknown[]): Promise<T> {
      return (await send(method, params, true)).json!.result as T;
    },
    batch: sendBatch,
    async text(method: string, params: readonly unknown[]): Promise<string> {
      return (await send(method, params, false)).text;
    },
  };
}

const TIMESTAMP = /"timestamp"\s*:\s*"(0x[0-9a-fA-F]+)"/;
const NUMBER = /"number"\s*:\s*"(0x[0-9a-fA-F]+)"/;

/** A block's number and timestamp out of an `eth_getBlockByNumber` answer, without parsing the transaction list. */
export function headerFields(text: string): { number: number; timestamp: number } {
  const t = TIMESTAMP.exec(text);
  const n = NUMBER.exec(text);
  if (!t || !n) throw new Error(`block answer without number/timestamp: ${text.slice(0, 120)}`);
  return { number: Number.parseInt(n[1]!, 16), timestamp: Number.parseInt(t[1]!, 16) };
}
