-- Real positions on the Aave V4 MAG7 spoke (Base mainnet): borrowers from the indexer's Borrow-event scan,
-- health at the venue's held price and at the 24/7 DEX TWAP, read in rotating batches on the fifth-minute tick.
CREATE TABLE IF NOT EXISTS aave_borrowers (
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,                -- lowercase
  first_seen_block INTEGER NOT NULL,
  last_seen_block INTEGER NOT NULL,
  reserve_ids TEXT NOT NULL,            -- JSON array of the reserve ids borrowed
  source TEXT NOT NULL,                 -- indexer
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, address)
);
CREATE TABLE IF NOT EXISTS aave_scan_state (
  chain_id INTEGER PRIMARY KEY,
  next_offset INTEGER NOT NULL,         -- where the rotating batch resumes
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS aave_positions (
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  debt_usdc TEXT NOT NULL,              -- raw 6-decimal USDC debt on reserve 7
  debt_value_usd REAL NOT NULL,
  collateral_value_usd REAL NOT NULL,   -- at the spoke oracle's prices (held while closed)
  shadow_collateral_value_usd REAL NOT NULL, -- at the 1h DEX TWAP where a pool exists
  shadow_coverage REAL NOT NULL,        -- share of the factor-weighted collateral value with a 24/7 price
  collateral_json TEXT NOT NULL,        -- AaveCollateralLeg[] (per reserve: raw, prices, factor, values)
  venue_hf REAL,                        -- the spoke's healthFactor; NULL without debt
  model_hf REAL,                        -- Σ value × factor / debt value at venue prices (reproduces venue_hf)
  shadow_hf REAL,                       -- the same at the DEX TWAP
  protection_case INTEGER NOT NULL,     -- 1 when shadow_hf < 1.05 with debt
  risk_premium_bps INTEGER NOT NULL,
  avg_collateral_factor REAL NOT NULL,
  PRIMARY KEY (chain_id, address, taken_at)
);
CREATE INDEX IF NOT EXISTS aave_positions_address ON aave_positions (address, taken_at);
