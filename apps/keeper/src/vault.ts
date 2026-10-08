// The vault job (plan M6, the repay gate): watch CreditDesk lines through the DeskProtectionVault's ladder and,
// when a line's shadow LTV reaches its grace line, repay it back to a target at any hour with `protect(lineId,
// amount)`: the user's reserve first, then the partner's, then a bounded Reserve advance. A repay can never hurt
// the borrower, so it is the one action that is safe on a held feed; it is armed as a validity transaction that Base
// includes only while the feed still shows the round the decision was made on. Pure functions here; the network
// side is vault-job.ts.
//
// Shadow LTV = debt / (collateral × shadow price): the ShadowGuard prices the collateral at the fresh feed in an
// open session and at the pool TWAP less its haircut while the feed is held, so the line is judged at the price the
// market shows on Saturday, never at Friday's held value. Debt and collateral come from the desk's own `capacity`
// quote, which fills both before any refusal (CreditDeskLib.quote), so one view answers at any hour.
import type { Address, Hex } from "viem";
import { addressWord, hexToBigInt, strip, word } from "./raw.js";

/** 4-byte selectors (`cast sig`), checked against viem's `toFunctionSelector` in the tests. */
export const VAULT_SELECTOR = {
  /** CreditDesk.line(uint256) → Line (9 words) */
  line: "0x3c7d9255",
  /** CreditDesk.capacity(uint256) → Quote (10 words) */
  capacity: "0xab1bbeca",
  /** IOracle.price() (the ShadowGuard) */
  price: "0xa035b1fe",
  /** DeskProtectionVault.keeper() */
  keeper: "0xaced1661",
  /** DeskProtectionVault.paused() */
  paused: "0x5c975abb",
  /** DeskProtectionVault.previewProtect(uint256,uint256) → Funding (4 words) */
  previewProtect: "0x869f2640",
  /** DeskProtectionVault.protect(uint256,uint256) */
  protect: "0x1bb980bb",
} as const;

/** The vault's `Protected(uint256 indexed lineId, address indexed user, bytes32 indexed partnerId, …)` topic. */
export const VAULT_PROTECTED_TOPIC: Hex = "0x77c9658efaabd30c7db7765c03b34d4d3c43ed1ecf857f582dd11f772478a169";

const WAD = 10n ** 18n;
const E36 = 10n ** 36n;
/** previewProtect with this amount answers the whole ladder: user reserve, partner reserve, advance room. */
export const LADDER_PROBE = (1n << 128n) - 1n;
/**
 * Amounts are rounded UP to a whole cent (10,000 raw USDC units): interest moves the exact figure every block, and a
 * stable amount keeps the decision (and its backoff fingerprint) still while the price is. Re-arms still change the
 * hash on purpose: the fees rise per window (protect.ts rearmFees), because identical bytes re-submitted after their
 * bound expired were accepted but never included (8 Oct 2026).
 */
export const AMOUNT_STEP = 10_000n;
/** Gas for `protect`: 270,857 (user reserve only) and 366,468 (with an advance) on the two live repays of 7 Oct 2026. */
export const VAULT_PROTECT_GAS_LIMIT = 700_000n;

export interface VaultTarget {
  lineId: bigint;
  /** Shadow LTV at which the vault repays, in bps (5200 = 52%). */
  graceLtvBps: number;
  /** Shadow LTV the repay brings the line back to, in bps; below grace. */
  targetLtvBps: number;
  /** The ShadowGuard that prices the collateral at any hour. */
  shadowOracle: Address;
  /** The feed whose storage carries the round (predicate), and the slot (TestPriceFeed: 5 = updatedAt). */
  feed: Address;
  feedSlot: bigint;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** `VAULT_TARGETS`: `lineId:graceLtvBps:targetLtvBps:shadowOracle:feed:slot,...`. */
export function parseVaultTargets(list: string | undefined): VaultTarget[] {
  const out: VaultTarget[] = [];
  for (const raw of (list ?? "").split(",")) {
    const t = raw.trim();
    if (!t) continue;
    const parts = t.split(":");
    if (parts.length !== 6) throw new Error(`bad VAULT_TARGETS entry (want lineId:graceBps:targetBps:oracle:feed:slot): ${t}`);
    const [lineId, grace, target, oracle, feed, slot] = parts as [string, string, string, string, string, string];
    if (!/^\d+$/.test(lineId) || BigInt(lineId) === 0n) throw new Error(`bad line id in VAULT_TARGETS: ${lineId}`);
    const g = Number(grace);
    const tg = Number(target);
    if (!Number.isInteger(g) || !Number.isInteger(tg) || tg <= 0 || g <= tg || g >= 10_000) {
      throw new Error(`VAULT_TARGETS ${lineId}: need 0 < target < grace < 10000 bps, got grace ${grace}, target ${target}`);
    }
    if (!ADDR.test(oracle) || !ADDR.test(feed)) throw new Error(`bad address in VAULT_TARGETS: ${t}`);
    if (!/^\d+$/.test(slot)) throw new Error(`bad slot in VAULT_TARGETS: ${slot}`);
    out.push({ lineId: BigInt(lineId), graceLtvBps: g, targetLtvBps: tg, shadowOracle: oracle as Address, feed: feed as Address, feedSlot: BigInt(slot) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- codecs

export const encodeLine = (lineId: bigint): Hex => `${VAULT_SELECTOR.line}${word(lineId)}` as Hex;
export const encodeCapacity = (lineId: bigint): Hex => `${VAULT_SELECTOR.capacity}${word(lineId)}` as Hex;
export const encodePreviewProtect = (lineId: bigint, amount: bigint): Hex => `${VAULT_SELECTOR.previewProtect}${word(lineId)}${word(amount)}` as Hex;
export const encodeVaultProtect = (lineId: bigint, amount: bigint): Hex => `${VAULT_SELECTOR.protect}${word(lineId)}${word(amount)}` as Hex;

/** CreditDesk.LineStatus, in declaration order. */
export const LINE_STATUS = ["NONE", "OPEN", "HELD", "CLOSED"] as const;
export type LineStatus = (typeof LINE_STATUS)[number];

/** CreditDesk.Reason, in declaration order (the quote's refusal). */
export const DESK_REASON = [
  "NONE", "DESK_PAUSED", "LINE_NOT_OPEN", "LINE_HELD", "PARTNER_INACTIVE", "MARKET_DISABLED", "MARKET_CLOSED", "FEED_PAUSED",
  "TRANSFER_PAUSED", "FEED_STALE", "FEED_INVALID", "UNKNOWN_TOKEN", "TICKER_NOT_ALLOWED", "NOT_ELIGIBLE", "BELOW_MIN_DRAW",
  "ABOVE_MAX_DRAW", "PARTNER_CAP", "TICKER_CAP", "INSUFFICIENT_CAPACITY", "NOT_AUTHORIZED_ON_VENUE",
] as const;

/** IMarketCalendar.Session, in declaration order. */
export const SESSION = ["UNKNOWN", "PRE", "REGULAR", "POST", "OVERNIGHT", "WEEKEND", "HOLIDAY"] as const;

export interface DeskLine {
  partnerId: Hex;
  user: Address;
  marketId: Hex;
  collateral: Address;
  policyVersion: number;
  status: LineStatus;
  holdReason: Hex;
  openedAt: number;
  drawnPrincipal: bigint;
}

export interface DeskQuote {
  reason: string;
  session: string;
  price8: bigint;
  collateralRaw: bigint;
  /** Loan-token units at the venue's price, 0 when the gate refuses (closed, stale, paused). */
  collateralValue: bigint;
  /** Loan-token units, interest accrued. */
  debt: bigint;
  maxDebt: bigint;
  available: bigint;
  effectiveMaxLtvWad: bigint;
  corporateActionHaircut: boolean;
}

export interface Funding {
  fromUser: bigint;
  fromPartner: bigint;
  fromAdvance: bigint;
  shortfall: bigint;
}

function words(data: Hex, n: number, what: string): bigint[] {
  const d = strip(data);
  if (d.length < n * 64) throw new Error(`${what}: expected ${n} words, got ${Math.floor(d.length / 64)}`);
  const out: bigint[] = [];
  for (let i = 0; i < n; i += 1) out.push(BigInt(`0x${d.slice(i * 64, (i + 1) * 64)}`));
  return out;
}

const hex32 = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}` as Hex;
const addr = (v: bigint): Address => `0x${v.toString(16).padStart(40, "0")}` as Address;

export function decodeLine(data: Hex): DeskLine {
  const w = words(data, 9, "line");
  return {
    partnerId: hex32(w[0]!),
    user: addr(w[1]!),
    marketId: hex32(w[2]!),
    collateral: addr(w[3]!),
    policyVersion: Number(w[4]!),
    status: LINE_STATUS[Number(w[5]!)] ?? "NONE",
    holdReason: hex32(w[6]!),
    openedAt: Number(w[7]!),
    drawnPrincipal: w[8]!,
  };
}

export function decodeQuote(data: Hex): DeskQuote {
  const w = words(data, 10, "capacity");
  return {
    reason: DESK_REASON[Number(w[0]!)] ?? `REASON_${w[0]!}`,
    session: SESSION[Number(w[1]!)] ?? `SESSION_${w[1]!}`,
    price8: w[2]!,
    collateralRaw: w[3]!,
    collateralValue: w[4]!,
    debt: w[5]!,
    maxDebt: w[6]!,
    available: w[7]!,
    effectiveMaxLtvWad: w[8]!,
    corporateActionHaircut: w[9]! !== 0n,
  };
}

export function decodeFunding(data: Hex): Funding {
  const w = words(data, 4, "previewProtect");
  return { fromUser: w[0]!, fromPartner: w[1]!, fromAdvance: w[2]!, shortfall: w[3]! };
}

export function decodeUint(data: Hex): bigint {
  return words(data, 1, "uint256")[0]!;
}

export function decodeAddress(data: Hex): Address {
  return addr(words(data, 1, "address")[0]!);
}

export { addressWord, hexToBigInt };

// ---------------------------------------------------------------------------------------------- sizing

export type VaultStanding = "LINE_CLOSED" | "NO_DEBT" | "NO_SHADOW_PRICE" | "BELOW_GRACE" | "IN_GRACE";

export interface VaultSizing {
  standing: VaultStanding;
  collateralRaw: bigint;
  debt: bigint;
  shadowPrice36: bigint | null;
  /** Collateral at the shadow price, loan-token units. */
  shadowValue: bigint;
  /** Null when there is no shadow price; a line with debt and no collateral value counts as fully over grace. */
  shadowLtvWad: bigint | null;
  /** Collateral at the venue's price (the desk's quote), null while the gate refuses to price it. */
  venueValue: bigint | null;
  venueLtvWad: bigint | null;
  graceLtvWad: bigint;
  targetLtvWad: bigint;
  /** What would bring the shadow LTV back to the target, rounded up to a cent, at most the debt; 0 below grace. */
  amount: bigint;
}

const bpsToWad = (bps: number): bigint => BigInt(bps) * 10n ** 14n;
export const MAX_LTV_WAD = (1n << 255n) - 1n;

/** The line's standing and the repay that restores the target. Pure. */
export function sizeVault(line: DeskLine, quote: DeskQuote, shadowPrice36: bigint | null, t: Pick<VaultTarget, "graceLtvBps" | "targetLtvBps">): VaultSizing {
  const graceLtvWad = bpsToWad(t.graceLtvBps);
  const targetLtvWad = bpsToWad(t.targetLtvBps);
  const debt = quote.debt;
  const venueValue = quote.collateralValue > 0n ? quote.collateralValue : null;
  const venueLtvWad = venueValue !== null && venueValue > 0n ? (debt * WAD) / venueValue : null;
  const base = { collateralRaw: quote.collateralRaw, debt, shadowPrice36, venueValue, venueLtvWad, graceLtvWad, targetLtvWad, amount: 0n };
  if (line.status === "CLOSED" || line.status === "NONE") return { ...base, standing: "LINE_CLOSED", shadowValue: 0n, shadowLtvWad: null };
  if (debt === 0n) return { ...base, standing: "NO_DEBT", shadowValue: 0n, shadowLtvWad: null };
  if (shadowPrice36 === null || shadowPrice36 === 0n) return { ...base, standing: "NO_SHADOW_PRICE", shadowValue: 0n, shadowLtvWad: null };
  const shadowValue = (quote.collateralRaw * shadowPrice36) / E36;
  const shadowLtvWad = shadowValue === 0n ? MAX_LTV_WAD : (debt * WAD) / shadowValue;
  if (shadowLtvWad < graceLtvWad) return { ...base, standing: "BELOW_GRACE", shadowValue, shadowLtvWad };
  const allowed = (shadowValue * targetLtvWad) / WAD; // floor: the repay restores at least the target
  const exact = debt > allowed ? debt - allowed : 0n;
  const rounded = ((exact + AMOUNT_STEP - 1n) / AMOUNT_STEP) * AMOUNT_STEP;
  return { ...base, standing: "IN_GRACE", shadowValue, shadowLtvWad, amount: rounded > debt ? debt : rounded };
}

/** previewProtect(lineId, amount) computed from the whole ladder (previewProtect at LADDER_PROBE): the contract's own min chain. */
export function fundFromLadder(amount: bigint, ladder: Funding): Funding {
  const fromUser = amount < ladder.fromUser ? amount : ladder.fromUser;
  let rest = amount - fromUser;
  const fromPartner = rest < ladder.fromPartner ? rest : ladder.fromPartner;
  rest -= fromPartner;
  const fromAdvance = rest < ladder.fromAdvance ? rest : ladder.fromAdvance;
  rest -= fromAdvance;
  return { fromUser, fromPartner, fromAdvance, shortfall: rest };
}

export type VaultDecision =
  | { action: "none"; reason: "line-closed" | "no-debt" | "no-shadow-price" | "below-grace" | "unfunded" | "paused-needs-advance" }
  /** Set by the job, never by decideVault: the repay was simulated and reverts, or is backing off after one. */
  | { action: "none"; reason: "would-revert" | "backoff" | "simulation-unavailable"; error: string; untilHead?: number }
  | { action: "protect"; amount: bigint; funding: Funding; capped: boolean };

/**
 * What to do for one line. The repay is capped to what the ladder can fund (a partial rescue beats none: the vault
 * reverts on any shortfall); while the vault is paused only the reserves can pay (it refuses advances).
 */
export function decideVault(s: VaultSizing, ladder: Funding | null, paused: boolean): Exclude<VaultDecision, { reason: "would-revert" | "backoff" | "simulation-unavailable" }> {
  switch (s.standing) {
    case "LINE_CLOSED":
      return { action: "none", reason: "line-closed" };
    case "NO_DEBT":
      return { action: "none", reason: "no-debt" };
    case "NO_SHADOW_PRICE":
      return { action: "none", reason: "no-shadow-price" };
    case "BELOW_GRACE":
      return { action: "none", reason: "below-grace" };
    case "IN_GRACE": {
      if (!ladder) return { action: "none", reason: "unfunded" };
      const usable: Funding = paused ? { ...ladder, fromAdvance: 0n } : ladder;
      const room = usable.fromUser + usable.fromPartner + usable.fromAdvance;
      if (room === 0n) return { action: "none", reason: paused && ladder.fromAdvance > 0n ? "paused-needs-advance" : "unfunded" };
      const amount = s.amount <= room ? s.amount : room;
      return { action: "protect", amount, funding: fundFromLadder(amount, usable), capped: amount < s.amount };
    }
  }
}

/** A wad as a percentage string with two decimals ("57.18"), for logs and events. */
export function pct(wad: bigint | null): string | null {
  if (wad === null) return null;
  if (wad >= MAX_LTV_WAD) return "inf";
  const bps = (wad * 10_000n) / WAD;
  return `${bps / 100n}.${(bps % 100n).toString().padStart(2, "0")}`;
}

/** A raw 6-decimal amount as a decimal string ("0.513000"). */
export function usdc(raw: bigint): string {
  return `${raw / 1_000_000n}.${(raw % 1_000_000n).toString().padStart(6, "0")}`;
}
