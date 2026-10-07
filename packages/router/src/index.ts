// Boundline credit router. Given a user's collateral, a partner policy and the live state of every candidate venue
// (rate, LLTV, liquidity, protection, session verdict, prices), choose where a draw should go and say why, as a
// deterministic route plan the API or keeper signs (EIP-712) and stores on the obligation record.
//
// Rules, in order (M11 of the plan of record):
//   1. a venue is only eligible when the collateral's SessionGate verdict is OPEN, except "Saturday mode": on a venue that
//      prices around the clock at the held feed (Aave V4) a partner may allow weekend draws at half capacity at the lower of
//      the held feed and the DEX TWAP less a haircut; Boundline's own SessionGuard markets never draw while closed;
//   2. capacity = collateral value × min(policy max LTV, venue LLTV), capped by venue liquidity, the policy's max draw and the
//      partner's exposure headroom; capacity rounds down; unknown data fails closed;
//   3. among eligible legs: protection available first (when preferred), then the lowest borrow rate, then the largest
//      capacity, then venue order (morpho, aave), then market id; ties are impossible after that, so the plan is reproducible.
// Pure: bigint arithmetic, no chain I/O, no dependencies. Hashing and signing belong to the caller (viem's hashTypedData).

export type Venue = "morpho" | "aave";
export type GateState = "OPEN" | "MARKET_CLOSED" | "FEED_PAUSED" | "TRANSFER_PAUSED" | "FEED_INVALID" | "FEED_STALE" | "UNKNOWN";
export type ProtectionMode = "pre-liquidation" | "vault" | "none";
export type PriceSource = "feed" | "twap-haircut";

export const WAD = 10n ** 18n;
export const BPS = 10_000n;
export const VENUE_ORDER: readonly Venue[] = ["morpho", "aave"];

export interface VenueCandidate {
  venue: Venue;
  chainId: number;
  /** Morpho market id (bytes32 hex) or Aave reserve id (decimal string). */
  marketId: string;
  collateral: string;
  collateralDecimals: number;
  loanDecimals: number;
  /** Borrow APR as a WAD (1e18 = 100% per year). Morpho: IRM per-second rate × 31,536,000; Aave: the reserve's variable rate. */
  borrowRateWad: bigint;
  /** The venue's liquidation LTV (Morpho LLTV, Aave liquidation threshold) as a WAD. */
  lltvWad: bigint;
  /** Loan units the venue can lend right now. */
  availableLiquidity: bigint;
  protection: ProtectionMode;
  /** SessionGate verdict for the collateral token. */
  gate: GateState;
  /** Feed answer scaled to 8 decimals (the held value while closed), null when invalid. */
  feedPrice8: bigint | null;
  /** DEX TWAP scaled to 8 decimals (publishes around the clock), null when unavailable. */
  twapPrice8: bigint | null;
  /** True for venues that keep pricing at the held feed while closed (Aave V4); false for SessionGuard markets. */
  pricesAroundTheClock: boolean;
}

export interface PartnerPolicy {
  allowed: boolean;
  /** Policy max LTV as a WAD; clamped to the venue LLTV. */
  maxLtvWad: bigint;
  minDraw: bigint;
  /** 0 = no cap. */
  maxDraw: bigint;
  /** Loan units left under the partner's and ticker's exposure caps. */
  exposureHeadroom: bigint;
}

export interface SaturdayMode {
  enabled: boolean;
  /** Haircut on min(held feed, TWAP), in bps, from the weekend-gap distribution. */
  haircutBps: number;
}

export interface RouteRequest {
  user: string;
  collateral: string;
  collateralAmount: bigint;
  collateralDecimals: number;
  /** Requested loan units. */
  amount: bigint;
  policy: PartnerPolicy;
  saturdayMode?: SaturdayMode;
  /** Rank protected venues first (default true). */
  preferProtection?: boolean;
  /** Unix seconds. */
  now: number;
  validForSeconds?: number;
}

export type RejectReason =
  | "TICKER_NOT_ALLOWED"
  | "MARKET_CLOSED"
  | "FEED_PAUSED"
  | "TRANSFER_PAUSED"
  | "FEED_INVALID"
  | "FEED_STALE"
  | "UNKNOWN_STATE"
  | "NO_PRICE"
  | "COLLATERAL_MISMATCH"
  | "INSUFFICIENT_LIQUIDITY"
  | "INSUFFICIENT_CAPACITY"
  | "BELOW_MIN_DRAW"
  | "PARTNER_CAP";

export interface Rejected {
  venue: Venue;
  marketId: string;
  reason: RejectReason;
  detail?: string;
}

export interface RouteLeg {
  venue: Venue;
  chainId: number;
  marketId: string;
  /** Loan units this leg lends: the request, or the capacity when the request exceeds it. */
  amount: bigint;
  capacity: bigint;
  /** Resulting LTV after the draw, WAD. */
  ltvWad: bigint;
  /** The LTV the leg was sized at (min of policy and venue), WAD. */
  maxLtvWad: bigint;
  expectedRateWad: bigint;
  protection: ProtectionMode;
  price8: bigint;
  priceSource: PriceSource;
  session: "open" | "saturday";
  /** Why this leg is shaped as it is (CAPACITY_LIMITED, SATURDAY_HALF_CAPACITY, PROTECTED, ...). */
  notes: string[];
}

export interface RoutePlan {
  version: 1;
  user: string;
  collateral: string;
  requested: bigint;
  chosen: RouteLeg | null;
  /** Other eligible legs in rank order. */
  alternatives: RouteLeg[];
  rejected: Rejected[];
  createdAt: number;
  validUntil: number;
  /** Plan-level reason codes: ROUTED, CAPACITY_LIMITED, NO_ROUTE. */
  reasonCodes: string[];
}

const GATE_REJECT: Record<Exclude<GateState, "OPEN">, RejectReason> = {
  MARKET_CLOSED: "MARKET_CLOSED",
  FEED_PAUSED: "FEED_PAUSED",
  TRANSFER_PAUSED: "TRANSFER_PAUSED",
  FEED_INVALID: "FEED_INVALID",
  FEED_STALE: "FEED_STALE",
  UNKNOWN: "UNKNOWN_STATE",
};

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

function min(...xs: bigint[]): bigint {
  return xs.reduce((a, b) => (b < a ? b : a));
}

/** Collateral value in loan units at an 8-decimal price, rounded down. */
export function collateralValue(collateralAmount: bigint, collateralDecimals: number, price8: bigint, loanDecimals: number): bigint {
  if (collateralAmount < 0n || price8 < 0n) throw new Error("negative input");
  return (collateralAmount * price8 * pow10(loanDecimals)) / (pow10(collateralDecimals) * pow10(8));
}

/** Price with a bps haircut, rounded down. */
export function haircut(price8: bigint, bps: number): bigint {
  if (bps < 0 || bps > 10_000) throw new Error("haircut out of range");
  return (price8 * (BPS - BigInt(bps))) / BPS;
}

function sizeLeg(req: RouteRequest, c: VenueCandidate): { leg: RouteLeg } | { rejected: Rejected } {
  const reject = (reason: RejectReason, detail?: string): { rejected: Rejected } => ({ rejected: { venue: c.venue, marketId: c.marketId, reason, ...(detail ? { detail } : {}) } });
  if (!req.policy.allowed) return reject("TICKER_NOT_ALLOWED");
  if (c.collateral !== req.collateral) return reject("COLLATERAL_MISMATCH", `${c.collateral} ≠ ${req.collateral}`);
  if (c.collateralDecimals !== req.collateralDecimals) return reject("COLLATERAL_MISMATCH", "decimals");
  const notes: string[] = [];
  let price8: bigint;
  let priceSource: PriceSource = "feed";
  let session: RouteLeg["session"] = "open";
  let capacityDivisor = 1n;
  if (c.gate === "OPEN") {
    if (c.feedPrice8 === null || c.feedPrice8 <= 0n) return reject("NO_PRICE");
    price8 = c.feedPrice8;
  } else if (c.gate === "MARKET_CLOSED" && c.pricesAroundTheClock && req.saturdayMode?.enabled) {
    // Saturday mode: half capacity at the lower of the held feed and the TWAP, less the haircut. Never on SessionGuard markets.
    if (c.feedPrice8 === null || c.feedPrice8 <= 0n || c.twapPrice8 === null || c.twapPrice8 <= 0n) return reject("NO_PRICE", "saturday mode needs both the held feed and the TWAP");
    price8 = haircut(min(c.feedPrice8, c.twapPrice8), req.saturdayMode.haircutBps);
    priceSource = "twap-haircut";
    session = "saturday";
    capacityDivisor = 2n;
    notes.push("SATURDAY_HALF_CAPACITY");
  } else {
    return reject(GATE_REJECT[c.gate as Exclude<GateState, "OPEN">]);
  }
  const maxLtvWad = min(req.policy.maxLtvWad, c.lltvWad);
  if (maxLtvWad <= 0n) return reject("INSUFFICIENT_CAPACITY", "ltv 0");
  const value = collateralValue(req.collateralAmount, req.collateralDecimals, price8, c.loanDecimals);
  let capacity = (value * maxLtvWad) / WAD / capacityDivisor;
  if (req.policy.maxDraw > 0n) capacity = min(capacity, req.policy.maxDraw);
  if (capacity > req.policy.exposureHeadroom) {
    capacity = req.policy.exposureHeadroom;
    notes.push("PARTNER_CAP_LIMITED");
  }
  if (capacity <= 0n) return reject(req.policy.exposureHeadroom <= 0n ? "PARTNER_CAP" : "INSUFFICIENT_CAPACITY");
  if (c.availableLiquidity < req.policy.minDraw || c.availableLiquidity <= 0n) return reject("INSUFFICIENT_LIQUIDITY", `${c.availableLiquidity} available`);
  if (capacity > c.availableLiquidity) {
    capacity = c.availableLiquidity;
    notes.push("LIQUIDITY_LIMITED");
  }
  if (capacity < req.policy.minDraw) return reject("BELOW_MIN_DRAW", `capacity ${capacity} < min ${req.policy.minDraw}`);
  let amount = req.amount;
  if (amount > capacity) {
    amount = capacity;
    notes.push("CAPACITY_LIMITED");
  }
  if (amount < req.policy.minDraw) return reject("BELOW_MIN_DRAW", `amount ${amount} < min ${req.policy.minDraw}`);
  if (c.protection !== "none") notes.push("PROTECTED");
  const ltvWad = value === 0n ? 0n : (amount * WAD) / value;
  return {
    leg: { venue: c.venue, chainId: c.chainId, marketId: c.marketId, amount, capacity, ltvWad, maxLtvWad, expectedRateWad: c.borrowRateWad, protection: c.protection, price8, priceSource, session, notes },
  };
}

/** Deterministic rank: protection first (when preferred), lowest rate, largest capacity, venue order, market id. */
export function compareLegs(a: RouteLeg, b: RouteLeg, preferProtection = true): number {
  if (preferProtection) {
    const pa = a.protection === "none" ? 1 : 0;
    const pb = b.protection === "none" ? 1 : 0;
    if (pa !== pb) return pa - pb;
  }
  if (a.expectedRateWad !== b.expectedRateWad) return a.expectedRateWad < b.expectedRateWad ? -1 : 1;
  if (a.capacity !== b.capacity) return a.capacity > b.capacity ? -1 : 1;
  const va = VENUE_ORDER.indexOf(a.venue);
  const vb = VENUE_ORDER.indexOf(b.venue);
  if (va !== vb) return va - vb;
  return a.marketId < b.marketId ? -1 : a.marketId > b.marketId ? 1 : 0;
}

export function route(req: RouteRequest, candidates: readonly VenueCandidate[]): RoutePlan {
  if (req.amount <= 0n) throw new Error("amount must be positive");
  if (req.collateralAmount < 0n) throw new Error("collateral must be non-negative");
  const legs: RouteLeg[] = [];
  const rejected: Rejected[] = [];
  for (const c of candidates) {
    const r = sizeLeg(req, c);
    if ("leg" in r) legs.push(r.leg);
    else rejected.push(r.rejected);
  }
  legs.sort((a, b) => compareLegs(a, b, req.preferProtection ?? true));
  const chosen = legs[0] ?? null;
  const reasonCodes: string[] = [];
  if (!chosen) reasonCodes.push("NO_ROUTE");
  else {
    reasonCodes.push("ROUTED");
    if (chosen.amount < req.amount) reasonCodes.push("CAPACITY_LIMITED");
    if (chosen.session === "saturday") reasonCodes.push("SATURDAY_MODE");
  }
  const validFor = req.validForSeconds ?? 120;
  return {
    version: 1,
    user: req.user,
    collateral: req.collateral,
    requested: req.amount,
    chosen,
    alternatives: legs.slice(1),
    rejected,
    createdAt: req.now,
    validUntil: req.now + validFor,
    reasonCodes,
  };
}

/** Canonical JSON (sorted keys, bigints as decimal strings) so two signers hash the same plan. */
export function canonicalRoutePlan(plan: RoutePlan): string {
  const sort = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(sort(plan));
}

export const ROUTE_PLAN_TYPES = {
  RoutePlan: [
    { name: "user", type: "address" },
    { name: "collateral", type: "string" },
    { name: "requested", type: "uint256" },
    { name: "venue", type: "string" },
    { name: "marketId", type: "string" },
    { name: "amount", type: "uint256" },
    { name: "ltvWad", type: "uint256" },
    { name: "expectedRateWad", type: "uint256" },
    { name: "protection", type: "string" },
    { name: "createdAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "reasons", type: "string" },
  ],
} as const;

export interface RoutePlanTypedData {
  domain: { name: "Boundline Router"; version: "1"; chainId: number; verifyingContract: string };
  types: typeof ROUTE_PLAN_TYPES;
  primaryType: "RoutePlan";
  message: {
    user: string;
    collateral: string;
    requested: bigint;
    venue: string;
    marketId: string;
    amount: bigint;
    ltvWad: bigint;
    expectedRateWad: bigint;
    protection: string;
    createdAt: bigint;
    validUntil: bigint;
    reasons: string;
  };
}

/** EIP-712 typed data for a routed plan (throws on NO_ROUTE); hash and sign it with viem's `hashTypedData` / `signTypedData`. */
export function routePlanTypedData(plan: RoutePlan, chainId: number, verifyingContract: string): RoutePlanTypedData {
  if (!plan.chosen) throw new Error("no route to sign");
  const c = plan.chosen;
  return {
    domain: { name: "Boundline Router", version: "1", chainId, verifyingContract },
    types: ROUTE_PLAN_TYPES,
    primaryType: "RoutePlan",
    message: {
      user: plan.user,
      collateral: plan.collateral,
      requested: plan.requested,
      venue: c.venue,
      marketId: c.marketId,
      amount: c.amount,
      ltvWad: c.ltvWad,
      expectedRateWad: c.expectedRateWad,
      protection: c.protection,
      createdAt: BigInt(plan.createdAt),
      validUntil: BigInt(plan.validUntil),
      reasons: [...plan.reasonCodes, ...c.notes].join(","),
    },
  };
}
