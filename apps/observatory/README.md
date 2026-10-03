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
| `GET /` | Server-rendered page |
| `GET /v1/tokens` | Full rows per token |
| `GET /v1/feeds` | Feed subset: price, round, updatedAt, age, frozen, registry |
| `GET /v1/sessions` | Session state, next transition, last feed print |
| `GET /v1/venues/morpho/markets` | The B20 markets on Morpho Blue, discovered from Morpho's API, read onchain (5-minute cache) |
| `GET /v1/venues/aave/positions` | MAG7 spoke reserve configs; borrower scan pending the indexer |
| `GET /v1/events`, `GET /v1/positions/:addr/shadow` | 501 until M5 / M6 land |

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
mainnet on 3 Oct 2026 (block 52117568) with a stubbed reader and calendar.

## Deploy

1. `wrangler kv namespace create SNAPSHOTS` and put the id into `wrangler.jsonc`.
2. `wrangler d1 create boundline-observatory`, put the id into `wrangler.jsonc`, then
   `wrangler d1 migrations apply boundline-observatory --remote`.
3. `wrangler r2 bucket create boundline-observatory-exports`.
4. `wrangler deploy`. Add the custom domain `boundline.xyz` in the Workers dashboard (or the
   `routes` block noted in `wrangler.jsonc`) once the zone is on the account.
5. Optional: set `BASE_RPC_URL` to a CDP Node RPC URL as a secret for higher read limits.

The cron fires every minute. The first snapshot after deploy is computed on demand by the first
request if the cron has not run yet.
