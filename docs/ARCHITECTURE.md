# Boundline architecture

One page for a reader who knows DeFi credit and wants to know what each part does, why it exists, and
what proves it. The living state (addresses, counts, open items) is in `docs/CONTEXT.md`.

## The problem in one diagram

```
 Coinbase tokenized stock (B20, 0xb200…)            trades 24/7 on Base
 Chainlink stock feed                               publishes Sun 20:00 ET → Fri 20:00 ET, holds Friday's close otherwise
 Aave V4 Equities Hub / Morpho Blue B20 markets     read the held price, liquidate at any hour, no session logic
                       ▲
                       │  Boundline sits here: a session-aware credit-operations layer
                       │  "never settle or liquidate against a frozen feed"
```

## Layers

| Layer | Component | What it decides | Proof |
| --- | --- | --- | --- |
| Time | `MarketCalendar` (Solidity), `@boundline/calendar` (TS) | which NYSE session an instant belongs to (PRE, REGULAR, POST, OVERNIGHT, WEEKEND, HOLIDAY), DST by rule, early closes; instants at or after 20:00 ET belong to the next exchange date | three independent implementations (Python zoneinfo, Solidity, TypeScript) agree on 5,643 instants and 300 transitions |
| Verdict | `SessionGate` | per token: `MARKET_CLOSED > FEED_PAUSED > TRANSFER_PAUSED > FEED_INVALID > FEED_STALE > OPEN`, reading the feed, the OracleRegistry (multiplier, pause) and the token's transfer pause; every external read fails closed | 34 oracle tests |
| Venue oracle | `SessionGuard` (Morpho `IOracle`) | `price()` reverts unless the gate is `OPEN`, so Morpho's `borrow`, `withdrawCollateral`, `liquidate` revert while the feed is held; `repay` and `supplyCollateral` never read the oracle and keep working | fork test on the live Morpho (weekend and Thanksgiving); live on Base Sepolia since 3 Oct 2026 (`MarketClosed(WEEKEND)` on a real borrow attempt) |
| Protection oracle | `ShadowGuard` (pre-liquidation `IOracle`) | the fresh feed in session; while held, the DEX TWAP (Aerodrome Slipstream `observe`) less a haircut, with a deviation bound against the held feed | validated against live data (feed 333.66 vs TWAP 333.61) |
| Credit (Morpho) | `CreditDesk` + `CreditDeskLib` | partner-scoped self-custody lines: policy (allowed tickers, max LTV below LLTV, draw bounds, exposure caps, eligibility hook), session-gated `draw`/`withdrawCollateral`, any-hour `repay`/`addCollateral`, keeper `hold`/`release`, a decision hash on every action; the user stays the Morpho position owner (`setAuthorization(desk)`) | 24 tests on the etched mainnet Morpho bytecode; live lines 1–3 on Sepolia with draws, repays and API quotes |
| Credit (Aave V4) | `AaveDesk` + `AaveDeskLib` | the same policy shape over the MAG7 spoke through Aave's Taker (`borrowOnBehalfOf`, the desk forwards to the owner), session check before every draw | 33 tests; 8 fork tests on the live spoke (enrolment, draw, Saturday repay, recovery) |
| Protection (Morpho) | Morpho pre-liquidation (vendored, audited) with `ShadowGuard` as oracle + `Protector` | inside the band `preLltv < shadow LTV ≤ LLTV` a partial pre-liquidation at the live price; the Protector sells the seized collateral on the collateral's own pool inside `onPreLiquidate` and repays from proceeds; `sizing` is the on-chain cap and knows that on a SessionGuard market while closed only a full close-out can pass | 18 tests; fork test pre-liquidating a real Steakhouse AAPLc borrower on a Saturday; **automated live on Sepolia 6 Oct** (`0x982c7327…b695`); **a full close-out by the keeper under a staged frozen feed, 12 Oct** (`0x9774913e…0352`, a raw `liquidate` refused `FeedStale` at the same moment) |
| Protection (Aave) | `ProtectionVault` | any-hour protective repay through the Giver, funded down a ladder (user reserve → partner reserve → bounded advance), recovery through the Taker in open sessions only; five-way conservation invariants | 11 tests + 5 invariants; fork proof of an 80 USDC Saturday repay |
| Capital | `BoundlineReserve` (ERC-4626) + `DeskProtectionVault` | capital providers fund advances; allocations capped by utilisation, withdrawals behind a cooldown; the Morpho-side vault repays desk lines at any hour down the ladder and recovers in session through the desk | 16 + 13 tests + 6 invariants; live on Sepolia 7 Oct: two protective repays on line 1, one funded by a Reserve advance, settled, fee harvested; 12 Oct: the keeper Worker's vault job repaid line 1 under a staged frozen feed (`0x47ac5279…1d24`: 0.40 user reserve + 0.14 advance), settled and harvested in session |
| Payout | `LocalPayoutRouter` | the borrow batch ends with a swap of the drawn USDC into a local stablecoin with a slippage bound and a session check (Slipstream CL and Aerodrome v2 pools) | 15 tests; fork swap on the real Aerodrome EURC/USDC pool; live on Sepolia 7 Oct (0.5 USDC → 0.46 EURCt in session) |
| Keeper | `apps/keeper` (Cloudflare cron) | mirrors mainnet rounds and registry params onto the Sepolia simulators; the protection job reads `Protector.sizing` per watched borrower and arms the allowed action as a **validity transaction** with a storage predicate on the feed's `updatedAt` slot and a 30-block bound | live; the sequencer's rules measured in `docs/evidence/validity-transactions-sepolia.md` |
| Data plane | `apps/observatory`, `apps/indexer`, `scripts/replay` | per-minute snapshots of every feed, registry flag, DEX price, TWAP and real venue position; reopen captures; hash-chained daily roots over canonical event hashes; Morpho reconciliation; the assurance replay (real positions through −3/−8/−15% gaps, raw vs Boundline; scheduled nightly in CI once the repository is public) | live since 3 Oct; the 9–11 Oct reopen captured live and matched against the chain; first assurance run 7 Oct: 3 raw liquidations go through, all on positions staged near their limit, 0 on the protected path |
| Partner surface | `apps/api`, `packages/sdk`, `packages/router`, `apps/app`, `apps/console`, `apps/agent` | keys, quotes (capacity rounds down, charges round up, unknown data fails closed), obligations, decision timelines, policy versions, drills, evidence export, x402-metered public routes (two real settlements), the SDK's prepared calls and `wallet_sendCalls` batches with the ERC-7677 paymaster, ERC-8021 suffix and payout leg, the credit router, the reference app, the partner console, the MCP agent surface | live; 85 + 73 + 11 + 30 + 13 tests |

## Why the order of gates is forced

`PreLiquidation.preLiquidate` reverts once `borrowed > collateral × LLTV` at the pre-liquidation
oracle's price. A position that gaps through LLTV at the Sunday 20:00 ET reopen is taken by liquidators
in the first block; nothing can rescue it then. Only a repay or a shadow pre-liquidation made **while the
feed is held** prevents it. The venues cannot do this (their oracle is the held feed); Boundline can,
because it watches the 24/7 DEX price and has a funding ladder:

1. the user's own USDC (spend permission, Base Account),
2. a pre-funded user or partner reserve in the vault,
3. the seized collateral itself, through the shadow pre-liquidation (self-funding),
4. a bounded Reserve advance, only where Monday recovery is possible (desk authorisation on Morpho,
   `Taker.withdrawOnBehalfOf` on Aave). Never an unsecured advance.

## Non-custody

Boundline is an authorised manager, never a custodian: the user keeps the Morpho position
(`setAuthorization`), the Aave position (`setUserPositionManager` for the Taker and the Giver), and the
collateral; the API prepares typed data and calldata and never signs; the app holds no key; every
action emits a chain-, contract- and nonce-bound decision hash that the indexer folds into a daily root.

## Base-native pieces

B20 assets through the Cobalt factory with composite receiver policies and seize-exempt lists;
`base_sendRawTransactionValidity` with storage predicates (the sequencer holds the action until the state
matches); ERC-7677 paymaster and ERC-8021 Builder Code in the batch; Flashblocks preconfirmation
polling; x402 metering through the x402.org facilitator; Base Account spend permissions as the first
rung of the ladder.

## Where to look

| Question | Place |
| --- | --- |
| What is deployed and proven | `deployments/base-sepolia.json`, `docs/evidence/` |
| What each service answers | `docs/CONTEXT.md` §5–6 and each app's `README.md` |
| How a weekend looks on the feeds | `docs/evidence/reopen-2026-10-04.md` (reconstructed), `docs/evidence/reopen-2026-10-11.md` (captured live) |
| How the sequencer treats a validity transaction | `docs/evidence/validity-transactions-sepolia.md` |
| What the keeper did under a frozen feed | `docs/evidence/feed-outage-rescue-2026-10-12.md` (the weekend it was planned for: `docs/evidence/saturday-rescue-2026-10-10.md`) |
| What can go wrong | `docs/THREAT-MODEL.md` |
