# Boundline build context

Living record of everything built so far, where it lives, how it is verified, and what is open.
**Start here** in any new session (human or Claude), then `docs/BUILD.md` for the schedule.
Update this file at the end of every session together with the ledger in `docs/BUILD.md`.
Last update: **Mon 12 Oct 2026, night IST** (the live reopen capture, the feed-outage rescue, the D1 read budget; see the
12 Oct entries in sections 5, 6, 8–12).

## 1. What Boundline is, in one paragraph

Coinbase tokenized stocks (B20 assets, `0xb200…`) trade on Base around the clock. Their Chainlink
feeds publish from Sunday 20:00 ET to Friday 20:00 ET and hold Friday's close otherwise. The live
credit venues on Base (Aave V4 Equities Hub, Morpho Blue B20 markets) read that held price with no
staleness, pause or market-hours check and liquidate at any hour. Boundline is the session-aware
credit-operations layer that enforces "never settle or liquidate against a frozen feed": an onchain
NYSE calendar, a verdict engine over feed, registry and issuer state, Morpho oracles that refuse to
price a held feed, a pre-liquidation oracle on the DEX TWAP for weekend protection, partner-scoped
self-custody credit lines, and a public Observatory. Non-custodial: Boundline is an authorised
manager, never a custodian.

**The core claim, already proven on two venues:** a Morpho market whose oracle is a `SessionGuard`
refuses `borrow`, `withdrawCollateral` and `liquidate` while the feed is held (weekend, holiday) and
still accepts `repay` and `supplyCollateral`. Proven on a mainnet fork of the live Morpho (fork test)
and live on Base Sepolia on 3 Oct 2026 (section 6), where the whole stack now runs end to end: real B20 test
stocks mirrored from mainnet by a keeper, a session-safe Morpho market, the CreditDesk with a partner and a
live line, and a partner API that quotes it. On 6 Oct 2026 the stack went two steps further: **protected mode is
live on Sepolia** (Morpho's audited pre-liquidation with a ShadowGuard oracle, Boundline's Protector selling the seized
collateral inside the callback, and the keeper arming the action as a Cobalt **validity transaction** that Base included
in the next block), **Aave V4 is the second venue** (AaveDesk and ProtectionVault proven against the live MAG7 spoke on a
fork), and the Boundline app and SDK are live as partner #1. On 7 Oct 2026 the capital and partner layers
followed: the **Boundline Reserve** (ERC-4626) funds bounded advances through a Morpho-side protection vault that repaid a
live desk line at any hour down the ladder (user reserve, then a Reserve advance, settled with its fee); a **fork replay**
of real Aave and Morpho positions through −3/−8/−15% weekend gaps shows three raw liquidations go through and none on the
protected path; the **local-money payout leg** swapped drawn USDC into a local stablecoin in session; the partner API is
**x402-metered** (two real settlements); the **console**, the **agent surface** (MCP) and the landing site are live.
On 8 Oct 2026 the drills became evidence and the keeper became careful: **six drills ran live on Sepolia** (issuer
transfer pause, ineligible receiver, scheduled multiplier, keeper hold, registry pause, stale feed) and **two on a mainnet
fork** (the real 24 Sep Aave hub halt replayed with its own payloads; a bad-debt probe where the raw venue leaves 853.92
USDC of bad debt and the protected path none); the keeper **simulates every action before signing**, runs the
**DeskProtectionVault job** and re-signs its validity transactions; the **DividendHarvester** turns each cash dividend
into a repayment (fork-tested on NVDAc's real 1 Oct dividend); the **mainnet deploy is one command**, rehearsed on forks
(50 transactions, about $0.80 of gas); the partner API gained **route plans, webhooks and Saturday mode**; the indexer
stopped dying on the CPU cap and gained **seize watch**; the submission package (portal text, scripts, deck) exists.
On 9 Oct 2026 the **self-repaying leg went live on Sepolia**: the `DividendHarvester` deployed, desk line 1 opted in,
and NVDAc's real 1 Oct dividend step, replayed on the AAPLt registry mirror, was swept into the loan, first by the
operator and then by the **keeper Worker's new harvest job on its own, three blocks after the step**, each followed by a
re-base when the step was removed; the partner API's stored policy version now follows the desk; the submission's
pending slots for the drills, webhooks, route plans and the harvester carry hashes. Over the **9 to 11 Oct weekend** the
keeper watched both protection targets for 48 hours and, both being below the band, signed nothing; the planned
Saturday rescues were not run (no operator). The Observatory **captured the Sun 11 Oct reopen live** on all ten feeds and
a chain reconstruction matches it field for field. On **12 Oct** the Saturday rescue's two actions ran in session under a
staged frozen feed (the AAPLt test feed held stale, which the ShadowGuard treats like a weekend): the keeper Worker closed
out the drill position at the TWAP shadow price and repaid desk line 1 down the vault's ladder, each a validity
transaction on the frozen feed slot, while a raw `Morpho.liquidate` was refused `FeedStale`; the advance was settled and
harvested in session. The same evening the Cloudflare account was found over **D1's free daily read quota** (one unindexed
query: 4.21M of 5M reads a day), which had also cost both live capture runs their before-phase; fixed in code, and
deployed at 18:20 UTC once the account was on Workers Paid (migration 0004 applied, both capture runs closed). On
**13 Oct at 00:24–00:26 UTC Boundline went to Base mainnet**: the whole footprint from a fresh key in 50 transactions,
every address as rehearsed, 16 contracts verified on Basescan, 33 of 33 checks against mainnet; the session-safe market
is unseeded and nobody has opted in, so nothing has been lent or protected on mainnet.

## 2. Frame

| Item | Value |
| --- | --- |
| Hackathon | Colosseum Crypto World's Fair, Base track; University and Public Goods prizes also claimed |
| Deadline | Mon 12 Oct 2026 23:59 PT = **Tue 13 Oct 2026 12:29 IST**; submit Sun 11 Oct evening IST |
| Feature freeze | Sat 10 Oct 2026 |
| Team | two developers (Lane A contracts and evidence, Lane B data, UI and business) plus parallel Claude sessions |
| Plan of record | `/Users/farseen/BaseFlow/reports/Boundline v3 full build plan 2026-09-26.md` (mechanics) and `Boundline v3 winning idea plan 2026-09-26.md` (pitch) |
| Repo | `/Users/farseen/boundline`, local git on `main`, no remote yet (public repo needed before submission; pushing later keeps the dates, never backdate) |
| Old repo | `/Users/farseen/BaseFlow`: reference and plans only, nothing imported |
| Cloudflare plan | Workers **Paid** since the evening of 12 Oct (D1 answered 12 of 12 probes at 18:11 UTC; no daily D1 caps, no 10 ms CPU cap). Before that Workers **Free**, where the 10 ms CPU cap **was enforced, inconsistently** (corrected 8 Oct: the 7 Oct note "no longer enforced" was wrong). 8 Oct 06:39 UTC: every indexer cron tick died `exceededCpu` at `cpuTime 10` and its sources had stalled for hours, while the keeper (8 ms) and Observatory (6 ms) ticks passed and API fetches at 16–19 ms ended `ok`. After the 8 Oct diets: keeper 3–6 ms, indexer 8–16 ms (passing), Observatory 4–25 ms. Some crons never fire on this account (the API's, 8 Oct; the indexer's, 3 Oct): drive them from a cron that does, through a binding |
| Dependency order | toolchain → calendar and oracles → Observatory → test stocks, CreditDesk and policy → indexer and registry → pre-liquidation, AaveDesk, ProtectionVault, Reserve → fork replay and nightly assurance → router, self-repaying and local-money legs → API, SDK, widget, console, app, agent surface → drills, evidence, docs → deck, videos, submission |

## 3. Repository map

| Path | What | Verified by |
| --- | --- | --- |
| `contracts/src/calendar/` | `MarketCalendar.sol` (onchain NYSE sessions in ET, DST and civil-date math, append-only year loads), `Nyse2026.sol` (2026 holidays and early closes) | 18 generated tests + 2 differential tests on 5,643 instants |
| `contracts/src/oracle/` | `SessionGate.sol` (verdict engine), `SessionGuard.sol` (Morpho `IOracle`), `ShadowGuard.sol` (pre-liquidation oracle on the Aerodrome TWAP) | 34 tests + fork test on live Morpho |
| `contracts/src/desk/` | `CreditDesk.sol` + external `CreditDeskLib.sol` (partner-scoped self-custody credit lines on Morpho, policy engine, decision hashes; since 7 Oct `protectionVault` + `recoverCollateral`, callable only by the registered vault, for the Monday recovery of an advance) | 24 tests on the etched mainnet Morpho bytecode |
| `contracts/src/protection/` | `Protector.sol` (Boundline's pre-liquidator: sells the seized collateral on the collateral's own pool inside `onPreLiquidate`, on-chain sizing cap, decision hashes), `interfaces/ICLSwapPool.sol`, `vendor/` (morpho-org pre-liquidation, GPL-2.0-or-later, built via-IR through a `compilation_restrictions` entry) | 18 tests on the etched Morpho + 4 fork tests under base-forge |
| `contracts/src/aave/` | `AaveDesk.sol` + external `AaveDeskLib.sol` (self-custody lines on the Aave V4 MAG7 spoke through the Taker), `ProtectionVault.sol` (seven-day protective repay through the Giver, bounded advances, recovery through the Taker; since 7 Oct an `IAdvanceSink` with a `funder`, the Reserve), `AaveEnrolment.sol`, `AaveTypes.sol`, `interfaces/IAaveV4.sol` (own minimal interfaces of v0.5.11) | 54 unit and invariant tests on mock spoke and managers; 8 fork tests on the live spoke under base-forge (6 under stock forge) |
| `contracts/src/payout/` | `LocalPayoutRouter.sol` (7 Oct): the local-money leg at the end of a borrow batch: pulls USDC, swaps on a Slipstream/Uniswap-v3 pool (direct swap + callback) or an Aerodrome v2 pool, enforces `deadline`, `minOut` and, when `gateToken` is set, the SessionGate's `OPEN`; refunds unfilled input, records `payouts` per sender; no owner, holds nothing between calls. `contracts/src/test/MockStable.sol`, `MockV2Pool.sol` | 15 tests; fork test on the real Aerodrome EURC/USDC pool (base-forge 4/4); live on Sepolia |
| `contracts/src/reserve/` | `BoundlineReserve.sol` (ERC-4626 over USDC: capital providers fund advances; allocations to `IAdvanceSink`s under a utilisation cap, redemptions behind a cooldown, `harvest` folds fees into the share price, `writeDown` records a loss), `DeskProtectionVault.sol` (the ProtectionVault's shape over CreditDesk lines: user and partner reserves, keeper `protect(lineId, amount)` → `desk.repay` down the ladder, bounded advances with a fee, `recover` through the desk's `recoverCollateral` in open sessions only), `IAdvanceSink.sol` | 16 + 13 + 6 invariants + 5 deploy tests; live on Sepolia (section 6.1) |
| `contracts/src/test/` | Sepolia simulators: `TestPriceFeed`, `MirrorOracleRegistry`, `MockB20`, `MockCLPool`, `MockSwapPool` (fixed-price swap over `MockCLPool`, the Protector's Sepolia sale venue) | 20 tests |
| `contracts/src/interfaces/`, `libraries/` | `IMarketCalendar`, `IPriceGate`, `IAggregatorV3`, `IOracleRegistry`, `ICLPool`, `IEligibility`; Uniswap `TickMath` (GPL-2.0-or-later, own header) | |
| `contracts/script/` | `DeployCalendar`, `DeploySepoliaSimulators`, `DeployOracles` (Sepolia and mainnet paths), `CreateSessionSafeMarket` (`run`, `seed`), `IssueTestStocks` (B20 factory flow, `wire`), `DeployCreditDesk` (desk + market + partner + policy in one run), `DeployProtection` (pool, ShadowGuard, factory, pre-liquidation, Protector), `DeployAave` (mainnet only, keyless dry run, simulated on a base-anvil fork), `wire-sepolia.sh` (the Cobalt wire as checked `cast` calls, guard retries while RPC nodes catch up), `wire-protection-sepolia.sh`, `README.md` with the recipes that worked | 6 + 9 + 4 tests on base-std's mocks and the etched Morpho; all dry-runnable keyless |
| `contracts/test/fixtures/` | `calendar-2026.json` (differential fixture), `morpho-blue-8453.runtime.hex` (mainnet Morpho runtime bytecode, etched in desk tests) | |
| `contracts/broadcast/` | Foundry broadcast records of every real deploy (committed; `dry-run/` ignored) | |
| `deployments/` | `base-sepolia.json` (addresses, txs, proofs), `README.md` | |
| `packages/calendar` | `@boundline/calendar`: the calendar in TypeScript (`Intl`-based), fixture generator | 98 tests, zero disagreements with Solidity |
| `packages/chain` | `@boundline/chain`: Base mainnet and Sepolia addresses, ABIs, viem client with RPC fallback, bigint TickMath and price math, Aave V4 constants, EIP-712 types and enrolment calls (`aave.ts`) | 19 tests |
| `packages/sdk` | `@boundline/sdk`: viem-only reads (line, quote, capacity, gate verdict, Morpho authorisation), session and health copy, prepared calls, `borrowBatch`/`repayBatch` for `wallet_sendCalls` with the ERC-7677 paymaster and ERC-8021 suffix as options, Flashblocks preconfirmation polling, partner-API client; ABIs generated from the forge artifacts | 58 tests, enum names asserted against the Solidity sources |
| `apps/observatory` | `@boundline/observatory`: Cloudflare Worker, per-minute snapshot cron (hand-rolled Multicall3 reads since 6 Oct; Morpho positions on minute 0 of every five, **Aave V4 positions** on minute 1, the **weekend-gap panel** on minute 2 of every ten), reopen capture runs, real Morpho and Aave positions with shadow health (`aave-positions.ts`: spoke and oracle reads hand-rolled, the Σ value×factor/debt model reproduces the spoke's `healthFactor` to four decimals), `/v1/gaps` (indexer rounds + the bundled 2–4 Oct evidence + capture runs), `/v1/assurance` (KV from the replay), JSON API, HTML page with six panels, D1 (migrations 0001–0003) and KV | 210 tests, live |
| `apps/keeper` | `@boundline/keeper`: per-minute cron with two jobs: the Sepolia feed mirror (raw JSON-RPC adapter `raw.ts`, one unwaited transaction per tick; vars `MIRROR_HOLD_FEED` / `MIRROR_HOLD_REGISTRY` hold a drilled symbol since 7 Oct) and the **protection job** (`protect.ts`, `protect-job.ts`: reads every watched borrower's `Protector.sizing`, arms the allowed action as a validity transaction through the sequencer, re-armed every tick); routes `/v1/status`, `/v1/protect`, `/v1/config`; `scripts/validity-tx.ts` for one-off validity transactions | 65 tests, live |
| `apps/agent` | `@boundline/agent`: the agent surface, an MCP server over streamable HTTP (`POST /mcp`, hand-rolled JSON-RPC: initialize, ping, tools/list, tools/call) with REST aliases (`POST /v1/tools/:name`); tools `session`, `positions`, `shadowHealth`, `quote`, `protect`, `route` over the other Workers through service bindings; read-only, holds the partner key as a secret | 13 tests, live |
| `packages/router` | `@boundline/router`: the credit router, pure and dependency-free: `route(request, candidates)` chooses venue and market by session verdict, policy and venue LTV, liquidity, protection and rate (deterministic rank), Saturday mode (half capacity at min(held feed, TWAP) less a haircut, around-the-clock venues only), `canonicalRoutePlan`, `routePlanTypedData` (EIP-712 `Boundline Router` v1) | 11 tests |
| `packages/ledger` | `@boundline/ledger`: the five-way conservation model as pure functions (proceeds = debt reduction + fees + reserve settlement + borrower remainder; advanced = settled + outstanding; collateral in = sold + returned; debt before = after + repaid; bad debt ⊂ remaining debt), running totals per subject | 10 tests (drill numbers, fork numbers, generated events) |
| `apps/indexer` | `@boundline/indexer`: events into D1 with per-source cursors, hash-chained daily roots, Morpho reconciliation; phase 2 adds five Base mainnet sources behind `INDEX_MAINNET` (feed aggregators, OracleRegistry, B20 tokens, 13 B20 Morpho markets, Aave MAG7 spoke), rotation and a per-tick budget; routes `/v1/events` (with argument filters), `/v1/sources`, `/v1/feeds/:symbol/rounds` (weekend-gap history), `/v1/venues/aave/borrowers`, `/v1/desk/lines`, `/v1/desk/lines/:id/timeline`, `/v1/roots`, `/v1/reconcile/latest` | 69 tests, live |
| `apps/api` | `@boundline/api`: partner API over the CreditDesk (keys, lines, quotes, obligations served from the indexer, decisions and `/v1/lines/:id/decisions` timelines; correlation id, idempotency, policy version, quote hash); since 7 Oct **x402 metering** on `POST /v1/quotes` and `GET /v1/positions/:addr/shadow` for keyless callers ($0.01 USDC, x402.org facilitator, v1 body + v2 header, hand-rolled in `x402.ts`), `/v1/policy` and prepared policy versions (`policy.ts`, migration 0002), `/v1/drills` (`drills.ts` + runs bundled from `docs/evidence/drills`), `/v1/reconciliation`, `/v1/evidence/export` (keccak over canonical JSON), shadow health per address (`raw.ts` encodes `Protector.sizing`) | 85 tests, live |
| `apps/app` | `@boundline/app`: the Boundline app (partner #1): Vite + React 19 + wagmi 3 + Base Account; portfolio, borrow widget (since 7 Oct with a "Receive as" selector: USDC or a local stablecoin through the payout leg, local amount and slippage bound shown), protect (pre-liquidation opt-in), statements (local-money payouts panel); a Worker serves the assets and proxies `/api/*` to the partner API and the indexer through service bindings with the partner key as a secret | typecheck + build, live |
| `apps/console` | `@boundline/console`: the partner console (7 Oct): obligations and decision timelines, policy editor producing prepared versions (field-level diff, the `setTickerPolicy`/`setPartnerConfig` calls the admin signs with wagmi, version history), drills with recorded runs as timelines, reconciliation (latest run, daily roots, source cursors), evidence export with the bundle hash recomputed client-side; Worker proxies `/api/*` to the API, indexer and Observatory through service bindings, forwards a pasted partner key or uses its own secret | 30 tests, live |
| `apps/site` | the landing page (7 Oct): static assets, live session and feed table from the Observatory, real proof hashes, partner section | live |
| `scripts/reopen-evidence.py` | reconstructs a weekend freeze and reopen from the Chainlink round history (binary search on `getRoundData`, DEX state at the last block before reopen); stdlib only | wrote `docs/evidence/reopen-2026-10-04.*` |
| `scripts/replay/` | the fork replay harness: `run.ts` pins a Base mainnet block, fetches the Aave borrowers from the live indexer, runs `contracts/test/fork/ReplayFork.t.sol` under base-forge (Friday close, −3/−8/−15% feed rewrite through the aggregator's transmission slot, Sunday reopen, raw venue vs Boundline from one EVM snapshot), writes `docs/evidence/assurance/<date>.json/.md`, hashes it and publishes KV `assurance-latest`; `nightly.sh` + `.github/workflows/nightly.yml` (03:00 UTC, needs secrets, no remote yet) | ran 7 Oct: 5 positions × 3 gaps, raw liquidatable 3, Boundline 0 |
| `docs/evidence/` | `reopen-2026-10-04.md/.json` (the 2 to 4 Oct weekend on all ten feeds), `validity-transactions-sepolia.md` (the sequencer's rules and the live transactions), `assurance/` (the replay method and the 7 Oct run with its hash), `drills/` (recorded drill runs the API serves) | |
| `docs/runbooks/` | `saturday-rescue-2026-10-10.md`: the 9–11 Oct weekend drill, minute by minute | |
| `docs/ARCHITECTURE.md`, `docs/THREAT-MODEL.md` | one page each: layers with their proofs; threats, actors, mitigations, status | |
| `scripts/gen-calendar-tests.py` | Python `zoneinfo` oracle that generates the Solidity calendar tests | |
| `docs/BUILD.md` | day-by-day schedule to 10 Oct and the ledger | |
| `.github/workflows/ci.yml` | contracts build/test/fmt, TypeScript build/typecheck/test, fork job gated on `BASE_RPC_URL` | not yet run (no remote) |
| `.env.example` | every key, RPC and account the scripts and Workers read | |

**8 Oct 2026 additions and changes to the map:**

| Path | What | Verified by |
| --- | --- | --- |
| `contracts/src/harvest/DividendHarvester.sol` | the self-repaying leg (section 4.9) | 17 unit tests incl. a 256-run fuzz; fork test on NVDAc's real dividend; 21,310 bytes |
| `contracts/src/aave/AaveVenue.sol` (+ `AaveDeskLib`, `ProtectionVault`) | the hub's `SpokeConfig` (`halted`, `active`) read for both reserves: reason `VENUE_HALTED` (25, appended), `HOLD_VENUE`; `ProtectionVault.venueReason` | AaveDesk 38, ProtectionVault 14 + 5 invariants with hub switches; sizes AaveDesk 22,552, Lib 14,693, ProtectionVault 16,879 |
| `contracts/script/DeployMainnet.s.sol`, `deploy-mainnet.sh`, `DeployMainnet.cost.py`, `DeployHarvest.s.sol` | the whole mainnet footprint in one ordered, resumable run (`plan`, `rehearse`, `broadcast [--resume]`, `check`), 33 post-deploy checks; harvester deploy | rehearsed on base-anvil forks at 52,327,262 / 52,327,370 / 52,328,022: 50 txs, 50.98–51.02M gas, 0.00031 ETH, 33/33 |
| `contracts/test/drills/`, `scripts/drills/` | fork drills `venue-halt` (the real 24 Sep hub halt, freeze, pause) and `bad-debt-probe` (largest Steakhouse AAPLc borrower), `run-fork-drills.sh` (`--only`) | base-forge; 71/71 and 75/75 checks; skip without `BASE_RPC_URL` |
| `scripts/sepolia/` | the Sepolia operator's tools: `bl.py` (helpers), `drills.py`, `record_protect.py`, `stage_line1.py`, `stage_drill_position.py`, `twap.py` (`show`, `mirror`, `ltv --who drill|line1 --bps N`) | used live 8 Oct (123 transactions, all status 1) |
| `docs/evidence/drills/*.json` | 12 drills, 17 runs (live and fork), served by the API's `/v1/drills` | |
| `docs/evidence/validity-rearm-2026-10-08.md` | the re-arm experiment | |
| `docs/submission/`, `docs/deck/` | portal text with an evidence index, 2:00 pitch and 3:00 demo scripts, logo, public-repo checklist, X thread, weekly-update scripts; 12-slide typst deck and PDF | every hash re-checked on chain by the lane that wrote them |
| `docs/runbooks/mainnet-deploy.md` | what a funded key buys and the exact commands | |
| `apps/keeper` | + `vault-job.ts`, `vault.ts`, `events.ts`, `reverts.ts`, `rpc.ts`, `warm.ts`; KV `KEEPER_STATE`; binding `API_EVENTS` | 118 tests |
| `apps/indexer` | + `rpc.ts`, `multicall.ts`, `seize.ts`, `seize-baseline.ts`, `topics.ts`, migration `0003_event_hashes`; sources `sepolia-protection`, `mainnet-policy-registry` | 108 tests |
| `apps/api` | + `route.ts`, `route-signer.ts`, `webhooks.ts`, migration `0003_route_webhooks`; the `Events` WorkerEntrypoint | 118 tests |
| `apps/agent`, `packages/router` | x402 on the REST aliases; candidates and raw encoders moved into `@boundline/router` (`./candidates`, `./raw`) | agent 19, router 15 |
| `packages/sdk`, `apps/app`, `apps/console`, `apps/site` | vault reads and calls, route, webhooks and events clients; the app's route card and protection reserve; the console's webhooks, events and Saturday mode; the site's bridge Worker (`apps/site/worker/`) | sdk 95, console 46 |

## 4. Contracts

### 4.1 Session model (`MarketCalendar`, `@boundline/calendar`)

- Sessions: `UNKNOWN` (no data loaded for the year: fail closed), `PRE` 04:00–09:30 ET, `REGULAR`
  09:30–16:00 (13:00 on an early-close day), `POST` 16:00–20:00 (13:00–17:00 after an early close),
  `OVERNIGHT` otherwise on a trading day, `WEEKEND` Fri 20:00 to Sun 20:00 ET, `HOLIDAY` from the
  eve's 20:00 ET until 20:00 ET on the closure date.
- Instants at or after 20:00 ET belong to the next exchange date's session (matches the feeds, which
  resume Sunday 20:00 ET).
- US DST rule computed onchain (`dstStart`/`dstEnd`), Hinnant civil-date math, `describe(timestamp)`,
  `nextTransition(timestamp, horizonDays ≤ 60)` walking the marks 240, 570, 780, 960, 1020, 1200
  minutes, `wallClockToUtc`, `dateKeyOf`. `Ownable2Step`, append-only `loadYear`, `addClosure`,
  `addEarlyClose`.
- 2026 data: holidays 1 Jan, 19 Jan, 16 Feb, 3 Apr, 25 May, 19 Jun, 3 Jul, 7 Sep, 26 Nov, 25 Dec;
  early closes 27 Nov, 24 Dec.
- Three independent implementations agree: Python `zoneinfo` (test generator), Solidity, TypeScript
  `Intl` (5,643 instants and 300 transitions, zero disagreements).

### 4.2 Oracles

- **SessionGate** (`IPriceGate`, `Ownable2Step`): per-token `FeedConfig{feed, feedDecimals,
  heartbeat (default 24h), tolerance (default 2h), locked}`; `check(token)` never reverts and
  returns a `Verdict{state, session, answer, updatedAt, multiplier, registryPaused, transferPaused}`.
  Precedence `MARKET_CLOSED > FEED_PAUSED > TRANSFER_PAUSED > FEED_INVALID > FEED_STALE > OPEN`;
  every external read is a low-level staticcall and any failure fails closed (registry failure →
  paused, token `isPaused` failure → paused, feed failure → invalid). `priceOf` reverts with named
  errors `MarketClosed(Session)`, `FeedPaused`, `TransferPaused`, `FeedStale(token, updatedAt,
  maxAge)`, `FeedInvalid`, `UnknownToken`. Feeds scale to 8 decimals; `lockFeed` is permanent.
- **SessionGuard** (Morpho `IOracle`): immutables gate, collateral, loan token,
  `SCALE = 10^(36 + loanDecimals − 8 − collateralDecimals)` (1e26 for an 8-decimal stock against
  6-decimal USDC, so $100 = 1e36), optional haircut ≤ 2000 bps outside `REGULAR`. `price()` reverts
  whenever the gate is not `OPEN`, so Morpho's `borrow`, `withdrawCollateral` and `liquidate` revert
  while `repay` and `supplyCollateral` (which never read the oracle) keep working.
- **ShadowGuard** (`IOracle`, `Ownable2Step`): the pre-liquidation oracle. Returns the feed price
  when `OPEN`; when `MARKET_CLOSED` or `FEED_STALE` returns the Aerodrome Slipstream TWAP
  (`observe([window, 0])`, window 5 min to 1 day, Uniswap `TickMath`, floor toward −∞) less a
  haircut (default 200 bps, max 1000) and reverts `ShadowDeviation` if the TWAP is more than
  `maxDeviationBps` (default 3000, range 1000–5000) from the held feed; reverts `ShadowUnavailable`
  on issuer or transfer pause or an invalid feed. Validated against live data: feed 333.66495, TWAP
  tick −12049 → 3.3361e36 within 1e-5.

### 4.3 CreditDesk (self-custody lines on Morpho)

`Ownable2Step`, `ReentrancyGuard`, EIP-712 domain `Boundline CreditDesk` v1. Constructor
`(owner, IMorpho, SessionGate, IPolicyRegistry, enforceB20Policies, keeper)`.

- Partners (`admin`, `signer`, `eligibility` hook, `active`, `policyVersion`, exposure cap and
  exposure) and per-ticker policies (`allowed`, `maxLtvWad` below the market LLTV, `minDraw`,
  `maxDraw`, exposure cap); markets registered only if they exist on Morpho and their oracle's
  `GATE()` is this desk's gate.
- Line statuses `NONE, OPEN, HELD, CLOSED`; obligation statuses `OPEN, HOLD_SESSION, HOLD_FEED,
  HOLD_ISSUER, HOLD_TRANSFER, HOLD_KEEPER, CLOSED`; twenty named refusal reasons (`MARKET_CLOSED`,
  `FEED_STALE`, `TICKER_NOT_ALLOWED`, `NOT_ELIGIBLE`, `PARTNER_CAP`, `INSUFFICIENT_CAPACITY`,
  `NOT_AUTHORIZED_ON_VENUE`, …).
- Flows: `openLine` (EIP-712 `LineAuthorization` when the partner has a signer), `addCollateral`
  (anyone, desk pulls then `supplyCollateral` on behalf of the user), `draw` (owner only, Morpho
  `borrow` with the user as `onBehalf` and receiver, needs the user's Morpho authorisation),
  `repay` (anyone; `REPAY_ALL` pulls exactly `expectedBorrowAssets` and repays by shares, refunds
  excess), `withdrawCollateral` (session-gated plus post-withdraw policy LTV check), `closeLine`,
  keeper `hold`/`release`. `quote` and `capacity` views; corporate-action haircut when a scheduled
  `newUIMultiplier` lower than the current one is within 7 days; B20 `isAuthorized` preflight on both
  legs when enforcement is on; every action emits `Decision(lineId, action, hash, amount, price8)`
  with a chain-, contract- and nonce-bound hash.
- Tested on the real mainnet Morpho bytecode (etched at `0xBBBB…FFCb`, owner written to slot 0,
  mock IRM, LLTV 0.625e18 enabled).

### 4.4 Simulators (Sepolia only)

`TestPriceFeed` (`setAnswer`, `setAnswerAt`, `setRoundData`), `MirrorOracleRegistry` (default
(1e18, not paused); `setPaused`, `setMultiplier`), `MockB20` (ERC-20 with `setPaused(feature)`,
`uiMultiplier`/`newUIMultiplier`/`effectiveAt`), `MockCLPool` (`setAverageTick`, `setCumulative`,
`setObserveReverts`).

### 4.5 Scripts (`contracts/script/README.md` has the env tables)

All dry-run keyless. `IssueTestStocks` creates real B20 assets through the factory precompile
(deterministic salt `keccak256("boundline/test-stock/<SYMBOL>/v1")`, allowlist of holders on
`MINT_RECEIVER_POLICY`, empty blocklist on both transfer scopes, roles, supply cap, `batchMint`);
its `wire(token, venues)` step binds `INTERSECT(blocklist, allowlist)` to the receiver scope and
lists the venues on `SEIZE_EXEMPT_POLICY` (Cobalt only, not yet run). `DeployOracles.runSepolia()`
accepts `<SYMBOL>_TOKEN/_FEED/_POOL/_PRICE_E8`; `runMainnet()` binds all ten Coinbase feeds with
SessionGuards and ShadowGuards for AAPLc and NVDAc (`DRY_RUN_ETCH` stubs are refused in a broadcast).
`CreateSessionSafeMarket` is permissionless `createMarket` with the AdaptiveCurveIrm at 62.5% LLTV;
the AAPLc/USDC mainnet market was simulated against the live Morpho (about 5.9M gas). `DeployCreditDesk`
(`--tc DeployCreditDesk`, env `GATE`, `KEEPER`, `COLLATERAL`, `ORACLE`, `PARTNER_ID`, policy values) deploys the
desk, registers the market, creates the partner and sets the ticker policy with named pre-check errors.
**Size:** the monolithic desk was 28,271 bytes at the project's 10,000 optimizer runs (EIP-170 allows 24,576), so
Sepolia got it with `FOUNDRY_OPTIMIZER_RUNS=200` (23,634 bytes). It is now split: `CreditDesk` (19,738 bytes: state,
access control, orchestration, accounting, events, decision hashes) plus the external `CreditDeskLib` (15,073
bytes: quote, obligation status, expected debt, market checks, add-collateral, borrow, repay-all, withdraw,
signature validation, B20 preflight) called by DELEGATECALL; ABI, storage layout and events unchanged. CI runs
`forge build --sizes --skip 'test/**' --skip 'script/**'`. The Sepolia desk at `0x39aB…399a` is still the 200-run
monolith; it is redeployed with the library version at the feature-freeze redeploy. `wire-sepolia.sh` performs the Cobalt wire (allowlist the venues, composite
`INTERSECT(blocklist, allowlist)` on the receiver scope, seize-exempt list) as `cast send` calls, each preceded by
the identical `eth_call`, because base-forge's local simulation runs Beryl precompiles.

### 4.6 Protected mode on Morpho (`contracts/src/protection/`, 6 Oct 2026)

- Morpho's audited `PreLiquidation` / `PreLiquidationFactory` are vendored (`vendor/`, GPL-2.0-or-later headers kept)
  and built via-IR at 999,999 runs through a `compilation_restrictions` entry, because the default pipeline makes
  `preLiquidate` stack-too-deep. The pre-liquidation oracle is a **ShadowGuard**, so a position is priced live at any
  hour: the fresh feed in session, the pool TWAP less 200 bps while the feed is held.
- **`Protector`** (`Ownable2Step`, operators = owner + a settable keeper): `protect(preLiq, borrower, seizedAssets,
  repaidShares, maxCollateralSold, deadline)` runs `preLiquidate`; inside `onPreLiquidate` the seized collateral already
  sits in the Protector, which sells exactly enough of it on the collateral's own Slipstream pool (direct pool swap with
  the Uniswap-v3 callback, no router) to cover `repaidAssets`, approves the pre-liquidation contract, and keeps the
  remainder (preLIF just above 1.0) for the Reserve. `sizing(preLiq, borrower, targetLtv)` is the on-chain cap: standing
  (`NO_POSITION`, `NO_SHADOW_PRICE`, `BELOW_BAND`, `IN_BAND`, `ABOVE_LLTV`), shadow and venue LTV, the largest partial
  that returns the shadow LTV to `preLltv`, and whether a full close-out may run. Every action emits `Protected` with a
  chain-, contract- and nonce-bound decision hash.
- **Design fact:** `PreLiquidation.onMorphoRepay` calls `Morpho.withdrawCollateral`, which re-checks health through the
  **market** oracle. On a SessionGuard market while closed a partial pre-liquidation therefore reverts `MarketClosed`;
  only a full close-out (every share repaid, Morpho skips the oracle at `borrowShares == 0`) can execute. Partials run at
  any hour on held-price markets (the mainnet Steakhouse targets) and in session everywhere. `sizing` reports it,
  `protect` enforces it.
- Fork proof (base-forge, Alchemy archive): real borrower `0x8E87…0e9f` on the Steakhouse AAPLc market `0xae1a…3c28`,
  Saturday warp, Morpho calls the position healthy at the held feed, the Protector pre-liquidates at the TWAP and sells
  the seized AAPLc on the real Aerodrome pool.

### 4.7 Aave V4 as the second venue (`contracts/src/aave/`, 6 Oct 2026)

- **`AaveDesk`** (+ external `AaveDeskLib`, 22,552 + 13,664 bytes): self-custody lines on the Aave V4 MAG7 spoke through
  Aave's activated **Taker**. `openLine(partnerId, reserveId)`, `draw` by the line owner → `Taker.borrowOnBehalfOf(spoke,
  7, amount, user)`; the Taker pays the caller, so the desk forwards to the line owner in the same call and that is the
  only path. SessionGate `check(collateralToken)` must be `OPEN` before every draw, the CreditDesk's policy shape and
  reason codes are kept (first 20 reasons and 8 statuses in the same order) and extended with `VENUE_PAUSED`,
  `VENUE_FROZEN`, `NO_COLLATERAL`, `COLLATERAL_DISABLED`, `VENUE_UNHEALTHY`, `HOLD_VENUE`; capacity is
  `min(policy headroom, the spoke's own headroom)`; `repay` by anyone through the Giver; decision hashes.
- **`ProtectionVault`**: USDC reserves per user and per partner; keeper `protect(user, amount)` walks the ladder user
  reserve → partner reserve → bounded vault advance (fee 1%) and pays `Giver.repayOnBehalfOf` at any hour; `recover`
  settles an advance through `Taker.withdrawOnBehalfOf` in open sessions only (the sale leg is a later lane);
  five-way conservation invariants (advanced = recovered + outstanding, no negative balance).
- **`AaveEnrolment`** documents the batch a Base Account user signs: `setUserPositionManager(Taker)`,
  `setUserPositionManager(Giver)`, `Taker.approveBorrow(spoke, 7, desk, cap)` (or the `WithSig` variants through the
  SignatureGateway; domains `TakerPositionManager`/`1` and `Spoke`/`1`, keyed nonces `(key << 64) | seq`).
- Fork proof (6 Oct, live spoke `0x1790…7B8D`, borrower `0xC9Bc…ca66` with 14.77 AAPLc and 3,943 USDC debt,
  impersonated): enrolment, a 10 USDC draw through the live Taker in the PRE session, an 80 USDC Saturday protective
  repay through the live Giver (50 from the user reserve, 30 advanced) with the weekend draw still refused
  `MARKET_CLOSED`, and a 0.1 AAPLc recovery through the Taker (a real B20 transfer, base-forge only). Live facts:
  collateral factors AAPLc 78%, NVDAc 70%, TSLAc 65%; spoke oracle `0xaBaf…2A47`; USDC debt on the spoke 1.23M.

### 4.8 The Reserve and bounded advances (`contracts/src/reserve/`, 7 Oct 2026)

- **`BoundlineReserve`** (OpenZeppelin `ERC4626` over USDC, `Ownable2Step`, `ReentrancyGuard`): capital providers
  deposit USDC and hold `blUSDC`; the manager allocates idle USDC to registered sinks (`allocate` → `fundAdvances`,
  `recall` → `defundAdvances`, `harvest` → `collectFees`), `totalAssets = idle + Σ allocated − writtenDown`; after any
  allocation `Σ allocated ≤ utilisationCapBps × totalAssets` (max 90%); redemptions go through `requestRedeem` and
  are honoured after `cooldownSeconds`, capped by idle USDC (`maxWithdraw`/`maxRedeem` reflect both).
- **`IAdvanceSink`**: `fundAdvances`, `defundAdvances(amount, to)`, `collectFees(to)`, `advanceLiquidity`,
  `totalOutstanding`, `feesCollected`. `ProtectionVault` (Aave) and `DeskProtectionVault` (Morpho) implement it; each
  has a `funder` (the Reserve) allowed to fund, defund and collect besides the owner.
- **`DeskProtectionVault`**: the Morpho-side ladder for CreditDesk lines. Keeper `protect(lineId, amount)` reads the
  line, takes user reserve → partner reserve → bounded advance (fee ≤ 500 bps, cap per line), approves the desk and
  calls `desk.repay` (callable by anyone, pulls from the caller), returns unused funds up the ladder, records the
  advance and emits `Protected` with a decision hash; `repayAdvance` by anyone; `recover(lineId, amount)` keeper-only
  in an open session calls the desk's **`recoverCollateral`** (callable only by the registered `protectionVault`,
  session-gated like a withdraw, post-withdraw policy LTV check, receiver = the vault), then `returnCollateral`.
  Invariants: USDC held == user reserves + partner reserves + free advance liquidity + fees; advanced == settled +
  outstanding per line; per-line outstanding ≤ cap; held collateral attributed to its line; a protect never raises
  debt; desk exposure == Σ principal.
- Sizes at 10,000 runs: CreditDesk 20,807 (3,769 under EIP-170), CreditDeskLib 15,097, DeskProtectionVault 18,000,
  BoundlineReserve 13,568, ProtectionVault 15,186.
- The live Sepolia desk predates `setProtectionVault`/`recoverCollateral`: the repay path is live (section 6.1), the
  recovery path is unit- and invariant-proven and goes live with the freeze redeploy, when the Cobalt receiver
  allowlists of the three test stocks must also admit the vault (else `PolicyForbids`).

### 4.9 The self-repaying leg and the Aave hub halt (8 Oct 2026)

- **What a dividend is on chain (researched 8 Oct):** the Chainlink Coinbase feeds report total return (share price ×
  the OracleRegistry multiplier); a token's raw balance never changes and one token redeems for `multiplier` shares. On
  mainnet the registry multiplier equals the token's own `multiplier()`: AAPLc 1.0, GOOGLc 1.000377118676784179, METAc
  1.000313792289598084, NVDAc 1.000537939576369481, each moved once by an issuer `announce` (NVDAc's is a "Cash Dividend"
  in Coinbase's corporate-actions API: tx `0x7aef5d1292d0f78b1cdc05518301553fc7220e5a0022d98b822dc09ac925ddcd`, block
  52,041,960). So any venue valuing raw × feed already counts every dividend (multiplying again is the v1 double count),
  and the harvestable collateral is `raw × (m1 − m0) / m1`, which leaves exactly the share count held at `m0`.
- **`DividendHarvester`** (21,310 bytes): opt-in by `Morpho.setAuthorization(harvester, true)` plus `enroll(marketId,
  lineId, mode)`; `harvest(user, marketId, deadline)` by an operator in an OPEN session only: flash-borrows the repayment
  from Morpho, repays through `desk.repay` (desk lines; Morpho for plain positions), withdraws only the dividend
  collateral, sells it on the stock's pool above a price floor (exact output, the Protector's direct-swap pattern), supplies
  the unsold rest back, and checks LTV did not rise. Rises above `maxStepBps` (splits), falls, `HEADROOM` mode and no-debt
  re-base without selling. The desk's `Line` holds no collateral amount (it reads Morpho), so the direct withdrawal cannot
  desync it. Fork proof: real Steakhouse borrower `0xcBFB…f2E6` (4.888 NVDAc, 425.11 USDC debt): 259,715 raw NVDAc sold on
  the real Aerodrome pool, 0.599048 USDC repaid, 3,086 raw back on the position. **Live on Sepolia since 9 Oct**
  (`0x5b1d1975929d764f41BAb9DA32C696ba137BD58E`, verified; section 6.1): routed to the AAPLt pool, admitted to AAPLt's
  allowlist and seize-exempt list, line 1 enrolled (HARVEST), keeper = the protection signer; four live harvest calls
  recorded in `docs/evidence/drills/dividend-harvest.json`. The reserve-yield source is still not built.
- **Aave hub halt:** the real 24 Sep 2026 halt was hub-level (`SpokeConfig.halted` through the Safe → executor → payload
  → `HubConfigurator.updateSpokeHalted` for all 8 assets; halt tx `0x86de199821582541271107b04751115aafeec608901a6260b0a27af52c0eed8f`),
  which `AaveDesk` did not read: during the replayed halt it quoted `NONE` with 991.48 USDC available and recorded `OPEN`.
  Fixed (`AaveVenue`): quotes and records fail closed on a halted or unreadable hub (`VENUE_HALTED`, `HOLD_VENUE`, 0
  available); desk and vault repays refuse only on a positive read of a halt or a paused USDC reserve, so a bad read never
  blocks protection; `recover` refuses on a halted or unreadable hub and a paused collateral reserve.

## 5. TypeScript

- **`@boundline/calendar`**: `sessionAt`, `isFeedLive`, `describe`, `nextTransition`, `dateKeyOf`,
  `zoneFields`, `wallClockToEpoch`, `NYSE_2026` (with `source`), `SESSION_CODE`, boundary marks; since 6 Oct also
  `zoneFieldsArithmetic` (US DST by rule, Hinnant civil-date math, no Intl), `setZoneResolver`, `nextFeedBoundary`;
  Intl stays the default so the TS-versus-Solidity differential keeps its independence, and the arithmetic resolver
  agrees with Intl on the 5,643-instant fixture, every 2025–2027 DST boundary and a 30,000-instant sweep.
- **`@boundline/chain`**: `B20_TOKENS` (ten Coinbase stocks), `MAINNET`/`SEPOLIA` address books,
  `AAVE_MAG7_RESERVES`, `FEED`, ABIs (aggregator, OracleRegistry, B20 asset and factory, policy
  registry, Morpho, Morpho oracle, Aave spoke, CL pool, ERC-20) and `TOPICS`; `createBaseClient`
  builds a viem `fallback` transport from a comma-separated RPC list (`PUBLIC_RPC_URLS` per chain);
  `tickToPrice36`, `twapTick`, `divergenceBps`, `feedAgeSeconds`.
- **`@boundline/observatory`** (Hono on Workers): routes `/`, `/health`, `/v1/tokens`, `/v1/feeds`,
  `/v1/sessions`, `/v1/venues/morpho/markets`, `/v1/venues/aave/positions`, `/v1/events` (501 until
  the indexer), `/v1/positions/:addr/shadow`. **Since 6 Oct the tick is CPU-lean:** hand-rolled Multicall3
  encode/decode (`src/encoding.ts`, calldata built once at module scope, one `eth_call` that also carries Multicall3's
  block number and timestamp), raw JSON-RPC with ordered fallback (`src/rpc.ts`; the secret `BASE_RPC_URL_PRIVATE` =
  Alchemy serves `eth_call` first, log scans use the public list because Alchemy's free tier caps `eth_getLogs` at 10
  blocks), the arithmetic ET calendar (`setZoneResolver("arithmetic")`, differential-tested against Intl), liveness
  flips found by walking 20:00 ET marks and cached, the Borrow scan and market reads hand-rolled too; measured 4–9 ms
  CPU per snapshot tick, 20 of 21 events `ok` after the deploy, 30 of 30 minutes recorded. A second cron trigger
  (`*/5`) never fired on this account, so positions run on every fifth minute of the one cron. Cron `* * * * *` snapshots every feed, registry flag,
  pause, multiplier, DEX price and TWAP into D1 (one row per token per tick) and writes KV `latest`
  only when the fingerprint changes or every 10 minutes (free-tier budget). `EXPORTS` (R2) is
  optional. Reads go through the RPC fallback list; a keyed RPC can be the secret
  `BASE_RPC_URL_PRIVATE`. Reopen capture: a window from 15 minutes before to 90 minutes after every feed
  transition records each token's rounds, DEX price and TWAP and the first post-reopen print with its lag and gap
  (`/v1/captures`). Real positions: borrowers of the mainnet B20 Morpho markets with venue health versus shadow
  health at the Aerodrome TWAP and a protection flag (`/v1/positions`, `/v1/positions/:addr/shadow`).
- **`@boundline/keeper`**: cron every minute. **Mirror job:** reads the mainnet rounds for AAPLc, NVDAc, TSLAc and
  the OracleRegistry params through a hand-built Multicall3 `aggregate3` (`raw.ts`), copies them with `setRoundData`
  and `setOracleParams` onto the Sepolia simulators when they differ, signs with the memoised local account (noble's
  tables built at module evaluation), sends at most `MAX_TX_PER_TICK` (default 1) per tick and never waits for a
  receipt (the next tick's `pending > latest` check covers it). **Protection job:** for every `PROTECT_TARGETS` entry
  (`preLiq:borrower:feed:slot`) reads `Protector.sizing` in one multicall, chooses the partial the contract allows or
  the close-out when no partial can run, signs `protect(...)` with its own key (secret `PROTECT_KEY`) and submits it
  through the sequencer with a storage predicate on the feed's `updatedAt` slot (the action lands only while the feed
  still shows the round the decision was made on) and a 30-block bound, re-armed every tick with a second attempt 35 s
  later. `/v1/status`, `/v1/protect` (live sizing and decision per target), `/v1/config`.
- **`@boundline/indexer`**: cron every minute (its own cron fires since 6 Oct; the Observatory's kick is still there,
  ticks within 40 s of each other are de-duplicated); Morpho events for the Sepolia markets, calendar, gate, test feeds,
  mirror registry and CreditDesk into D1 (500-block ranges, idempotent batches, per-source cursors); daily root
  `keccak256(prev_root ‖ h1 ‖ …)` over canonical event hashes, computed when events arrived or every ten minutes;
  market replay reconciled against `position` and `market`. **Phase 2 (chain 8453, `INDEX_MAINNET=true`):** the ten
  Coinbase feed aggregators (`AnswerUpdated` from block 51,640,000, aggregators resolved once from the proxies), the
  OracleRegistry (`OraclePausedSet` plus role events; no multiplier event exists there), the ten priced B20 tokens'
  governance and corporate-action events, the 13 B20 Morpho markets and the Aave MAG7 spoke (from 52,198,000), with
  source rotation and a per-tick budget (4 ranges per source, 12 ranges and 300 logs per tick). Routes `/v1/events`
  (`chainId`, `source`, `since`, argument filters), `/v1/sources`, `/v1/feeds/:symbol/rounds` (gaps ≥ 6 h with held and
  next answer), `/v1/venues/aave/borrowers`, `/v1/desk/lines`, `/v1/desk/lines/:id/timeline`, `/v1/cursors`,
  `/v1/roots`, `/v1/reconcile/latest`.
- **`@boundline/api`** (Hono, D1): hashed partner keys, bearer auth, idempotency with replay and conflict,
  `X-Correlation-Id`, `X-Policy-Version`, `X-Quote-Hash`; `POST /v1/lines` returns the EIP-712
  `LineAuthorization` typed data plus the `openLine` calldata (the user sends it; the API never signs);
  `POST /v1/quotes` reads the desk, rounds capacity down and charges up, fails closed; `GET /v1/lines/:id`,
  `/v1/obligations` (from the indexer's `LineOpened` events with the current desk status; the API's own cache as a
  labelled fallback), `/v1/lines/:id/decisions` (decoded timeline: action, hash, amount, price, block, tx),
  `/v1/decisions/:hash` (filtered server-side on the indexer).
- **`@boundline/sdk`** (viem, framework-free): `createBoundline({ chainId })` with reads (`getLine`, `quote`, `capacity`,
  `session`, `health` with human copy such as "Wall Street is closed until Sun 20:00 ET; repay and add collateral stay
  open"), prepared calls (`prepareAuthorizeDesk`, `prepareApprove`, `prepareAddCollateral`, `prepareDraw`,
  `prepareRepay` with `REPAY_ALL`, `prepareOpenLine`), `borrowBatch`/`repayBatch` → `wallet_sendCalls` params with
  `capabilities.paymasterService` (ERC-7677) and `capabilities.dataSuffix` (ERC-8021 schema 0, checked against Base's
  worked example), `waitForPreconfirmation` (200 ms polling, an all-zero block hash means preconfirmed), the
  partner-API client; chain config in one place (`BASE_SEPOLIA` carries the desk, the three markets and the
  pre-liquidation; mainnet has `desk: null`).
- **`@boundline/app`** (Vite + React 19 + wagmi 3 + `@base-org/account`): `/` portfolio with the session ribbon and
  health bar, `/borrow` (the widget: capacity from a live quote through the proxy, refusal reasons in words, one
  `wallet_sendCalls` batch authorise → approve → addCollateral → draw with a sequential fallback for wallets without
  EIP-5792, preconfirmation state), `/protect` (Morpho authorisation state and the pre-liquidation opt-in), `/statements`
  (decision timeline). Paymaster and Builder Code are build-time gates (`VITE_PAYMASTER_URL`, `VITE_BUILDER_CODE`), both
  off until the CDP project and the Builder Code exist. The Worker holds no key but the partner API key.

- **`@boundline/observatory` since 7 Oct**: `/v1/venues/aave/positions` (22 positions from the 31 borrowers the indexer has
  seen since block 52,198,000; reserve factors AAPLc 78, NVDAc 70, TSLAc 65 %; shadow HF at the TWAP; `protectionCase`
  under 1.05), `/v1/venues/aave/reserves`, `/v1/gaps` (two weekends: 2–4 Oct from the evidence, 25–27 Sep from the
  indexer; the indexer's mainnet feed cursors trail by about nine days and advance about 1.5 h of chain per minute),
  `/v1/assurance`; `/v1/positions/:addr/shadow` rows carry `venue`. Tick CPU: plain 4–7 ms, Morpho 14–44 ms, Aave
  21–25 ms warm, gaps 16–21 ms, page 15 ms warm (cached `Intl` formatters): the Aave and gaps ticks pass only because the
  account no longer enforces the 10 ms cap.
- **`@boundline/sdk` payout leg** (7 Oct): `preparePayout(cfg, params)`, `borrowBatch({ …, payout })` appends
  `approve(USDC → router)` + `payout` after the draw, `quotePayout` (fixed-rate mock view, CL `slot0`, v2 `getAmountOut`),
  `formatLocal`; `BASE_SEPOLIA.payout = { router, pools: { EURCt } }`, `reserve`, `deskProtectionVault`; 73 tests.
- **`@boundline/api` since 7 Oct**: the auth middleware lets keyless calls through only on the two metered routes, where
  the x402 flow runs (402 with the requirements; `X-PAYMENT` verified and settled through the facilitator; refusals are
  never settled; a partner key is never metered); `GET /v1/policy` reads the desk live; `POST /v1/policy/versions`
  stores a prepared draft (diff + calldata) and `…/applied` checks the desk's `policyVersion` advanced (409 otherwise);
  `GET /v1/drills` serves eleven drill definitions with the recorded runs (weekend-gap 2, partial-repayment 3,
  protection 1, validity-transactions 2); `GET /v1/reconciliation`; `GET /v1/evidence/export` (hash over canonical JSON,
  `?format=download`); `GET /v1/positions/:addr/shadow` (desk lines + Protector standing; decision PROTECT/ALLOW/UNKNOWN).
- **`@boundline/console`** (7 Oct, Vite + React 19 + wagmi): pages Obligations, Line (timeline), Policy (editor, drafts,
  sign-and-apply, history), Drills, Reconciliation, Evidence; `hashing.ts` recomputes the export hash (`hash` and
  `correlationId` excluded) and it matched the live bundle; fixtures behind `VITE_CONSOLE_MOCK=1`.
- **`@boundline/router`** (7 Oct, pure): `route(request, candidates)` → a `RoutePlan` (chosen leg, alternatives in rank
  order, every rejection with a reason: `MARKET_CLOSED`, `FEED_STALE`, `TICKER_NOT_ALLOWED`, `INSUFFICIENT_LIQUIDITY`,
  `BELOW_MIN_DRAW`, `PARTNER_CAP`, …); capacity = collateral value × min(policy LTV, venue LLTV) capped by liquidity,
  max draw and exposure headroom, rounded down; rank = protection first (when preferred), lowest rate, largest capacity,
  venue order, market id; Saturday mode only on around-the-clock venues; `canonicalRoutePlan` and `routePlanTypedData`
  for the signer (the API will sign plans stored on obligations; the agent returns them unsigned).
- **`@boundline/ledger`** (7 Oct, pure): `reconcile(event)` returns the five identities with residuals and a `pass`
  flag; a `Ledger` keeps running totals per line or user; tested on the 6 Oct drill and the Aave fork numbers.
- **`@boundline/agent`** (7 Oct, Workers): MCP server (protocol 2025-06-18, streamable HTTP, JSON-RPC batches, no
  server-initiated streams) and REST aliases; `route` builds candidates from the Observatory's tokens and Morpho
  markets plus a two-step multicall (`market`, `idToMarketParams`, then the IRM's `borrowRateView`; hand-rolled
  encoders in `raw.ts`) on mainnet, or the three Sepolia session-safe markets (AAPLt marked `pre-liquidation`); a
  failed rate read falls back to the Observatory's liquidity and LLTV with rate 0 and a note (fail closed, never
  silent). Live: `route` for 1 AAPLc at a 55% policy chose the Steakhouse market `0xae1a…3c28` at 5.53% APR with
  184.68 USDC capacity, `protection: none` (no Boundline pre-liquidation on mainnet yet).

**8 Oct 2026 (Thursday):**

- **Keeper** (deploys `abcce602` by Lane H, then `74212fbb` by main): five jobs in one cron: feed mirror, registry
  mirror, protection, **vault** and events. **Every action is simulated before signing** (`eth_call` of the exact calldata
  from the signer at `latest`, must pass, and `pending`, a revert blocks): a revert becomes `would-revert` with the error
  decoded by 4-byte selector (98 entries), no signature, no event, and a 150-block backoff in KV unless the target's inputs
  change. Found by the Sepolia operator: `Protector.sizing` never looks at the sale pool's USDC, so an unpayable close-out
  used to be re-armed and reverted every minute. **Vault job** (`VAULT_TARGETS` = `lineId:graceBps:targetBps:shadowOracle:feed:slot`,
  line 1 at grace 52% and target 45%): shadow LTV from the ShadowGuard, amount to the target capped by
  `previewProtect` (no shortfall), `DeskProtectionVault.protect` as a validity transaction with the held-feed predicate;
  it shares the protect signer `0x4066…0373` (the vault's keeper since 8 Oct) with the Protector job: one signature per
  tick, the Protector first. **Re-arms re-sign** with a new hash (tip and cap +25% per 30-block window): in the 8 Oct
  experiment known bytes re-sent after expiry were included 0 of 4 times, re-signed ones 2 of 2 within 1–2 blocks
  (`docs/evidence/validity-rearm-2026-10-08.md`). **KV `KEEPER_STATE`** (`a648931723db46ca90aef102b0fe83bb`): key `hold`
  (JSON `{feed, registry}`, merged with `MIRROR_HOLD_*`, so a drill holds a symbol without a redeploy; commands in
  `apps/keeper/README.md`) and the jobs' grace, armed and backoff state. **Events**: RPC binding `API_EVENTS` →
  `boundline-api#Events`: `grace`, `grace.cleared`, `protect` through `ingest`, and since main's `74212fbb` the keeper's
  cron also calls the API's `tick()` once a minute (the API's own cron never fires). CPU: a raw JSON-RPC client and a
  module-scope warm-up of every cron path took the first tick from 34–36 ms to 5.0 ms idle / 8.9 ms with a signature;
  live 3–6 ms `ok`. Routes `/v1/vault`, `/v1/protect?simulate=…`, `/v1/events/probe`.
- **Indexer** (v7 `cef99b88` by Lane G, then `aba6ef13` by main): raw JSON-RPC with batched ranges, a lean decoder
  differential-tested against viem, one D1 read, one atomic lease and one commit per tick, incremental byte-identical
  roots (migration `0003_event_hashes`); the 20 s lease replaced the start marker that a killed tick left behind (it
  had blocked the Observatory's kick); every invocation `ok` at 8–16 ms; `mainnet-feeds` catching up at about 1,118
  blocks a minute (lag 135.6 h → 110 h by 08:20 UTC, ETA about 3 h). New sources `sepolia-protection` (Protector,
  DeskProtectionVault, Reserve, payout router; vault events folded into line timelines) and `mainnet-policy-registry`;
  `/v1/seize-watch`. **Roots for Sepolia 2026-10-06 and 2026-10-07 report `drift: true`**: the backfill added events to
  days already rooted; re-rooting needs `DELETE FROM daily_roots WHERE chain_id = 84532 AND day >= '2026-10-06'` on D1
  `boundline-indexer` (the permission classifier denied it to the lane: a human approval). **Re-rooted 12 Oct** with
  Farseen's approval: the delete removed 6 rows (6–11 Oct) at 18:23 UTC and the indexer re-formed them by 18:46 UTC after
  hashing the backfilled events (8 per tick), every day `drift: false` and chained to the next: 6 Oct 54 → 61 events
  (root `0x18f17091…`), 7 Oct 31 → 51 (`0xafec52c1…`), 8 Oct 57, 9 Oct 49, 10 and 11 Oct 0.
- **Seize watch (mainnet, 8 Oct):** no `SEIZE_ROLE` has ever been granted on the ten stocks (full-history scan from block
  49,145,000, 187 governance logs, live `hasRole` checks); `SEIZE_EXEMPT_POLICY` went 0 → policy 129 on all ten on Mon 5 Oct
  2026 17:38–18:00 UTC (a blocklist administered by `0x38467bE00970af18076fd08F6b4Cf38Ba91572B1`; two addresses blocklisted
  at block 52,216,975 and removed at 52,217,211); seize receiver policy 0; all seven venue pools exempt (block 52,328,243).
  Observatory panel "Seize watch".
- **Partner API** (`b0264d18` by Lane I): `POST /v1/route` and `GET /v1/lines/:id/route` (plans stored in D1, EIP-712
  signed only once `ROUTE_SIGNER_KEY` exists: pending the human, unsigned with a note until then; keyless x402-metered);
  live: Sepolia 0.02 AAPLt → the AAPLt market, capacity 3.356830 USDC at 1.56% APR, `pre-liquidation`; mainnet 1 AAPLc →
  Steakhouse `0xae1a…3c28`, 184.625650 USDC at 5.46%, `none`. Saturday mode as an off-chain partner policy (versioned,
  around-the-clock venues only; off by default, proven on and off). Webhooks: HMAC-SHA256 signatures (`Boundline-Signature:
  t=…,v1=…`), retries 1/2/4/8/16 min, a bounded poll of the indexer's `credit-desk` and `sepolia-protection` events (one
  source a minute, at most 4 new events), the `Events` entrypoint (`ingest`, `tick`), the echo receiver
  (`/v1/webhooks/echo/:token`; demo receiver `wh_0078c9cd-6ae3-4bd8-ac91-37f5e4710da1`, token `boundline-demo-53a54f87681c`),
  `POST /v1/webhooks/poll` on demand. **The API's own cron trigger never fired** (registered 07:25:55 UTC, nothing in a 7-minute
  tail): the keeper drives `tick()`. `/v1/drills` serves 12 drills and 17 runs. **Hono's default SmartRouter costs 24–26 ms
  CPU on a cold request; `PatternRouter` 0.2–0.3 ms**: API, keeper, indexer and Observatory use `PatternRouter` since 8 Oct.
- **Agent** (`f6ec84db`): keyless REST aliases pay $0.01 through x402 (partner key bypasses, `/mcp` stays free).
- **SDK, app, console, site** (Lane J): `@boundline/sdk` vault reads and prepared calls, route, webhooks and events clients,
  webhook signature verification; the app's route card (`/borrow`) and protection reserve (`/protect`), vault events in
  `/statements`; the console's Webhooks (echo receiver, deliveries), Events and Saturday mode, and a fix for a crash on
  "Prepare version"; the site reads the Observatory and `/v1/drills` through a bridge Worker (its live panel had shown
  "Observatory unreachable" in every browser: no CORS headers) and lists twelve proofs re-checked on chain. Base Pay not
  built: it sends a plain transfer and the vault credits only `deposit`/`repayAdvance`.

**9 Oct 2026 (Friday):**

- **Keeper harvest job** (`apps/keeper/src/harvest-job.ts`, vars `HARVESTER`, `HARVEST_TARGETS` = `user:marketId`): each
  tick one batch (head, a Multicall3 of `keeper()` and every target's `preview`, the signer's nonces, the gas price);
  `READY` → `harvest(user, market, now + 600)`, `STEP_DOWN`/`STEP_TOO_LARGE`/`HEADROOM`/`NO_DEBT` → the same call
  re-bases; simulated from the signer at latest and pending first, a plain transaction (the contract refuses outside
  OPEN, so no validity predicate), gas limit 900k (live: 535,346 harvest, 167,821 re-base). Shares `PROTECT_KEY`, third
  after the Protector and the vault, yields whenever either wanted the signer, never while a transaction is in flight;
  watches (`not-keeper`) until `harvester.keeper()` is the signer. `GET /v1/harvest` is the live view; `/v1/config`
  lists the job. **It reads nothing while it could not act** (`harvestGate`): when the vault's quote says
  `MARKET_CLOSED`/`WEEKEND`/`HOLIDAY` or the venue oracle is not live, and when the Protector or the vault wanted the
  signer; a post-deploy tail had shown 6–8 ms CPU per tick with it reading every minute (3–6 ms on 8 Oct), so every
  Saturday tick and every tick that signs a protection is the 8 Oct profile; in session, with it reading, ticks measured
  4–5 ms (7 ms on the first cold one; 6 ticks, all `ok`, keeper `28fe170c`). 13 tests.
- **Keeper RPC:** a batch whose answer has any rate-limited entry (`-32007 25/second request limit reached` from
  sepolia.base.org, inside an otherwise good array) is re-sent to the next URL; the last URL's answer stands; a revert is
  never re-sent. 1 test (keeper 131 with the gate's tests).
- **Partner API:** `GET /v1/whoami` reads the desk's partner version and stores it when it moved (it said 1 while the desk
  was at 4: policies applied on chain without `POST …/applied`); `GET /v1/policy` stores what it reads; whoami answers
  `policyVersionSource: desk | stored`. The drills registry has 13 drills (`dividend-harvest` added). 3 tests (API 121).
- **Scripts:** `scripts/sepolia/harvest.py` (the operator run; `--by-keeper` lets the Worker act), `scripts/sepolia/friday.py`
  (the runbook's Friday steps as one guarded command); `drills.py` no longer reads a session scratchpad file (the hold
  switch's namespace id is the keeper's `KEEPER_STATE`) and retries a KV write once after `wrangler whoami` when the OAuth
  token expired (`Authentication error [code: 10000]`, seen 8 and 9 Oct); `errors.json` has the harvester's errors.

**12 Oct 2026 (Monday):**

- **Observatory read budget** (`068d65e`): migration `0004_read_budget.sql` (indexes `positions (chain_id, taken_at)`,
  `aave_positions (chain_id, taken_at)`, `snapshots (symbol, feed_updated_at, taken_at)`); the latest-positions views read a
  two-hour range anchored on the newest row with `NOT EXISTS` (a GROUP BY reads the whole history even with an index);
  `lastPositionsTakenAt` is `ORDER BY taken_at DESC LIMIT 1`; `positionsForAddress` uses `address IN (lower, checksum)`
  (`lower(address)` scanned the table). Measured on production-sized synthetic data: 15,901 → 1 rows for the newest
  `taken_at`, 36,000 → ~1,200 for the Aave view, 12,960 + a sort → 1 for the held print. `test/d1-sqlite.ts` runs the
  stores' real SQL on Node's SQLite with every migration and asserts the plans. **Capture runs complete:** the window
  ends at +5400 s to the second, so only a tick landing exactly then completed a run (both live runs stayed open); an
  idle tick now closes overdue runs (`closeOverdueRuns`, one read of 4 rows). Observatory 226 tests. **Deployed 12 Oct
  18:20 UTC** with Farseen's go-ahead, once the account was on Workers Paid: Observatory `704e8868`, migration 0004
  applied remotely; the first idle tick closed both live capture runs (`completedAt` 1791595800 and 1791768600, each the
  run's start + 5400 s).
- **API drills registry** (`48db571`): 14 drills (new `reserve-ladder`: the 7 Oct operator cycle and the 12 Oct keeper run);
  new runs on `protection` (3), `stale-feed` (2), `weekend-gap` (the 9–11 Oct weekend); the list view is 88.7 KB (guard
  raised to 120 KB). Served after the API is redeployed (runs are bundled at build time).
- **Scripts:** `scripts/sepolia/outage_rescue.py` (`show`, `pre`, `stale`, `step1`, `step2`, `restore`, `settle`): the
  feed-outage rescue step by step, snapshotting every number into `docs/evidence/feed-outage-rescue-2026-10-12.json`;
  `forge fmt` clean (`ec86941`).

## 6. Deployments and live state

### 6.1 Base Sepolia (chain 84532), deployed 3 Oct 2026, all verified on sepolia.basescan.org

Deployer and owner `0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E`. Record: `deployments/base-sepolia.json`.

| Contract | Address |
| --- | --- |
| MarketCalendar (2026 loaded) | `0x70575eb938645A9D3E18Dda035f5A6a7713696B8` |
| MirrorOracleRegistry | `0xc78A796710be93774310ff8Cf467EaABCeAb4655` |
| SessionGate | `0x92f59437d4ef5CDcEAe2CcDE89B03A7B4B1Ae427` |
| AAPLt (real B20 asset) | `0xB2000000000000000000000E063E65377cA34141` |
| AAPLt TestPriceFeed (333.66495) / SessionGuard | `0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a` / `0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854` |
| NVDAt (real B20 asset) | `0xB200000000000000000000AEd76Eae58870E2ae6` |
| NVDAt TestPriceFeed (187.50) / SessionGuard | `0x097dCec820dCF11b5e8d0fA698b86714f96dB0e2` / `0xcEDcD908aB8B12766147459fb34F8C6Da4aA7518` |
| TSLAt (real B20 asset) | `0xb200000000000000000000Af3FB2181a8772F804` |
| TSLAt TestPriceFeed (430.00) / SessionGuard | `0x5CB94874E3a54F36Bc8DD9c85405ea300e5b43a1` / `0xcADf92BBDC997fDb5920FF0Ba95B4d2d2b8389B3` |
| Morpho Blue (same address as mainnet) | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| Market AAPLt/USDC, AdaptiveCurveIrm, LLTV 62.5% | id `0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047`, seeded 10 USDC |
| Circle USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| **CreditDesk** (owner deployer, keeper below, B20 enforcement on, verified at 200 runs) | `0x39aBaDc0aAa12D1F7e259b89536Aa1848997399a` |
| Partner `boundline-app` (admin deployer, no signer, cap 1,000 USDC; AAPLt, NVDAt and TSLAt max LTV 0.5, draws 1–100 USDC, cap 500 each) | id `0x626f756e646c696e652d617070…` |
| Market NVDAt/USDC (6 Oct, registered on the desk, unseeded) | id `0x7cb7fcc828a7296f8ea18256e0f5763a5588cfe22df9c943088021c762e58cc9` |
| Market TSLAt/USDC (6 Oct, registered on the desk, unseeded) | id `0xb0e8d25d1c9b822cc718c89666b887698922a7b49fdb00dbdecd70dd4ed9e2f1` |
| Keeper key (owns the feeds and the registry; the mirror signer) | `0x28A50Eb7C2Db2B04638D3b226c724A1Cfe999894` |
| **Protected mode (6 Oct, all verified):** MockSwapPool (USDC/AAPLt, TWAP tick −12021, holds 2 USDC) | `0x5069f3753961efcaea8c7f6ec49a182e2c40081b` |
| ShadowGuard AAPLt (pool TWAP less 200 bps while held, max deviation 3000 bps) | `0x7a53b459be6e5e9a12324cc3417bb027daf73f65` |
| PreLiquidationFactory (vendored) / PreLiquidation AAPLt/USDC (preLltv 0.58, preLCF 1.0/1.0, preLIF 1.01/1.02) | `0x09af92fbfd4bad4a138a9093f08606db02c50c75` / `0xdcae709341aab652144e8afcb47479fe49e133a1` |
| Protector (owner deployer; keeper = the protection signer `0x4066…0373`; route AAPLt → the pool) | `0x5c546946c909718040dd686f63df6cb5e4df442c` |
| Protection signer (keeper Worker secret `PROTECT_KEY`) / validity demo key | `0x40668755c993A551dB05E844fF9150A0C00a0373` / `0xEcC07A1D6306B56f9684F5555C2dE87174Dc6AAE` |

Holders of 1,000 shares of each stock: the deployer, the demo borrower
`0xB789aD318945B37566E2549F65526Cc269a482Fc`, and `0xc709E654f322714261b65280A0f7121B3a0F0BE8`.

Live proofs (weekend session, 3 Oct): the borrower approved and supplied 10 AAPLt as collateral
(succeeds, `supplyCollateral` never reads the oracle); `borrow` of 1 USDC reverts
`MarketClosed(WEEKEND)` (`0x3e363de9…05`); `SessionGuard.price()` and `SessionGate.priceOf(AAPLt)`
revert the same way; `AAPLt.isPaused(feature)` answers `false` for features 0–3.

Wired: AAPLt on 3 Oct (`TRANSFER_RECEIVER_POLICY` = composite `216172782113783970` = `INTERSECT(blocklist 157,
holders allowlist 72057594037928092 + Morpho, desk, keeper)`, `SEIZE_EXEMPT_POLICY` = allowlist `72057594037928099`;
on 6 Oct both lists also admit the Protector, the pre-liquidation and the pool); NVDAt and TSLAt on 6 Oct (composites
`216172782113783972` / `…973`, seize-exempt `72057594037928103` / `…102`). Every `eth_call` prediction matched the
receipt. The keeper mirrors mainnet onto the test feeds every minute (first tick 3 Oct 16:11 UTC), so the Sepolia gate
holds, goes stale and reopens exactly as mainnet does.

**Lines and positions (6 Oct 2026):**
- **Line 1** (borrower `0xB789…82Fc`, AAPLt): 10 AAPLt collateral; the **first in-session draw** of 5 USDC during the
  PRE session (tx `0x661ebb1a…8bac`, block 47759305, Decision `0xdaa6562f…c816`, price 332.67), a 2 USDC repay
  (`0xe3bc2f0b…771b`) and a 0.1 USDC repay delivered as a validity transaction (`0x6b17288f…49dd`): 2.9 USDC debt
  outstanding, LTV 0.09%. The API read the drawn line (`GET /v1/lines/1`, `POST /v1/quotes` 200 with quote hash
  `0x023d1eb2…5d78`, capacity 1,660.35 USDC) and the indexer holds the `Drawn`, `Repaid` and `Decision` events. The
  borrower authorised the pre-liquidation (`0xe66aeda3…4ac5`).
- **Lines 2 and 3** (same borrower, NVDAt and TSLAt): 5 shares of collateral each through `desk.addCollateral` under
  the composite receiver policies; quotes `NONE` with capacity 603.09 and 957.98 USDC; the markets are unseeded (the
  deployer has no USDC left), so draws wait for liquidity.
- **Drill position** (the deployer, directly on Morpho, outside the desk): 0.01 AAPLt and 2 USDC debt, shadow LTV
  60.1% inside the band; authorised the pre-liquidation; the **keeper's protection job pre-liquidated it
  automatically** with a validity transaction (`0x982c7327…b695`, block 47760683, 486,363 gas): 52,273 raw AAPLt
  seized and sold on the pool, 0.171377 USDC repaid, shadow LTV back to exactly 58.00%, `Protected` emitted, 757 raw
  AAPLt kept as the incentive. Every hash is in `deployments/base-sepolia.json` (`proofs`, `protection.drill`).

**7 Oct 2026 additions (all verified on sepolia.basescan.org):**

| Contract | Address | Facts |
| --- | --- | --- |
| `BoundlineReserve` | `0x7AcE5c9ca94d5B67feC97348Ff41778D092a6B6E` | tx `0x1d31ac9e…2acb0`, block 47806313; asset USDC, shares `blUSDC`, owner and manager the deployer, cooldown 3,600 s, utilisation cap 8,000 bps; seeded with 2 USDC (`0xa274b426…97d6`), 1 USDC allocated to the vault (`0x249bfab3…d8ea`); after the live cycle `totalAssets` 2.002 USDC on 2.0 shares |
| `LocalPayoutRouter` | `0x1a6Dbc873F32f3dcE7719F213cf81842856F6354` | tx `0x08644e1a…feff`, block 47806347, gate `0x92f5…e427`; proof: the borrower swapped 0.5 USDC → 0.46 EURCt in the REGULAR session with `gateToken` AAPLt (`0x9090633c…5bd3`, block 47806425) |
| `EURCt` (`MockStable`) | `0xE9E71CFfFd3f053e2C7791277B794fd7aDaeA82A` | "Boundline test EURC", 6 decimals, tx `0x04e0115c…e853` |
| EURCt/USDC pool (`MockSwapPool`) | `0x31f0EB7569D34d72dEC3C80aCB8949bA5Ac96Cd4` | token0 EURCt, token1 USDC, 0.92 EURCt per USDC, 100,000 EURCt seeded, tx `0x2219c23e…90c4` |
| `DeskProtectionVault` | `0x87f600279F021ca859b9903DE884d3A7A169f38c` | tx `0xf24fef6f…b925`, block 47806314; desk `0x39aB…399a`, keeper = deployer (the Worker's protect key takes over when its job learns `protect(lineId, amount)`), fee 100 bps, cap 2 USDC per line, funder = the Reserve, partner admin of `boundline-app` = deployer |

Live cycle on line 1 (7 Oct, all status 1): the borrower deposited 1 USDC into their reserve (`0x648d1da4…7345`);
`protect(1, 0.5 USDC)` repaid 0.5 from the user reserve, debt 2.800134 → 2.300134 (`0xa0efe0c4…9f07`, desk decision
`0x5770ecaf…e1b0`, vault decision `0x87c3ecb6…b53e`); `protect(1, 0.7 USDC)` repaid 0.5 from the user reserve plus a
**0.2 USDC Reserve advance**, debt → 1.600134, fee 0.002 (`0x28c1ec44…08a4`); the borrower settled the advance plus
fee (`0x14c4ffbd…db9a`); the Reserve harvested the fee (`0xf2574764…da67`): one share = 1.001 USDC. Record:
`deployments/base-sepolia.json` `reserve`. **x402 settlements** (same day): a keyless shadow read paid 0.01 USDC
(`0x8816d08f…c6ff`, block 47806632, USDC transfer validity key → `0x2f0d…2a4E`, settled by the facilitator's signer
`0xd407…f1bf`) and a keyless quote (`0x055981d8…a8f9`); record `proofs`.

**8 Oct 2026 (Sepolia operator lane K1; every hash in `deployments/base-sepolia.json` and `docs/evidence/`):**

- **Second automatic protection, found in the cross-check:** the keeper had pre-liquidated the deployer's drill position a
  second time on Tue 6 Oct ~13:56 UTC, unrecorded until today: tx `0x6d45ddc95b314de50f3a3375b2d764302e07a920869fd2000fa768fdc84a40d9`,
  block 47,763,353, 7,116 raw AAPLt seized, 0.023302 USDC repaid, 7,005 raw sold at 330.91685 (venue = shadow, in
  session), shadow LTV 58.3074% → 57.9999%, decision `0x1a78c549…d444`. Now run 2 of the `protection` drill.
- **Line 1 reshaped for the vault drill** (the desk allows one open line per partner, user and market, so there is no
  line 4): withdraw 9.98 AAPLt `0xbc42e179…d5c5`, draw 1.62 USDC `0xd2de1e47…26ce`, a 0.4 USDC user reserve in the
  DeskProtectionVault (`0xa0673e92…3776` approve, `0x070e87e8…7928` deposit). Line 1 now: 0.02 AAPLt, 3.210176 USDC,
  47.8% LTV at the feed.
- **Drill position pre-positioned below the band at the close:** the deployer repaid 0.06 USDC on its own position
  (`0x345aeea78f3e19955461de49b8f1f32845a17102d2c70eeeec00e042c9b7b939`): debt 1.745454 USDC; the MockSwapPool's 1.805321
  USDC covers a close-out with +0.059867; at the mirrored TWAP the position sits at 56.33% while held.
- **Mock TWAP mirrored from the real Aerodrome AAPLc/USDC pool**: tick −12125 ($336.1675; `ShadowGuard.twapPrice36()`
  equals the computed quote), txs `0xcd177bfe…98a2`, `0xd4517a08…116b`, `0xaec35885…9f13`.
- **The DeskProtectionVault's keeper is the Worker's protect signer** `0x4066…0373`: `setKeeper` `0x0154bde33ecbf5cfe11c0651c839533f724e71af75f25e60510628b872ba93b8`
  (block 47,838,039).
- **Six live drills**, every one ended clean (the mirror-key drills inside a KV hold of all three symbols, released):
  `issuer-transfer-pause` (TSLAt: `TRANSFER_PAUSED`, line 3 `HOLD_TRANSFER`, addCollateral `ContractPaused(0)`),
  `ineligible-receiver` (the desk's B20 preflight `PolicyForbids` versus Morpho's opaque `transfer reverted`),
  `scheduled-multiplier` (NVDAt via `announce`: line 2 capacity 592.39 → 296.20 → 592.39), `keeper-hold` (line 1:
  `LINE_HELD`, `HOLD_KEEPER`, a 0.01 USDC repay landed while held), `registry-pause` (TSLAt: `FEED_PAUSED`, the desk shows
  `HOLD_ISSUER`, addCollateral still lands), `stale-feed` (TSLAt: in-session `FEED_STALE`, `HOLD_FEED`, the Worker's
  mirror restored the round).
- **Webhooks proven end to end (main session, afternoon):** the desk's keeper held and released line 1 (inside a KV hold)
  — `hold` `0x5dd9d8df6cac14096e4b0ae3e6eafe6553a0de8a760b271bf0e3438fe91e42b7` (block 47,839,633), `release`
  `0xd1687fdf25da3e4aeed84fde4d731431d35ccd4304ac02d9564111eb33202514` (block 47,839,650); the indexer picked up both
  Decision events, the API's poll (driven by the keeper's cron) made `hold` and `release` events, and both reached the
  echo receiver HMAC-signed with valid signatures, 84 s and 170 s after their blocks (`deployments/base-sepolia.json`
  `proofs`).
- Balances after: deployer 0.039566 ETH, 2.96 USDC; borrower 4.508 USDC; vault 1.4 USDC (1.0 advance liquidity + 0.4
  user reserve); pool 1.805321 USDC; Reserve 1.002 USDC idle. The borrower EOA is EIP-7702-delegated to MetaMask's
  verified `EIP7702StatelessDeleGator` (`0x63c0…e32b`); it still signs normally.

**9 Oct 2026 (main session; `deployments/base-sepolia.json` → `harvest` and two new `proofs`):**

- **DividendHarvester** `0x5b1d1975929d764f41BAb9DA32C696ba137BD58E` (verified): deploy
  `0x15ac4ee1613150727a773d1b89336be26469379fe5e775209b4fd2dd5b2ae347` (block 47,880,898), route AAPLt → pool
  `0xbf7baa5a2f3ec3ced68635c9b74245c0fa52dd184ea5a1fbebffb0e5d1641141`; admitted to AAPLt's allowlist
  `0x148561d2f442c8aad1f090d5177157facbf501ab9d1e8a03b9e387d0c3f9b59e` and seize-exempt list
  `0x523f9b8b3b870b6beadb4c1084513b499ceb1e2b7610bd6ca7bc9615df9e0ad4`; keeper → the protection signer
  `0xd70432405d34ffb1ea3dc6ed7214121d1ef64d0c3b554cf6eaf024d8500e473b`. Borrower opt-in: `setAuthorization`
  `0x68e31e0c9fc047085719b61268865800a174412549c6d3fb33e1f69dccc75f0d`, `enroll(AAPLt market, 1, HARVEST)`
  `0x329962dd07d36e2816c10f1877696dde8a0ee5a63c2ea4566d725040c60e88a9`.
- **Operator run:** step `0x8ee7e75e…59b5`; harvest `0xa44b786744d8246b9352914d843ee96723314d5fd74e2fcaecdafcf85624f680`
  (block 47,881,125: 1,075 raw AAPLt dividend collateral, 1,066 sold, 0.003582 USDC repaid through `desk.repay`, 9 back;
  decision hash `0x12aeea9d…f0aa`); keeper mirror back `0x9f12f40d…22ae`; re-base
  `0xaa136601955d0db9b78243f2e6ee24cc609c0c53ba3bf5013c060466e7efae66` (`STEP_DOWN`).
- **Keeper run (no operator):** step `0x73a3fd0e…8048` (block 47,881,643); the Worker harvested
  `0xb1312b5f7844d1ae1cc2c38e001552f611a457bd605ffb634ffe2d24b1124616` at block 47,881,646 from `0x4066…0373` (1,074 raw,
  0.003579 USDC repaid, decision #2 `0x84d51cc8…e7e4`); mirror back `0x70a96355…2dad`; the Worker re-based
  `0x3827eb336f540895113f3f0d2f66dc3e155fdc3309f32c01c386e0025e47cf2d`. The Sepolia feed was not moved in either run.
- Line 1 after: 1,997,869 raw AAPLt, 3.203147 USDC debt (48.7% at the mirrored TWAP while held); pool about 1.798 USDC
  (headroom over the drill debt about +0.053).

**9–11 Oct weekend:** the Friday mirror was not applied (the one-shot job ran after the close; materiality 6 ticks); at the
close and through the weekend both targets stayed below the band (drill 56.33%, line 1 48.67% while held) and the keeper
signed nothing; the recorded Saturday rescues were not run. The keeper mirrored the Sun 11 Oct reopen onto the test feeds
(NVDAt +19 s, AAPLt +229 s `0xdc69fd45…3c45`, TSLAt +317 s behind mainnet). Record: `docs/evidence/saturday-rescue-2026-10-10.*`.

**12 Oct 2026 (feed-outage rescue; `deployments/base-sepolia.json` → `proofs` 2026-10-12; `docs/evidence/feed-outage-rescue-2026-10-12.*`):**

- Staging: keeper mirror held (KV, all symbols, then AAPLt only); `setRoundData` on the AAPLt test feed, same round and
  answer, `updatedAt` 1791726186 (27 h old) `0x9d1e1d550847b754de0de3e6257966becd9e6817ecb9adc486c049f4ff81b00b` (block
  48,027,552): gate `FEED_STALE` (REGULAR), ShadowGuard source TWAP, `SessionGuard.price()` and a raw `Morpho.liquidate`
  revert `FeedStale(AAPLt, 1791726186, 93600)`, line 1 obligation `HOLD_FEED`.
- Step 1: mock TWAP to tick −11695 (drill position 58.81%, `IN_BAND`); the keeper armed at head 48,027,595 and Base
  included the close-out at 48,027,596: `0x9774913eecd620da53019d701f10c8e90400cb6497030785a2e374360d280352` (559,715 raw
  seized, 1.745740 USDC repaid, 542,123 sold, 17,592 kept, decision #3 `0x8e37f401…8aea`, predicate held).
- Step 2: tick −11086 (line 1 54.00%); armed at 48,027,655, included at 48,027,656:
  `0x47ac5279c4804e73d05f1e8d813775514e4f8b8b09c6ffc7b014fac1956e1d24` (0.40 user reserve + 0.14 advance, fee 0.0014;
  debt 3.203537 → 2.663537; 44.90%; vault decision `0xcacc2f57…12ab`).
- Restore: TWAP mirrored (tick −12242), hold released, the Worker's mirror restored the live round
  `0xd532f47f5671b7955bb69e3f4748ee84ade58ce7920a80e7619a50b21e47d8b4` (gate `OPEN`). Settle:
  `repayAdvance(1, 0.1414)` `0x7b71e812afff01285f20eb4af568a334834dda6b463e5242cd8da7fc8636df9f`; Reserve `harvest`
  `0x5b6874d4c3b9bf415e453c0f1d199a5b406c1b163b5a5e4404815602e8ab11c3` (totalAssets 2.0034 on 2.0 shares).
- After: drill position closed (380,896 raw AAPLt left, no debt); **the MockSwapPool holds 0.052420 USDC** (top it up
  before any further close-out); line 1 2,663,537 raw USDC debt on 1,997,869 raw AAPLt (39.13% at the feed); vault 1.0 USDC
  advance liquidity, user reserve 0; protect signer 0.004834 ETH.

### 6.2 Base mainnet (chain 8453)

**Deployed 13 Oct 2026, 00:24:55–00:26:37 UTC** (blocks 52,530,874–52,530,925) by `contracts/script/deploy-mainnet.sh
broadcast` (runbook `docs/runbooks/mainnet-deploy.md`) from a fresh deployer `0x55463704EB58d25f239A8f353Af2EBE4fe242431`:
50 transactions, 50 succeeded, 51,466,140 gas, 0.00031127 ETH; every address equal to the fork rehearsal run at 00:21 IST
with the same deployer and keeper; 16 contracts verified on Basescan; `deploy-mainnet.sh check` 33 of 33 against mainnet;
first transaction `0x3b1343ef4fc50ae161551014b6df3c8d34992a8690ca2a6825b82d8a4ae6240e`, last
`0x155cc53c1388a863dbee44ffb0b6962f6e8abeb2f9f9a4aef30474d59a3a5a4c`. The session created both keys at Farseen's request
into `~/.boundline/base-mainnet.env` (0600, addresses only printed) and he funded the deployer with 0.005 ETH (0.00469
left). The deployer owns every contract (no `FINAL_OWNER`); the keeper `0x82093784Ade31543404b8AD949E49F314af7612c`
holds the keeper role and no ETH, and no mainnet keeper job runs (nobody has opted in). The session-safe market is
unseeded. Record: `deployments/base-mainnet.json`; broadcast `contracts/broadcast/DeployMainnet.s.sol/8453/`.

| Contract | Address |
| --- | --- |
| MarketCalendar | `0xb45cE0AEAAaADc68D5EbD9573FD8bFA91c1f79e5` |
| SessionGate (all ten Coinbase feeds bound) | `0x327895dA0fe53e18A8af5E98Bc749223B5227Ec6` |
| SessionGuard AAPLc / NVDAc | `0xf94C3C8aEb3E79376868a23f42a31Cb3B6a3F132` / `0x8ffE3c46D677ee3b8CE1773C22607aA340e1fc8E` |
| ShadowGuard AAPLc / NVDAc | `0xaBF4E1Fb06a7d8D56099ff285f2c066B88d04760` / `0xed7DFF91124403E606ff443306643eD2a621769B` |
| Session-safe AAPLc/USDC market (62.5%) | id `0xb50ecaba0652b5a51bde9a747e9b7a2075c7ab68fd3c6ef7c05eabf6bb0f1d28`, created in `0xf2bc11d1eeba35e4335929034a042334d797dda50b7c5d5a74f764da406b4ff7` |
| CreditDesk | `0x1671166DB8B93057Fa9a95b052b86c30E7B6a7Dd` (created in `0x6ca4ed1683471fe9810dc1a7260d19bf00d6c01e0e36b4a51a23d3d7fcbf1f40`) |
| Protector | `0x3D620E6F0d20d5BcC8dbf2d30c81af17AB2932D5` |
| Pre-liquidations: Steakhouse AAPLc / Steakhouse NVDAc / session-safe AAPLc | `0x50353Fd5D28cD5b1481Dd96b0074655484447e2F` / `0x8d2573D18E07186CC87B61ac1593bC293d9ECc8f` / `0x1D6B5C5134C1450f9F07272106aE47637EbFCAFb` |
| AaveDesk / Aave protection vault | `0x405dD60f038D5Aa2C411787113BeF2911F2e783A` / `0xDD17651338D948e8Ec2e1D830EF7705A30DC0800` |
| Reserve / desk protection vault | `0xc4d5d866E9b5aDf35B4FD750fb192d99e20da1B4` / `0x0828f1aDADaf7C1f44B3425337ebE7189c7B1cD9` |
| LocalPayoutRouter / DividendHarvester | `0xFC18E12929a3763476c13463fb05106F6F226112` / `0x10f07f1e905Ff1205B1d6e39CEBe91fF0076E8Ce` |

Wired the same morning: `MAINNET_PRE_LIQUIDATIONS` and `MAINNET_SESSION_SAFE_MARKETS` in `packages/router` (routes to the
three markets say `pre-liquidation`; the session-safe one never gets Saturday mode), `BASE_MAINNET` in `packages/sdk`,
`LOCAL_PAYOUT.mainnetRouter` in `packages/chain`. METAc and GOOGLc get no pre-liquidation (no 24/7 pool in the address book). Constants the code relies on: Morpho
`0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`, AdaptiveCurveIrm
`0x46415998764C29aB2a25CbeA6254146D50D22687`, OracleRegistry
`0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD`, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
AAPLc `0xb200000000000000000000C2e324d24d7eEcd1fb` with feed
`0x787f13dEa48Db0897CbCDD985de77809D837F988`, Aerodrome AAPLc/USDC pool
`0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0`, NVDAc/USDC pool
`0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9`. Precompiles on every Base network: B20 factory
`0xB20f000000000000000000000000000000000000`, PolicyRegistry
`0x8453000000000000000000000000000000000002`, ActivationRegistry `0x8453…0001`.

### 6.3 Live services

| Service | Where | Notes |
| --- | --- | --- |
| Observatory | https://boundline-observatory.papermind-ai.workers.dev | Worker `boundline-observatory` on Farseen's Cloudflare account; KV `SNAPSHOTS` `aa7d8b27e629463da60008acfeccc30d`; D1 `boundline-observatory` `dce1418d-1356-40ba-b6a8-5915ddbd95a7` (migration 0001 applied); cron every minute; no R2 (login lacks the scope). Redeploy: `cd apps/observatory && pnpm exec wrangler deploy`. |
| Keeper | https://boundline-keeper.papermind-ai.workers.dev | Worker `boundline-keeper`; secret `KEEPER_KEY`; cron every minute; `/v1/status` shows both chains per pair. Redeploy: `cd apps/keeper && pnpm exec wrangler deploy` |
| Indexer | https://boundline-indexer.papermind-ai.workers.dev | Worker `boundline-indexer`; D1 `boundline-indexer` `dde9a6a8-e474-43a0-a809-b7f5e2e91ca4` (migration 0001); `CREDIT_DESK_SEPOLIA` set. **Its own cron trigger never fired on this account** (40 minutes, re-registered once), so the Observatory's cron calls its `POST /__tick` through a service binding with the shared secret `TICK_TOKEN` (also `INDEXER_TICK_TOKEN` on the Observatory; value in `~/.boundline/cloudflare-internal.env`); verified: cursors advance every minute, 32 Sepolia events, reconciliation PASS 3/3 |
| Partner API | https://boundline-api.papermind-ai.workers.dev | Worker `boundline-api`; D1 `boundline-api` `9dee89e3-b1bd-42b3-b91c-adbcf9f58da9` (migrations 0001, 0002 policy versions); vars since 7 Oct `MARKETS` (JSON with the protection contracts), `X402_ENABLED`, `X402_PAY_TO` `0x2f0d…2a4E`, `X402_FACILITATOR`, `X402_NETWORK` base-sepolia, `X402_PRICE_USDC` 0.01; vars `CREDIT_DESK`, `INDEXER_URL`, service binding `INDEXER` (Worker-to-Worker fetches over workers.dev are refused with Cloudflare error 1042); partner `boundline-app` seeded, key in `~/.boundline/boundline-api-partner-keys.txt` (hash only in D1). Verified live: `GET /v1/lines/1` (status OPEN, obligation HOLD_SESSION), `POST /v1/quotes` (MARKET_CLOSED, WEEKEND), `GET /v1/decisions/<hash>` resolving the openLine decision from the indexer |
| App | https://boundline-app.papermind-ai.workers.dev | Worker `boundline-app`; secret `PARTNER_API_KEY`; service bindings `API` → `boundline-api`, `INDEXER` → `boundline-indexer`; `run_worker_first: ["/api/*"]`, SPA fallback. Redeploy: `pnpm --filter @boundline/sdk build && pnpm --filter @boundline/app deploy` |
| Console | https://boundline-console.papermind-ai.workers.dev | Worker `boundline-console` (7 Oct); secret `PARTNER_API_KEY`; service bindings `API`, `INDEXER`, `OBSERVATORY` (the Observatory sends no CORS headers, so the ribbon reads through the binding). Redeploy: `pnpm --filter @boundline/console build && pnpm --filter @boundline/console exec wrangler deploy` |
| Site | https://boundline-site.papermind-ai.workers.dev | Worker `boundline-site` (7 Oct), static assets from `apps/site/public`. Redeploy: `cd apps/site && pnpm exec wrangler deploy` |
| Agent | https://boundline-agent.papermind-ai.workers.dev | Worker `boundline-agent` (7 Oct); `POST /mcp`, `GET /v1/tools`, `POST /v1/tools/:name`; secret `PARTNER_API_KEY`; service bindings `API`, `INDEXER`, `OBSERVATORY`, `KEEPER`. Redeploy: `cd apps/agent && pnpm exec wrangler deploy` |
| boundline.xyz / boundline.app | same Cloudflare account | still serve the old v1 site; repointing is a human decision |

Keeper vars since 7 Oct also `MIRROR_HOLD_FEED` / `MIRROR_HOLD_REGISTRY` (blank; `/v1/config` shows `hold`).
Keeper secrets and vars after 6 Oct: `KEEPER_KEY` (mirror), `PROTECT_KEY` (protection signer), vars `PROTECTOR`,
`PROTECT_TARGETS` (two targets on the AAPLt pre-liquidation), `BASE_SEPOLIA_SEQUENCER_URL`, optional `MAX_TX_PER_TICK`.
Indexer: `INDEX_MAINNET=true`, migration 0002 applied, RPC list Tenderly public gateway first (the working free log
source), own cron firing. The Observatory keeps one cron (`* * * * *`: snapshot, capture, indexer kick, positions on
every fifth minute) and the secret `BASE_RPC_URL_PRIVATE` (Alchemy, `eth_call` only).

Since 8 Oct: keeper vars `DESK_PROTECTION_VAULT`, `CREDIT_DESK`, `VAULT_TARGETS`, KV `KEEPER_STATE`
(`a648931723db46ca90aef102b0fe83bb`), service binding `API_EVENTS` → `boundline-api` entrypoint `Events`; the keeper's
cron drives the API's webhook `tick()` because **the API's own cron never fires**; the indexer's own cron fires and the
Observatory's kick is de-duplicated by a 20 s lease; the API has migration 0003 (route plans, webhooks), a cron trigger that
does not fire, the `Events` entrypoint and `/health` `features: ["route","webhooks","events-entrypoint","saturday-mode"]`;
the site has a bridge Worker (`apps/site/worker/`) with service bindings to the Observatory and the API. Deploy a router
change with `pnpm --filter @boundline/router build` first (`dist/` is gitignored). Last deploys: 9 Oct keeper
`28fe170c` (vars `HARVESTER`, `HARVEST_TARGETS`), API `6dd36100`; 8 Oct indexer `aba6ef13`, Observatory `326a3f30`,
agent `f6ec84db`, app `75aa8695`, console `1bfb9a5b`, site `b15a91fe`; 12 Oct Observatory `704e8868` (migration 0004),
API `41ddd5b4`, site `13123dff`. Checked 12 Oct: the live agent, app and console carry their last commits (each was
deployed minutes before it was committed; the indexer and keeper likewise by timestamp), so only the Observatory, API and
site were behind `main`.

**12 Oct: D1's free daily quota was exhausted.** From about 16:00 UTC every D1 query on the account failed ("exceeded
D1's free tier daily row read limit … wait until tomorrow (midnight UTC)", code 7500): the indexer, the Observatory's
position panels and capture detail, and everything reading through them (console obligations, API obligations) answered
500, while KV- and RPC-backed routes (Observatory `/`, `/v1/tokens`, `/v1/sessions`, keeper, agent) kept working.
`wrangler d1 insights --sort-by reads` named the cause (positions `MAX(taken_at)`, 4.21M of the ~4.8M reads a day) and
`--sort-by writes` showed writes at ~97K of the 100K free a day (snapshots 56.3K: one row plus two index rows per insert).
Over the cap D1 refused unevenly (probes alternated between answering and refusing). Farseen moved the account to
Workers Paid that evening: D1 answered 12 of 12 probes at 18:11 UTC, and with his go-ahead the session deployed the
Observatory (migration 0004 + code), the API (the 12 Oct drill runs: 14 drills, `protection` 3 runs) and the site
(copy) at 18:20–18:23 UTC.

## 7. Keys, accounts and secrets (locations only, never values)

- Test-only Base Sepolia keys from the old project live **outside the repo** in a 0600 env file on
  the deployer's machine (`~/.boundline/base-sepolia.env`; scrub this path before the repo goes
  public). Variables: `BOUNDLINE_TESTNET_DEPLOYER_KEY` (`0x2f0d…2a4E`, about 0.05 ETH and 5 USDC
  after tonight), `BOUNDLINE_TESTNET_BORROWER_KEY` (`0xB789…82Fc`, 0.63 ETH, 3 USDC, 990 AAPLt;
  once pasted in a chat, so Sepolia-only forever), `BOUNDLINE_TESTNET_RISK_SIGNER_KEY`
  (`0x592D…5B89`, unfunded), `BOUNDLINE_TESTNET_RECOVERY_OPERATOR_KEY` (`0x4490…7cAA`, unfunded),
  `BOUNDLINE_ETHERSCAN_API_KEY` (works as `BASESCAN_API_KEY` for `--verify` on both networks),
  `BOUNDLINE_ALCHEMY_API_KEY`, `BOUNDLINE_TESTNET_KEEPER_KEY` (`0x28A5…9894`, generated 3 Oct with cast, 0.01 ETH,
  owns the Sepolia feeds and registry, also stored as the Cloudflare secret `KEEPER_KEY` of the keeper Worker),
  `BOUNDLINE_TESTNET_VALIDITY_KEY` (`0xEcC0…6AAE`, 6 Oct, the validity-transaction demo key, 0.005 ETH and about 0.8
  USDC), `BOUNDLINE_TESTNET_PROTECT_KEY` (`0x4066…0373`, 6 Oct, the keeper's protection signer and the Protector's
  keeper, 0.005 ETH, also the Cloudflare secret `PROTECT_KEY`). Deployer after 6 Oct: about 0.039 ETH, 3 USDC.
  The API partner key for `boundline-app` is in `~/.boundline/boundline-api-partner-keys.txt` (shown once, hash in
  D1). Load with `set -a; . <file>; set +a` and pass
  `--private-key "$VAR"`; never echo a value, never point these keys at chain 8453.
- Cloudflare: `wrangler` holds an OAuth login on the deployer's machine (scopes: workers, KV, D1,
  pages, zone read; **no R2**). Account id `d1dc74d76398a3583271827dd3384c07`.
- **8 Oct:** no new key was created. Writing new keys under `~/.boundline` (a vault-keeper key, a route-signer key) was
  refused by the session's permission classifier, so the vault job shares the protect signer (the plan of 6 Oct named it)
  and the route signer waits for the human: generate a key, keep it in `~/.boundline/base-sepolia.env` as
  `BOUNDLINE_ROUTE_SIGNER_KEY`, `wrangler secret put ROUTE_SIGNER_KEY` in `apps/api` (typed data only, unfunded).
  The keeper→API events use an RPC entrypoint, which needs no shared secret.
- Not yet existing: mainnet deployer key, dedicated keeper key, CDP project (paymaster, Node RPC
  key), Builder Code, Arena project with both developers, team AAPLc positions, USDC seed for the
  mainnet market. `.env.example` lists every variable the code reads.
- Faucets: Circle USDC 20 per 2 hours (https://faucet.circle.com), Chainlink 0.5 ETH, CDP faucet.

## 8. Toolchain and the facts that cost time

| Tool | Version / fact |
| --- | --- |
| Foundry | stock `forge` 1.7.1, solc 0.8.30, `cancun`, optimizer 10,000 runs; `base = true` in `foundry.toml`; remappings for `forge-std`, `base-std` v1.1.0 (Cobalt interfaces), `morpho-blue` v1.0.0, `pre-liquidation`, `aave-v4` v0.5.11, OpenZeppelin 5.7; `[lint] lint_on_build = false` because aave-v4's `'src/...'` imports break solar |
| Base Foundry | `~/.foundry/bin/base-forge` 1.6.0-v1.1.0 (`base-foundryup --install v1.1.0`). Live **Beryl** precompiles: no `createCompositePolicy`, so `wire` and three tests skip. The nightly (3 Oct) is Denim-leaning and rejects the `SEIZE_EXEMPT_POLICY` scope. Stock forge cannot call precompiles at all (B20 assets have one byte of code executed by the node), so anything touching a real B20 asset runs under base-forge, and Base Sepolia over RPC is the only Cobalt-exact environment |
| Morpho | `Morpho.sol` pins solc 0.8.19: unit tests etch the mainnet runtime bytecode fixture instead of compiling it. `IMorphoBase` exposes `createMarket.selector` |
| Node | pnpm 11.7 workspace (`allowBuilds` for esbuild and workerd, `minimumReleaseAgeExclude` for wrangler), TypeScript 7.0.2 (NodeNext, strict), vitest 5.0.3, tsx, wrangler 4.147.0, Hono 4.13, viem 2.57.2 |
| Python | `zoneinfo` as the independent calendar oracle (`scripts/gen-calendar-tests.py`) |
| Profiles | `FOUNDRY_PROFILE=lane-a|lane-b|lane-c|lane-d` give each parallel session its own `out-lane-x/` and `cache-lane-x/` |

**The platform fact of 6 Oct 2026:** the account was on the Workers **Free plan, 10 ms CPU per invocation**, and that,
not scheduling, is why crons "never fired": every tick on all three Workers ended `outcome: exceededCpu` on a cold
isolate. Measured in Node (`apps/observatory/scripts/bench-cpu.ts`): viem `privateKeyToAccount` 17.8 ms on first use
(noble-curves builds its base-point tables), a signature 1.6 ms, viem's multicall encode 3 ms but `read()` 88 ms cold
and 17 ms warm, the first `Intl.DateTimeFormat` 10 ms. The D1 history showed most hours since Saturday with zero
snapshot ticks, and the Sunday 4 Oct reopen capture was lost (reconstructed from the round history instead). Fixes:
hand-rolled Multicall3 encode/decode everywhere on the hot path, module-scope warm-ups (startup has its own budget),
memoised clients and accounts, one signature per tick, no receipt waits, the positions job on its own cron. Later the
same day ticks of 30 to 180 ms CPU passed with `outcome: ok` and the indexer's own cron began firing, which looks like a
plan upgrade or Cloudflare leniency; the lean paths stay either way. **Validity transactions (Cobalt):**
`base_sendRawTransactionValidity` on `https://sepolia-sequencer.base.org` accepts a `block_number` bound at most **32
blocks (about 64 s) ahead** ("maximum permitted block"), answers `already known` while a previous bound is alive, and
`replacement transaction underpriced` when another transaction shares the nonce, so each job signs with its own key and
re-arms every tick. Measured on the live `!=` case: a re-submitted known hash with a satisfied predicate was accepted
seven times without inclusion before the eighth landed (base fee flat), so a validity transaction guarantees "not
before", not "as soon as"; next experiment: a new hash per re-arm (same nonce, higher tip). **Logs:** `eth_getLogs` is capped at 500 blocks on mainnet.base.org and sepolia.base.org; the Alchemy
free tier allows 10-block windows (unusable); publicnode refuses archive ranges and multi-address filters; Tenderly's
public gateway serves 500-block windows back to September. **D1** rejects `LIKE` patterns over about 50 bytes (use
`instr`). **RPC node lag:** `sepolia.base.org` nodes trail each other by seconds, so an `eth_call` right after a send can
see `PolicyNotFound` for a policy already mined (the wire script's guard now retries). Well-known test keys (0xB0B,
0xA11CE) are EIP-7702-delegated on Base mainnet, so their signatures fail Aave's checker. B20 precompiles work on a
mainnet fork under base-forge, not under stock forge.

**7 Oct facts:** `vm.setEnv` is process-wide in forge, so a test that reads an env var can see another suite's value
(`DeployAave.t.sol` was de-raced); back-to-back `cast send` from one key hit `nonce too low` on the lagging Sepolia
node (pass the pending nonce); Alchemy's free tier has no `debug_traceCall`, so the replay finds the aggregator's
transmission slot with `vm.record`/`vm.accesses` (it equals `keccak256(abi.encode(aggregatorRound, 12))`; the aggregator
answers `No access` to direct reads, so its round is derived from the proxy's); under stock forge the in-session gate
verdict on a mainnet fork is `FEED_PAUSED` because the live OracleRegistry reaches a Base precompile and the gate fails
closed (base-forge returns `OPEN`); Aerodrome's EURC/USDC and cNGN/ZARP pools are Slipstream CL pools (`slot0`, `stable()`
reverts), cNGN/USDC is Uniswap v4; the x402.org facilitator lists v2 `eip155:84532` and v1 `base-sepolia`, both accepted,
and settles from its own signer; the Observatory's workers.dev origin sends no CORS headers (browser pages read it through a
service binding); a freshly deployed Worker can answer empty bodies for its first seconds (retry once).

**9 Oct facts:** this session's scratchpad (`/private/tmp/…`) was wiped overnight: nothing the repo needs may live there.
The wrangler OAuth token expires within a day and a KV write then fails `Authentication error [code: 10000]`;
`wrangler whoami` refreshes it. Alchemy's Sepolia endpoint answered an `eth_getLogs` range with HTTP 400; the Basescan v2
logs API (`drills._find_mirror_tx`) works. sepolia.base.org rate-limits **per entry inside a batch** (`-32007`). Line 1
has about $0.16 of capacity and the policy's smallest draw is $1, so the demo's beat 4 must add shares; more than ~0.013
AAPLt would push Saturday's step 2 past the ShadowGuard's 30% guard (demo checklist and runbook). The Claude-in-Chrome
extension was not connected, so the front ends were checked over HTTP only (all 200).

**12 Oct facts:** D1's free tier caps the **account** at 5M rows read and 100K rows written a day, resetting at 00:00
UTC, and a row read counts every row a query visits (a full scan of a growing table costs its size every run).
`wrangler d1 insights <db> --timePeriod 1d --sort-type sum --sort-by reads|writes --json` ranks queries (it does not count
against the quota). Over the cap, D1 fails every query with code 7500 and enforces it unevenly (probes alternate). Under US
daylight time the weekly feed close and reopen (20:00 ET) are exactly 00:00 UTC, the last instant of D1's quota day, so a
quota run-out costs exactly the minutes before each transition. SQLite answers a GROUP BY on the primary key's prefix by
scanning the PK index in order (the whole history) even when a narrower range index exists; "no newer row for the same
key" (`NOT EXISTS`) keeps the range scan. `lower(address) = lower(?)` defeats an `(address, …)` index. The ShadowGuard's
`heldFeed` is `MARKET_CLOSED || FEED_STALE`, so a stale feed in session exercises the weekend protection path exactly; the
keeper's jobs do not gate on the session. The auto-mode classifier refuses `wrangler deploy` (production deploy) and once
refused a plain read of `deployments/base-sepolia.json` through `python3 -c`; the Read tool works. A closed drill position
leaves the MockSwapPool nearly empty (it pays the close-out's USDC).

**8 Oct facts:** the Free plan's 10 ms cap kills heavy cron ticks (`exceededCpu` at exactly `cpuTime 10`) while light
ones and some 16–19 ms fetches pass: never rely on leniency, measure with a tail. Hono's default SmartRouter compiles a
regular expression over every route on the first request of a cold isolate (24–26 ms CPU); `PatternRouter` costs 0.2–0.3
ms. viem's request code dominated a cold keeper tick (34 ms); a raw client plus a module-scope warm-up removed it. The
desk allows **one open line per (partner, user, market)** (`LineExists`). `Protector.sizing` reports `fullCloseAllowed`
without looking at the sale pool's USDC, so the keeper must simulate before signing (it does since 8 Oct). The sequencer
did not include **known validity-transaction bytes re-sent after their bound expired** (0 of 4), while re-signed ones
landed in 1–2 blocks (2 of 2): re-sign every re-arm. On the desk, a registry pause (`FEED_PAUSED`) shows as obligation
`HOLD_ISSUER`; a scheduled split is a lower UI multiplier via the B20 `announce`/`updateUIMultiplier` path, which the desk
haircuts only when lower; an unadmitted receiver is refused by the desk's own B20 preflight (`PolicyForbids`) while
Morpho's path gives only `transfer reverted`. The real 24 Sep Aave halt was **hub-level** (`SpokeConfig.halted`), not a
reserve freeze; under a reserve freeze a direct venue borrow and liquidation still pass. The Sunday 11 Oct reopen is unix
**`1791763200`** (Mon 12 Oct 00:00 UTC); the earlier `1791849600` in this file was a day late. `wrangler tail` output
flushes late: run it detached and stop it with SIGINT; a stray tail from a previous session can keep running for a day.
`ps` shows a forked anvil's full `--fork-url` (with the key): never print process command lines. The permission
classifier refuses writes to the secret store (`~/.boundline`) and destructive D1 statements (a re-root delete): ask the
human.

Operational lessons: a brand-new Worker's cron can take ten minutes to start, and one Worker's cron never
started at all (drive it from a working cron through a service binding); a fresh workers.dev route can answer
Cloudflare error 1042 (HTTP 404) for a minute after its first deploy, and the same 1042 is what a Worker gets when
it fetches another Worker's workers.dev URL (use service bindings); parallel Bash calls in one Claude session
share the shell cwd and the harness resets it between calls even mid-command, so always use absolute paths,
`forge --root` and `pnpm --filter <pkg> exec`; zsh needs quotes around globs like `--include=*.sol`; a view
called inside `vm.prank` consumes the prank; `sepolia.base.org` is load-balanced and its nodes
disagree on the head for a few seconds, so run one broadcaster per key at a time, pass `--slow`, and
retry a `nonce too low`; `mainnet.base.org` rate-limits Cloudflare egress, hence the RPC fallback
list; KV on the free tier allows 1,000 writes a day, hence the throttle; macOS has no `timeout`.

## 9. Verification state (12 Oct 2026, night IST)

```sh
forge test --root contracts     # 264 passed, 0 failed, 8 skipped (fork suites without BASE_RPC_URL), 29 suites
forge fmt --root contracts --check   # clean since 12 Oct (ec86941)
pnpm test                       # 898 vitest: calendar 106, chain 19, ledger 10, router 17, agent 19, api 121, indexer 108,
                                #   keeper 131, observatory 226, sdk 95, console 46
pnpm typecheck                  # clean (every package and app)
BASE_RPC_URL=<alchemy archive> FOUNDRY_BASE=true ~/.foundry/bin/base-forge test --root contracts --match-path 'test/fork/*'
                                # + test/drills and test/harvest: 8 fork suites (5 in fork/, 2 in drills/, HarvestFork), 42 passed (8 Oct)
scripts/drills/run-fork-drills.sh [--only venue-halt|bad-debt-probe]   # writes docs/evidence/drills/{venue-halt,bad-debt-probe}.json
contracts/script/deploy-mainnet.sh rehearse                            # 50 txs, ~51M gas, 33/33 checks on a base-anvil fork (re-run 12 Oct: 0.00031456 ETH)
KEEPER=0x82093784Ade31543404b8AD949E49F314af7612c contracts/script/deploy-mainnet.sh check   # 33/33 against Base mainnet (13 Oct)
python3 -I scripts/sepolia/twap.py show                                # the Saturday numbers, live
python3 -I scripts/sepolia/outage_rescue.py show                       # every number the feed-outage rescue reads, live
```

12 Oct cross-check: the build matched section 9 of 9 Oct exactly before the session's changes (264/8 forge, 887 vitest,
typecheck clean); keeper healthy (all pairs in sync, both protection targets below band, vault and harvest keepers set);
the Observatory had captured the 9 Oct close and the 11 Oct reopen live; the indexer, the Observatory's position routes and
capture detail answered 500 from the D1 quota (section 6.3). After the deploys (18:20–18:46 UTC): every D1-backed route
answered 200, the API listed 14 drills (`protection` 3 runs, `reserve-ladder` 2), both capture runs carried
`completedAt`, the keeper reported 3 of 3 feeds and registries in sync with 0 read errors, the indexer was within a few
minutes of both heads, the live site was byte-identical to `apps/site/public/index.html`, and the Sepolia roots from
6 Oct were re-formed without drift.

Morning cross-check (8 Oct 06:35–07:00 UTC, before the lanes): forge 240/0/5, vitest 691 and typecheck matched section 9 of
7 Oct; all 8 Workers answered; **94 of 94** recorded full transaction hashes are successful Base Sepolia transactions (the
other 14 32-byte strings are ids and hashes); the Observatory had 60/60 snapshots in every hour since 7 Oct 07:00 UTC.
Live after the lanes: keeper ticks `ok` at 3–6 ms with `apiTick: ok`; indexer every invocation `ok` (8–16 ms), every Sepolia
source and the mainnet Aave/Morpho sources at head, `mainnet-feeds` catching up; `/v1/drills` 12 drills and 17 runs; the
API's route, webhooks (echo delivery 200, signature valid) and Saturday mode answer; the agent's REST aliases answer 402
keyless; the site's live panel renders through its bridge Worker. Every hash cited by the 8 Oct lanes was re-checked on
chain by the lane that wrote it (K1: 123 transactions, all status 1).

## 10. Decisions, dated

- **26 Sep**: rebuild Boundline ground-up in a new repo; the old repo is reference only, no
  disclosure machinery beyond the submission form's one question.
- **1 Oct**: credit layer only; the consumer alternative is shelved for good.
- **3 Oct**: two developers, not three; local git only, no GitHub until the public push before
  submission; build runs day by day from `docs/BUILD.md`.
- **3 Oct**: Sepolia order is test stocks first, then the oracle stack bound to the real tokens (one
  deploy instead of two); `wire` waits for the desk and keeper and goes out as `cast send` calldata
  because base-forge simulates with Beryl.
- **3 Oct**: Observatory deployed to workers.dev only; the custom domains are untouched; R2 skipped;
  KV writes throttled; public RPC fallback list instead of a keyed RPC for now.
- **3 Oct**: old-project Sepolia leftovers (15 USDC hub deposit, 2 USDC Morpho supply) withdrawn to
  the deployer and used to seed the new market.
- **6 Oct**: every signing job gets its own key (mirror, protection, validity demo) because a waiting validity
  transaction holds a nonce; the keeper signs at most one transaction per tick and never waits for receipts; all
  Workers hand-roll their hot-path encoding (Free-plan CPU cap); the Workers Paid plan is recommended regardless.
  Pre-liquidation vendored and built via-IR rather than a second solc; the Protector swaps on the collateral's own pool
  (no router: the Slipstream router belongs to another factory than the AAPLc pool); preLCF 100% at both ends so the
  keeper sizes actions itself. NVDAt and TSLAt markets created unseeded (no USDC on the deployer; the Circle faucet is a
  human step). Aave interfaces are our own minimal copies of v0.5.11; `recover` keeps the collateral (sale leg later);
  `closeLine` requires desk principal 0, not spoke debt 0. The app never signs or holds keys; paymaster, Builder Code
  and mainnet are config gates. Protection targets are env-driven on Sepolia (`PROTECT_TARGETS`), not discovered.
- **7 Oct**: the Reserve is an ERC-4626 with sinks (`IAdvanceSink`) rather than a vault that lends to users; the desk's
  `recoverCollateral` is callable only by the registered protection vault (receiver = caller, so collateral cannot be
  diverted) and the Sepolia desk is **not** redeployed before the freeze; the replay harness is a Foundry fork test
  driven by a TS script, not a TS harness (EVM snapshots give raw and protected paths from one Saturday state); x402 is
  hand-rolled (v1 body + v2 header) with the facilitator behind a dependency, partner keys are never metered; the agent
  surface is read-only and holds the partner key, route plans are returned unsigned (the API signs stored plans later);
  the router is pure and dependency-free; the keeper's mirror can hold a symbol (`MIRROR_HOLD_*`) so Thursday's drills
  are not reverted a minute later; the payout router has no owner and refunds unfilled input; cNGN is not routed
  (Uniswap v4 pool); the Reserve, vault, router and agent keep the deployer as their operator until a keeper job exists.
- **9 Oct**: the harvester runs from the keeper Worker with the shared protection signer, third in line (no new key could
  be written); the harvest job sends plain transactions because the contract itself refuses outside an open session; the
  live harvests replay NVDAc's real 1 Oct multiplier step on the AAPLt registry mirror and do not move the feed (said in
  every record); the Friday mirror is applied only when no position would act at the close, so Saturday's rescues happen
  while recorded; the demo's borrow is sized (0.01 AAPLt, $1) so the vault rescue stays possible; the API's stored policy
  version follows the desk on read.
- **8 Oct**: the drill position is pre-positioned below the band at the close (a 0.06 USDC repay) instead of leaving the
  pool short, because the keeper then had no pre-arm simulation; the keeper now simulates every action and re-signs every
  re-arm; line 1 (not a new line) is the vault drill's subject; the vault job shares the protect signer (one signature per
  tick, the Protector first) because new keys could not be written; keeper→API events go over an RPC entrypoint, and the
  keeper's cron drives the API's webhook tick; route plans stay unsigned until the human approves a signer key; Saturday
  mode is an off-chain partner policy, off by default; Base Pay is not built (the vault credits only `deposit` and
  `repayAdvance`, so a Base Pay transfer would land uncredited); the harvester repays first through a Morpho flash loan,
  then withdraws only the dividend collateral; Aave desk lending fails closed on a hub halt or an unreadable hub while
  repays refuse only on a positive read; every Hono Worker uses `PatternRouter`; the CreditDesk is not redeployed for
  the harvester (the desk reads collateral from Morpho, so the harvester needs no desk change).
- **3 Oct, night**: a dedicated keeper key owns the Sepolia simulators and lives in Cloudflare as a secret; the
  Sepolia feeds mirror mainnet's rounds verbatim (held, stale and reopening like the real thing) instead of being
  kept artificially fresh. The desk went to Sepolia at 200 optimizer runs rather than waiting for the library
  split. The Cobalt wire runs as `cast send` with an `eth_call` guard before each write. The API is
  self-custody only: it prepares typed data and calldata and never signs. Indexer phase 1 is Sepolia only.
- **12 Oct**: the missed Saturday rescue is replaced by the same two actions under a staged frozen feed in session,
  recorded as a feed-outage rescue and never called a weekend (the ShadowGuard's `heldFeed` makes the paths identical);
  the vault ladder gets its own drill (`reserve-ladder`) instead of sharing the Protector's; the Observatory's latest views
  drop positions not written for two hours (closed ones no longer linger); D1 is fixed with indexes and bounded queries
  regardless of the plan, and Farseen takes Workers Paid; mainnet: Farseen funds fresh deployer and keeper keys himself;
  the public repository stays local until he publishes it (his call, 12 Oct); claims in the submission carry the replay's
  "staged" caveat and say "replay", not "nightly".
- **13 Oct**: the mainnet keys were created by the session at Farseen's request (only the addresses printed) and he
  funded the deployer; the deploy broadcast once funded, as he approved; the deployer keeps ownership (no `FINAL_OWNER`);
  the keeper key holds the role with no ETH and no mainnet job (nobody has opted in); the session-safe market stays
  unseeded; the router keeps Saturday mode off mainnet session-safe markets (their SessionGuard refuses while closed).

## 11. Open items

**Clocked:** the submission, before **Tue 13 Oct 12:29 IST**. The weekend items of 9–12 Oct are closed: the Friday mirror
was not applied (recorded), the Saturday rescues were not run on the weekend (recorded; done under a staged outage on
12 Oct), the reopen capture is in `docs/evidence/reopen-2026-10-11.*`, the advance was settled and harvested.

**Done 12 Oct night:** Workers Paid active; Observatory (migration 0004), API and site deployed; both capture runs
closed; the Sepolia daily roots from 6 Oct rebuilt (Farseen approved the delete).

**Done 13 Oct morning:** the mainnet deploy (50 transactions, 16 verified, 33/33 checks) and its wiring in the router,
SDK and chain packages.

**Next build items (session-doable):** redeploy the API and the agent so `POST /v1/route` and the agent's `route` tool
mark the three mainnet markets `pre-liquidation` (they bundle `@boundline/router`; needs Farseen's go-ahead); top up the
MockSwapPool before any further close-out. Not worth the remaining time: the reserve-yield source, other chains, the desk
freeze redeploy.

**Human-only**:
- **Route signer key** for the API (typed data only, unfunded), or a decision to keep plans unsigned.
- Optional on mainnet: a USDC seed for the session-safe market, each developer's AAPLc position, and handing ownership
  from the hot deployer key to a hardware wallet (`acceptOwnership()` flow, `FINAL_OWNER`).
- **Arena project with both developers registered**; the second developer's own commits (all commits so far are
  Farseen's, and the roster must match who did the work); a **public GitHub repo** (`docs/submission/PUBLIC-REPO-CHECKLIST.md`).
- The `TODO-HUMAN` fields in `docs/submission/SUBMISSION.md` (backgrounds, teammate, GitHub URL, X handle, University
  wording, the prior-work sentence) and the two videos.
- The recording wallet's address if the demo is not recorded with the borrower test wallet (it must be admitted to the
  test stocks' allowlists first).
- Circle faucet top-ups (20 USDC per 2 h) for the deployer `0x2f0d…2a4E` (2.96 USDC after 12 Oct; the MockSwapPool needs
  ≥ 1.8 USDC before another close-out drill);
  CDP project and Builder Code; boundline.xyz; Cloudflare R2 scope if exports are wanted; CI secrets once the remote exists.

## 12. Commit history

| Commit | What |
| --- | --- |
| `eeed7bd` | Scaffold the Boundline monorepo |
| `bb19663` | MarketCalendar: onchain NYSE session calendar in ET |
| `1c4c48b` | pnpm workspace skeletons for calendar, chain and observatory |
| `52aa4f6` | SessionGate, SessionGuard and ShadowGuard oracles with simulators |
| `69b4853` | README and the day-by-day build schedule to 10 Oct |
| `4ff6009` | TypeScript calendar, 5,643-instant differential fixture, Morpho fork test |
| `a71e208` | Chain package and the Observatory v0 worker |
| `48e4847` | CreditDesk: partner-scoped credit lines on Morpho, self-custody mode |
| `180e6b7` | Build ledger for 3 Oct |
| `81df4ba` | `.env.example` listing every key and RPC |
| `da2d27c` | Oracle deploy, session-safe market and Cobalt test-stock scripts |
| `5bcd2f8` | Test-stock suite runs live under base-forge, Cobalt-only cases skip on Beryl |
| `93f7bb6` | Sepolia test stocks, oracle stack and session-safe Morpho market deployed |
| `edd3dd4` | Observatory live on Cloudflare with KV write throttle and RPC fallback |
| `060f192` | docs/CONTEXT.md, the living build context |
| `a1031f4` | Keeper Worker: mirror mainnet feed rounds and registry params onto the Sepolia simulators |
| `e7fe38b` | CreditDesk deployed on Base Sepolia and AAPLt's Cobalt policies wired |
| `3516b67` | Observatory: reopen capture runs and shadow health for real Morpho positions |
| `962040d` | Indexer Worker: events into D1 with hash-chained daily roots and Morpho reconciliation |
| `cf03ac0` | Partner API: lines, quotes, obligations and decisions over the CreditDesk |
| `be9cb68` | Build context, ledger and deployment record for the five live lanes |
| `0bec0f4` | API reaches the indexer through a service binding |
| `bf48607` | Indexer tick driven from the Observatory cron through a service binding |
| `e964a07` | CreditDesk split into the desk and an external CreditDeskLib (fits EIP-170 at 10,000 runs) |
| `8c798c1` | Service-binding fallbacks and the live verification of the indexer and API recorded |
| `c80432e` | Keeper: raw JSON-RPC adapter and one unwaited transaction per tick (Free-plan CPU cap); first in-session draw and repay; the 2 to 4 Oct weekend reconstructed |
| `15177f2` | NVDAt and TSLAt markets registered on the desk and wired, lines 2 and 3, first validity transaction |
| `69a4fe0` | `@boundline/sdk` and the Boundline app live on Workers |
| `86ec1f1` | Protected mode on Morpho: Protector, vendored pre-liquidation, AAPLt ShadowGuard live on Sepolia |
| `ea98c12` | Keeper protection job arming the Protector's action as a validity transaction |
| `ae7d1ff` | Indexer phase 2 (five mainnet sources) and the API served from it |
| `2830003` | Aave V4: AaveDesk, ProtectionVault, enrolment helper, proven on the live MAG7 spoke |
| `7013265` | Automated protection drill recorded; SDK config carries the pre-liquidation and the new markets |
| `8ff5873`…`d9d77b0` | 6 Oct evening: Observatory diet, validity-tx loop fixes, the `!=` validity transaction's evidence |
| `82fe341` | Keeper: `MIRROR_HOLD_FEED`/`REGISTRY`; lane-e/lane-f forge profiles |
| `7226360` | Runbook for the 9–11 Oct Saturday rescue |
| `591555f` | Architecture doc and threat model |
| `e84b860` | `@boundline/router` |
| `a2b5c65` | Agent surface (MCP server) |
| `682fe8b` | Boundline Reserve and DeskProtectionVault live on Sepolia; ProtectionVault funder; desk `recoverCollateral` |
| `e5e346b` | Fork replay harness, nightly assurance, `@boundline/ledger` |
| `3c5de44` | Deployment record: Reserve, vault, line 1 protective repays |
| `94eb94d` | Partner API: x402 metering, policy versions, drills, reconciliation, evidence export, shadow health |
| `4344a83` | Local-money payout leg live on Sepolia; SDK payout option; app "Receive as"; landing site |
| `152d099` | Partner console |
| `8b70c13`, `549f90c` | Observatory Aave V4 positions, gap panel, assurance status; 7 Oct context and ledger |
| `fa25261` | 8 Oct: the API depends on `@boundline/router` |
| `fbfc447` | Submission package: portal text, pitch and demo scripts, deck, logo, checklist, X thread; README |
| `e460ee4` | Sepolia drills executed live (six) and the second automatic protection recorded |
| `ead6852` | Saturday rescue staged on line 1 and the drill position; runbook rewritten |
| `464efe1` | Fork drills: the real 24 Sep Aave hub halt; the bad-debt probe |
| `d765c10` | DividendHarvester |
| `ef27a70` | Mainnet in one run: `DeployMainnet`, `deploy-mainnet.sh`, runbook |
| `f8c9119`, `7784be2`, `b7479d6`, `c246efa` | SDK vault/route/webhooks; app route card and reserve; console webhooks, events, Saturday mode; site bridge Worker |
| `32d6869` | Aave desk and vault read the hub's halt switch (`VENUE_HALTED`) |
| `301cca9`, `ad5616e` | Keeper: vault job, simulate before signing, KV hold, events, CPU; the re-arm experiment |
| `12c9392` | Runbook order rule (top up before moving the TWAP) |
| `9154059`, `af446a3`, `862c31e` | Router shared candidates; agent x402; partner API route plans, Saturday mode, webhooks, drills registry |
| `f18311e`, `453dea0` | Indexer CPU diet, protection events, seize watch; Observatory seize-watch panel |
| `88075ce`, `76fe8ca`, `3f33761` | Keeper drives the API's webhook tick; PatternRouter everywhere; 8 Oct context, webhook proof |
| `3362abf`, `77270df` | 9 Oct: the API's stored policy version follows the desk; Sepolia scripts off the scratchpad, KV token refresh |
| `de42ab2` | The self-repaying leg live on Sepolia: harvester deployed, one dividend harvested into line 1 |
| `ae4057a`, `2c84d51` | Submission, README and deck filled from the evidence; demo beat 4 sizing |
| `f113c99`, `278dc05` | Keeper harvest job; the Worker harvested and re-based on its own |
| `3d9d83d`, `f2a770a` | `friday.py`; keeper RPC re-sends a rate-limited batch to the next node |
| `95bd40d`, `bbd57ac` | 9 Oct context and ledger; the harvest job reads nothing while it could not act |
| `85a9f56`, `e915fef` | 9 Oct: context for the harvest gate; submission counts |
| `3dc89f3` | 10 Oct: evidence of the Friday step and the close (the mirror not applied, nothing acted while held) |
| `068d65e` | 12 Oct: Observatory D1 read budget (migration 0004, bounded latest views) and capture runs that complete |
| `0ac40b0` | The 9–11 Oct weekend and the Sun 11 Oct reopen, captured live and reconstructed from the chain |
| `48db571` | The feed-outage rescue on Base Sepolia; drill runs, the `reserve-ladder` drill, the weekend record filled |
| `ec86941` | `forge fmt` on the payout router and its tests |

## 13. How to keep this file true

At the end of a session: bump the "Last update" line, add the session's row to the ledger in
`docs/BUILD.md`, append to sections 6, 9, 10 and 11 here (addresses, counts, decisions, open items),
and commit the two files together with the work. Numbers in this file are copied from the tool
output of that session, never estimated.
