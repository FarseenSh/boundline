// The evidence bundle's hash: keccak256 over the UTF-8 of the bundle's JSON with keys sorted recursively, bigints as
// decimal strings and undefined dropped (the same canonical form the quote hash uses), computed over every field
// except `hash` itself (and the per-request `correlationId` the route adds afterwards). Anyone holding the bundle
// can recompute it.
import { keccak256, stringToHex, type Hex } from "viem";
import { canonicalJson } from "./quote-hash.js";

export const EVIDENCE_HASH_SCHEME = "keccak256(utf8(JSON.stringify(bundle without hash and correlationId, keys sorted recursively, bigints as decimal strings)))";

export function evidenceHash(bundle: Record<string, unknown>): Hex {
  const { hash: _hash, correlationId: _cid, ...rest } = bundle;
  return keccak256(stringToHex(canonicalJson(rest)));
}

/** Attaches the scheme and the hash; the hash covers the scheme too. */
export function sealEvidence<T extends Record<string, unknown>>(bundle: T): T & { hashScheme: string; hash: Hex } {
  const withScheme = { ...bundle, hashScheme: EVIDENCE_HASH_SCHEME };
  return { ...withScheme, hash: evidenceHash(withScheme) };
}
