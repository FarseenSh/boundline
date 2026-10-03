-- One row per token per snapshot. Numbers that exceed 2^53 are stored as text.
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at INTEGER NOT NULL,            -- unix seconds the snapshot was taken
  block INTEGER NOT NULL,
  block_timestamp INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  token TEXT NOT NULL,
  feed_answer TEXT NOT NULL,            -- raw 8-decimal answer
  feed_price REAL,                      -- answer / 1e8
  feed_round_id TEXT NOT NULL,
  feed_updated_at INTEGER NOT NULL,
  feed_age_seconds INTEGER NOT NULL,
  session TEXT NOT NULL,                -- calendar session at taken_at
  feed_live INTEGER NOT NULL,           -- 1 when the calendar says the feed publishes
  feed_frozen INTEGER NOT NULL,         -- 1 when closed or stale
  registry_multiplier TEXT NOT NULL,    -- 1e18 scale
  registry_paused INTEGER NOT NULL,
  transfer_paused INTEGER NOT NULL,
  paused_features TEXT NOT NULL,        -- JSON array of feature names
  ui_multiplier TEXT NOT NULL,
  new_ui_multiplier TEXT NOT NULL,
  effective_at INTEGER,                 -- NULL when no scheduled corporate action
  dex_price REAL,                       -- spot from slot0, NULL when no pool
  dex_twap_1h REAL,                     -- 1h TWAP from observe, NULL when no pool or no history
  divergence_bps REAL,                  -- (twap - feed) / feed * 1e4
  gap_at_reopen_bps REAL                -- divergence while the feed is frozen, else NULL
);
CREATE INDEX IF NOT EXISTS snapshots_symbol_taken_at ON snapshots (symbol, taken_at);
CREATE INDEX IF NOT EXISTS snapshots_taken_at ON snapshots (taken_at);
