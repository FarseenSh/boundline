// Hand-rolled ABI encoding and decoding for the fixed call shapes the Observatory reads every minute.
//
// Why not viem's generic encoder and decoder: measured on 6 Oct 2026, one snapshot read through
// `client.multicall` cost about 17 ms of CPU on a warm Node process and about 90 ms cold, more than the
// Workers Free plan allows per invocation (10 ms). Every layout below is known in advance, so there is
// no ABI parsing, no selector hashing and no generic tuple walking: a snapshot decodes in well under a
// millisecond. `test/encoding.test.ts` proves the encoder byte-identical to viem's and the decoders
// equal to viem's on a recorded mainnet response.
import type { Address, Hex } from "viem";

/** Multicall3, same address on Base mainnet and Base Sepolia. */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** 4-byte selectors (`cast sig` of each signature; checked against viem's toFunctionSelector in the tests). */
export const SELECTOR = {
  aggregate3: "0x82ad56cb", // aggregate3((address,bool,bytes)[])
  getBlockNumber: "0x42cbb15c", // getBlockNumber()
  getCurrentBlockTimestamp: "0x0f28c97d", // getCurrentBlockTimestamp()
  latestRoundData: "0xfeaf968c", // latestRoundData()
  decimals: "0x313ce567", // decimals()
  getOracleParams: "0xd4197e82", // getOracleParams(address)
  isPaused: "0xbc61e733", // isPaused(uint8)
  pausedFeatures: "0xde9997e3", // pausedFeatures()
  uiMultiplier: "0xa60bf13d", // uiMultiplier()
  newUIMultiplier: "0xdc767007", // newUIMultiplier()
  effectiveAt: "0x97a4064f", // effectiveAt()
  slot0: "0x3850c7bd", // slot0()
  liquidity: "0x1a686502", // liquidity()
  observe: "0x883bdbfd", // observe(uint32[])
  market: "0x5c60e39a", // market(bytes32)
  position: "0x93c52062", // position(bytes32,address)
  price: "0xa035b1fe", // price()
} as const;

export interface Call {
  target: Address;
  callData: Hex;
  /** Default true: a failing call yields `success: false` instead of reverting the whole aggregate. */
  allowFailure?: boolean;
}

/** One aggregate3 result: `data` is the return data as hex without the 0x prefix. */
export interface CallResult {
  success: boolean;
  data: string;
}

const WORD = 64; // hex characters per 32-byte word
const TWO_255 = 1n << 255n;
const TWO_256 = 1n << 256n;

// ---------------------------------------------------------------- words

/** A non-negative integer as one 32-byte word. */
export function wordUint(value: bigint | number): string {
  const v = BigInt(value);
  if (v < 0n || v >= TWO_256) throw new RangeError(`uint word out of range: ${value}`);
  return v.toString(16).padStart(WORD, "0");
}

export function wordAddress(address: Address): string {
  const body = address.slice(2).toLowerCase();
  if (body.length !== 40 || !/^[0-9a-f]{40}$/.test(body)) throw new RangeError(`bad address: ${address}`);
  return body.padStart(WORD, "0");
}

export function wordBytes32(value: Hex): string {
  const body = value.slice(2).toLowerCase();
  if (body.length !== 64 || !/^[0-9a-f]{64}$/.test(body)) throw new RangeError(`bad bytes32: ${value}`);
  return body;
}

/** Selector plus static 32-byte words. */
export function callData(selector: string, ...words: string[]): Hex {
  return `${selector}${words.join("")}` as Hex;
}

/** `observe(uint32[] secondsAgos)`: one dynamic array argument. */
export function observeCallData(secondsAgos: readonly number[]): Hex {
  return callData(SELECTOR.observe, wordUint(32), wordUint(secondsAgos.length), ...secondsAgos.map(wordUint));
}

// ---------------------------------------------------------------- aggregate3

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
  return `${SELECTOR.aggregate3}${wordUint(32)}${wordUint(calls.length)}${offsets.join("")}${elements.join("")}` as Hex;
}

function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

function wordAt(hex: string, index: number): string {
  const w = hex.slice(index * WORD, (index + 1) * WORD);
  if (w.length !== WORD) throw new RangeError(`word ${index} missing: data has ${hex.length / 2} bytes`);
  return w;
}

function smallAt(hex: string, index: number): number {
  const v = BigInt(`0x${wordAt(hex, index)}`);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`word ${index} is not a small integer`);
  return Number(v);
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

/** The inverse of `decodeAggregate3`, for tests and local simulations. */
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

/** The calls inside aggregate3 calldata, for tests and fakes that answer by target and selector. */
export function decodeAggregate3Calldata(data: string): Call[] {
  const hex = strip0x(data);
  if (!hex.startsWith(SELECTOR.aggregate3.slice(2))) throw new RangeError("not aggregate3 calldata");
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

// ---------------------------------------------------------------- return data readers

/** Word `index` of return data as an unsigned integer. Throws when the data is too short. */
export function uintAt(data: string, index: number): bigint {
  return BigInt(`0x${wordAt(data, index)}`);
}

/** Word `index` as a two's-complement signed integer (int24, int56, int256 all encode this way). */
export function intAt(data: string, index: number): bigint {
  const v = uintAt(data, index);
  return v >= TWO_255 ? v - TWO_256 : v;
}

export function boolAt(data: string, index: number): boolean {
  return uintAt(data, index) !== 0n;
}

/** Word `index` as a lowercase address (no checksum: comparisons here are case-insensitive). */
export function addressAt(data: string, index: number): Address {
  return `0x${wordAt(data, index).slice(24)}` as Address;
}

/** A dynamic array of static words whose offset sits in head word `headIndex`. */
export function uintArrayAt(data: string, headIndex: number): bigint[] {
  const at = smallAt(data, headIndex) / 32;
  const length = smallAt(data, at);
  const out: bigint[] = [];
  for (let k = 0; k < length; k += 1) out.push(uintAt(data, at + 1 + k));
  return out;
}

export function intArrayAt(data: string, headIndex: number): bigint[] {
  const at = smallAt(data, headIndex) / 32;
  const length = smallAt(data, at);
  const out: bigint[] = [];
  for (let k = 0; k < length; k += 1) out.push(intAt(data, at + 1 + k));
  return out;
}

// ---------------------------------------------------------------- typed decoders for the calls above

export function decodeUint(data: string): bigint {
  return uintAt(data, 0);
}

export function decodeBool(data: string): boolean {
  return boolAt(data, 0);
}

/** `latestRoundData()` -> [roundId, answer, startedAt, updatedAt, answeredInRound]. */
export function decodeLatestRoundData(data: string): readonly [bigint, bigint, bigint, bigint, bigint] {
  return [uintAt(data, 0), intAt(data, 1), uintAt(data, 2), uintAt(data, 3), uintAt(data, 4)];
}

/** `getOracleParams(address)` -> [multiplier, paused]. */
export function decodeOracleParams(data: string): readonly [bigint, boolean] {
  return [uintAt(data, 0), boolAt(data, 1)];
}

/** `pausedFeatures()` -> uint8[]. */
export function decodeUint8Array(data: string): number[] {
  return uintArrayAt(data, 0).map((v) => Number(v));
}

/** `slot0()` -> [sqrtPriceX96, tick, observationIndex, observationCardinality, observationCardinalityNext, unlocked]. */
export function decodeSlot0(data: string): readonly [bigint, number, number, number, number, boolean] {
  return [uintAt(data, 0), Number(intAt(data, 1)), Number(uintAt(data, 2)), Number(uintAt(data, 3)), Number(uintAt(data, 4)), boolAt(data, 5)];
}

/** `observe(uint32[])` -> [tickCumulatives, secondsPerLiquidityCumulativeX128s]. */
export function decodeObserve(data: string): readonly [bigint[], bigint[]] {
  return [intArrayAt(data, 0), uintArrayAt(data, 1)];
}

/** Morpho `market(bytes32)` -> the six uint128 fields. */
export function decodeMarket(data: string): { totalSupplyAssets: bigint; totalSupplyShares: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint; lastUpdate: bigint; fee: bigint } {
  return {
    totalSupplyAssets: uintAt(data, 0),
    totalSupplyShares: uintAt(data, 1),
    totalBorrowAssets: uintAt(data, 2),
    totalBorrowShares: uintAt(data, 3),
    lastUpdate: uintAt(data, 4),
    fee: uintAt(data, 5),
  };
}

/** Morpho `position(bytes32,address)` -> (supplyShares, borrowShares, collateral). */
export function decodePosition(data: string): { supplyShares: bigint; borrowShares: bigint; collateral: bigint } {
  return { supplyShares: uintAt(data, 0), borrowShares: uintAt(data, 1), collateral: uintAt(data, 2) };
}
