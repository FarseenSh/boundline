import { keccak256, stringToHex, type Hex } from "viem";

/** JSON with sorted object keys, bigints as decimal strings and undefined dropped, so the same data always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalize(v);
    }
    return out;
  }
  return value;
}

export interface QuoteHashInput {
  chainId: number;
  desk: string;
  request: unknown;
  /** The chain-derived part of the response only: no timestamps, no correlation id, no hash. */
  response: unknown;
  blockNumber: bigint;
}

/** keccak256 over the canonical JSON of the quote's inputs and outputs at a block. */
export function quoteHash(input: QuoteHashInput): Hex {
  return keccak256(stringToHex(canonicalJson(input)));
}
