// The protection job (plan M6 and M13): watch each protected borrower through the Protector's on-chain `sizing`
// view, decide, and submit the action as a validity transaction that Base includes only while the predicate
// holds (the feed still shows the held round: the Saturday action) with a short block-number bound, re-armed
// every tick. Pure functions here; the network adapter is in protect-job.ts.
//
// Measured limits that shape this (6 Oct 2026, Base Sepolia sequencer): a block-number bound may be at most
// 32 blocks ahead ("maximum permitted block"), and a re-submission while the previous bound is alive answers
// "already known". So "armed" means: resubmitted at least every ~60 s with a fresh bound.
import type { Address, Hex } from "viem";
import { SELECTOR as RAW_SELECTOR, addressWord, hexToBigInt, strip, word } from "./raw.js";

export const PROTECT_SELECTOR = {
  /** sizing(address,address,uint256) */
  sizing: "0x94eb1b61",
  /** protect(address,address,uint256,uint256,uint256,uint256) */
  protect: "0x0edfc057",
} as const;
export const RAW = RAW_SELECTOR;

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
  return `${PROTECT_SELECTOR.sizing}${addressWord(preLiq)}${addressWord(borrower)}${word(targetLtvWad)}` as Hex;
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

export function encodeProtect(preLiq: Address, borrower: Address, seizedAssets: bigint, repaidShares: bigint, maxCollateralSold: bigint, deadline: bigint): Hex {
  return `${PROTECT_SELECTOR.protect}${addressWord(preLiq)}${addressWord(borrower)}${word(seizedAssets)}${word(repaidShares)}${word(maxCollateralSold)}${word(deadline)}` as Hex;
}

export type ProtectionDecision =
  | { action: "none"; reason: "no-position" | "no-shadow-price" | "below-band" | "above-lltv" | "nothing-feasible" }
  | { action: "partial"; seizedAssets: bigint; repaidShares: 0n; expectedRepaid: bigint }
  | { action: "close"; seizedAssets: 0n; repaidShares: bigint; expectedRepaid: bigint };

/**
 * What to submit for one borrower, from the Protector's own sizing. The contract enforces the same cap, so this
 * only chooses between the partial it allows and the close-out it allows: a partial whenever one can run
 * (several small actions beat one large one), the close-out only when no partial can (a SessionGuard market
 * while closed), nothing otherwise.
 */
export function decideProtection(s: Sizing): ProtectionDecision {
  switch (s.standing) {
    case "NO_POSITION":
      return { action: "none", reason: "no-position" };
    case "NO_SHADOW_PRICE":
      return { action: "none", reason: "no-shadow-price" };
    case "BELOW_BAND":
      return { action: "none", reason: "below-band" };
    case "ABOVE_LLTV":
      return { action: "none", reason: "above-lltv" };
    case "IN_BAND":
      if (s.maxSeizedAssets > 0n) return { action: "partial", seizedAssets: s.maxSeizedAssets, repaidShares: 0n, expectedRepaid: s.maxRepaidAssets };
      if (s.fullCloseAllowed && s.borrowShares > 0n) return { action: "close", seizedAssets: 0n, repaidShares: s.borrowShares, expectedRepaid: s.fullCloseRepaidAssets };
      return { action: "none", reason: "nothing-feasible" };
  }
}

export interface StoragePredicate {
  type: "storage";
  params: { address: Address; slot: Hex; op: "=" | "!=" | "<" | "<=" | ">" | ">="; value: Hex };
}
export interface BlockPredicate {
  type: "block_number";
  params: { op: "<="; value: Hex };
}
export type Predicate = StoragePredicate | BlockPredicate;

/** The sequencer's measured ceiling is head + 32; stay under it. */
export const VALIDITY_WINDOW_BLOCKS = 30n;

/**
 * Predicates for an action that must land only while the feed still shows `heldSlotValue` ("held": the
 * Saturday repay or shadow pre-liquidation), or only once it has changed ("changed": the first block after
 * the reopen), plus the short expiry the sequencer demands.
 */
export function predicatesFor(feed: Address, slot: bigint, heldSlotValue: Hex, head: bigint, mode: "held" | "changed", window: bigint = VALIDITY_WINDOW_BLOCKS): Predicate[] {
  return [
    { type: "storage", params: { address: feed, slot: `0x${slot.toString(16)}` as Hex, op: mode === "held" ? "=" : "!=", value: heldSlotValue } },
    { type: "block_number", params: { op: "<=", value: `0x${(head + window).toString(16)}` as Hex } },
  ];
}

/** The sequencer answers this while the previous submission of the same transaction is still alive. */
export function isAlreadyKnown(message: string): boolean {
  return /already known/i.test(message);
}

export interface ProtectTarget {
  preLiq: Address;
  borrower: Address;
  /** The TestPriceFeed (Sepolia) or Chainlink aggregator (mainnet) whose storage holds the round. */
  feed: Address;
  /** Storage slot holding the feed's updatedAt (TestPriceFeed: 5). */
  feedSlot: bigint;
}

/** `PROTECT_TARGETS`: `preLiq:borrower:feed:slot,...`. */
export function parseTargets(list: string | undefined): ProtectTarget[] {
  const out: ProtectTarget[] = [];
  for (const raw of (list ?? "").split(",")) {
    const t = raw.trim();
    if (!t) continue;
    const [preLiq, borrower, feed, slot] = t.split(":");
    if (!preLiq || !borrower || !feed || slot === undefined) throw new Error(`bad PROTECT_TARGETS entry: ${t}`);
    for (const a of [preLiq, borrower, feed]) if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`bad address in PROTECT_TARGETS: ${a}`);
    out.push({ preLiq: preLiq as Address, borrower: borrower as Address, feed: feed as Address, feedSlot: BigInt(slot) });
  }
  return out;
}

export { hexToBigInt };
