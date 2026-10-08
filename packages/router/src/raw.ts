// Hand-rolled ABI encoding for the reads behind a route (Multicall3 aggregate3 over Morpho `market`,
// `idToMarketParams` and the IRM's `borrowRateView`). Same reasoning as apps/keeper/src/raw.ts: viem's generic
// decoder is tens of milliseconds cold, these are string operations (Workers Free plan: 10 ms CPU per invocation).
// Moved here from apps/agent on 8 Oct 2026 so the agent and the partner API build route candidates from one copy;
// `@boundline/router` itself (index.ts) stays pure and does no I/O: this module is the `./raw` subpath export.
export type Hex = `0x${string}`;

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
export const SELECTOR = {
  aggregate3: "0x82ad56cb",
  market: "0x5c60e39a",
  idToMarketParams: "0x2c3c9157",
  borrowRateView: "0x8c00bf6b",
} as const;

const TWO_256 = 1n << 256n;

export function strip(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

export function word(value: bigint | number | boolean): string {
  let v = typeof value === "boolean" ? (value ? 1n : 0n) : BigInt(value);
  if (v < 0n) v += TWO_256;
  if (v < 0n || v >= TWO_256) throw new RangeError(`value does not fit in 256 bits: ${value}`);
  return v.toString(16).padStart(64, "0");
}

export function addressWord(address: string): string {
  const a = strip(address).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(a)) throw new RangeError(`not an address: ${address}`);
  return a.padStart(64, "0");
}

export function bytes32Word(id: string): string {
  const h = strip(id).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new RangeError(`not bytes32: ${id}`);
  return h;
}

/** The i-th 32-byte word of ABI data without its 0x prefix, or null when the data is too short. */
export function wordAt(data: string, i: number): bigint | null {
  const s = data.slice(i * 64, (i + 1) * 64);
  return s.length === 64 ? BigInt(`0x${s}`) : null;
}

export interface Call3 {
  target: string;
  allowFailure: boolean;
  callData: Hex;
}

export function encodeAggregate3(calls: readonly Call3[]): Hex {
  const elements = calls.map((c) => {
    const data = strip(c.callData);
    if (data.length % 2 !== 0) throw new RangeError("callData must be whole bytes");
    const padded = data.padEnd(Math.ceil(data.length / 64) * 64, "0");
    return addressWord(c.target) + word(c.allowFailure) + word(0x60) + word(data.length / 2) + padded;
  });
  let offset = calls.length * 32;
  const offsets: string[] = [];
  for (const e of elements) {
    offsets.push(word(offset));
    offset += e.length / 2;
  }
  return `${SELECTOR.aggregate3}${word(0x20)}${word(calls.length)}${offsets.join("")}${elements.join("")}` as Hex;
}

export interface Call3Result {
  success: boolean;
  returnData: Hex;
}

export function decodeAggregate3(data: Hex): Call3Result[] {
  const d = strip(data);
  const arrayOffset = wordAt(d, 0);
  if (arrayOffset === null) throw new Error("aggregate3: empty return data");
  const base = Number(arrayOffset) * 2;
  const length = wordAt(d, base / 64);
  if (length === null) throw new Error("aggregate3: missing array length");
  const n = Number(length);
  const elementsStart = base + 64;
  const out: Call3Result[] = [];
  for (let i = 0; i < n; i += 1) {
    const rel = wordAt(d, elementsStart / 64 + i);
    if (rel === null) throw new Error(`aggregate3: missing offset for element ${i}`);
    const tupleStart = elementsStart + Number(rel) * 2;
    const success = wordAt(d, tupleStart / 64);
    const bytesRel = wordAt(d, tupleStart / 64 + 1);
    if (success === null || bytesRel === null) throw new Error(`aggregate3: truncated element ${i}`);
    const bytesStart = tupleStart + Number(bytesRel) * 2;
    const bytesLen = wordAt(d, bytesStart / 64);
    if (bytesLen === null) throw new Error(`aggregate3: missing bytes length for element ${i}`);
    const payload = d.slice(bytesStart + 64, bytesStart + 64 + Number(bytesLen) * 2);
    if (payload.length !== Number(bytesLen) * 2) throw new Error(`aggregate3: truncated bytes for element ${i}`);
    out.push({ success: success !== 0n, returnData: `0x${payload}` as Hex });
  }
  return out;
}

export interface MorphoMarket {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
}

export interface MorphoMarketParams {
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: bigint;
}

export function encodeMarket(id: string): Hex {
  return `${SELECTOR.market}${bytes32Word(id)}` as Hex;
}

export function encodeIdToMarketParams(id: string): Hex {
  return `${SELECTOR.idToMarketParams}${bytes32Word(id)}` as Hex;
}

export function decodeMarket(data: Hex): MorphoMarket {
  const d = strip(data);
  const w = [0, 1, 2, 3, 4, 5].map((i) => wordAt(d, i));
  if (w.some((x) => x === null)) throw new Error("market: expected 6 words");
  const [a, b, c, e, f, g] = w as bigint[];
  return { totalSupplyAssets: a!, totalSupplyShares: b!, totalBorrowAssets: c!, totalBorrowShares: e!, lastUpdate: f!, fee: g! };
}

/** The low 20 bytes of a word as a lowercase 0x address. */
export function addressFromWord(w: bigint): string {
  return `0x${w.toString(16).padStart(40, "0")}`;
}

export function decodeMarketParams(data: Hex): MorphoMarketParams {
  const d = strip(data);
  const w = [0, 1, 2, 3, 4].map((i) => wordAt(d, i));
  if (w.some((x) => x === null)) throw new Error("idToMarketParams: expected 5 words");
  const [l, c, o, i, lltv] = w as bigint[];
  return { loanToken: addressFromWord(l!), collateralToken: addressFromWord(c!), oracle: addressFromWord(o!), irm: addressFromWord(i!), lltv: lltv! };
}

/** `borrowRateView(MarketParams, Market)`: two static tuples, eleven words in order. Returns the per-second rate (WAD). */
export function encodeBorrowRateView(p: MorphoMarketParams, m: MorphoMarket): Hex {
  return `${SELECTOR.borrowRateView}${addressWord(p.loanToken)}${addressWord(p.collateralToken)}${addressWord(p.oracle)}${addressWord(p.irm)}${word(p.lltv)}${word(m.totalSupplyAssets)}${word(m.totalSupplyShares)}${word(m.totalBorrowAssets)}${word(m.totalBorrowShares)}${word(m.lastUpdate)}${word(m.fee)}` as Hex;
}

export function decodeUint(data: Hex): bigint {
  const w = wordAt(strip(data), 0);
  if (w === null) throw new Error("expected one word");
  return w;
}

/** One `eth_call` to Multicall3 through an ordered RPC list; the first endpoint that answers wins. */
export async function multicall(rpcs: readonly string[], calls: readonly Call3[], fetchImpl: typeof fetch = fetch): Promise<Call3Result[]> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: MULTICALL3, data: encodeAggregate3(calls) }, "latest"] });
  let lastError = "no rpc";
  for (const url of rpcs) {
    try {
      const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(8000) });
      const json = (await res.json()) as { result?: Hex; error?: { message?: string } };
      if (json.error || !json.result) {
        lastError = json.error?.message ?? "empty result";
        continue;
      }
      return decodeAggregate3(json.result);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`multicall failed on every rpc: ${lastError}`);
}
