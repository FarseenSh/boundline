import { sha256Hex } from "./auth.js";
import type { Hex } from "viem";
import type { Store } from "./db.js";

/** Replays are honoured for a day; an older row is ignored and the request runs again. */
export const IDEMPOTENCY_TTL_SECONDS = 86_400;

export interface IdempotentResult {
  status: number;
  body: unknown;
  /** True when the stored response was returned instead of running the handler. */
  replayed: boolean;
  /** True when the key was seen with a different request: the caller answers 422. */
  conflict: boolean;
}

/** The hash that ties an Idempotency-Key to one exact request. */
export function requestHash(method: string, path: string, rawBody: string): Promise<string> {
  return sha256Hex(`${method.toUpperCase()}\n${path}\n${rawBody}`);
}

/**
 * Runs `handler` once per (partner, key, request): the same key with the same request replays the stored
 * status and body; the same key with a different request is a conflict; keys older than the TTL expire.
 */
export async function runIdempotent(
  store: Store,
  partnerId: Hex,
  key: string,
  reqHash: string,
  now: number,
  handler: () => Promise<{ status: number; body: unknown }>,
): Promise<IdempotentResult> {
  const prior = await store.getIdempotent(partnerId, key);
  if (prior && now - prior.createdAt <= IDEMPOTENCY_TTL_SECONDS) {
    if (prior.requestHash !== reqHash) return { status: 422, body: null, replayed: false, conflict: true };
    return { status: prior.status, body: JSON.parse(prior.responseJson) as unknown, replayed: true, conflict: false };
  }
  const result = await handler();
  await store.putIdempotent({
    key,
    partnerId,
    requestHash: reqHash,
    status: result.status,
    responseJson: JSON.stringify(result.body),
    createdAt: now,
  });
  return { ...result, replayed: false, conflict: false };
}
