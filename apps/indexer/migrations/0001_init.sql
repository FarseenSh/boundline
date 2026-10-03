-- Decoded onchain events, one row per log. Numbers that can exceed 2^53 travel as decimal strings inside args_json.
CREATE TABLE IF NOT EXISTS events (
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_time INTEGER NOT NULL,            -- block timestamp, unix seconds
  tx_hash TEXT NOT NULL,                  -- 0x-prefixed, lowercase
  log_index INTEGER NOT NULL,
  address TEXT NOT NULL,                  -- emitter, 0x-prefixed, lowercase
  topic0 TEXT NOT NULL,                   -- event signature hash, lowercase
  name TEXT NOT NULL,                     -- decoded event name, or "unknown:<topic0>"
  args_json TEXT NOT NULL,                -- canonical JSON: sorted keys, bigints as decimal strings, hex lowercased
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS events_chain_address_block ON events (chain_id, address, block_number, log_index);
CREATE INDEX IF NOT EXISTS events_chain_name_block ON events (chain_id, name, block_number, log_index);
CREATE INDEX IF NOT EXISTS events_chain_time ON events (chain_id, block_time);

-- Where each source's scan stands. last_block_time is the timestamp of last_block, used to close UTC days.
CREATE TABLE IF NOT EXISTS cursors (
  chain_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  last_block INTEGER NOT NULL,
  last_block_time INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, source)
);

-- One root per chain per complete UTC day, chained to the previous day's root (see README "Root scheme").
CREATE TABLE IF NOT EXISTS daily_roots (
  chain_id INTEGER NOT NULL,
  day TEXT NOT NULL,                      -- YYYY-MM-DD (UTC)
  first_block INTEGER,                    -- NULL when the day had no events
  last_block INTEGER,
  event_count INTEGER NOT NULL,
  prev_root TEXT NOT NULL,
  root TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, day)
);

-- Replayed-state checks against live reads. One row per subject per run; a run shares checked_at.
CREATE TABLE IF NOT EXISTS reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  subject TEXT NOT NULL,                  -- e.g. "market:0x4a03…", "position:0x4a03…:0xb789…"
  checked_at INTEGER NOT NULL,
  block_number INTEGER NOT NULL,          -- the block the expected and actual states refer to
  expected_json TEXT NOT NULL,
  actual_json TEXT NOT NULL,
  status TEXT NOT NULL                    -- PASS | FAIL | SKIP
);
CREATE INDEX IF NOT EXISTS reconciliations_chain_checked ON reconciliations (chain_id, checked_at);
