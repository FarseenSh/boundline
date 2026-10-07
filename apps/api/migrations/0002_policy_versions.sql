-- Policy versions a partner prepared through the console: the diff against the on-chain policy at preparation
-- time and the calls the partner admin signs. `applied` is set once the desk's policyVersion is seen to advance.
CREATE TABLE IF NOT EXISTS policy_versions (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  status TEXT NOT NULL,                  -- prepared | applied
  note TEXT NOT NULL,
  changes_json TEXT NOT NULL,            -- [{scope, symbol?, collateral?, field, before, after}]
  calls_json TEXT NOT NULL,              -- [{to, data, description, function}]
  policy_version_before INTEGER NOT NULL,
  policy_version_after INTEGER,
  tx_hash TEXT,
  created_at INTEGER NOT NULL,           -- unix seconds
  applied_at INTEGER
);
CREATE INDEX IF NOT EXISTS policy_versions_partner ON policy_versions (partner_id, created_at);
