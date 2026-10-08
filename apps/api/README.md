# @boundline/api

The partner API: a Hono Worker with D1 that prepares credit-line calls, quotes capacity, reads
obligations from the `CreditDesk` on Base Sepolia, and serves the partner console (policy versions,
drills, reconciliation, evidence export). Self-custody throughout: the API never holds a key, never
signs and never sends on a user's or a partner's behalf. It hands the user typed data, a digest and
calldata; the user sends the transaction. The partner admin signs policy changes the same way.

Every response carries `X-Correlation-Id` (echoed from the request or generated), `X-Policy-Version`
(the partner's current policy version, or the line's own version on line routes) and, on quotes,
`X-Quote-Hash`. The JSON body repeats `correlationId`, `policyVersion` and `quoteHash`.

## Routes

All `/v1/*` routes need `Authorization: Bearer <partner key>`, except the two metered routes below,
which also accept an x402 payment instead of a key. POSTs with a key need `Idempotency-Key`.

| Route | What |
| --- | --- |
| `GET /health` | liveness, no auth |
| `POST /v1/lines` | `{partnerId, user, marketId, deadline}` → the EIP-712 `LineAuthorization` typed data, the digest (verified against the desk's `lineAuthorizationDigest`), `signatureRequired` and the `openLine` calldata the user sends |
| `POST /v1/quotes` **(metered)** | `{lineId, draw}` or `{partnerId, user, marketId, draw}` → the desk's quote with a reason name, session name, price, collateral, debt, `capacity` (rounded **down** to the cent), charges (rounded **up**), and a `quoteHash` |
| `GET /v1/lines/:id` | the line, its obligation status and a zero-draw quote |
| `GET /v1/obligations?partnerId=&limit=` | the partner's lines from the indexer's `LineOpened` events (`source: "indexer"`: open block, time, tx and decision hash) with the line status, obligation status, policy version and drawn principal read live from the desk; when the indexer is unreachable it falls back to the lines this API has seen (`source: "api-cache"`, `sourceNote` says why) |
| `GET /v1/lines/:id/decisions` | the line's decision timeline from the indexer: every `Decision` (action name decoded from bytes32, hash, amount, price8, block, time, tx) plus the typed events beside them (LineOpened, Drawn, Repaid, …); 404 for another partner's line, 501 without an indexer, 502 when it is down |
| `GET /v1/decisions/:hash` | the indexer's `Decision` event with that hash |
| `GET /v1/positions/:addr/shadow` **(metered)** | every desk line the address owns (found through `lineOf` on the partner's markets, the indexer's `LineOpened` events and this API's cache), each with its zero-draw quote and, where protected mode is live on the market, the Protector's on-chain `sizing`: standing (`BELOW_BAND`, `IN_BAND`, `ABOVE_LLTV`, …), shadow and venue LTV, the partial the keeper would take. `decision` is `PROTECT` when any line is in or above the band, `ALLOW` otherwise, `UNKNOWN` without lines |
| `GET /v1/policy` | the live policy from the desk: partner config (admin, signer, eligibility, active, exposure cap and exposure) and one row per market (allowed, maxLtvWad, minDraw, maxDraw, exposureCap, exposure, the market's LLTV) |
| `POST /v1/policy/versions` | `{note, tickers?: [{collateral, allowed, maxLtvWad, minDraw, maxDraw, exposureCap}], partner?: {signer, eligibility, exposureCap, active}}` → a prepared version: field-level `changes` against the on-chain policy and the `setTickerPolicy` / `setPartnerConfig` `calls` the partner admin signs, in order; 400 when nothing changes |
| `GET /v1/policy/versions`, `GET /v1/policy/versions/:id` | the partner's prepared and applied versions, newest first |
| `POST /v1/policy/versions/:id/applied` | `{txHash}` → marks the version applied once the desk's `policyVersion` has advanced past the version's `policyVersionBefore` (else 409 with the current version); the partner's policy version in D1 follows the desk |
| `GET /v1/drills`, `GET /v1/drills/:id` | the drills registry: twelve drills (weekend gap, stale feed, registry pause, issuer transfer pause, scheduled multiplier, ineligible receiver, venue halt, keeper hold, partial repayment, bad-debt probe, protection, validity transactions) with numbered steps and the recorded runs (transaction hashes, outcome, evidence paths) bundled from `docs/evidence/drills/*.json` |
| `POST /v1/route` **(metered)** | `{chainId: 84532 \| 8453, borrower?, collateral: [{symbol, amount}], amountUsdc?, preferProtection?, saturdayMode?, lineId?, partnerId?, maxLtvBps?}` → a deterministic route plan from `@boundline/router` (chosen leg, alternatives, every rejection with its reason), its `planHash` (keccak256 of the canonical plan), the EIP-712 "Boundline Router" v1 `typedData` and `digest`, and `signature`/`signer` when the secret `ROUTE_SIGNER_KEY` exists (else `note: "route signer not configured"`). Base Sepolia reads the desk's market for the symbol, the SessionGate verdict and the partner's on-chain ticker policy in one Multicall3 call plus the IRM rate; Base mainnet reads the Observatory's B20 Morpho markets and the IRM rates. Without `amountUsdc` it plans the capacity. With `lineId` (partner key) the plan is stored on the line |
| `GET /v1/lines/:id/route` | the newest plan stored on a line of this partner (404 when none) |
| `GET /v1/whoami` | the partner a key belongs to (the agent checks keys with it) |
| `POST /v1/webhooks` | `{url (https), events: ["grace","grace.cleared","protect","hold","release","recovery","settle"] or ["*"], description?}` → 201 with the signing `secret`, shown once; at most ten per partner |
| `GET /v1/webhooks`, `DELETE /v1/webhooks/:id` (or `POST …/:id/delete`), `POST /v1/webhooks/:id/test`, `GET /v1/webhooks/:id/deliveries` | list (with the last delivery), soft delete, send a signed `ping`, delivery history (status, attempts, last code, next attempt, payload hash) |
| `GET /v1/events` | the partner's event log: keeper events and the on-chain events the cron picked up from the indexer |
| `POST /v1/webhooks/poll` | one bounded webhook tick on demand (both indexer sources, then up to two due deliveries); idempotent |
| `POST /v1/webhooks/echo/:token`, `GET /v1/webhooks/echo/:token` | no key: a built-in demo receiver that keeps the last 20 deliveries for a token with the result of verifying their signature against the webhook's secret |
| `GET /v1/reconciliation` | the indexer's latest Morpho reconciliation and the hash-chained daily roots |
| `GET /v1/evidence/export[?format=download]` | one JSON bundle: policy, obligations, decision timelines (first 10 lines, 100 events each), reconciliation and roots, drills, under `hash = keccak256(utf8(JSON.stringify(bundle without hash and correlationId, keys sorted recursively)))` so anyone can recompute it; `format=download` adds a `content-disposition` |

Rules that hold on every route: a partner only ever sees its own lines (others answer 404), a
quote the desk cannot fully answer is 409 `{reason: "UNKNOWN"}` and never a partial number, and
routes that need the desk answer 503 `{error: "desk not deployed"}` until `CREDIT_DESK` is set.

Idempotency: the same key with the same request replays the stored status and body (header
`X-Idempotent-Replay: true`); the same key with a different request is 422; keys expire after 24 h.

## x402 metering

`POST /v1/quotes` and `GET /v1/positions/:addr/shadow` are public: a caller without a partner key
pays **$0.01 USDC on Base Sepolia per call** through [x402](https://docs.x402.org). Partners with a
key are never metered. The flow is hand-rolled from the x402 v2 specification (no wallet stack in
the Worker) and accepts both protocol generations, which the public facilitator supports side by side:

| | v2 (CAIP-2 networks) | v1 |
| --- | --- | --- |
| 402 requirements | header `PAYMENT-REQUIRED` (base64 JSON, `network: "eip155:84532"`) | body `{x402Version: 1, accepts: [{network: "base-sepolia", maxAmountRequired: "10000", …}]}` |
| payment | header `PAYMENT-SIGNATURE` (base64 `PaymentPayload`) | header `X-PAYMENT` |
| settlement | header `PAYMENT-RESPONSE` | header `X-PAYMENT-RESPONSE` |

The payment is an EIP-3009 `transferWithAuthorization` signature over USDC
(`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, EIP-712 domain `USDC`/`2`) to `X402_PAY_TO`; the
facilitator (`https://x402.org/facilitator`) verifies it before the route runs and broadcasts it,
paying the gas, after the route answered 2xx. A refusal (404, 409, …) is never settled: nobody pays
for a "no". The facilitator is reached through the global fetch, never a Worker binding.

```sh
API=https://boundline-api.papermind-ai.workers.dev
curl -si $API/v1/positions/0xB789aD318945B37566E2549F65526Cc269a482Fc/shadow | head -20   # 402 + PAYMENT-REQUIRED
# with @x402/fetch (v2) or x402-fetch (v1) the client signs and retries; the response carries PAYMENT-RESPONSE
```

Live proof (7 Oct 2026, Base Sepolia): two keyless calls paid through the public facilitator with
`scripts/x402-pay.ts` (a hand-rolled v2 client: it reads `PAYMENT-REQUIRED`, signs the EIP-3009
authorization with `X402_PAYER_KEY`, retries with `PAYMENT-SIGNATURE`). `GET /v1/positions/0xB789…82Fc/shadow`
settled in [`0x8816d08f…c6ff`](https://sepolia.basescan.org/tx/0x8816d08fb7d6fadb8983f116bb4963bb5040e9666db6f15076272eb81cf5c6ff)
(block 47806632, `Transfer(0xEcC0…6AAE → 0x2f0d…2a4E, 10000)` on USDC, broadcast by the facilitator's signer
`0xd407…f1bf`, 85,776 gas) and `POST /v1/quotes` in
[`0x055981d8…a8f9`](https://sepolia.basescan.org/tx/0x055981d83ca73612b1677326f1ecb5847c9ccbfcdcad1b8a25f3a2c81eaca8f9);
both responses carried `PAYMENT-RESPONSE` with `success: true`.

Vars: `X402_ENABLED` (`"true"`), `X402_PAY_TO`, `X402_FACILITATOR`, `X402_NETWORK` (`base-sepolia`),
`X402_PRICE_USDC` (`0.01`), optional `X402_ASSET`. With `X402_ENABLED` unset, keyless calls are 401
on every route as before.

```sh
KEY=bl_...
curl -s $API/v1/obligations -H "Authorization: Bearer $KEY"
curl -s $API/v1/quotes -H "Authorization: Bearer $KEY" -H "Idempotency-Key: $(uuidgen)" \
  -H 'content-type: application/json' -d '{"lineId":"1","draw":"100000000"}'
curl -s $API/v1/lines -H "Authorization: Bearer $KEY" -H "Idempotency-Key: $(uuidgen)" \
  -H 'content-type: application/json' \
  -d '{"partnerId":"boundline-app","user":"0xB789aD318945B37566E2549F65526Cc269a482Fc","marketId":"0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047","deadline":1791200000}'
curl -s $API/v1/lines/1 -H "Authorization: Bearer $KEY"
curl -s $API/v1/lines/1/decisions -H "Authorization: Bearer $KEY"
curl -s $API/v1/policy -H "Authorization: Bearer $KEY"
curl -s $API/v1/policy/versions -H "Authorization: Bearer $KEY" -H "Idempotency-Key: $(uuidgen)" \
  -H 'content-type: application/json' \
  -d '{"note":"AAPLt to 55%","tickers":[{"collateral":"0xB2000000000000000000000E063E65377cA34141","allowed":true,"maxLtvWad":"550000000000000000","minDraw":"1000000","maxDraw":"100000000","exposureCap":"500000000"}]}'
curl -s $API/v1/drills -H "Authorization: Bearer $KEY"
curl -s $API/v1/reconciliation -H "Authorization: Bearer $KEY"
curl -s "$API/v1/evidence/export?format=download" -H "Authorization: Bearer $KEY" -o evidence.json
```

`partnerId` is the desk's bytes32: pass the hex, or the short string the deploy script left-aligned
into bytes32 (`"boundline-app"` becomes `0x626f756e646c696e652d617070…00`). Amounts are USDC base
units as decimal strings; the API answers with both base units and a six-decimal `usdc` string.

## Webhooks

A delivery is a `POST` of `{id, type, createdAt, at, chainId, partnerId, source, lineId?, borrower?, data, txHash?,
decisionHash?}` with `Boundline-Event`, `Boundline-Delivery` and `Boundline-Signature: t=<unix>,v1=<hex>` where
`v1 = HMAC-SHA256(secret, t + "." + raw body)` (Web Crypto). A receiver recomputes it, compares in constant time and
refuses timestamps more than 300 s away. Failed deliveries are retried by the cron after 1, 2, 4, 8 and 16 minutes, six
attempts at most. Two sources feed the log:

- **the keeper**, through the `Events` RPC entrypoint (`export class Events extends WorkerEntrypoint`, method
  `ingest(evt)`); the keeper binds `{ binding: "API_EVENTS", service: "boundline-api", entrypoint: "Events" }`. An RPC
  entrypoint is reachable only through a binding, so there is no shared secret. Grace entry and exit, protective actions
  armed; deduplicated by a hash of the event (a transaction hash makes the same action one event whatever its time);
- **the indexer**, polled through the `INDEXER` binding: the desk's `HOLD`/`RELEASE` decisions (`source=credit-desk`) and
  the protection contracts' executed events (`source=sepolia-protection`: the DeskProtectionVault's `Protected`,
  `AdvanceSettled`, `CollateralRecovered` and the Protector's `Protected`). A tick is small by construction, because a
  scheduled invocation on the Free plan is killed at 10 ms of CPU and a killed tick must never repeat the same work
  forever: a source's first poll only primes its cursor at the newest event (history is not replayed to partners), one
  source is polled per tick (alternating by minute), at most four new events are taken oldest first with the cursor saved
  every two, and their deliveries go out on the retry pass (at most two a tick). Anything older than a day is logged,
  never delivered. Measured: the worst cold tick 9.3 ms in Node with real SQL, 1.5–2.2 ms warm (`scripts/bench-cpu.ts`).
  Ticks come from this Worker's cron (`* * * * *`) and, because new cron triggers on this account have been slow or
  silent before, from the keeper calling `env.API_EVENTS.tick()` (the same entrypoint) once a minute; two ticks in a
  minute only find duplicates. `POST /v1/webhooks/poll` runs one on demand.

A receiver verifies a delivery in a few lines (the same check the echo receiver runs, `verifySignature` in
`src/webhooks.ts`, tested against Python's `hmac`):

```ts
const header = req.headers.get("boundline-signature") ?? "";            // "t=1791444417,v1=35b6…8a69"
const t = Number(/t=(\d+)/.exec(header)?.[1]);
const v1 = /v1=([0-9a-f]{64})/.exec(header)?.[1] ?? "";
const body = await req.text();                                            // the raw body, before any JSON.parse
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
const ok = Math.abs(Date.now() / 1000 - t) <= 300 && expected === v1;   // compare in constant time in production
```

Live (8 Oct 2026): the `boundline-app` partner has the built-in receiver registered for every event
(`wh_0078c9cd-6ae3-4bd8-ac91-37f5e4710da1`); `GET /v1/webhooks/echo/boundline-demo-53a54f87681c` shows what it received
and whether each signature verified.

An event is attributed to the partner the line belongs to (this API's records, else the desk's `line()`), or named in
the event (the vault's `partnerId`), or through the borrower's lines. Deliveries to this API's own host (the echo
receiver) are dispatched to the app itself, because a Worker fetching its own workers.dev URL gets Cloudflare error 1042.

## Saturday mode

A partner policy option (plan M11), default off: `POST /v1/policy/versions` with
`{"note": "…", "saturdayMode": {"enabled": true, "capacityFraction": 0.25, "haircutBps": 300}}`. It is an off-chain
routing policy (nothing to sign), so a version that holds only routing changes is applied as it is prepared; in a
version with desk calls it applies when the version is marked applied. `GET /v1/policy` shows it with the version that
set it. `POST /v1/route` applies it only on venues that keep pricing around the clock at the held feed (the mainnet
Morpho B20 markets, Aave V4): weekend draws at most `capacityFraction` (≤ 0.5) of the normal capacity at
min(held feed, DEX TWAP) less `haircutBps`. Boundline's own SessionGuard markets stay closed whatever it says. A request
can opt out with `saturdayMode: false`, never opt in past the policy.

## Quote hash

`quoteHash = keccak256(canonicalJson({chainId, desk, request, response, blockNumber}))` where
`response` is the chain-derived part of the body (no timestamps, no correlation id) and
`canonicalJson` sorts keys and writes bigints as decimal strings. The row is kept in the `quotes`
table, so a hash a partner shows later can be matched to exactly what was quoted and at which block.
The evidence export's `hash` uses the same canonical form over the whole bundle.

## Deploy

```sh
cd /Users/farseen/boundline/apps/api
pnpm exec wrangler d1 create boundline-api            # paste the id into wrangler.jsonc
pnpm exec wrangler d1 migrations apply boundline-api --remote   # 0001 partners/idempotency/quotes/lines, 0002 policy_versions, 0003 route plans, settings, webhooks
pnpm exec wrangler deploy
```

Vars in `wrangler.jsonc`: `CHAIN_ID` (84532), `BASE_SEPOLIA_RPC_URL` (comma list, first wins),
`CREDIT_DESK`, `MORPHO`, `SESSION_GATE`, optional `INDEXER_URL`, `MARKETS` (JSON array of
`{symbol, collateral, marketId, preLiquidation?, protector?, targetLtvWad?}` from
`deployments/base-sepolia.json`), the `X402_*` vars above, `BASE_RPC_URL` (mainnet list for route rates),
`DESK_PROTECTION_VAULT`, `PUBLIC_HOST`. Bindings: `DB`, `INDEXER`, `OBSERVATORY`. Cron `* * * * *` (webhooks). One
optional secret: `ROUTE_SIGNER_KEY` (signs route plans' typed data, never a transaction); without it plans are unsigned.

CPU: the Workers Free plan allows 10 ms per invocation. The app uses Hono's `PatternRouter` (the default SmartRouter
compiles a regular expression for every route on the first request: 24–26 ms measured); `scripts/bench-cpu.ts` measures
the route, a webhook delivery and the cron (8 Oct 2026: route 8.1 ms on the first request, 2–3 ms after; a delivery
1–3 ms; the cron's poll under 1 ms).

## Partner keys

Keys are 32 random bytes shown once; only the SHA-256 hex is stored.

```sh
pnpm --filter @boundline/api exec tsx scripts/new-partner-key.ts boundline-app "Boundline app"
# prints the key, its hash, and the `wrangler d1 execute boundline-api --remote --command "INSERT …"` to run
```

## Desk ABI

`src/abi/creditDesk.ts` is generated from the Foundry artifact. After a change to `CreditDesk.sol`:

```sh
FOUNDRY_PROFILE=lane-b forge build --root /Users/farseen/boundline/contracts
pnpm --filter @boundline/api exec tsx scripts/gen-abi.ts
```

The Protector's `sizing` view is read with a hand-rolled encoder (`src/raw.ts`, checked against
viem in `test/raw.test.ts`) so the Worker never decodes a tuple through the generic ABI path on a
hot route.

## Tests

```sh
pnpm --filter @boundline/api typecheck
pnpm --filter @boundline/api test      # 114 tests: auth, idempotency, rounding, fail-closed quotes, typed data, correlation ids, obligations, decisions, x402 (both generations, verify/settle, refusals never settled), shadow positions, policy versions, Saturday mode, route plans (Sepolia and mainnet, the hand-rolled EIP-712 digest against viem, signature recovery), webhooks (HMAC against Python's hmac, echo, retries and backoff, the indexer poll), drills, reconciliation, evidence export, raw encoding, the D1 stores over a D1-shaped fake and over node:sqlite with the real migrations
```

Handlers take a `Store`, a `DeskReader` and a `Facilitator` interface, so the tests run without a
network: an in-memory store, a fake D1 that executes the real SQL constants, a fake desk and a
recording facilitator.

## Out of scope here

Partner signing of `LineAuthorization` (the partner signs the returned digest with its own key). Obligations and decision history come from the indexer through the `INDEXER` service
binding (`INDEXER_URL` names the host); without it the API still answers from its own cache.
