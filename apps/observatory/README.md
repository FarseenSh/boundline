# Boundline Observatory

The public data plane for Coinbase tokenized-stock (B20) credit on Base: every priced token's
Chainlink feed and age, the Coinbase OracleRegistry multiplier and pause flag, issuer pause
state, scheduled corporate actions, the 24/7 Aerodrome price with its 1h TWAP, the divergence
from the held feed, and the gap the feed will print at the next reopen. Served as a page at `/`
and as JSON under `/v1`.

A Cloudflare Worker (Hono) with a one-minute cron. Reads go through `src/reader.ts` (one
multicall per snapshot), shaping is pure (`src/snapshot.ts`), the latest snapshot lives in KV,
history is appended to D1.

## Routes

| Route | What |
| --- | --- |
| `GET /` | Server-rendered page: token table, the reopen capture panel, the real-positions table |
| `GET /v1/tokens` | Full rows per token |
| `GET /v1/feeds` | Feed subset: price, round, updatedAt, age, frozen, registry |
| `GET /v1/sessions` | Session state, next session transition, next feed liveness transition, last feed print |
| `GET /v1/captures` | Capture runs (newest first) with their per-token summaries, plus the next feed transition |
| `GET /v1/captures/:transitionAt` | One run and every row it recorded |
| `GET /v1/positions` | Latest row per real borrower on the B20 Morpho markets: venue health versus shadow health |
| `GET /v1/positions/:addr/shadow` | That address's latest row per market, its history count, and a decision (ALLOW, PROTECT, UNKNOWN) |
| `GET /v1/venues/morpho/markets` | The B20 markets on Morpho Blue, discovered from Morpho's API, read onchain (15-minute cache) |
| `GET /v1/venues/aave/positions` | MAG7 spoke reserve configs; the Aave borrower scan is not built yet |
| `GET /v1/events` | 501 until the indexer lands |

## Reopen capture

Feed liveness flips at the Friday 20:00 ET close, the Sunday 20:00 ET reopen and around NYSE
holidays. `src/capture.ts` finds the next such boundary from the calendar (skipping live-to-live
boundaries such as OVERNIGHT to PRE) and the cron records every tick inside
**[transition − 15 min, transition + 90 min]**: one `captures` row per token per minute with the
feed round, the Aerodrome spot and the 1h TWAP, phase `before`, `at` (the first minute after) or
`after`. The run's `summary_json` keeps, per token, the held print (the last round at or before the
boundary) and the first round past it with its lag in seconds and the gap in basis points against
the held close; `first_update_at` is the earliest such print across tokens and `completed_at` is set
90 minutes after the boundary. A Worker deployed after the boundary still joins the run: the last
flip inside the previous 90 minutes is found by binary search and the held print is taken from the
`snapshots` history. Nothing is armed by hand; the next reopen is Sun 4 Oct 2026 20:00 ET
(1791158400), so the panel on `/` shows the countdown until then and the per-token table after.

## Real positions

`src/positions.ts` and `src/jobs.ts` keep a `borrowers` table for the B20 Morpho markets. Public
RPCs refuse deep `eth_getLogs` ranges (publicnode calls anything older than about 8,000 blocks an
archive request; `mainnet.base.org` caps a range at 2,000 blocks and rate-limits Cloudflare), so
the first run seeds the table from Morpho's API (`marketPositions` with `borrowShares_gte: 1`) and
the cron then follows `Borrow` events from a cursor (`scan_cursors`, one row per market, 2 calls of
2,000 blocks per tick at most; a cursor that falls behind the archive cutoff jumps forward and the
API is asked again). Every 10 minutes one multicall reads `market(id)`, the market oracle's
`price()` and `position(id, user)` for every borrower and stores a `positions` row with the debt
(Morpho's shares-to-assets rounding), the venue price, the 1h DEX TWAP price for tokens with an
Aerodrome pool (AAPLc, NVDAc), and the health factor at each. `protection_case` is set when the
shadow health is below 1 while the venue still reports healthy. Aave V4 spoke positions are not
scanned yet.

## Local run

```sh
pnpm --filter @boundline/chain build        # the Worker bundles @boundline/chain from dist
pnpm --filter @boundline/calendar build     # and @boundline/calendar
cd apps/observatory
pnpm exec wrangler d1 migrations apply boundline-observatory --local
pnpm exec wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # take one snapshot
open http://localhost:8787/
```

One snapshot without Workers at all: `pnpm exec tsx apps/observatory/scripts/live-snapshot.ts AAPLc`.

## Tests

`pnpm --filter @boundline/observatory test` runs the pure modules against values captured from
mainnet on 3 Oct 2026 (block 52117568) with a stubbed reader and calendar, the capture and
position jobs against the in-memory stores (`memoryStores` in `src/stores.ts`, the twin of the D1
store), and the routes through `createApp` with fake bindings.

## Deploy

Live on the team's Cloudflare account at **https://boundline-observatory.papermind-ai.workers.dev**
(deployed 3 Oct 2026 from this directory with `pnpm exec wrangler deploy`; the cron `* * * * *` is
attached). Resources, all bound in `wrangler.jsonc`:

| Resource | Name | Id |
| --- | --- | --- |
| KV namespace (`SNAPSHOTS`) | SNAPSHOTS | `aa7d8b27e629463da60008acfeccc30d` |
| D1 database (`DB`) | boundline-observatory | `dce1418d-1356-40ba-b6a8-5915ddbd95a7` (APAC) |

Redeploy:

```sh
pnpm --filter @boundline/chain build && pnpm --filter @boundline/calendar build
cd apps/observatory
pnpm exec wrangler d1 migrations apply boundline-observatory --remote   # 0002_captures.sql adds capture_runs, captures, borrowers, scan_cursors, positions
pnpm exec wrangler deploy
```

First-time setup on another account: `wrangler kv namespace create SNAPSHOTS` and
`wrangler d1 create boundline-observatory`, put both ids into `wrangler.jsonc`, apply the migration,
deploy. Add the custom domain `boundline.xyz` in the Workers dashboard (or the `routes` block noted in
`wrangler.jsonc`) once the zone is on the account.

### RPC

`BASE_RPC_URL` (a var in `wrangler.jsonc`) is a comma-separated list read through a viem fallback
transport, in order: publicnode, dRPC, then `mainnet.base.org` (Blast was dropped on 3 Oct 2026 when it began failing every call). Base's own public endpoint answers
"over rate limit" to Cloudflare's shared egress, which took the first deploy down on every snapshot, so it
is last. For a keyed endpoint (CDP Node, Alchemy) set the secret and it is tried first:

```sh
pnpm exec wrangler secret put BASE_RPC_URL_PRIVATE   # paste the full URL with the key
```

### Free-tier budget

The Worker is sized for the Workers Free plan. The cron fires 1,440 times a day while free KV allows
1,000 writes a day, so `src/kv-latest.ts` rewrites the `latest` key only when something a reader must
see at once has changed (session state, a feed print, the frozen flag, registry or issuer pauses,
multipliers, a scheduled corporate action, read errors) or when the stored copy is 10 minutes old.
Block number, feed age and the DEX price therefore lag by up to 10 minutes on the page and under `/v1`
when nothing else moves; D1 still receives every minute's rows (10 a minute, 14,400 a day, inside the
100,000-a-day free write limit). The two venue routes cache in KV for 15 minutes for the same reason.
The reopen capture adds about 1,100 rows per run plus one `capture_runs` write per tick inside the
window; the position scan adds one cursor batch per tick and one `positions` row per borrower every
10 minutes; neither writes KV.

R2 is not bound: the deploy login has no r2 scope and nothing exports yet. `Env.EXPORTS` is optional;
re-add the binding in `wrangler.jsonc` when exports land.

The first snapshot after deploy is computed on demand by the first request if the cron has not run yet.
