import type { Snapshot } from "./snapshot.js";

const INSERT = `INSERT INTO snapshots (taken_at, block, block_timestamp, symbol, token, feed_answer, feed_price, feed_round_id,
  feed_updated_at, feed_age_seconds, session, feed_live, feed_frozen, registry_multiplier, registry_paused, transfer_paused,
  paused_features, ui_multiplier, new_ui_multiplier, effective_at, dex_price, dex_twap_1h, divergence_bps, gap_at_reopen_bps)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)`;

/** Append one row per token. Batched so a snapshot is all-or-nothing. */
export async function appendSnapshot(db: D1Database, s: Snapshot): Promise<number> {
  const stmt = db.prepare(INSERT);
  const batch = s.tokens.map((t) =>
    stmt.bind(
      s.takenAt, s.block, s.blockTimestamp, t.symbol, t.address, t.feedAnswer, t.feedPrice, t.feedRoundId,
      t.feedUpdatedAt, t.feedAgeSeconds, t.session, t.feedLive ? 1 : 0, t.feedFrozen ? 1 : 0, String(Math.round(t.registryMultiplier * 1e18)),
      t.registryPaused ? 1 : 0, t.transferPaused ? 1 : 0, JSON.stringify(t.pausedFeatures), String(Math.round(t.uiMultiplier * 1e18)),
      String(Math.round(t.newUIMultiplier * 1e18)), t.effectiveAt, t.dexPrice, t.dexTwap1h, t.divergenceBps, t.gapAtReopenBps,
    ),
  );
  if (batch.length === 0) return 0;
  await db.batch(batch);
  return batch.length;
}
