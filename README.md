# Boundline

**Borrow against your stocks on Base. Paid in your currency. Never liquidated while Wall Street is closed.**

Coinbase tokenized stocks trade on Base every hour of every day. Their Chainlink feeds publish
from Sunday 20:00 ET to Friday 20:00 ET and hold Friday's close all weekend. The two live credit
venues on Base read that held price with no staleness check, no pause check and no market-hours
logic, and liquidate around the clock. Base's own docs say "never settle or liquidate against a
frozen feed". Boundline is the credit-operations layer that enforces it: session-aware credit
across Aave V4 and Morpho, protection seven days a week instead of penalty liquidation at the
reopen, one auditable obligation record, embeddable by any wallet or neobroker, non-custodial.

## Layout

| Path | What |
|---|---|
| `contracts/` | Foundry. `calendar/` NYSE session calendar in ET; `oracle/` SessionGate (verdict engine), SessionGuard (Morpho market oracle), ShadowGuard (pre-liquidation oracle on the Aerodrome TWAP); `desk/` CreditDesk (partner-scoped self-custody lines on Morpho); `protection/` Protector over Morpho's pre-liquidation; `aave/` AaveDesk and ProtectionVault on Aave V4; `reserve/` the Boundline Reserve (ERC-4626) and the desk-side protection vault; `payout/` the local-money payout router; `test/` simulators for Base Sepolia; `script/` deploys. |
| `packages/calendar` | The same calendar in TypeScript, checked against the Solidity one on thousands of instants. |
| `packages/chain` | Base mainnet and Sepolia addresses, ABIs, viem clients, price math. |
| `packages/sdk` | `@boundline/sdk`: reads, quotes, prepared calls, `wallet_sendCalls` batches with the paymaster, Builder Code and payout leg. |
| `packages/router` | The credit router: venue and market by session, LTV, liquidity, protection and rate; signed route plans. |
| `packages/ledger` | The five-way conservation ledger for protection and liquidation events. |
| `apps/observatory` | The B20 credit Observatory: a Cloudflare Worker that snapshots every feed, registry flag, pause, corporate action, DEX price and venue position on Base mainnet, reopen captures, the nightly assurance status, as a public page and JSON API. |
| `apps/keeper` | Mirrors mainnet feeds onto the Sepolia simulators and arms protection as validity transactions. |
| `apps/indexer` | Events into D1 with hash-chained daily roots and reconciliation. |
| `apps/api` | The partner API: keys, quotes, obligations, decisions, policy versions, drills, evidence export; x402-metered public routes. |
| `apps/app`, `apps/console`, `apps/site`, `apps/agent` | The reference app (partner #1), the partner console, the landing page, the MCP agent surface. |
| `scripts/replay` | The fork replay harness behind the nightly assurance run. |
| `docs/ARCHITECTURE.md`, `docs/THREAT-MODEL.md` | One page each. |
| `docs/CONTEXT.md` | **Start here.** The living build context: everything built so far, deployments, live services, toolchain facts, decisions and open items. |
| `docs/BUILD.md` | The day-by-day build schedule and ledger. |
| `deployments/` | Addresses, transactions and live proofs per network (Base Sepolia is live). |

## Run

```sh
pnpm install
forge test --root contracts          # contracts (fork suites need BASE_RPC_URL)
pnpm test                            # every TypeScript package and app
pnpm --filter @boundline/observatory dev
```

Live: Observatory https://boundline-observatory.papermind-ai.workers.dev, app https://boundline-app.papermind-ai.workers.dev,
console https://boundline-console.papermind-ai.workers.dev, site https://boundline-site.papermind-ai.workers.dev, agent
https://boundline-agent.papermind-ai.workers.dev, API https://boundline-api.papermind-ai.workers.dev. The Base Sepolia
stack (test stocks, oracle stack, session-safe Morpho markets, CreditDesk, protected mode, Reserve, payout router) with
every proof hash is in `deployments/base-sepolia.json`; the evidence is under `docs/evidence/`.

## Licence

MIT. `contracts/src/libraries/TickMath.sol` is Uniswap's, GPL-2.0-or-later, under its own header.
