# Build schedule: Sat 3 Oct to Sat 10 Oct 2026 (IST)

Plan of record: `/Users/farseen/BaseFlow/reports/Boundline v3 full build plan 2026-09-26.md`
(mechanics) and `Boundline v3 winning idea plan 2026-09-26.md` (pitch). This file is the
day-by-day split of that plan from today to feature freeze, for two developers plus parallel
Claude sessions. Deadline: Mon 12 Oct 23:59 PT = **Tue 13 Oct 12:29 IST**. Submit Sun 11 Oct
evening IST.

Dependency order (never reorder): toolchain → calendar and oracles → Observatory → test stocks,
CreditDesk and policy → indexer and registry → pre-liquidation, AaveDesk, ProtectionVault,
Reserve → fork replay and nightly assurance → router, self-repaying and local-money legs → API,
SDK, widget, console, app, agent surface → drills, evidence, docs → deck, videos, submission.

## Session protocol

- Start every Claude session inside `/Users/farseen/boundline` (memory keys off the folder).
- Two human lanes: **Lane A** contracts and evidence, **Lane B** data, UI and business. Claude
  forks run with `FOUNDRY_PROFILE=lane-a|lane-b|lane-c|lane-d` so parallel forge runs never
  share `out/` and `cache/`; forks never commit, the main session commits.
- Commit under your own git identity, small commits, never backdate. Local git only until the
  public repo is pushed before submission.
- Every mainnet write is fork-tested first; every deploy is verified on Basescan; amounts stay
  in tens to hundreds of dollars; Boundline never custodies.
- Update the ledger below at the end of each session.

## Ledger (what is done)

| Date | Done |
|---|---|
| Sat 3 Oct | Repo scaffold (pnpm workspace, Foundry with base-std v1.1.0, morpho-blue, pre-liquidation, aave-v4, OZ 5.7). `MarketCalendar` + `Nyse2026` (18 tests from Python's tz database). `SessionGate`, `SessionGuard` (Morpho IOracle), `ShadowGuard` (pre-liquidation oracle, Aerodrome TWAP) with 34 tests. Simulators `TestPriceFeed`, `MirrorOracleRegistry`, `MockB20`, `MockCLPool` (20 tests) and dry-run deploy scripts. `@boundline/calendar` TS port with a differential fixture against the Solidity calendar. `@boundline/chain` addresses, ABIs, clients. Observatory v0 Worker (snapshot cron, JSON API, HTML page). |

## Day by day

### Sat 3 Oct (today)

| Lane A | Lane B | Humans only |
|---|---|---|
| Calendar, oracles, simulators, scripts (done). Deploy `MarketCalendar`, `SessionGate`, `MirrorOracleRegistry`, test feeds to **Sepolia** as soon as a funded deployer key exists; verify. | Observatory v0 (done) → deploy to Cloudflare under boundline.xyz so the cron captures the **Sun 4 Oct 20:00 ET reopen (Mon 5 Oct 05:30 IST)**. Replace the live site's placeholders. | Create the Crypto World's Fair project on the Arena, both developers registered. CDP project: paymaster policies (Sepolia and mainnet, allowlist + per-user cap), faucet, Node RPC key. Builder Code at dashboard.base.org. Cloudflare: KV, D1, R2, Workers `boundline-observatory`, `boundline-api`, `boundline-keeper`, custom domains. Wallets: Sepolia deployer (ETH + Circle USDC), mainnet deployer (ETH), separate keeper key; each developer buys about $100 of AAPLc on Aerodrome; about $300 USDC for the market seed and the Reserve. Archive RPC for the fork. |

### Sun 4 Oct

| Lane A | Lane B |
|---|---|
| Deploy `SessionGate` + `SessionGuard` + `ShadowGuard` to **mainnet** with the real feeds and registry; lock feeds; verify. `Morpho.createMarket(USDC, AAPLc, SessionGuard, AdaptiveCurveIrm, 0.625e18)`: the first session-safe B20 market on Base, labelled empty. Sepolia test stocks through the B20 factory post-Cobalt (roles incl. SEIZE_ROLE, supply cap, four policy scopes, batchMint, `eth_simulateV1` first), Sepolia Morpho market with SessionGuard. `CreditDesk` core, self-custody mode: `openLine`, `addCollateral`, `draw`, `repay`, `withdrawCollateral`, `closeLine`, keeper `hold`/`release`; receiver hardcoded to the position owner; obligation events with decision hashes; fuzz and invariants (policy ≤ venue LLTV, held line cannot draw, collateral-share conservation). | Observatory live: reopen capture panel armed, shadow health per real Morpho and Aave position (borrower discovery from `Borrow` events and the Morpho API), weekend-gap history panel from the Chainlink round history. Weekly video 1 (60 s). First X thread with the weekend gap. |

### Mon 5 Oct

| Lane A | Lane B |
|---|---|
| `CreditDesk` policy layer: allowed tickers, per-ticker max LTV below LLTV, min and max draw, per-partner and per-ticker exposure caps, `IEligibility` hook (Base Verify consumer on Sepolia, EIP-712 partner attestation fallback), B20 `isAuthorized` preflight on both legs, registry and transfer pause via SessionGate, corporate-action haircut from `effectiveAt`. Cobalt composite policy (partner allowlist INTERSECT issuer blocklist) and `SEIZE_EXEMPT_POLICY` on the Sepolia stocks; scheduled 2-for-1 multiplier drill. Indexer Worker + D1 (Morpho, Aave spoke, B20, registry, Chainlink rounds) with the hash-chained daily root and the reconciliation job. | API skeleton (Hono Worker, D1): partner keys, `POST /v1/lines`, `POST /v1/quotes` (capacity rounds down, charges round up, unknown data fails closed), `GET /v1/lines/{id}`, `/v1/obligations`, `/v1/decisions/{hash}`; correlation id, idempotency key, policy version, quote hash on every response. Partner console v0 (obligations, timeline). Outreach batch 1 (Zyfai, Clearstar, Steakhouse, Gauntlet, Superform, 628 Labs, Dromos, o1.exchange, BaseStonk, AstralBeam). |

### Tue 6 Oct

| Lane A | Lane B |
|---|---|
| Pre-liquidation contracts on the mainnet factory for the Steakhouse AAPLc, NVDAc, METAc, GOOGLc markets with `preLiquidationOracle = ShadowGuard`; `Protector` contract that sells seized collateral on Aerodrome inside `onPreLiquidate` and repays from proceeds; Sepolia factory copy. Keeper Worker: shadow HF from the TWAP, sizing rule (healthy under both the shadow and the venue price, several small actions), pre-signed **validity transactions** with storage predicates on the aggregator round slot and the registry pause slot plus a `block_number` expiry. `AaveDesk` + `ProtectionVault`: enrolment batch (`setUserPositionManagersWithSig`, `approveBorrowWithSig`, `approveWithdrawWithSig`, spend permission), `draw` via Taker, `protect` via Giver; fork tests enrol, draw, protect, Monday recovery against the live spoke. | Observatory protected-mode page (opt-in instructions, live authorisations). `@boundline/sdk` (viem): read models, quote, prepare and send calls, Base Account helpers, Builder Code suffix. Widget: "Borrow up to $X against your AAPLc", health bar that knows the next reopen, one `wallet_sendCalls` batch with the CDP paymaster, `capabilities.dataSuffix`, 200 ms preconfirmation polling. The Boundline app at boundline.xyz/app as partner #1. |

### Wed 7 Oct

| Lane A | Lane B |
|---|---|
| Grace state, Boundline Reserve (ERC-4626, cooldown, utilisation cap), bounded advances with Monday recovery (Morpho authorisation, Aave `withdrawOnBehalfOf`), recovery ledger with the five-way conservation tests. Fork replay harness: real Aave and Morpho positions through Friday close, a −8% gap and the Sunday reopen, raw venue versus Boundline, evidence JSON with hashes (aggregator slot via the prestate tracer, `anvil_setStorageAt`, `evm_setNextBlockTimestamp`). Nightly assurance job and status page. | Console: policy editor with versions, drill runner, reconciliation status, evidence export. x402 metering on `/v1/quotes` and `/v1/positions/{addr}/shadow` (x402.org facilitator on Sepolia). Local-money payout leg: swap to EURC or cNGN at the end of the borrow batch with a slippage bound and a session check; widget shows local units. Landing page. |

### Thu 8 Oct

| Lane A | Lane B |
|---|---|
| Sepolia drills executed and rendered as timelines: weekend gap, stale feed, registry pause, issuer transfer pause, scheduled multiplier, ineligible receiver, venue halt, partial repayment, bad-debt probe. Credit router (venue and market by rate, LTV, liquidity, protection, session) with signed route plans. Self-repaying leg: dividend harvest on `UIMultiplierUpdated`/`MultiplierUpdated`, reserve yield via Steakhouse USDC (mock ERC-4626 on Sepolia). Saturday mode (default off). Seize watch and corporate-action haircut. **Readiness gate decision** for third-party lines. | Webhooks (hold, grace, protect, recovery), evidence view, MCP agent surface (`quote`, `shadowHealth`, `positions`, `protect`, `route`) metered by x402, Base Pay for partner and protection fees. README, architecture doc, threat model. Submission text: description, chains and tools, team, GTM, demand validation, distribution; name the Observatory and SessionGuard as public goods; the one honest prior-work sentence. |

### Fri 9 Oct

| Lane A | Lane B |
|---|---|
| **Stage the live reopen drill**: a real self-custody position on the mainnet market just above the grace line before Fri 20:00 ET (Sat 10 Oct 05:30 IST), Reserve funded, keeper validity transactions pre-signed (Saturday repay with `= Friday value` on the aggregator slot, first-block repay with `!=`). Expansion packs if the gate allows: SessionGuard and the desk on Robinhood Chain and Arbitrum One with a real position each. CI green, every contract verified. | Base office hours #2. Deck refresh (typst theme), CertiK audit-credit listing, weekly video 2, follow-ups toward two recorded conversations. Bug-bash list. |

### Sat 10 Oct: feature freeze

Bug bash, redeploy everything, logged-out check of every link, record the 2:00 pitch and the
3:00 demo. The keeper acts on Saturday if the DEX moves; hashes go into the evidence index.

### Sun 11 Oct

**Submit on Colosseum** (evening IST), dry run from a clean browser, weekly video 3, confirm
both developers are on the submission.

### Mon 12 Oct 05:30 IST

The reopen lands. Capture the first-block transaction hashes, update the submission before
Tue 13 Oct 12:29 IST. Small fixes only.
