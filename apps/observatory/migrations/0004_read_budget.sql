-- Read budget (12 Oct 2026). The account ran out of D1's free 5M rows read per day by 16:00 UTC, and every D1-backed
-- route answered 500 until midnight UTC. `wrangler d1 insights` over the last day:
--   SELECT MAX(taken_at) FROM positions WHERE chain_id = ?    277 runs x 15,214 rows = 4.21M (a full scan per run)
--   lastHeldPrint over snapshots (symbol, feed_updated_at <=)   15 runs x 16,877 rows = 0.25M
-- and the latest-positions views (page, /v1/positions, /v1/venues/aave/positions) GROUP BY the whole history on every
-- call. positions grows by about 14,000 rows a day, snapshots by 14,400, so every one of these got slower each day.
-- With these indexes the newest taken_at is one index entry, the latest views read a two-hour range (stores.ts,
-- LATEST_POSITIONS_WINDOW_SECONDS) and the held print is one entry. Each costs one extra row written per insert.
CREATE INDEX IF NOT EXISTS positions_chain_taken ON positions (chain_id, taken_at);
CREATE INDEX IF NOT EXISTS aave_positions_chain_taken ON aave_positions (chain_id, taken_at);
-- taken_at last so `ORDER BY feed_updated_at DESC, taken_at DESC LIMIT 1` is answered from the index order: a held
-- weekend round repeats on ~2,900 snapshots per symbol, which a (symbol, feed_updated_at) index would still sort.
CREATE INDEX IF NOT EXISTS snapshots_symbol_updated ON snapshots (symbol, feed_updated_at, taken_at);
