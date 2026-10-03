-- Partner API records. Keys are never stored: only the SHA-256 hex of the bearer token.
CREATE TABLE IF NOT EXISTS partners (
  partner_id TEXT PRIMARY KEY,          -- bytes32 hex, lowercase, the id the CreditDesk uses
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,    -- sha256 hex of the bearer key
  policy_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL           -- unix seconds
);

-- One row per (partner, Idempotency-Key): the stored status and body are replayed for the same request hash
-- within 24 hours; a different request hash with the same key is refused with 422.
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (partner_id, key)
);
CREATE INDEX IF NOT EXISTS idempotency_created ON idempotency (created_at);

-- Every quote the API produced, keyed by its hash (keccak256 of the canonical inputs and outputs at a block).
CREATE TABLE IF NOT EXISTS quotes (
  quote_hash TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS quotes_partner ON quotes (partner_id, created_at);

-- Lines this API has quoted or looked up; the desk has no enumeration, so /v1/obligations lists these.
CREATE TABLE IF NOT EXISTS lines (
  line_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  user TEXT NOT NULL,
  market_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lines_partner ON lines (partner_id, first_seen);
