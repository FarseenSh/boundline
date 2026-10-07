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
| `GET /v1/drills`, `GET /v1/drills/:id` | the drills registry: eleven drills (weekend gap, stale feed, registry pause, issuer transfer pause, scheduled multiplier, ineligible receiver, venue halt, partial repayment, bad-debt probe, protection, validity transactions) with numbered steps and the recorded runs (transaction hashes, outcome, evidence paths) bundled from `docs/evidence/drills/*.json` |
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
pnpm exec wrangler d1 migrations apply boundline-api --remote   # 0001 partners/idempotency/quotes/lines, 0002 policy_versions
pnpm exec wrangler deploy
```

Vars in `wrangler.jsonc`: `CHAIN_ID` (84532), `BASE_SEPOLIA_RPC_URL` (comma list, first wins),
`CREDIT_DESK`, `MORPHO`, `SESSION_GATE`, optional `INDEXER_URL`, `MARKETS` (JSON array of
`{symbol, collateral, marketId, preLiquidation?, protector?, targetLtvWad?}` from
`deployments/base-sepolia.json`), and the `X402_*` vars above. No secrets are needed.

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
pnpm --filter @boundline/api test      # 85 tests: auth, idempotency, rounding, fail-closed quotes, typed data, correlation ids, obligations, decisions, x402 (both generations, verify/settle, refusals never settled), shadow positions, policy versions, drills, reconciliation, evidence export, raw encoding, the D1 store over a D1-shaped fake
```

Handlers take a `Store`, a `DeskReader` and a `Facilitator` interface, so the tests run without a
network: an in-memory store, a fake D1 that executes the real SQL constants, a fake desk and a
recording facilitator.

## Out of scope here

Partner signing of `LineAuthorization` (the partner signs the returned digest with its own key) and
webhooks. Obligations and decision history come from the indexer through the `INDEXER` service
binding (`INDEXER_URL` names the host); without it the API still answers from its own cache.
