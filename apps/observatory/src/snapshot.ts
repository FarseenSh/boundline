// Pure shaping of raw chain reads into the Observatory's public rows. No I/O.
import { FEED, answerToNumber, divergenceBps, feedAgeSeconds, price36ToHuman, sqrtPriceToPrice36, tickToPrice36, twapTick, wadToNumber } from "@boundline/chain";
import { LIVE_SESSIONS, type CalendarPort, type Session, type Transition } from "./calendar-port.js";
import type { ChainReads, PoolRead, TokenRead } from "./reader.js";

/** A feed older than heartbeat + tolerance is stale even inside a session (plan M2: 24h + 2h). */
export const STALE_AFTER_SECONDS = FEED.heartbeatSeconds + 2 * 3600;

const FEATURE_NAMES = ["TRANSFER", "MINT", "BURN", "SEIZE"] as const;

export interface TokenRow {
  symbol: string;
  address: string;
  feed: string;
  feedPrice: number | null;
  feedAnswer: string;
  feedRoundId: string;
  feedUpdatedAt: number;
  feedAgeSeconds: number;
  session: Session;
  feedLive: boolean;
  /** Closed by the calendar, or stale by the heartbeat: a held value, not a price. */
  feedFrozen: boolean;
  registryMultiplier: number;
  registryPaused: boolean;
  transferPaused: boolean;
  pausedFeatures: string[];
  uiMultiplier: number;
  newUIMultiplier: number;
  effectiveAt: number | null;
  /** Scheduled corporate action (Cobalt ERC-8056) when effectiveAt is in the future. */
  scheduledAction: { newUIMultiplier: number; effectiveAt: number; ratio: number } | null;
  pool: string | null;
  dexPrice: number | null;
  dexTwap1h: number | null;
  /** Morpho 36-scale price of the 1h TWAP, for shadow health; null without a pool. */
  dexTwapPrice36: string | null;
  divergenceBps: number | null;
  /** The move the feed will print at the next reopen: divergence while frozen, else null. */
  gapAtReopenBps: number | null;
  readErrors: string[];
}

export interface SessionBlock {
  state: Session;
  isFeedLive: boolean;
  nextTransition: Transition;
  calendarSource: string;
  /** Latest feed print across all tokens; the "frozen since" instant when closed. */
  lastFeedUpdateAt: number;
}

export interface Snapshot {
  version: 1;
  takenAt: number;
  chainId: number;
  block: number;
  blockTimestamp: number;
  session: SessionBlock;
  tokens: TokenRow[];
}

export function shapePool(p: PoolRead): { spot: number; twap: number | null; price36: bigint | null } {
  // Aerodrome B20 pools are USDC (token0) / stock (token1): the stock is token1.
  const spot = price36ToHuman(sqrtPriceToPrice36(p.sqrtPriceX96, true), 8, 6);
  if (!p.tickCumulatives) return { spot, twap: null, price36: null };
  const tick = twapTick(p.tickCumulatives, p.twapWindow);
  const price36 = tickToPrice36(tick, true);
  return { spot, twap: price36ToHuman(price36, 8, 6), price36 };
}

export function shapeToken(t: TokenRead, pool: PoolRead | undefined, calendar: CalendarPort, now: number): TokenRow {
  const session = calendar.sessionAt(now);
  const feedLive = LIVE_SESSIONS.has(session);
  const age = feedAgeSeconds(t.feedUpdatedAt, now);
  const feedPrice = t.feedAnswer > 0n ? answerToNumber(t.feedAnswer, t.feedDecimals) : null;
  const frozen = !feedLive || age > STALE_AFTER_SECONDS;
  const effectiveAt = t.effectiveAt > 0n ? Number(t.effectiveAt) : null;
  const scheduled =
    effectiveAt !== null && effectiveAt > now && t.uiMultiplier > 0n
      ? {
          newUIMultiplier: wadToNumber(t.newUIMultiplier),
          effectiveAt,
          ratio: Number((t.newUIMultiplier * 10n ** 18n) / t.uiMultiplier) / 1e18,
        }
      : null;
  const shaped = pool ? shapePool(pool) : null;
  const twap = shaped?.twap ?? null;
  const divergence = twap !== null && feedPrice !== null ? divergenceBps(twap, feedPrice) : null;
  return {
    symbol: t.symbol,
    address: t.address,
    feed: t.feed,
    feedPrice,
    feedAnswer: t.feedAnswer.toString(),
    feedRoundId: t.feedRoundId.toString(),
    feedUpdatedAt: Number(t.feedUpdatedAt),
    feedAgeSeconds: age,
    session,
    feedLive,
    feedFrozen: frozen,
    registryMultiplier: wadToNumber(t.registryMultiplier),
    registryPaused: t.registryPaused,
    transferPaused: t.transferPaused,
    pausedFeatures: t.pausedFeatures.map((f) => FEATURE_NAMES[f] ?? `FEATURE_${f}`),
    uiMultiplier: wadToNumber(t.uiMultiplier),
    newUIMultiplier: wadToNumber(t.newUIMultiplier),
    effectiveAt,
    scheduledAction: scheduled,
    pool: pool?.pool ?? null,
    dexPrice: shaped?.spot ?? null,
    dexTwap1h: twap,
    dexTwapPrice36: shaped?.price36?.toString() ?? null,
    divergenceBps: divergence,
    gapAtReopenBps: frozen ? divergence : null,
    readErrors: t.errors,
  };
}

export function buildSnapshot(reads: ChainReads, calendar: CalendarPort, now: number): Snapshot {
  const poolBySymbol = new Map(reads.pools.map((p) => [p.symbol, p]));
  const tokens = reads.tokens.map((t) => shapeToken(t, poolBySymbol.get(t.symbol), calendar, now));
  const state = calendar.sessionAt(now);
  return {
    version: 1,
    takenAt: now,
    chainId: reads.chainId,
    block: Number(reads.blockNumber),
    blockTimestamp: reads.blockTimestamp,
    session: {
      state,
      isFeedLive: LIVE_SESSIONS.has(state),
      nextTransition: calendar.nextTransition(now),
      calendarSource: calendar.source,
      lastFeedUpdateAt: tokens.reduce((m, t) => Math.max(m, t.feedUpdatedAt), 0),
    },
    tokens,
  };
}
