// Multicall3 `aggregate3` encoded and decoded by hand (the same codec as apps/observatory/src/encoding.ts): one eth_call
// for many reads, without viem's multicall path on a Free-plan invocation.
import type { Address, Hex } from "viem";

export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const AGGREGATE3 = "0x82ad56cb"; // aggregate3((address,bool,bytes)[])
export const GET_BLOCK_NUMBER = "0x42cbb15c"; // Multicall3.getBlockNumber()
const WORD = 64;

export interface Call {
  target: Address;
  callData: Hex;
  allowFailure?: boolean;
}

/** One aggregate3 result: `data` is the return data as hex without the 0x prefix. */
export interface CallResult {
  success: boolean;
  data: string;
}

export function wordUint(value: bigint | number): string {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n) throw new RangeError("negative uint");
  return v.toString(16).padStart(WORD, "0");
}

export function wordAddress(address: string): string {
  return address.slice(2).toLowerCase().padStart(WORD, "0");
}

function strip0x(s: string): string {
  return s.startsWith("0x") ? s.slice(2) : s;
}

function wordAt(hex: string, index: number): string {
  const w = hex.slice(index * WORD, index * WORD + WORD);
  if (w.length !== WORD) throw new RangeError(`word ${index} out of range`);
  return w;
}

function smallAt(hex: string, index: number): number {
  const v = BigInt(`0x${wordAt(hex, index)}`);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("offset too large");
  return Number(v);
}

/** Calldata of `aggregate3((address target, bool allowFailure, bytes callData)[] calls)`. */
export function encodeAggregate3(calls: readonly Call[]): Hex {
  const elements = calls.map((c) => {
    const data = c.callData.slice(2).toLowerCase();
    if (data.length % 2 !== 0) throw new RangeError("callData must be whole bytes");
    const padded = data.padEnd(Math.ceil(data.length / WORD) * WORD, "0");
    return wordAddress(c.target) + wordUint(c.allowFailure === false ? 0 : 1) + wordUint(0x60) + wordUint(data.length / 2) + padded;
  });
  // The element offsets are relative to the first byte after the array length word.
  let offset = calls.length * 32;
  const offsets: string[] = [];
  for (const e of elements) {
    offsets.push(wordUint(offset));
    offset += e.length / 2;
  }
  return `${AGGREGATE3}${wordUint(32)}${wordUint(calls.length)}${offsets.join("")}${elements.join("")}` as Hex;
}

/** Return data of `aggregate3`: `(bool success, bytes returnData)[]`. */
export function decodeAggregate3(result: string): CallResult[] {
  const hex = strip0x(result);
  if (hex.length < 2 * WORD) throw new RangeError(`aggregate3 result too short: ${hex.length / 2} bytes`);
  const lengthWord = smallAt(hex, 0) / 32;
  const count = smallAt(hex, lengthWord);
  const base = lengthWord + 1;
  const out: CallResult[] = [];
  for (let i = 0; i < count; i += 1) {
    const element = base + smallAt(hex, base + i) / 32;
    const success = BigInt(`0x${wordAt(hex, element)}`) !== 0n;
    const lengthAt = element + smallAt(hex, element + 1) / 32;
    const length = smallAt(hex, lengthAt);
    const start = (lengthAt + 1) * WORD;
    const data = hex.slice(start, start + length * 2);
    if (data.length !== length * 2) throw new RangeError(`result ${i} truncated`);
    out.push({ success, data });
  }
  return out;
}

/** Test helper: the return data of `aggregate3` for the given results. */
export function encodeAggregate3Result(results: readonly CallResult[]): Hex {
  const elements = results.map((r) => {
    const data = strip0x(r.data).toLowerCase();
    const padded = data.padEnd(Math.ceil(data.length / WORD) * WORD, "0");
    return wordUint(r.success ? 1 : 0) + wordUint(0x40) + wordUint(data.length / 2) + padded;
  });
  let offset = results.length * 32;
  const offsets: string[] = [];
  for (const e of elements) {
    offsets.push(wordUint(offset));
    offset += e.length / 2;
  }
  return `0x${wordUint(32)}${wordUint(results.length)}${offsets.join("")}${elements.join("")}` as Hex;
}

/** Test helper: the calls inside aggregate3 calldata. */
export function decodeAggregate3Calldata(data: string): Call[] {
  const hex = strip0x(data);
  if (!hex.startsWith(AGGREGATE3.slice(2))) throw new RangeError("not aggregate3 calldata");
  const body = hex.slice(8);
  const lengthWord = smallAt(body, 0) / 32;
  const count = smallAt(body, lengthWord);
  const base = lengthWord + 1;
  const out: Call[] = [];
  for (let i = 0; i < count; i += 1) {
    const element = base + smallAt(body, base + i) / 32;
    const target = `0x${wordAt(body, element).slice(24)}` as Address;
    const allowFailure = BigInt(`0x${wordAt(body, element + 1)}`) !== 0n;
    const lengthAt = element + smallAt(body, element + 2) / 32;
    const length = smallAt(body, lengthAt);
    const start = (lengthAt + 1) * WORD;
    out.push({ target, allowFailure, callData: `0x${body.slice(start, start + length * 2)}` as Hex });
  }
  return out;
}
