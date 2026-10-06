# @boundline/api

The partner API: a Hono Worker with D1 that prepares credit-line calls, quotes capacity and reads
obligations from the `CreditDesk` on Base Sepolia. Self-custody throughout: the API never holds a
key, never signs and never sends on a user's behalf. It hands the user typed data, a digest and
calldata; the user sends the transaction.

Every response carries `X-Correlation-Id` (echoed from the request or generated), `X-Policy-Version`
(the partner's current policy version, or the line's own version on line routes) and, on quotes,
`X-Quote-Hash`. The JSON body repeats `correlationId`, `policyVersion` and `quoteHash`.

## Routes

All `/v1/*` routes need `Authorization: Bearer <partner key>`. POSTs need `Idempotency-Key`.

| Route | What |
| --- | --- |
| `GET /health` | liveness, no auth |
| `POST /v1/lines` | `{partnerId, user, marketId, deadline}` → the EIP-712 `LineAuthorization` typed data, the digest (verified against the desk's `lineAuthorizationDigest`), `signatureRequired` and the `openLine` calldata the user sends |
| `POST /v1/quotes` | `{lineId, draw}` or `{partnerId, user, marketId, draw}` → the desk's quote with a reason name, session name, price, collateral, debt, `capacity` (rounded **down** to the cent), charges (rounded **up**), and a `quoteHash` |
| `GET /v1/lines/:id` | the line, its obligation status and a zero-draw quote |
| `GET /v1/obligations?partnerId=&limit=` | the partner's lines from the indexer's `LineOpened` events (`source: "indexer"`: open block, time, tx and decision hash) with the line status, obligation status, policy version and drawn principal read live from the desk; when the indexer is unreachable it falls back to the lines this API has seen (`source: "api-cache"`, `sourceNote` says why) |
| `GET /v1/lines/:id/decisions` | the line's decision timeline from the indexer: every `Decision` (action name decoded from bytes32, hash, amount, price8, block, time, tx) plus the typed events beside them (LineOpened, Drawn, Repaid, …); 404 for another partner's line, 501 without an indexer, 502 when it is down |
| `GET /v1/decisions/:hash` | 501 until `INDEXER_URL` is set, then the indexer's `Decision` event with that hash (the indexer filters by `decisionHash` itself) |

Rules that hold on every route: a partner only ever sees its own lines (others answer 404), a
quote the desk cannot fully answer is 409 `{reason: "UNKNOWN"}` and never a partial number, and
routes that need the desk answer 503 `{error: "desk not deployed"}` until `CREDIT_DESK` is set.

Idempotency: the same key with the same request replays the stored status and body (header
`X-Idempotent-Replay: true`); the same key with a different request is 422; keys expire after 24 h.

```sh
API=https://boundline-api.<subdomain>.workers.dev
KEY=bl_...
curl -s $API/v1/obligations -H "Authorization: Bearer $KEY"
curl -s $API/v1/quotes -H "Authorization: Bearer $KEY" -H "Idempotency-Key: $(uuidgen)" \
  -H 'content-type: application/json' -d '{"lineId":"1","draw":"100000000"}'
curl -s $API/v1/lines -H "Authorization: Bearer $KEY" -H "Idempotency-Key: $(uuidgen)" \
  -H 'content-type: application/json' \
  -d '{"partnerId":"boundline-app","user":"0xB789aD318945B37566E2549F65526Cc269a482Fc","marketId":"0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047","deadline":1791200000}'
curl -s $API/v1/lines/1 -H "Authorization: Bearer $KEY"
curl -s $API/v1/lines/1/decisions -H "Authorization: Bearer $KEY"
```

`partnerId` is the desk's bytes32: pass the hex, or the short string the deploy script left-aligned
into bytes32 (`"boundline-app"` becomes `0x626f756e646c696e652d617070…00`). Amounts are USDC base
units as decimal strings; the API answers with both base units and a six-decimal `usdc` string.

## Quote hash

`quoteHash = keccak256(canonicalJson({chainId, desk, request, response, blockNumber}))` where
`response` is the chain-derived part of the body (no timestamps, no correlation id) and
`canonicalJson` sorts keys and writes bigints as decimal strings. The row is kept in the `quotes`
table, so a hash a partner shows later can be matched to exactly what was quoted and at which block.

## Deploy

```sh
cd /Users/farseen/boundline/apps/api
pnpm exec wrangler d1 create boundline-api            # paste the id into wrangler.jsonc
pnpm exec wrangler d1 migrations apply boundline-api --remote
pnpm exec wrangler deploy
```

Vars in `wrangler.jsonc`: `CHAIN_ID` (84532), `BASE_SEPOLIA_RPC_URL` (comma list, first wins),
`CREDIT_DESK` (empty until the desk is deployed), `MORPHO`, `SESSION_GATE`, optional `INDEXER_URL`.
No secrets are needed.

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

## Tests

```sh
pnpm --filter @boundline/api typecheck
pnpm --filter @boundline/api test      # 50 tests: auth, idempotency, rounding, fail-closed quotes, typed data, correlation ids, obligations (indexer-backed and the cache fallback), the decisions timeline, decision lookup, the D1 store over a D1-shaped fake
```

Handlers take a `Store` and a `DeskReader` interface, so the tests run without a network: an
in-memory store, a fake D1 that executes the real SQL constants, and a fake desk.

## Out of scope here

Partner signing of `LineAuthorization` (the partner signs the returned digest with its own key),
x402 metering and webhooks. Obligations and decision history come from the indexer through the `INDEXER`
service binding (`INDEXER_URL` names the host); without it the API still answers from its own cache.
