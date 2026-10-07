// Hand-rolled ABI words for the few raw eth_calls the API makes outside the desk ABI (the Protector's `sizing`
// view). String concatenation and BigInt parsing cost microseconds; viem's generic decoders cost tens of
// milliseconds cold, which matters on a Worker. The selectors and layout are the keeper's (apps/keeper/src/protect.ts),
// copied here rather than imported across apps so each Worker bundles only its own code.
import type { Address, Hex } from "viem";

const TWO_256 = 1n << 256n;

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

/** The i-th word of ABI-encoded data (0-based), or null when the data is too short. */
export function wordAt(data: string, i: number): bigint | null {
  const s = data.slice(i * 64, (i + 1) * 64);
  return s.length === 64 ? BigInt(`0x${s}`) : null;
}

/** Protector selectors (`cast sig`), the same values the keeper checks against viem's `toFunctionSelector`. */
export const PROTECTOR_SELECTOR = {
  /** sizing(address,address,uint256) */
  sizing: "0x94eb1b61",
} as const;

/** Protector.Standing, in declaration order. */
export const STANDING = ["NO_POSITION", "NO_SHADOW_PRICE", "BELOW_BAND", "IN_BAND", "ABOVE_LLTV"] as const;
export type Standing = (typeof STANDING)[number];

/** Protector.Sizing: 18 static fields, one word each. */
export interface Sizing {
  standing: Standing;
  collateral: bigint;
  borrowShares: bigint;
  debtAssets: bigint;
  shadowPrice36: bigint;
  venuePrice36: bigint;
  venueOracleLive: boolean;
  shadowLtvWad: bigint;
  venueLtvWad: bigint;
  preLifWad: bigint;
  preLcfWad: bigint;
  targetLtvWad: bigint;
  maxSeizedAssets: bigint;
  maxRepaidShares: bigint;
  maxRepaidAssets: bigint;
  fullCloseAllowed: boolean;
  fullCloseSeizedAssets: bigint;
  fullCloseRepaidAssets: bigint;
}

export const SIZING_WORDS = 18;

export function encodeSizing(preLiq: Address, borrower: Address, targetLtvWad: bigint): Hex {
  return `${PROTECTOR_SELECTOR.sizing}${addressWord(preLiq)}${addressWord(borrower)}${word(targetLtvWad)}` as Hex;
}

export function decodeSizing(data: Hex): Sizing {
  const d = strip(data);
  if (d.length < SIZING_WORDS * 64) throw new Error(`sizing: expected ${SIZING_WORDS} words, got ${Math.floor(d.length / 64)}`);
  const w = (i: number): bigint => BigInt(`0x${d.slice(i * 64, (i + 1) * 64)}`);
  const standingIndex = Number(w(0));
  const standing = STANDING[standingIndex];
  if (!standing) throw new Error(`sizing: unknown standing ${standingIndex}`);
  return {
    standing,
    collateral: w(1),
    borrowShares: w(2),
    debtAssets: w(3),
    shadowPrice36: w(4),
    venuePrice36: w(5),
    venueOracleLive: w(6) !== 0n,
    shadowLtvWad: w(7),
    venueLtvWad: w(8),
    preLifWad: w(9),
    preLcfWad: w(10),
    targetLtvWad: w(11),
    maxSeizedAssets: w(12),
    maxRepaidShares: w(13),
    maxRepaidAssets: w(14),
    fullCloseAllowed: w(15) !== 0n,
    fullCloseSeizedAssets: w(16),
    fullCloseRepaidAssets: w(17),
  };
}

/** A raw `eth_call` at the latest block: `data` in, return data out. The viem client's transport provides it; tests fake it. */
export type EthCaller = (to: Address, data: Hex) => Promise<Hex>;
