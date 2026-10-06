# @boundline/indexer

The evidence plane: a Cloudflare Worker that pulls onchain events into D1 every minute, closes each UTC
day with a hash-chained root, and replays the Morpho market to check that the stored history reproduces
the live state. Phase 1 covers Base Sepolia (our market, oracle stack and the CreditDesk); phase 2 (on
since 6 Oct 2026, behind `INDEX_MAINNET=true`) follows Base mainnet: the ten Coinbase stock feeds, the
OracleRegistry, the B20 tokens' governance and corporate-action events, the 13 B20 Morpho markets and the
Aave V4 MAG7 spoke.

## What it stores

| Table | Row | Notes |
| --- | --- | --- |
| `events` | one decoded log | key `(chain_id, tx_hash, log_index)`; `args_json` is canonical (sorted keys, bigints as decimal strings, hex lowercased); unknown topics are kept as `unknown:<topic0>` with raw topics and data |
| `cursors` | one per `(chain_id, source)` | `last_block` and its timestamp `last_block_time`; the row `source = "reconcile"` holds the last reconciliation time |
| `daily_roots` | one per `(chain_id, UTC day)` | chained roots, see below |
| `reconciliations` | one per subject per run | `PASS`, `FAIL` or `SKIP` with the expected and actual JSON |

Sources (phase 1, Base Sepolia, addresses from `deployments/base-sepolia.json`, cross-checked by
`test/sources.test.ts`):

| Source id | Filter | From block |
| --- | --- | --- |
| `morpho-market-aaplt` | Morpho `0xBBBB…FFCb`, topic0 ∈ {CreateMarket, Supply, Withdraw, SupplyCollateral, WithdrawCollateral, Borrow, Repay, Liquidate, AccrueInterest}, topic1 = market id `0x4a03…8047` | 47,634,839 |
| `oracle-stack` | every log of the MarketCalendar, MirrorOracleRegistry, SessionGate and the three TestPriceFeeds (FeedSet, FeedLocked, YearLoaded, ClosureAdded, EarlyCloseAdded, AnswerUpdated, OraclePausedSet, MultiplierSet, OwnershipTransferred, OwnershipTransferStarted) | 47,634,676 |
| `credit-desk` | every log of `CREDIT_DESK_SEPOLIA` (LineOpened, CollateralAdded, Drawn, Repaid, CollateralWithdrawn, LineClosed, LineHeld, LineReleased, Decision, partner and market admin events) | 47,634,676, only when the var holds an address |

Morpho `SetAuthorization` is not market-scoped and is not indexed in phase 1; it becomes useful filtered by
`authorized = desk` once the desk exists.

Sources (phase 2, Base mainnet 8453, constants in `MAINNET_STACK`, pinned to `@boundline/chain` by
`test/mainnet-sources.test.ts`; every address re-read by RPC on 6 Oct 2026):

| Source id | Filter | From block |
| --- | --- | --- |
| `mainnet-feeds` | the ten phase-2 aggregators behind the Coinbase feed proxies (`proxy.aggregator()`), topic0 = `AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)` | 51,640,000 (~Tue 22 Sep 2026, so the 26–28 Sep and 3–5 Oct weekends are in the history; `MAINNET_FEEDS_START_BLOCK`) |
| `mainnet-oracle-registry` | every log of `0x3f3E…5CaD`: `OraclePausedSet(address indexed token, bool paused)` plus the AccessControl role events (the verified ABI has no multiplier event: multipliers are read from the tokens) | 52,198,000 (head − 50,000 on 6 Oct 2026; `MAINNET_START_BLOCK`) |
| `mainnet-b20-tokens` | the ten priced B20 tokens, topic0 ∈ {Paused, Unpaused, UIMultiplierUpdated, UIMultiplierUpdateCancelled, MultiplierUpdated, Announcement, EndAnnouncement, PolicyUpdated, RoleGranted, RoleRevoked, Seized, SupplyCapUpdated}; Transfer and Approval are deliberately not indexed | 52,198,000 |
| `mainnet-morpho-b20-markets` | Morpho `0xBBBB…FFCb`, topic0 ∈ {Borrow, Repay, SupplyCollateral, WithdrawCollateral, Liquidate, AccrueInterest}, topic1 ∈ the 13 B20 market ids (Supply/Withdraw are vault traffic and are left out) | 52,198,000 |
| `mainnet-aave-mag7-spoke` | spoke `0x1790…7B8D`, topic0 ∈ {Supply, Withdraw, Borrow, Repay, LiquidationCall, SetUserPositionManager, UpdatePositionManager} (ISpoke v0.5.11; `Repay` and `LiquidationCall` carry the `PremiumDelta` tuple) | 52,198,000 |

The aggregators are the phase-2 ones; a Chainlink phase change moves them, so `GET /v1/sources` shows the
addresses being followed and a feed that stops printing while its proxy keeps updating means the
constant must be refreshed. No reconciliation runs for the mainnet markets (the replay needs every
Supply/Withdraw, which we skip); the Sepolia market keeps its reconciliation.

## Tick (cron `* * * * *`, in practice `POST /__tick` from the Observatory's cron)

1. The sources are visited in an order that rotates every minute (so a busy source never starves the
   others). For each source: `eth_getLogs` from `cursor + 1` in ranges of 500 blocks (Base's public RPCs cap `eth_getLogs` at a 500-block range) up to `head − 1`, at
   most `MAX_RANGES_PER_TICK` (default 5, deployed 4) ranges per source, inside an 18 s budget, and inside a
   budget shared by the whole tick: `MAX_RANGES_TOTAL_PER_TICK` (default 8, deployed 12) ranges and
   `MAX_LOGS_PER_TICK` (default 200, deployed 300) decoded logs; a range that starts is finished, no further range starts
   once either is spent, and the rest waits for the next tick. Logs are decoded with viem, inserted with
   `INSERT OR IGNORE` in batches of 100, and the cursor moves only after a range is stored (a crash re-scans
   the range; duplicates are ignored). Block timestamps come from `eth_getBlockByNumber` with a per-tick cache.
2. Daily roots, per chain, only when the tick stored events or ten minutes passed since the last check (the
   `roots` cursor row): every complete UTC day without a root is rooted in order (see the scheme).
3. Reconciliation of the AAPLt/USDC market when new market events arrived or ten minutes passed.

A tick that starts less than 40 s after the previous one is skipped (the `tick` cursor row): the Worker's own cron
and the Observatory's `/__tick` kick both fire every minute, and two ticks at once would scan the same ranges twice.

The budget exists because this account runs on the Workers Free plan: 10 ms of CPU per invocation, and the
tick is one invocation whether the cron fires it or the Observatory calls `/__tick`.

Nothing throws out of the cron; every source reports its own error in the log line
`ingest <source> head=… cursor=a->b ranges=… logs=… inserted=… [error=…]`.

## Root scheme

For chain `c` and UTC day `d` (all blocks whose timestamp falls in `[d 00:00:00Z, d+1 00:00:00Z)`):

```
h_i   = keccak256(abi.encode(uint256 chainId, bytes32 txHash, uint256 logIndex, address emitter,
                             bytes32 topic0, bytes32 keccak256(bytes(args_json))))
root  = keccak256(prev_root ‖ h_1 ‖ h_2 ‖ … ‖ h_n)      events sorted by (block_number, log_index)
prev_root = root of the previous calendar day, or 32 zero bytes before the first rooted day
```

A day with no events has `root = keccak256(prev_root)`, so the chain is contiguous by calendar day from the
first day that holds an event. A day is rooted only once every source cursor of that chain has a
`last_block_time` at or beyond the day's end, so late logs cannot change a published root. `args_json` is
exactly the stored string (`GET /v1/events` returns it parsed; re-serialise with sorted keys, bigints as
decimal strings and lowercase hex to recompute). `GET /v1/roots` also returns `today`, the provisional root
over the current day's events so far, and the days still pending closure.

## Reconciliation

`replayMarket` applies the market's events in order the way Morpho's storage moves: `Supply`/`Withdraw` move
supply shares and assets, `SupplyCollateral`/`WithdrawCollateral` move collateral, `Borrow`/`Repay` move
borrow shares and assets, `Liquidate` repays shares, seizes collateral and writes off bad debt against the
suppliers, `AccrueInterest` adds the interest to both totals and the fee shares to supply shares. Every
address seen is compared with `position(id, user)` and the totals with `market(id)` at the replay's last
block (falling back to the latest state when the RPC cannot serve that block; `block_number` is 0 then).
Fee shares are minted to Morpho's fee recipient, which the events do not name; our market has a zero fee.

## Routes

| Route | What |
| --- | --- |
| `GET /health` | liveness |
| `GET /v1/sources` | every source this deployment follows (chain, addresses, topic filter, start block, cursor) and the mainnet constants (feeds with aggregators, the 13 market ids, cutoffs) |
| `GET /v1/events?chainId=84532&source=&address=&name=&from=&to=&since=&limit=100&before=block:logIndex&lineId=&partnerId=&decisionHash=&user=&borrower=&onBehalf=&token=` | newest first, `limit` ≤ 500, `next` carries the cursor for the following page; `source` restricts to a source's emitters, `since` is a block-time floor, the argument filters match the canonical `args_json` (the first one in SQL, the others on the page); `chain=` still works |
| `GET /v1/feeds/:symbol/rounds?chainId=8453&since=&limit=200&before=` | a stock's `AnswerUpdated` prints newest first (`AAPLc` … on mainnet, `AAPLt` … with `chainId=84532`) plus `gaps`: every pause of 6 h or more between consecutive prints on the page with the held answer, the next answer and the move in bps (the weekend-gap history) |
| `GET /v1/venues/aave/borrowers?since=&limit=500` | distinct borrowers of the Aave MAG7 spoke from its `Borrow` events since the cutoff block, with first/last block and reserve ids |
| `GET /v1/desk/lines?chainId=84532&partnerId=0x…&limit=&before=` | `LineOpened` events of the CreditDesk, newest first, optionally one partner's |
| `GET /v1/desk/lines/:id/timeline?chainId=84532` | every desk event of one line, oldest first (LineOpened, CollateralAdded, Drawn, Repaid, CollateralWithdrawn, LineHeld, LineReleased, LineClosed and the `Decision` rows with their hashes) |
| `GET /v1/cursors` | every source cursor |
| `GET /v1/roots?chain=84532` | the last 60 daily roots, the scheme, and `today` (rolling) |
| `GET /v1/roots/:day?chain=84532` | one day's root or 404 |
| `GET /v1/reconcile/latest?chain=84532` | the most recent run: per-subject checks with expected and actual, rolled-up status |

## Env

| Name | Where | Value |
| --- | --- | --- |
| `DB` | D1 binding | `boundline-indexer` |
| `BASE_RPC_URL`, `BASE_SEPOLIA_RPC_URL` | vars | comma-separated RPC lists, first answers, rest fall back. Mainnet: Tenderly's public gateway first (serves 500-block log windows back to September, max 1,000), then `mainnet.base.org` (500-block cap, rate-limits Workers), then publicnode (recent ranges only). Measured 6 Oct 2026; Alchemy's free tier allows 10-block log windows and is not in the list |
| `BASE_RPC_URL_PRIVATE`, `BASE_SEPOLIA_RPC_URL_PRIVATE` | secrets, optional | keyed RPCs tried first |
| `CREDIT_DESK_SEPOLIA` | var | the desk address once deployed; empty skips the source |
| `INDEX_MAINNET` | var | `"true"` enables the five phase-2 mainnet sources (on since 6 Oct 2026) |
| `MAINNET_START_BLOCK`, `MAINNET_FEEDS_START_BLOCK` | vars | first block the mainnet sources scan (defaults 52,198,000 and 51,640,000) |
| `MAX_RANGES_PER_TICK` | var | ranges per source per tick, default 5 (deployed 4) |
| `MAX_RANGES_TOTAL_PER_TICK`, `MAX_LOGS_PER_TICK` | vars | the tick's shared budget: ranges across all sources (default 8, deployed 12) and decoded logs (default 200, deployed 300) |

## Deploy (main session)

```sh
cd /Users/farseen/boundline/apps/indexer
pnpm exec wrangler d1 create boundline-indexer          # paste the id into wrangler.jsonc database_id
pnpm exec wrangler d1 migrations apply boundline-indexer --remote
pnpm exec wrangler deploy
curl https://boundline-indexer.<subdomain>.workers.dev/v1/cursors   # after two minutes: cursors moved, events stored
pnpm exec wrangler d1 execute boundline-indexer --remote --command "select name, count(*) from events group by name"
```

After the CreditDesk deploy: set `CREDIT_DESK_SEPOLIA` in `wrangler.jsonc` and redeploy.

## Budget (Workers Free)

D1 allows 100k row writes and 5M row reads a day. A quiet day costs one cursor write per source per tick
(8 sources × 1,440 = 11,520 at the limit; a source whose head is not far enough ahead writes nothing) plus the
events themselves. The mainnet feeds print roughly 20–60 rounds a day per stock on a trading day and none on
the weekend; the Morpho B20 markets add an `AccrueInterest` row per interaction; the Aave spoke a handful a
day. The feed backfill from block 51,640,000 is about 1,200 ranges of 500 blocks and proceeds at the tick budget's pace (a few hours).
Reconciliation reads the Sepolia market's events once per run (≤ 144 runs a day). No KV, no R2.

CPU is the scarcer resource: 10 ms per invocation on the Free plan. A cold isolate decoding a few hundred logs
with viem exceeds it, which is what the per-tick log cap and the range caps are for; `wrangler tail
boundline-indexer --format json` shows `outcome` and `cpuTime` per `/__tick` call.

## Tests

`pnpm --filter @boundline/indexer test` (68 tests, no network): decoding from EVM-shaped fixture logs
(Borrow, SupplyCollateral, AnswerUpdated, Decision, unknown topic, an Aave `Repay` with its `PremiumDelta`
tuple, a B20 `Paused` with a feature array), canonical JSON, root determinism and sensitivity, range
planning, ingestion against a fake RPC (cursor advance, duplicates, head not far enough, deadline, RPC error,
the shared tick budget), the tick's source rotation and root gating, the replay and reconciliation (PASS,
FAIL, pinned-block fallback, SKIP), daily-root closure, the event query builder and the memory store's
filters, the routes on the in-memory store (including the phase-2 routes with a synthetic weekend gap), the
address cross-check against the deployment record, and the mainnet constants against `@boundline/chain` and
the event signatures. The D1 SQL in `src/store-d1.ts` is exercised live after a deploy, not by the unit tests.

## Still open

Mainnet market reconciliation (needs Supply/Withdraw for the replay), B20 `B20Created` discovery for the ten
unpriced tokens, re-resolving the feed aggregators on a Chainlink phase change, and the Observatory reading
`/v1/venues/aave/borrowers` to show Aave positions.
