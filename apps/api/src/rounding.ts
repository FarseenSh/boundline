// Money helpers over USDC base units (6 decimals) as bigint. Capacity rounds down, charges round up:
// the API never promises a cent it cannot deliver and never under-collects one.

export const USDC_DECIMALS = 6;
/** One cent in USDC base units. */
export const CENT = 10_000n;

export class NegativeAmount extends Error {
  constructor(value: bigint) {
    super(`negative amount ${value}`);
  }
}

/** Largest whole-cent amount not above `x`. */
export function roundDownToCents(x: bigint): bigint {
  if (x < 0n) throw new NegativeAmount(x);
  return x - (x % CENT);
}

/** Smallest whole-cent amount not below `x`. */
export function roundUpToCents(x: bigint): bigint {
  if (x < 0n) throw new NegativeAmount(x);
  const r = x % CENT;
  return r === 0n ? x : x + (CENT - r);
}

/** "12.345678" for 12_345_678n; always six decimals, no exponent, no locale. */
export function formatUsdc(x: bigint): string {
  if (x < 0n) throw new NegativeAmount(x);
  const s = x.toString().padStart(USDC_DECIMALS + 1, "0");
  return `${s.slice(0, -USDC_DECIMALS)}.${s.slice(-USDC_DECIMALS)}`;
}

/** Parses a non-negative integer amount in base units from a decimal string or a safe integer. Anything else is null. */
export function parseBaseUnits(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === "string" && /^[0-9]{1,40}$/.test(value)) return BigInt(value);
  return null;
}
