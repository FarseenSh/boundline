-- Reopen captures: every tick inside the window around a feed liveness transition, one row per token.
CREATE TABLE IF NOT EXISTS capture_runs (
  transition_at INTEGER PRIMARY KEY,    -- unix seconds of the session boundary where feed liveness flips
  from_session TEXT NOT NULL,
  to_session TEXT NOT NULL,
  kind TEXT NOT NULL,                   -- reopen (held -> live) or close (live -> held)
  armed_at INTEGER NOT NULL,            -- first tick inside the window
  first_update_at INTEGER,              -- earliest post-transition feed print across tokens (feed updatedAt)
  completed_at INTEGER,                 -- set 90 minutes after the transition
  summary_json TEXT NOT NULL            -- CaptureSummary: per token held print, first post-transition print, lag, gap
);
CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transition_at INTEGER NOT NULL,
  from_session TEXT NOT NULL,
  to_session TEXT NOT NULL,
  token_symbol TEXT NOT NULL,
  phase TEXT NOT NULL,                  -- before | at | after
  taken_at INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  feed_round_id TEXT NOT NULL,
  feed_answer TEXT NOT NULL,            -- raw 8-decimal answer
  feed_updated_at INTEGER NOT NULL,
  dex_price REAL,                       -- Aerodrome spot, NULL without a pool
  twap_price REAL,                      -- 1h TWAP, NULL without a pool
  note TEXT
);
CREATE INDEX IF NOT EXISTS captures_run ON captures (transition_at, token_symbol, taken_at);

-- Real positions on the B20 Morpho markets: borrowers discovered from Borrow events (plus Morpho's API as the seed),
-- health at the venue's held price and at the 24/7 DEX TWAP.
CREATE TABLE IF NOT EXISTS borrowers (
  chain_id INTEGER NOT NULL,
  market_id TEXT NOT NULL,
  address TEXT NOT NULL,
  first_seen_block INTEGER NOT NULL,
  source TEXT NOT NULL,                 -- logs | api
  PRIMARY KEY (chain_id, market_id, address)
);
CREATE TABLE IF NOT EXISTS scan_cursors (
  chain_id INTEGER NOT NULL,
  market_id TEXT NOT NULL,
  last_block INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, market_id)
);
CREATE TABLE IF NOT EXISTS positions (
  chain_id INTEGER NOT NULL,
  market_id TEXT NOT NULL,
  address TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  collateral_symbol TEXT NOT NULL,
  lltv REAL NOT NULL,
  collateral TEXT NOT NULL,             -- raw 8-decimal collateral units
  borrow_shares TEXT NOT NULL,
  debt_assets TEXT NOT NULL,            -- raw USDC units, shares converted up like Morpho does
  venue_price REAL,                     -- USD per share as the venue's oracle answers (held while closed)
  shadow_price REAL,                    -- USD per share from the 1h DEX TWAP, NULL without a pool
  venue_hf REAL,                        -- NULL when no debt
  shadow_hf REAL,                       -- NULL when no debt or no pool
  protection_case INTEGER NOT NULL,     -- 1 when shadow_hf < 1 while venue_hf >= 1
  PRIMARY KEY (chain_id, market_id, address, taken_at)
);
CREATE INDEX IF NOT EXISTS positions_address ON positions (address, taken_at);
