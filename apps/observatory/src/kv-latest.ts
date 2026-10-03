// The KV write budget is the scarce resource on the Workers Free plan: 1,000 writes a day against a cron that
// fires 1,440 times a day. The latest snapshot is rewritten only when something a reader must see at once has
// changed, or when the stored copy is older than LATEST_REFRESH_SECONDS. D1 still receives every snapshot.
import type { Snapshot } from "./snapshot.js";

export const KV_LATEST = "latest";
/** Rewrite the cached snapshot at least this often even when nothing material changed (block, age and DEX drift). */
export const LATEST_REFRESH_SECONDS = 600;

export interface LatestMeta {
  /** `takenAt` of the snapshot that was written. */
  writtenAt: number;
}

export type WriteDecision =
  | { write: true; reason: "first" | "changed" | "refresh" }
  | { write: false; reason: "unchanged"; ageSeconds: number };

/**
 * What must reach readers immediately: the session, each token's feed print, frozen flag, registry and issuer
 * pauses, multipliers and scheduled corporate actions, and whether reads failed. Block number, feed age, time
 * and the DEX price drift every minute and wait for the periodic refresh. Venue health is not in the snapshot
 * yet (indexer work); add it here when it lands.
 */
export function fingerprint(s: Snapshot): string {
  return JSON.stringify([
    s.chainId,
    s.session.state,
    s.session.isFeedLive,
    s.session.nextTransition.at,
    s.tokens.map((t) => [
      t.symbol,
      t.address,
      t.feedAnswer,
      t.feedUpdatedAt,
      t.feedFrozen,
      t.registryPaused,
      t.transferPaused,
      t.pausedFeatures,
      t.registryMultiplier,
      t.uiMultiplier,
      t.newUIMultiplier,
      t.effectiveAt,
      t.readErrors.length,
    ]),
  ]);
}

export function decideLatestWrite(
  prev: Snapshot | null,
  prevMeta: LatestMeta | null,
  next: Snapshot,
  refreshSeconds: number = LATEST_REFRESH_SECONDS,
): WriteDecision {
  if (!prev || !prevMeta) return { write: true, reason: "first" };
  if (fingerprint(prev) !== fingerprint(next)) return { write: true, reason: "changed" };
  const ageSeconds = next.takenAt - prevMeta.writtenAt;
  if (ageSeconds < 0 || ageSeconds >= refreshSeconds) return { write: true, reason: "refresh" };
  return { write: false, reason: "unchanged", ageSeconds };
}

/** Reads the stored copy, decides, and writes `latest` with `{ writtenAt }` metadata when the decision says so. */
export async function storeLatest(kv: KVNamespace, snapshot: Snapshot): Promise<WriteDecision> {
  const stored = await kv.getWithMetadata<Snapshot, LatestMeta>(KV_LATEST, "json");
  const decision = decideLatestWrite(stored.value, stored.metadata, snapshot);
  if (decision.write) {
    await kv.put(KV_LATEST, JSON.stringify(snapshot), { metadata: { writtenAt: snapshot.takenAt } satisfies LatestMeta });
  }
  return decision;
}
