-- Phase 2 (Base mainnet sources): the feed-round and desk-line reads filter by emitter and event name together.
CREATE INDEX IF NOT EXISTS events_chain_address_name_block ON events (chain_id, address, name, block_number, log_index);
