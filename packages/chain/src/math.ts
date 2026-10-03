// Pure helpers shared by the Observatory, the keeper and the SDK. No I/O.

const Q96 = 2n ** 96n;
const Q192 = 2n ** 192n;
export const ORACLE_PRICE_SCALE = 10n ** 36n;

const MIN_TICK = -887272;
const MAX_TICK = 887272;

/**
 * Uniswap v3 TickMath.getSqrtRatioAtTick in bigint: sqrt(1.0001^tick) * 2^96.
 * Port of the audited constants; exact to the on-chain library.
 */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new RangeError(`tick out of range: ${tick}`);
  const absTick = tick < 0 ? -tick : tick;
  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const steps: readonly [number, bigint][] = [
    [0x2, 0xfff97272373d413259a46990580e213an],
    [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, mul] of steps) if ((absTick & bit) !== 0) ratio = (ratio * mul) >> 128n;
  if (tick > 0) ratio = (2n ** 256n - 1n) / ratio;
  // round up when converting from Q128.128 to Q64.96
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/**
 * Morpho `IOracle.price()` scale (1e36, raw loan units per raw collateral unit) from a pool tick.
 * With USDC as token0 and the stock as token1 (the Aerodrome B20 pools), `collateralIsToken1` is true.
 * Decimals need no adjustment: Morpho prices raw units against raw units.
 */
export function tickToPrice36(tick: number, collateralIsToken1: boolean): bigint {
  const sqrt = getSqrtRatioAtTick(tick);
  const ratioQ192 = sqrt * sqrt; // token1 raw per token0 raw, Q192
  return collateralIsToken1 ? (Q192 * ORACLE_PRICE_SCALE) / ratioQ192 : (ratioQ192 * ORACLE_PRICE_SCALE) / Q192;
}

/** Same as tickToPrice36 but from a live sqrtPriceX96. */
export function sqrtPriceToPrice36(sqrtPriceX96: bigint, collateralIsToken1: boolean): bigint {
  const ratioQ192 = sqrtPriceX96 * sqrtPriceX96;
  return collateralIsToken1 ? (Q192 * ORACLE_PRICE_SCALE) / ratioQ192 : (ratioQ192 * ORACLE_PRICE_SCALE) / Q192;
}

/** Human price (loan per whole collateral token) from a Morpho 36-scale price, as a JS number. */
export function price36ToHuman(price36: bigint, collateralDecimals: number, loanDecimals: number): number {
  // price36 = humanPrice * 1e36 * 10^loanDec / 10^collDec
  const scale = 36 + loanDecimals - collateralDecimals;
  return Number(price36) / 10 ** scale;
}

/**
 * Time-weighted average tick from two `observe` cumulatives, Uniswap convention:
 * floor division toward negative infinity. `cumulatives` is [atWindowAgo, now].
 */
export function twapTick(cumulatives: readonly [bigint, bigint] | readonly bigint[], windowSeconds: number): number {
  if (cumulatives.length < 2) throw new RangeError("need two cumulatives");
  if (!Number.isInteger(windowSeconds) || windowSeconds <= 0) throw new RangeError("window must be a positive integer");
  const delta = (cumulatives[cumulatives.length - 1] as bigint) - (cumulatives[0] as bigint);
  const w = BigInt(windowSeconds);
  let tick = delta / w;
  if (delta < 0n && delta % w !== 0n) tick -= 1n;
  return Number(tick);
}

/** Signed divergence of the DEX price from the feed price in basis points. */
export function divergenceBps(dex: number, feed: number): number {
  if (!(feed > 0) || !Number.isFinite(dex)) return Number.NaN;
  return ((dex - feed) / feed) * 10_000;
}

/** Age of a feed round in seconds; never negative. */
export function feedAgeSeconds(updatedAt: bigint | number, nowSeconds: number): number {
  const u = Number(updatedAt);
  return Math.max(0, Math.floor(nowSeconds - u));
}

/** Chainlink 8-decimal answer to a JS number. */
export function answerToNumber(answer: bigint, decimals = 8): number {
  return Number(answer) / 10 ** decimals;
}

/** WAD (1e18) multiplier to a JS number. */
export function wadToNumber(wad: bigint): number {
  return Number(wad) / 1e18;
}
