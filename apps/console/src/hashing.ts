// The evidence bundle's hash, recomputed in the browser so a judge can check the API's number without
// trusting it. The API's scheme (its `hashScheme` field): keccak256 of the UTF-8 of the bundle without `hash`
// and without the per-request `correlationId`, keys sorted recursively, no whitespace, bigints as decimal strings.
import { keccak256, stringToBytes, type Hex } from "viem";

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashOf(value: unknown): Hex {
  return keccak256(stringToBytes(canonicalJson(value)));
}

/** Fields the API leaves out of the hash: the hash itself and the per-request correlation id. */
export const UNHASHED_FIELDS: readonly string[] = ["hash", "correlationId"];

/** The bundle's hash as the API defines it. */
export function rehashBundle(bundle: Record<string, unknown>): Hex {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bundle)) if (!UNHASHED_FIELDS.includes(k)) rest[k] = v;
  return hashOf(rest);
}

export interface BundleCounts {
  lines: number;
  obligations: number;
  decisions: number;
  roots: number;
  drills: number;
  bytes: number;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function get(v: unknown, key: string): unknown {
  return v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
}

/** Counts for the Evidence page. `decisions` is per line (`{ lineId, decisions: [...] }`), roots sit under `reconciliation.roots.roots`. */
export function bundleCounts(bundle: Record<string, unknown>): BundleCounts {
  // `obligations` arrives either as the array itself or as the API's envelope `{ source, count, rows: [...] }`.
  const envelope = bundle.obligations;
  const obligations = Array.isArray(envelope) ? envelope : arr(get(envelope, "rows")).length > 0 ? arr(get(envelope, "rows")) : arr(get(envelope, "obligations"));
  const perLine = arr(bundle.decisions);
  const lineIds = new Set<string>();
  for (const o of obligations) if (typeof get(o, "lineId") === "string") lineIds.add(get(o, "lineId") as string);
  for (const d of perLine) if (typeof get(d, "lineId") === "string") lineIds.add(get(d, "lineId") as string);
  const flat = perLine.length > 0 && perLine.every((d) => get(d, "action") !== undefined);
  const decisions = flat ? perLine.length : perLine.reduce<number>((n, d) => n + arr(get(d, "decisions")).length, 0);
  const roots = arr(get(get(bundle.reconciliation, "roots"), "roots")).length || arr(get(bundle.roots, "roots")).length || arr(bundle.roots).length;
  return {
    lines: lineIds.size || arr(bundle.lines).length,
    obligations: obligations.length,
    decisions,
    roots,
    drills: arr(bundle.drills).length,
    bytes: new TextEncoder().encode(JSON.stringify(bundle)).length,
  };
}
