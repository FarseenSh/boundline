// Builds the router's venue candidates from the live services: the Observatory's token snapshot (feed, session,
// pauses, TWAP) and Morpho market list (mainnet), the three Boundline session-safe markets on Base Sepolia, and
// the IRM's live borrow rate read in one multicall per chain.
import type { GateState, VenueCandidate } from "@boundline/router";
import { decodeMarket, decodeMarketParams, decodeUint, encodeBorrowRateView, encodeIdToMarketParams, encodeMarket, MORPHO, multicall, type Call3, type Hex } from "./raw.js";

export const SECONDS_PER_YEAR = 31_536_000n;
const STOCK_DECIMALS = 8;
const USDC_DECIMALS = 6;
/** The SessionGate's defaults: heartbeat 24 h plus a 2 h tolerance. */
const STALE_AFTER_SECONDS = 26 * 3600;

export interface ObservatoryToken {
  symbol: string;
  feedAnswer: string;
  feedUpdatedAt: number;
  feedAgeSeconds: number;
  session: string;
  feedLive: boolean;
  registryPaused: boolean;
  transferPaused: boolean;
  dexTwapPrice36: string | null;
}

export interface ObservatoryMarket {
  id: string;
  collateral: { address: string; symbol: string };
  lltv: number;
  totalSupplyAssets: string;
  totalBorrowAssets: string;
}

/** Boundline's own markets on Base Sepolia (deployments/base-sepolia.json), with their mainnet price source. */
export const SEPOLIA_MARKETS: readonly { id: string; collateral: string; source: string; protection: VenueCandidate["protection"] }[] = [
  { id: "0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047", collateral: "AAPLt", source: "AAPLc", protection: "pre-liquidation" },
  { id: "0x7cb7fcc828a7296f8ea18256e0f5763a5588cfe22df9c943088021c762e58cc9", collateral: "NVDAt", source: "NVDAc", protection: "none" },
  { id: "0xb0e8d25d1c9b822cc718c89666b887698922a7b49fdb00dbdecd70dd4ed9e2f1", collateral: "TSLAt", source: "TSLAc", protection: "none" },
];

/** The SessionGate's precedence over the Observatory's flags: MARKET_CLOSED > FEED_PAUSED > TRANSFER_PAUSED > FEED_INVALID > FEED_STALE > OPEN. */
export function gateOf(t: ObservatoryToken): GateState {
  if (!t.feedLive) return "MARKET_CLOSED";
  if (t.registryPaused) return "FEED_PAUSED";
  if (t.transferPaused) return "TRANSFER_PAUSED";
  const answer = BigInt(t.feedAnswer || "0");
  if (answer <= 0n) return "FEED_INVALID";
  if (t.feedAgeSeconds > STALE_AFTER_SECONDS) return "FEED_STALE";
  return "OPEN";
}

/** price36 (loan per collateral, 36 decimals as Morpho scales it for 8-dec stock / 6-dec USDC) → 8-decimal price. */
export function price36To8(price36: string | null): bigint | null {
  if (!price36) return null;
  const p = BigInt(price36);
  // SCALE = 10^(36 + 6 - 8 - 8) = 1e26 → price8 = price36 / 1e26 * 1e8 ... i.e. price36 / 1e18 gives USD with 8 decimals? no:
  // price36 = price (USD per share) × 10^(36 + loanDec − collDec) = price × 1e34; price8 = price × 1e8 = price36 / 1e26.
  return p / 10n ** 26n;
}

export function lltvWadOf(lltv: number): bigint {
  return BigInt(Math.round(lltv * 1e6)) * 10n ** 12n;
}

export function aprWad(perSecondRateWad: bigint): bigint {
  return perSecondRateWad * SECONDS_PER_YEAR;
}

export interface RateRead {
  id: string;
  borrowRateWad: bigint;
  availableLiquidity: bigint;
  lltvWad: bigint;
  collateralToken: string;
  error?: string;
}

/** market + idToMarketParams for every id in one multicall, then borrowRateView for every market in a second one. */
export async function readRates(rpcs: readonly string[], ids: readonly string[], fetchImpl: typeof fetch = fetch): Promise<RateRead[]> {
  if (ids.length === 0) return [];
  const first: Call3[] = ids.flatMap((id) => [
    { target: MORPHO, allowFailure: true, callData: encodeMarket(id) },
    { target: MORPHO, allowFailure: true, callData: encodeIdToMarketParams(id) },
  ]);
  const r1 = await multicall(rpcs, first, fetchImpl);
  const parsed = ids.map((id, i) => {
    const m = r1[2 * i];
    const p = r1[2 * i + 1];
    if (!m?.success || !p?.success) return { id, error: "market read failed" as const };
    try {
      return { id, market: decodeMarket(m.returnData), params: decodeMarketParams(p.returnData) };
    } catch (err) {
      return { id, error: err instanceof Error ? err.message : String(err) };
    }
  });
  const live = parsed.filter((x): x is { id: string; market: ReturnType<typeof decodeMarket>; params: ReturnType<typeof decodeMarketParams> } => "market" in x);
  const second: Call3[] = live.map((x) => ({ target: x.params.irm, allowFailure: true, callData: encodeBorrowRateView(x.params, x.market) }));
  const r2 = second.length ? await multicall(rpcs, second, fetchImpl) : [];
  const rateById = new Map<string, bigint | string>();
  live.forEach((x, i) => {
    const r = r2[i];
    if (!r?.success) rateById.set(x.id, "rate read failed");
    else {
      try {
        rateById.set(x.id, aprWad(decodeUint(r.returnData)));
      } catch (err) {
        rateById.set(x.id, err instanceof Error ? err.message : String(err));
      }
    }
  });
  return parsed.map((x) => {
    if ("error" in x) return { id: x.id, borrowRateWad: 0n, availableLiquidity: 0n, lltvWad: 0n, collateralToken: "", error: x.error };
    const rate = rateById.get(x.id);
    const liquidity = x.market.totalSupplyAssets > x.market.totalBorrowAssets ? x.market.totalSupplyAssets - x.market.totalBorrowAssets : 0n;
    const base = { id: x.id, availableLiquidity: liquidity, lltvWad: x.params.lltv, collateralToken: x.params.collateralToken };
    return typeof rate === "bigint" ? { ...base, borrowRateWad: rate } : { ...base, borrowRateWad: 0n, error: typeof rate === "string" ? rate : "rate missing" };
  });
}

export interface CandidateInputs {
  tokens: readonly ObservatoryToken[];
  mainnetMarkets: readonly ObservatoryMarket[];
  mainnetRates: readonly RateRead[];
  sepoliaRates: readonly RateRead[];
}

/** Every candidate for one collateral symbol (mainnet `AAPLc` or Sepolia `AAPLt`); unknown rates fail closed (rate 0, flagged). */
export function buildCandidates(collateral: string, inputs: CandidateInputs): { candidates: VenueCandidate[]; notes: string[] } {
  const notes: string[] = [];
  const candidates: VenueCandidate[] = [];
  const tokenBySymbol = new Map(inputs.tokens.map((t) => [t.symbol, t]));
  const rateById = new Map([...inputs.mainnetRates, ...inputs.sepoliaRates].map((r) => [r.id.toLowerCase(), r]));
  const sourceSymbol = collateral.endsWith("t") ? `${collateral.slice(0, -1)}c` : collateral;
  const token = tokenBySymbol.get(sourceSymbol);
  if (!token) {
    notes.push(`no Observatory snapshot for ${sourceSymbol}`);
    return { candidates, notes };
  }
  const gate = gateOf(token);
  const feedPrice8 = BigInt(token.feedAnswer || "0");
  const twapPrice8 = price36To8(token.dexTwapPrice36);
  const common = { collateralDecimals: STOCK_DECIMALS, loanDecimals: USDC_DECIMALS, gate, feedPrice8: feedPrice8 > 0n ? feedPrice8 : null, twapPrice8, pricesAroundTheClock: false } as const;

  if (collateral === sourceSymbol) {
    for (const m of inputs.mainnetMarkets) {
      if (m.collateral.symbol !== collateral) continue;
      const r = rateById.get(m.id.toLowerCase());
      if (!r || r.error) notes.push(`${m.id.slice(0, 10)}: ${r?.error ?? "no rate read"} (rate 0, Observatory liquidity and LLTV used)`);
      const good = r && !r.error ? r : null;
      candidates.push({
        venue: "morpho",
        chainId: 8453,
        marketId: m.id,
        collateral,
        borrowRateWad: good?.borrowRateWad ?? 0n,
        lltvWad: good?.lltvWad ?? lltvWadOf(m.lltv),
        availableLiquidity: good?.availableLiquidity ?? BigInt(m.totalSupplyAssets) - BigInt(m.totalBorrowAssets),
        // No Boundline pre-liquidation exists on mainnet yet; these markets price at the held feed and liquidate at any hour.
        protection: "none",
        ...common,
        pricesAroundTheClock: true,
      });
    }
  } else {
    for (const s of SEPOLIA_MARKETS) {
      if (s.collateral !== collateral) continue;
      const r = rateById.get(s.id.toLowerCase());
      if (!r || r.error) notes.push(`${s.id.slice(0, 10)}: ${r?.error ?? "no rate read"} (rate 0, liquidity unknown → 0)`);
      const good = r && !r.error ? r : null;
      candidates.push({
        venue: "morpho",
        chainId: 84532,
        marketId: s.id,
        collateral,
        borrowRateWad: good?.borrowRateWad ?? 0n,
        lltvWad: good?.lltvWad ?? 625_000_000_000_000_000n,
        availableLiquidity: good?.availableLiquidity ?? 0n,
        protection: s.protection,
        ...common,
      });
    }
    notes.push("Sepolia prices are the mainnet feed mirrored by the keeper; the TWAP shown is mainnet's (the Sepolia pool is a fixed-price mock)");
  }
  return { candidates, notes };
}
