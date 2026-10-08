-- 8 Oct 2026: route plans, the partner's off-chain routing policy (Saturday mode) and webhooks.

-- Every route plan the API produced (POST /v1/route), keyed by its hash: keccak256 of the canonical plan JSON. A plan
-- made for a line (`lineId` in the request, partner callers only) is what GET /v1/lines/:id/route returns (latest first).
CREATE TABLE IF NOT EXISTS route_plans (
  plan_hash TEXT PRIMARY KEY,
  partner_id TEXT,                       -- null for an x402-metered (keyless) caller
  line_id TEXT,                          -- null unless the request named a line of this partner
  chain_id INTEGER NOT NULL,
  plan_json TEXT NOT NULL,               -- canonical RoutePlan JSON (bigints as decimal strings)
  typed_data_json TEXT,                  -- EIP-712 "Boundline Router" v1 typed data; null when NO_ROUTE
  digest TEXT,                           -- the EIP-712 digest a signer signs; null when NO_ROUTE
  signature TEXT,                        -- null while no route signer is configured
  signer TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS route_plans_line ON route_plans (partner_id, line_id, created_at);

-- The partner's off-chain routing policy, applied by a policy version (no desk call): Saturday mode today.
CREATE TABLE IF NOT EXISTS partner_settings (
  partner_id TEXT PRIMARY KEY,
  saturday_json TEXT NOT NULL,           -- {"enabled":false,"capacityFraction":0.5,"haircutBps":300}
  version_id TEXT,                       -- the policy version that set it
  updated_at INTEGER NOT NULL
);

-- Webhook endpoints a partner registered. The signing secret is kept to sign deliveries (shown to the partner once).
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  url TEXT NOT NULL,
  events_json TEXT NOT NULL,             -- ["grace","protect",...] or ["*"]
  description TEXT NOT NULL DEFAULT '',
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS webhooks_partner ON webhooks (partner_id, created_at);

-- The partner-scoped event log: keeper events (grace, protect armed, ...) and on-chain events the indexer saw.
-- `dedupe_key` makes ingest idempotent (indexer events: chain:tx:logIndex; keeper events: a hash of the event).
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,              -- '' when the event could not be attributed to a partner
  type TEXT NOT NULL,                    -- grace | grace.cleared | protect | hold | release | recovery | settle | ping
  chain_id INTEGER NOT NULL,
  source TEXT NOT NULL,                  -- keeper | indexer | api
  at INTEGER NOT NULL,                   -- unix seconds of the underlying fact
  line_id TEXT,
  borrower TEXT,
  tx_hash TEXT,
  decision_hash TEXT,
  data_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  backfill INTEGER NOT NULL DEFAULT 0,   -- 1: logged when the poller first started, never delivered
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_events_partner ON webhook_events (partner_id, at);

-- One delivery per (webhook, event); retried by the cron with backoff 1, 2, 4, 8, 16 minutes, at most 6 attempts.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,                  -- pending | delivered | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  last_code INTEGER,
  last_error TEXT,
  last_attempt_at INTEGER,
  next_attempt_at INTEGER,
  payload TEXT NOT NULL,                 -- the exact JSON body, signed again on every attempt with a fresh timestamp
  payload_hash TEXT NOT NULL,            -- sha256 hex of the body
  created_at INTEGER NOT NULL,
  UNIQUE (webhook_id, event_id)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook ON webhook_deliveries (webhook_id, created_at);

-- The built-in demo receiver (POST /v1/webhooks/echo/:token): the last 20 deliveries per token, with the result of
-- verifying the signature against the webhook's secret.
CREATE TABLE IF NOT EXISTS webhook_echo (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  delivery_id TEXT,
  event_type TEXT,
  signature_valid INTEGER NOT NULL,
  verification TEXT NOT NULL,
  body TEXT NOT NULL,
  headers_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_echo_token ON webhook_echo (token, seq);

-- Where the cron's indexer poll stopped, per indexer source (the highest block it has ingested).
CREATE TABLE IF NOT EXISTS poll_cursors (
  source TEXT PRIMARY KEY,
  last_block INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
