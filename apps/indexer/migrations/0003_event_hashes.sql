-- Per-event hashes for the daily roots (8 Oct 2026). Hashing a whole day inside one tick costs about 0.2 ms of CPU per
-- event on Workers (a 166-event mainnet day made a 45 ms tick; mainnet days hold 300-700 events), over the Free plan's
-- 10 ms, so each tick hashes a few stored events (ROOT_HASHES_PER_TICK) and a day's root is one keccak over its hashes
-- once every event of the day has one. h = keccak256(abi.encode(chainId, txHash, logIndex, address, topic0,
-- keccak256(args_json))), exactly as before; the roots do not change.
CREATE TABLE IF NOT EXISTS event_hashes (
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  day TEXT NOT NULL,                      -- YYYY-MM-DD (UTC) of the event's block
  block_number INTEGER NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS event_hashes_chain_day ON event_hashes (chain_id, day);
