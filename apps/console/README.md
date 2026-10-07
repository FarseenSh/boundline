# Boundline partner console

The partner-facing console over the Boundline partner API: obligations and their decision timelines, the
policy editor with a prepared-and-signed version history, the drill registry with recorded runs, the
indexer's reconciliation status and daily roots, and the evidence export with a hash the browser recomputes.
Vite + React 19 + wagmi v3 + viem, served by a Cloudflare Worker that proxies the partner API and the indexer.

Live: https://boundline-console.papermind-ai.workers.dev (Base Sepolia).

## Pages

- `/` obligations: every line of the partner with live statuses; `/lines/:id` the hash-bound decision timeline.
- `/policy` the desk's partner config and per-ticker policy; edits become a draft (only what changed), the API
  prepares the calls, the partner admin signs them (one `wallet_sendCalls` batch, or one transaction at a time),
  the console records the version as applied; version history below.
- `/drills` the drill registry; `/drills/:id` the steps and every recorded run as a timeline with explorer links.
- `/reconciliation` the latest reconcile run per check, the daily roots and the indexer sources' cursors.
- `/evidence` builds the export bundle, shows counts and the hash, recomputes the hash locally and downloads the JSON.

The ribbon at the top is the exchange clock from the Observatory's `/v1/sessions`, read through the proxy.

## Partner keys

Two ways in, both keep the key out of the repo and the logs:

| Mode | Where the key lives | How it reaches the API |
| --- | --- | --- |
| Console's own partner | the Worker secret `PARTNER_API_KEY` | the Worker adds `Authorization: Bearer` on `/api/v1/*` |
| A partner's own key | the browser tab's `sessionStorage` (sign-in box) | sent as a bearer to the proxy, which forwards it unchanged |

`/api/indexer/*` never carries a key. `/api/config` reports which mode is active.

## Worker proxy

| Browser path | Upstream (service binding) | Added |
| --- | --- | --- |
| `/api/health`, `/api/v1/*` | `boundline-api` | `Authorization: Bearer <pasted or PARTNER_API_KEY>` |
| `/api/indexer/v1/*` | `boundline-indexer` | nothing |
| `/api/observatory/v1/*` (GET) | `boundline-observatory` | nothing (the Observatory's origin sends no CORS headers, so the ribbon reads it here) |
| `/api/config` | the Worker itself | partner id, key presence, key source |

Request headers forwarded: `content-type`, `accept`, `idempotency-key`, `x-correlation-id`; response headers
forwarded: `content-type`, `content-disposition`, `x-correlation-id`, `x-policy-version`, `x-quote-hash`,
`x-idempotent-replay`. The routing is in `worker/route.ts` (tested with plain objects).

## API routes the console reads

Existing: `GET /v1/obligations`, `GET /v1/lines/:id`, `GET /v1/lines/:id/decisions`, `GET /v1/decisions/:hash`.
Added 7 Oct 2026 (Lane D): `GET /v1/policy`, `GET|POST /v1/policy/versions`, `GET /v1/policy/versions/:id`,
`POST /v1/policy/versions/:id/applied`, `GET /v1/drills`, `GET /v1/drills/:id`, `GET /v1/reconciliation`,
`GET /v1/evidence/export[?format=download]`. A 404/501 from one of these renders as "not live yet" on its page.

## Environment (`VITE_*`, read at build time)

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_CHAIN_ID` | `84532` | the chain the admin wallet signs on |
| `VITE_CONSOLE_MOCK` | unset | `1` serves fixtures (`src/mock.ts`) instead of the proxy, for UI work without the API |
| `VITE_OBSERVATORY_URL` | the live Observatory | ribbon source and footer link |
| `VITE_APP_URL` | the live app | footer link |

## Develop, test, deploy

```sh
pnpm --filter @boundline/console test          # vitest: policy maths and drafts, timelines, hashing, Worker routing
pnpm --filter @boundline/console typecheck
pnpm --filter @boundline/console build          # dist/
pnpm --filter @boundline/console exec wrangler deploy
pnpm --filter @boundline/console exec wrangler secret put PARTNER_API_KEY   # paste the console's partner key
VITE_CONSOLE_MOCK=1 pnpm --filter @boundline/console dev                    # fixtures mode, http://localhost:5174
```
