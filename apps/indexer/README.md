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

## Tick (cron `* * * * *`, and `POST /__tick` from the Observatory's cron as a fallback)

Rebuilt on 8 Oct 2026 for the Workers Free plan (10 ms of CPU per invocation): before, every cron tick ended
`exceededCpu` and the Observatory's kick was always skipped, so the sources advanced only now and then. Live, every
`fetch` and every D1 round trip costs CPU, so the tick makes few of both and keeps viem off its path.

1. **One read, one claim.** All cursors are read in one query. A tick that finished under 40 s ago wins nothing; else
   the tick claims a 20 s lease with one atomic upsert (`store.claimTick`), so the cron and the kick, which fire
   together, never both run (before, both read the marker before either wrote it and scanned the same ranges twice),
   and a tick killed mid-run blocks the next one for 20 s at most.
2. **Scan.** Sources in an order that rotates every minute. A source within `MIN_LAG_BLOCKS` of the head (Sepolia 45
   blocks = 90 s, mainnet 150 = 5 min) waits; otherwise `eth_getLogs` from `cursor + 1` in ranges of 500 blocks up to
   `head − 3` (load-balanced RPC nodes disagree on the head by a block or two), at most `MAX_RANGES_PER_TICK` ranges per
   source fetched as one JSON-RPC batch (an item the first URL refuses, e.g. Tenderly's `-32016 over rate limit`, is
   retried alone down the fallback list; a refused batch falls back to parallel single calls), inside the tick's shared budget (`MAX_RANGES_TOTAL_PER_TICK` ranges, `MAX_LOGS_PER_TICK`
   logs; the log cap stops the next source). JSON-RPC is hand-rolled (`src/rpc.ts`); logs are decoded by a hand-rolled
   ABI decoder (`src/decode.ts`) that reproduces viem's `decodeEventLog` (`strict: false`) byte for byte, held to it by
   a differential test on every event of every ABI and by `scripts/verify-live.ts` on stored rows; block times come from
   the logs' `blockTimestamp` (every Base RPC returns it) and one header read per cursor, parsed with a regex instead of
   a JSON parse of the transaction list.
3. **One commit.** Every source's events (multi-row `INSERT OR IGNORE`, 11 rows a statement under D1's 100-parameter
   cap) and cursor upserts go in one D1 batch. A tick that dies before it only costs a re-scan.
4. **Maintenance when due.** Daily roots, incrementally: hashing a 166-event day in one tick cost 45 ms of CPU live
   (mainnet days hold 300-700 events), so each tick hashes `ROOT_HASHES_PER_TICK` (8; a var) stored events into
   `event_hashes` (migration 0003), oldest unrooted first, and a day is rooted with one keccak over its stored hashes once
   every cursor has passed its end and every event has a hash (same scheme, same values; the root step then runs every
   tick until nothing is pending, else every ten minutes); a source that has never scanned holds day closure back. The AAPLt/USDC reconciliation every
   ten minutes or after new market events, through two hand-encoded `eth_call`s (`market`, `position`), not viem's
   multicall. Then the completion marker (riding in the commit when nothing is due).

Measured live on 8 Oct 2026 (`wrangler tail boundline-indexer --format json`): before, cron ticks `exceededCpu` at the
10 ms cap; after the raw-RPC rewrite 24–43 ms with the cron and the kick both running; with the single commit, the
lease and parallel ranges 11–13 ms, one run a minute, ~2.3 s wall (see the lane report for the final figures).
Offline, `scripts/bench-tick.ts` records a real tick from the live cursors and replays it (Node: ~1 ms warm).

Nothing throws out of the cron; every source reports its own error in the log line
`ingest <source> head=… cursor=a->b ranges=… logs=… inserted=… [error=…]`, and each tick ends with
`tick done: <ranges> ranges, <logs> logs, <n> store calls`.

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
| `GET /v1/desk/lines/:id/timeline?chainId=84532` | every event of one line, oldest first: the desk's (LineOpened, CollateralAdded, Drawn, Repaid, CollateralWithdrawn, LineHeld, LineReleased, LineClosed and the `Decision` rows with their hashes) and the DeskProtectionVault's (Protected, AdvanceSettled, CollateralRecovered, CollateralReturned; its own `Decision` rows stay off so a consumer's decision list remains the desk's), each labelled `contract` |
| `GET /v1/seize-watch` | who can seize the ten Coinbase stocks (SEIZE_ROLE holders from a full-history baseline plus indexed events), the SEIZE_EXEMPT/SEIZE_RECEIVER policies live, whether Morpho Blue, the Aave V4 hub, spoke, Taker, Giver and the Aerodrome pools are exempt under the exemption policy (live `isAuthorized`), the policy's membership changes; live reads memoised 60 s |
| `GET /v1/cursors` | every source cursor |
| `GET /v1/roots?chain=84532` | the last 60 daily roots (each with `eventsStoredNow` and `drift`: a source added later stored events in a day already rooted), the scheme, and `today` (rolling) |
| `GET /v1/roots/:day?chain=84532` | one day's root or 404 |
| `GET /v1/reconcile/latest?chain=84532` | the most recent run: per-subject checks with expected and actual, rolled-up status |

## Env

| Name | Where | Value |
| --- | --- | --- |
| `DB` | D1 binding | `boundline-indexer` |
| `BASE_RPC_URL`, `BASE_SEPOLIA_RPC_URL` | vars | comma-separated RPC lists, first answers, rest fall back. Mainnet: Tenderly's public gateway first (serves 500-block log windows back to September, max 1,000), then `mainnet.base.org` (500-block cap, rate-limits Workers), then publicnode (recent ranges only). Measured 6 Oct 2026; Alchemy's free tier allows 10-block log windows and is not in the list |
| `BASE_RPC_URL_PRIVATE`, `BASE_SEPOLIA_RPC_URL_PRIVATE` | secrets, optional | keyed RPCs tried first |
| `CREDIT_DESK_SEPOLIA` | var | the desk address once deployed; empty skips the source |
| `INDEX_MAINNET` | var | `"true"` enables the six phase-2 mainnet sources (on since 6 Oct 2026; the policy registry since 8 Oct) |
| `MAINNET_START_BLOCK`, `MAINNET_FEEDS_START_BLOCK` | vars | first block the mainnet sources scan (defaults 52,198,000 and 51,640,000) |
| `MAX_RANGES_PER_TICK` | var | ranges per source per tick, fetched in parallel, default 5 (deployed 6) |
| `MAX_RANGES_TOTAL_PER_TICK`, `MAX_LOGS_PER_TICK` | vars | the tick's shared budget: ranges across all sources (default 8, deployed 12; also bounded by the Free plan's 50 subrequests) and decoded logs (default 200, deployed 150) |

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

D1 allows 100k row writes and 5M row reads a day: one commit a tick writes the cursors that moved plus the events.
The Free plan allows 50 subrequests an invocation (every `eth_getLogs`, header read and retry): 12 ranges, 2 heads, a
few header reads and the reconciliation's reads stay under it. CPU is the scarce resource (10 ms an invocation); see
the tick section for the measurements and `scripts/bench-tick.ts` for the offline bench.

Adding a source with an earlier start block stores events in days that may already be rooted (8 Oct 2026:
`sepolia-protection` backfilled 6 and 7 Oct): `GET /v1/roots` flags those days with `drift`, and they are re-rooted only
by deleting their rows and the later ones (`DELETE FROM daily_roots WHERE chain_id = … AND day >= '…'`, a human
decision; the chain re-forms by itself, one day per tick, once every cursor has passed each day).

## Tests

`pnpm --filter @boundline/indexer test` (102 tests, no network): the lean decoder against viem on 40 random logs of every
event of every ABI plus edge cases (truncated data, an out-of-range bool, missing and extra topics, unknown topic0),
byte-level roots against the abi.encode reference, ingestion against a fake RPC (cursor advance, duplicates,
`blockTimestamp`, one header read, a failed range keeping the prefix, the raw client's memoisation), the tick (rotation,
shared budget, the atomic lease against two concurrent ticks, a killed tick, store round trips, minimum lag, root cadence
and the one-day cap, a never-scanned source holding closure back), reconciliation, routes (phase-2, the line timeline
with the vault, seize watch with a fake RPC, roots drift), and the addresses against the deployment record.
`scripts/verify-live.ts` re-decodes a sample of stored rows of every source from the RPC and recomputes stored roots
(8 Oct 2026: 137 of 137 rows identical; roots identical except the backfilled Sepolia 6 Oct, see Budget).

## Sources added on 8 Oct 2026

| id | What | From |
| --- | --- | --- |
| `sepolia-protection` | Protector `0x5c54…442c`, DeskProtectionVault `0x87f6…f38c`, BoundlineReserve `0x7AcE…B6E`, LocalPayoutRouter `0x1a6D…6354`, every event (ABI generated from the forge artifacts: `sepoliaProtectionAbi`) | 47,760,000 |
| `mainnet-policy-registry` | the B20 PolicyRegistry precompile `0x8453…0002`, every event (whole-chain volume: 2 events in 129,000 blocks) | 52,198,000 |

## Still open

Mainnet market reconciliation (needs Supply/Withdraw for the replay), B20 `B20Created` discovery for the ten
unpriced tokens, re-resolving the feed aggregators on a Chainlink phase change, and re-rooting the Sepolia days the
protection backfill drifted (a human decision, see Budget).
