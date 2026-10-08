// The credit router's plan as the partner API serves it (`POST /v1/route`, `GET /v1/lines/:id/route`): the same field
// names as `@boundline/router`'s RoutePlan, with every bigint as a decimal string. The router decides; the API signs
// the plan as EIP-712 typed data ("Boundline Router" v1) when its route signer is configured. This file holds the wire
// types and the words a widget shows for them.

export type RouteVenue = "morpho" | "aave";
export type RouteProtection = "pre-liquidation" | "vault" | "none";

export interface RouteLegWire {
  venue: RouteVenue;
  chainId: number;
  /** Morpho market id (bytes32 hex) or Aave reserve id (decimal string). */
  marketId: string;
  /** Loan units this leg lends: the request, or the capacity when the request exceeds it. */
  amount: string;
  capacity: string;
  /** LTV after the draw, WAD. */
  ltvWad: string;
  /** The LTV the leg was sized at: min(policy, venue LLTV), WAD. */
  maxLtvWad: string;
  /** Borrow APR as a WAD (1e18 = 100% a year). */
  expectedRateWad: string;
  protection: RouteProtection;
  /** 8-decimal price the leg was valued at. */
  price8: string;
  priceSource: "feed" | "twap-haircut";
  session: "open" | "saturday";
  notes: string[];
}

export interface RouteRejectedWire {
  venue: RouteVenue;
  marketId: string;
  reason: string;
  detail?: string;
}

export interface RoutePlanWire {
  version: 1;
  user: string;
  collateral: string;
  requested: string;
  chosen: RouteLegWire | null;
  alternatives: RouteLegWire[];
  rejected: RouteRejectedWire[];
  createdAt: number;
  validUntil: number;
  /** ROUTED, CAPACITY_LIMITED, SATURDAY_MODE, NO_ROUTE. */
  reasonCodes: string[];
}

export interface RouteRequestBody {
  chainId: 84532 | 8453;
  borrower?: string;
  /** Token units as decimal strings ("0.02" AAPLt), by symbol. */
  collateral: { symbol: string; amount: string }[];
  /** USDC to draw as a decimal string ("3.00"); the partner API plans for its capacity when omitted. */
  amountUsdc?: string;
  preferProtection?: boolean;
  /** Ask for Saturday mode; the partner's policy decides whether it applies. */
  saturdayMode?: boolean;
  /** Store the plan on this line's obligation record. */
  lineId?: string;
}

export interface RouteResponse {
  plan: RoutePlanWire;
  planHash: string;
  /** null when there is no route (nothing to sign). */
  typedData: unknown;
  /** EIP-712 signature by the API's route signer; null while no signer is configured. */
  signature: string | null;
  signer: string | null;
  note?: string;
  /** The desk's policy version the plan was made under, when known. */
  policyVersion?: number;
  correlationId?: string;
  chainId?: number;
  /** The EIP-712 digest the signature covers. */
  digest?: string | null;
  planHashScheme?: string;
  /** The partner's Saturday-mode policy and whether it changed this plan. */
  saturdayMode?: { enabled: boolean; capacityFraction: number; haircutBps: number; applied: boolean };
  /** "capacity" when no amount was asked for. */
  mode?: "capacity" | "amount";
  lineId?: string | null;
  /** True when the plan was stored on the line's obligation record. */
  stored?: boolean;
  blockNumber?: string | null;
  candidates?: number;
  /** What the API wants the caller to know about this plan (ignored fields, Saturday mode, failed reads). */
  notes?: string[];
  /** The API's own statement of what the plan is worth: the desk's quote at draw time decides. */
  authoritative?: string;
  metered?: boolean;
  createdAt?: number;
}

const WAD = 10n ** 18n;

/** "5.53" for 0.0553e18: the APR in percent with two decimals, rounded down. */
export function formatRateWad(rateWad: string | bigint): string {
  const r = BigInt(rateWad);
  if (r < 0n) return "—";
  const bps100 = (r * 10_000n) / WAD; // percent × 100
  return `${bps100 / 100n}.${(bps100 % 100n).toString().padStart(2, "0")}`;
}

/** "47.6" for 0.476e18: a WAD ratio in percent with one decimal, rounded down. */
export function formatWadPercent(wad: string | bigint): string {
  const x = BigInt(wad);
  const tenths = (x * 1000n) / WAD;
  return `${tenths / 10n}.${tenths % 10n}`;
}

/** What each of the router's rejection reasons means, for a borrower or a partner reading the plan. */
export const ROUTE_REJECT_COPY: Readonly<Record<string, string>> = Object.freeze({
  TICKER_NOT_ALLOWED: "The partner's policy does not allow this stock.",
  MARKET_CLOSED: "Wall Street is closed and this market never prices a held feed.",
  FEED_PAUSED: "Coinbase's OracleRegistry has paused this stock's price.",
  TRANSFER_PAUSED: "The issuer has paused transfers of this stock.",
  FEED_INVALID: "The feed answered an invalid price.",
  FEED_STALE: "The feed is older than its heartbeat allows.",
  UNKNOWN_STATE: "The session gate could not decide, so the market fails closed.",
  NO_PRICE: "No usable price for this market right now.",
  COLLATERAL_MISMATCH: "This market takes a different collateral.",
  INSUFFICIENT_LIQUIDITY: "The market has no USDC left to lend.",
  INSUFFICIENT_CAPACITY: "The collateral supports no borrowing at this LTV.",
  BELOW_MIN_DRAW: "What could be lent here is below the minimum draw.",
  PARTNER_CAP: "The partner's exposure cap is used up.",
});

export const PROTECTION_COPY: Readonly<Record<RouteProtection, string>> = Object.freeze({
  "pre-liquidation": "Protected: a partial pre-liquidation at the 24/7 DEX price runs at any hour before the venue could liquidate.",
  vault: "Protected: the protection vault repays at any hour from your reserve, then a bounded Reserve advance.",
  none: "No Boundline protection on this market yet.",
});

/** The leg's notes in words (CAPACITY_LIMITED, LIQUIDITY_LIMITED, PARTNER_CAP_LIMITED, SATURDAY_HALF_CAPACITY, PROTECTED). */
export const ROUTE_NOTE_COPY: Readonly<Record<string, string>> = Object.freeze({
  CAPACITY_LIMITED: "sized down to the capacity",
  LIQUIDITY_LIMITED: "capped by the market's liquidity",
  PARTNER_CAP_LIMITED: "capped by the partner's exposure headroom",
  SATURDAY_HALF_CAPACITY: "Saturday mode: half capacity at the lower of the held feed and the TWAP, less the haircut",
  PROTECTED: "protected market",
});

export function venueName(v: RouteVenue | string): string {
  return v === "morpho" ? "Morpho" : v === "aave" ? "Aave V4" : v;
}
