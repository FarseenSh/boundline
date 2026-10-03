/**
 * Canonical JSON for event arguments, so the same log always hashes the same way:
 * object keys sorted (recursively), bigints as decimal strings, 0x-hex strings lowercased,
 * arrays kept in order. Numbers, booleans and other strings pass through.
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const HEX = /^0x[0-9a-fA-F]*$/;

export function toCanonicalValue(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "string") return HEX.test(value) ? value.toLowerCase() : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toCanonicalValue);
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = toCanonicalValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return String(value);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}
