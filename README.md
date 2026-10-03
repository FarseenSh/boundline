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
| `contracts/` | Foundry. `calendar/` NYSE session calendar in ET; `oracle/` SessionGate (verdict engine), SessionGuard (Morpho market oracle), ShadowGuard (pre-liquidation oracle on the Aerodrome TWAP); `test/` simulators for Base Sepolia; `script/` deploys. |
| `packages/calendar` | The same calendar in TypeScript, checked against the Solidity one on thousands of instants. |
| `packages/chain` | Base mainnet and Sepolia addresses, ABIs, viem clients, price math. |
| `apps/observatory` | The B20 credit Observatory: a Cloudflare Worker that snapshots every feed, registry flag, pause, corporate action, DEX price and venue position on Base mainnet, as a public page and JSON API. |
| `docs/BUILD.md` | The day-by-day build schedule and ledger. |

## Run

```sh
pnpm install
forge test --root contracts          # calendar, oracles, simulators
pnpm test                            # TypeScript packages
pnpm --filter @boundline/observatory dev
```

## Licence

MIT. `contracts/src/libraries/TickMath.sol` is Uniswap's, GPL-2.0-or-later, under its own header.
