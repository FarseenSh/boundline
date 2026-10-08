# @boundline/agent

Boundline's agent surface: a Model Context Protocol server over streamable HTTP on Cloudflare Workers, with REST aliases
for curl. Live at https://boundline-agent.papermind-ai.workers.dev. Read-only: nothing here signs or sends a transaction.

| Route | What |
| --- | --- |
| `POST /mcp` | JSON-RPC 2.0 (protocol 2025-06-18): `initialize`, `ping`, `tools/list`, `tools/call`, batches. **Free.** |
| `GET /v1/tools` | the tool definitions and the pricing below. Free. |
| `POST /v1/tools/:name` | a tool's arguments as JSON. **$0.01 USDC on Base Sepolia per call through x402** for callers without a partner key; `Authorization: Bearer <partner key>` is never metered (the key is checked against the partner API's `GET /v1/whoami`, cached five minutes per isolate). An unknown tool is 404 before any payment, and a refusal (400) is never settled. |
| `GET /health` | tools, partner, pricing. Free. |

Tools: `session` (NYSE session on Base and the next feed transition), `positions` (real Morpho or Aave V4 positions on
Base mainnet with venue versus shadow health), `shadowHealth` (an address's Boundline lines and protection standing),
`quote` (a desk line's quote and hash), `protect` (what the keeper would arm right now), `route` (venue and market for a
draw, with the canonical plan and EIP-712 typed data; the partner API's `POST /v1/route` stores and signs plans).

x402 follows the partner API (`apps/api/src/x402.ts`), copied without Hono in `src/x402.ts`: a keyless call is answered
402 with the requirements (v1 body, v2 `PAYMENT-REQUIRED` header); `PAYMENT-SIGNATURE` (v2) or `X-PAYMENT` (v1) is
verified by the x402.org facilitator before the tool runs and settled only after a 2xx, with `PAYMENT-RESPONSE` on the
way out. Vars: `X402_ENABLED`, `X402_PAY_TO`, `X402_FACILITATOR`, `X402_NETWORK`, `X402_PRICE_USDC`.

```sh
AGENT=https://boundline-agent.papermind-ai.workers.dev
curl -s $AGENT/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"session","arguments":{}}}'
curl -si -X POST $AGENT/v1/tools/session -d '{}' | head -1                          # HTTP/2 402
curl -s -X POST $AGENT/v1/tools/route -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"user":"0xB789aD318945B37566E2549F65526Cc269a482Fc","collateral":"AAPLc","collateralAmount":"100000000","amount":"1000000"}'
```

The route candidates (Observatory snapshot, Morpho markets, IRM rates over hand-rolled Multicall3) live in
`@boundline/router/candidates` and `@boundline/router/raw`, shared with the partner API; `src/candidates.ts` and
`src/raw.ts` re-export them.

```sh
pnpm --filter @boundline/agent test        # 19 tests: MCP transport, tools, candidates, x402 metering and the key check
pnpm --filter @boundline/agent typecheck
cd apps/agent && pnpm exec wrangler deploy  # secret PARTNER_API_KEY; bindings API, INDEXER, OBSERVATORY, KEEPER
```
