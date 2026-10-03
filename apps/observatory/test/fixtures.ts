import type { CalendarPort, Session } from "../src/calendar-port.js";
import type { ChainReads, PoolRead, TokenRead } from "../src/reader.js";

/** Live values captured from Base mainnet on Sat 3 Oct 2026 10:48 UTC (block 52117568). */
export const NOW = 1791024483;
export const AAPLC = "0xb200000000000000000000C2e324d24d7eEcd1fb";
export const AAPLC_FEED = "0x787f13dEa48Db0897CbCDD985de77809D837F988";
export const POOL = "0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0";

export function token(overrides: Partial<TokenRead> = {}): TokenRead {
  return {
    symbol: "AAPLc",
    address: AAPLC,
    feed: AAPLC_FEED,
    feedAnswer: 33366495000n,
    feedUpdatedAt: 1790959199n,
    feedRoundId: 36893488147419103512n,
    feedDecimals: 8,
    registryMultiplier: 10n ** 18n,
    registryPaused: false,
    transferPaused: false,
    pausedFeatures: [],
    uiMultiplier: 10n ** 18n,
    newUIMultiplier: 10n ** 18n,
    effectiveAt: 0n,
    errors: [],
    ...overrides,
  };
}

export function pool(overrides: Partial<PoolRead> = {}): PoolRead {
  return {
    symbol: "AAPLc",
    pool: POOL,
    sqrtPriceX96: 43382422884745101848021795540n,
    tick: -12047,
    liquidity: 476209392808947n,
    tickCumulatives: [-99140738406n, -99184115416n],
    twapWindow: 3600,
    ...overrides,
  };
}

export function reads(tokens: TokenRead[], pools: PoolRead[]): ChainReads {
  return { chainId: 8453, blockNumber: 52117568n, blockTimestamp: NOW, tokens, pools };
}

export function calendar(state: Session, nextAt: number | null = 1791158400): CalendarPort {
  const live = state === "PRE" || state === "REGULAR" || state === "POST" || state === "OVERNIGHT";
  return {
    sessionAt: () => state,
    isFeedLive: () => live,
    nextTransition: () => ({ to: live ? "WEEKEND" : "OVERNIGHT", at: nextAt }),
    source: "test calendar",
  };
}
