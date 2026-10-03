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
pnpm exec wrangler d1 migrations apply boundline-observatory --remote   # only when migrations/ changed
pnpm exec wrangler deploy
```

First-time setup on another account: `wrangler kv namespace create SNAPSHOTS` and
`wrangler d1 create boundline-observatory`, put both ids into `wrangler.jsonc`, apply the migration,
deploy. Add the custom domain `boundline.xyz` in the Workers dashboard (or the `routes` block noted in
`wrangler.jsonc`) once the zone is on the account.

### RPC

`BASE_RPC_URL` (a var in `wrangler.jsonc`) is a comma-separated list read through a viem fallback
transport, in order: publicnode, dRPC, Blast, then `mainnet.base.org`. Base's own public endpoint answers
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

R2 is not bound: the deploy login has no r2 scope and nothing exports yet. `Env.EXPORTS` is optional;
re-add the binding in `wrangler.jsonc` when exports land.

The first snapshot after deploy is computed on demand by the first request if the cron has not run yet.
