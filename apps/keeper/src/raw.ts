// Raw JSON-RPC encoding for the keeper's handful of calls.
//
// Why this exists: the account runs on the Workers Free plan, 10 ms of CPU per invocation. Measured on 6 Oct 2026
// (Node, JIT on): viem's `privateKeyToAccount` costs 17.8 ms the first time an isolate uses it (noble-curves builds
// its base-point tables), and viem's generic multicall encode/decode costs 17 ms warm and 88 ms cold for a snapshot
// of 86 calls. Every cron tick on the account was dying with `exceededCpu`. The builders below are string
// concatenation and BigInt parsing: microseconds, and verified against viem's encoders in test/raw.test.ts.
import type { Address, Hex } from "viem";
import type { RegistryParams, Round, RoundArgs } from "./plan.js";

/** Multicall3, same address on Base mainnet and Base Sepolia. */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** 4-byte selectors (`cast sig`), checked against viem's `toFunctionSelector` in the tests. */
export const SELECTOR = {
  /** aggregate3((address,bool,bytes)[]) */
  aggregate3: "0x82ad56cb",
  /** latestRoundData() */
  latestRoundData: "0xfeaf968c",
  /** getOracleParams(address) */
  getOracleParams: "0xd4197e82",
  /** setRoundData(uint80,int256,uint256,uint256,uint80) */
  setRoundData: "0x1c12940a",
  /** setOracleParams(address,uint256,bool) */
  setOracleParams: "0x2a545b8f",
} as const;

const TWO_256 = 1n << 256n;
const TWO_255 = 1n << 255n;

export function strip(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/** One 32-byte ABI word as 64 hex characters; negative integers use two's complement. */
export function word(value: bigint | number | boolean): string {
  let v = typeof value === "boolean" ? (value ? 1n : 0n) : BigInt(value);
  if (v < 0n) v += TWO_256;
  if (v < 0n || v >= TWO_256) throw new RangeError(`value does not fit in 256 bits: ${value}`);
  return v.toString(16).padStart(64, "0");
}

export function addressWord(address: Address): string {
  const a = strip(address).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(a)) throw new RangeError(`not an address: ${address}`);
  return a.padStart(64, "0");
}

export function hexToBigInt(hex: Hex | string): bigint {
  const h = strip(hex);
  return h.length === 0 ? 0n : BigInt(`0x${h}`);
}

export function toInt256(unsigned: bigint): bigint {
  return unsigned >= TWO_255 ? unsigned - TWO_256 : unsigned;
}

/** The i-th word of ABI-encoded data (0-based), or null when the data is too short. */
function wordAt(data: string, i: number): bigint | null {
  const s = data.slice(i * 64, (i + 1) * 64);
  return s.length === 64 ? BigInt(`0x${s}`) : null;
}

export interface Call3 {
  target: Address;
  allowFailure: boolean;
  callData: Hex;
}

/** `aggregate3((address,bool,bytes)[])` calldata: a dynamic array of tuples with one dynamic member each. */
export function encodeAggregate3(calls: readonly Call3[]): Hex {
  const elements = calls.map((c) => {
    const data = strip(c.callData);
    if (data.length % 2 !== 0) throw new RangeError("callData must be whole bytes");
    const padded = data.padEnd(Math.ceil(data.length / 64) * 64, "0");
    // head: target, allowFailure, offset of `callData` inside the tuple (3 words = 0x60); tail: length + bytes.
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

/** Decodes `(bool success, bytes returnData)[]` as returned by `aggregate3`. */
export function decodeAggregate3(data: Hex): Call3Result[] {
  const d = strip(data);
  const arrayOffset = wordAt(d, 0);
  if (arrayOffset === null) throw new Error("aggregate3: empty return data");
  const base = Number(arrayOffset) * 2; // hex chars
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

/** `latestRoundData()` → (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound). */
export function decodeLatestRoundData(data: Hex): Round {
  const d = strip(data);
  const w = [0, 1, 2, 3, 4].map((i) => wordAt(d, i));
  if (w.some((x) => x === null)) throw new Error(`latestRoundData: expected 5 words, got ${Math.floor(d.length / 64)}`);
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = w as bigint[];
  return { roundId: roundId!, answer: toInt256(answer!), startedAt: startedAt!, updatedAt: updatedAt!, answeredInRound: answeredInRound! };
}

/** `getOracleParams(address)` → (uint256 multiplier, bool paused). */
export function decodeOracleParams(data: Hex): RegistryParams {
  const d = strip(data);
  const multiplier = wordAt(d, 0);
  const paused = wordAt(d, 1);
  if (multiplier === null || paused === null) throw new Error(`getOracleParams: expected 2 words, got ${Math.floor(d.length / 64)}`);
  return { multiplier, paused: paused !== 0n };
}

export function encodeLatestRoundData(): Hex {
  return SELECTOR.latestRoundData;
}

export function encodeGetOracleParams(token: Address): Hex {
  return `${SELECTOR.getOracleParams}${addressWord(token)}` as Hex;
}

export function encodeSetRoundData(args: RoundArgs): Hex {
  return `${SELECTOR.setRoundData}${word(args[0])}${word(args[1])}${word(args[2])}${word(args[3])}${word(args[4])}` as Hex;
}

export function encodeSetOracleParams(token: Address, multiplier: bigint, paused: boolean): Hex {
  return `${SELECTOR.setOracleParams}${addressWord(token)}${word(multiplier)}${word(paused)}` as Hex;
}

/** A revert's first four bytes, for error messages. */
export function describeRevert(returnData: Hex): string {
  const d = strip(returnData);
  return d.length === 0 ? "reverted without data" : `reverted ${`0x${d.slice(0, 8)}`}${d.length > 8 ? "…" : ""}`;
}
