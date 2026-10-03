# @boundline/indexer

The evidence plane: a Cloudflare Worker that pulls onchain events into D1 every minute, closes each UTC
day with a hash-chained root, and replays the Morpho market to check that the stored history reproduces
the live state. Phase 1 covers Base Sepolia (our market, oracle stack and the CreditDesk once deployed);
phase 2 (Base mainnet feeds, OracleRegistry, Morpho B20 markets, Aave spoke) is registered as an empty
source list behind `INDEX_MAINNET`.

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

## Tick (cron `* * * * *`)

1. For each source: `eth_getLogs` from `cursor + 1` in ranges of 2,000 blocks up to `head − 1`, at most
   `MAX_RANGES_PER_TICK` (default 5) ranges, inside an 18 s budget. Logs are decoded with viem, inserted with
   `INSERT OR IGNORE` in batches of 100, and the cursor moves only after a range is stored (a crash re-scans
   the range; duplicates are ignored). Block timestamps come from `eth_getBlockByNumber` with a per-tick cache.
2. Daily roots: every complete UTC day without a root is rooted in order (see the scheme).
3. Reconciliation of the AAPLt/USDC market when new market events arrived or ten minutes passed.

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
| `GET /v1/events?chain=84532&address=&name=&from=&to=&limit=100&before=block:logIndex` | newest first, `limit` ≤ 500, `next` carries the cursor for the following page |
| `GET /v1/cursors` | every source cursor |
| `GET /v1/roots?chain=84532` | the last 60 daily roots, the scheme, and `today` (rolling) |
| `GET /v1/roots/:day?chain=84532` | one day's root or 404 |
| `GET /v1/reconcile/latest?chain=84532` | the most recent run: per-subject checks with expected and actual, rolled-up status |

## Env

| Name | Where | Value |
| --- | --- | --- |
| `DB` | D1 binding | `boundline-indexer` |
| `BASE_RPC_URL`, `BASE_SEPOLIA_RPC_URL` | vars | comma-separated public RPC lists, first answers, rest fall back |
| `BASE_RPC_URL_PRIVATE`, `BASE_SEPOLIA_RPC_URL_PRIVATE` | secrets, optional | keyed RPCs tried first |
| `CREDIT_DESK_SEPOLIA` | var | the desk address once deployed; empty skips the source |
| `INDEX_MAINNET` | var | `"true"` enables the phase-2 sources (none registered yet) |
| `MAX_RANGES_PER_TICK` | var | ranges per source per tick, default 5 |

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
(2 sources × 1,440 = 2,880) plus the events themselves; the first catch-up over ~2,000 Sepolia blocks per
range writes at most a few hundred rows. Reconciliation reads the market's events once per run (≤ 144 runs a
day). No KV, no R2.

## Tests

`pnpm --filter @boundline/indexer test` (43 tests, no network): decoding from EVM-shaped fixture logs
(Borrow, SupplyCollateral, AnswerUpdated, Decision, unknown topic), canonical JSON, root determinism and
sensitivity, range planning, ingestion against a fake RPC (cursor advance, duplicates, head not far enough,
deadline, RPC error), the replay and reconciliation (PASS, FAIL, pinned-block fallback, SKIP), daily-root
closure, the routes on the in-memory store, and the address cross-check against the deployment record.
The D1 SQL in `src/store-d1.ts` is exercised live after the first deploy, not by the unit tests.

## Phase 2 still needs

Mainnet sources: `AnswerUpdated` on the aggregator behind each of the ten Coinbase feed proxies (resolve
`aggregator()` first; the proxy itself emits nothing), the OracleRegistry's own events (ABI not yet in
`@boundline/chain`), the Morpho B20 markets (reuse the discovery in `apps/observatory/src/morpho.ts` and the
per-market topic filter), the Aave MAG7 spoke events, and B20 asset pause, multiplier and policy events
(`TOPICS` in `@boundline/chain`). Each is one more entry in `mainnetSources()` plus a reconciliation per
market.
