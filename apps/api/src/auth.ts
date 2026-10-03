import type { PartnerRecord, Store } from "./db.js";

/** Hex SHA-256 of a UTF-8 string (Web Crypto, available in Workers and Node 20+). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The token from `Authorization: Bearer <token>`, or null when the header is missing or malformed. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? (m[1] as string) : null;
}

/** Resolves the partner for an Authorization header: only the SHA-256 of the key is ever stored or compared. */
export async function authenticate(store: Store, header: string | undefined): Promise<PartnerRecord | null> {
  const token = bearerToken(header);
  if (!token) return null;
  return store.findPartnerByKeyHash(await sha256Hex(token));
}

/** A fresh 32-byte partner key as hex, shown once. */
export function newPartnerKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `bl_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
