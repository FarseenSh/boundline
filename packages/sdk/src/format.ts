// Money and share formatting over base units as bigint. Capacity rounds down, charges round up.
export const USDC_DECIMALS = 6;
export const CENT = 10_000n;

export function roundDownToCents(x: bigint): bigint {
  if (x < 0n) throw new Error(`negative amount ${x}`);
  return x - (x % CENT);
}

export function roundUpToCents(x: bigint): bigint {
  if (x < 0n) throw new Error(`negative amount ${x}`);
  const r = x % CENT;
  return r === 0n ? x : x + (CENT - r);
}

/** "12.345678" for 12_345_678n (six decimals, no locale, no exponent). */
export function formatUnits(x: bigint, decimals: number): string {
  const neg = x < 0n;
  const s = (neg ? -x : x).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals === 0 ? "" : `.${s.slice(s.length - decimals)}`;
  return `${neg ? "-" : ""}${whole}${frac}`;
}

/** "$1,663.35" style, from USDC base units; rounds down to the cent so no cent is promised twice. */
export function formatUsd(x: bigint, opts: { cents?: boolean } = {}): string {
  const cents = opts.cents ?? true;
  const v = roundDownToCents(x);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n) / CENT;
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return cents ? `$${w}.${frac.toString().padStart(2, "0")}` : `$${w}`;
}

/** 8-decimal share counts: "10.0000" shares. */
export function formatShares(x: bigint, decimals = 8, places = 4): string {
  const s = formatUnits(x, decimals);
  const [w = "0", f = ""] = s.split(".");
  return places === 0 ? w : `${w}.${f.padEnd(places, "0").slice(0, places)}`;
}

/** Parses "12.5" or "12" into base units; null for anything that is not a non-negative decimal. */
export function parseUnits(text: string, decimals: number): bigint | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(t)) return null;
  const [w = "0", f = ""] = t.split(".");
  if (f.length > decimals) return null;
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export const parseUsdc = (text: string): bigint | null => parseUnits(text, USDC_DECIMALS);

/** 1e8 price to a number of dollars. */
export function price8ToNumber(price8: bigint): number {
  return Number(price8) / 1e8;
}

export function wadToNumber(wad: bigint): number {
  return Number(wad) / 1e18;
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function shortHash(h: string): string {
  return h.length > 16 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;
}
