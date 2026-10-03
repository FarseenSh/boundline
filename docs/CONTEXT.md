# Boundline build context

Living record of everything built so far, where it lives, how it is verified, and what is open.
**Start here** in any new session (human or Claude), then `docs/BUILD.md` for the schedule.
Update this file at the end of every session together with the ledger in `docs/BUILD.md`.
Last update: **Sat 3 Oct 2026, late evening IST** (commit `edd3dd4` plus this file).

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
and live on Base Sepolia on 3 Oct 2026 (section 6).

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
| Dependency order | toolchain → calendar and oracles → Observatory → test stocks, CreditDesk and policy → indexer and registry → pre-liquidation, AaveDesk, ProtectionVault, Reserve → fork replay and nightly assurance → router, self-repaying and local-money legs → API, SDK, widget, console, app, agent surface → drills, evidence, docs → deck, videos, submission |

## 3. Repository map

| Path | What | Verified by |
| --- | --- | --- |
| `contracts/src/calendar/` | `MarketCalendar.sol` (onchain NYSE sessions in ET, DST and civil-date math, append-only year loads), `Nyse2026.sol` (2026 holidays and early closes) | 18 generated tests + 2 differential tests on 5,643 instants |
| `contracts/src/oracle/` | `SessionGate.sol` (verdict engine), `SessionGuard.sol` (Morpho `IOracle`), `ShadowGuard.sol` (pre-liquidation oracle on the Aerodrome TWAP) | 34 tests + fork test on live Morpho |
| `contracts/src/desk/` | `CreditDesk.sol` (partner-scoped self-custody credit lines on Morpho, policy engine, decision hashes) | 24 tests on the etched mainnet Morpho bytecode |
| `contracts/src/test/` | Sepolia simulators: `TestPriceFeed`, `MirrorOracleRegistry`, `MockB20`, `MockCLPool` | 20 tests |
| `contracts/src/interfaces/`, `libraries/` | `IMarketCalendar`, `IPriceGate`, `IAggregatorV3`, `IOracleRegistry`, `ICLPool`, `IEligibility`; Uniswap `TickMath` (GPL-2.0-or-later, own header) | |
| `contracts/script/` | `DeployCalendar`, `DeploySepoliaSimulators`, `DeployOracles` (Sepolia and mainnet paths), `CreateSessionSafeMarket` (`run`, `seed`), `IssueTestStocks` (B20 factory flow, `wire`), `README.md` with the recipe that worked | 6 tests on base-std's mocks; all dry-runnable keyless |
| `contracts/test/fixtures/` | `calendar-2026.json` (differential fixture), `morpho-blue-8453.runtime.hex` (mainnet Morpho runtime bytecode, etched in desk tests) | |
| `contracts/broadcast/` | Foundry broadcast records of every real deploy (committed; `dry-run/` ignored) | |
| `deployments/` | `base-sepolia.json` (addresses, txs, proofs), `README.md` | |
| `packages/calendar` | `@boundline/calendar`: the calendar in TypeScript (`Intl`-based), fixture generator | 98 tests, zero disagreements with Solidity |
| `packages/chain` | `@boundline/chain`: Base mainnet and Sepolia addresses, ABIs, viem client with RPC fallback, bigint TickMath and price math | 14 tests |
| `apps/observatory` | `@boundline/observatory`: Cloudflare Worker, per-minute snapshot cron, JSON API, HTML page, D1 and KV | 29 tests, live |
| `scripts/gen-calendar-tests.py` | Python `zoneinfo` oracle that generates the Solidity calendar tests | |
| `docs/BUILD.md` | day-by-day schedule to 10 Oct and the ledger | |
| `.github/workflows/ci.yml` | contracts build/test/fmt, TypeScript build/typecheck/test, fork job gated on `BASE_RPC_URL` | not yet run (no remote) |
| `.env.example` | every key, RPC and account the scripts and Workers read | |

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
the AAPLc/USDC mainnet market was simulated against the live Morpho (about 5.9M gas).

## 5. TypeScript

- **`@boundline/calendar`**: `sessionAt`, `isFeedLive`, `describe`, `nextTransition`, `dateKeyOf`,
  `zoneFields`, `wallClockToEpoch`, `NYSE_2026` (with `source`), `SESSION_CODE`, boundary marks.
- **`@boundline/chain`**: `B20_TOKENS` (ten Coinbase stocks), `MAINNET`/`SEPOLIA` address books,
  `AAVE_MAG7_RESERVES`, `FEED`, ABIs (aggregator, OracleRegistry, B20 asset and factory, policy
  registry, Morpho, Morpho oracle, Aave spoke, CL pool, ERC-20) and `TOPICS`; `createBaseClient`
  builds a viem `fallback` transport from a comma-separated RPC list (`PUBLIC_RPC_URLS` per chain);
  `tickToPrice36`, `twapTick`, `divergenceBps`, `feedAgeSeconds`.
- **`@boundline/observatory`** (Hono on Workers): routes `/`, `/health`, `/v1/tokens`, `/v1/feeds`,
  `/v1/sessions`, `/v1/venues/morpho/markets`, `/v1/venues/aave/positions`, `/v1/events` (501 until
  the indexer), `/v1/positions/:addr/shadow`. Cron `* * * * *` snapshots every feed, registry flag,
  pause, multiplier, DEX price and TWAP into D1 (one row per token per tick) and writes KV `latest`
  only when the fingerprint changes or every 10 minutes (free-tier budget). `EXPORTS` (R2) is
  optional. Reads go through the RPC fallback list; a keyed RPC can be the secret
  `BASE_RPC_URL_PRIVATE`.

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

Holders of 1,000 shares of each stock: the deployer, the demo borrower
`0xB789aD318945B37566E2549F65526Cc269a482Fc`, and `0xc709E654f322714261b65280A0f7121B3a0F0BE8`.

Live proofs (weekend session, 3 Oct): the borrower approved and supplied 10 AAPLt as collateral
(succeeds, `supplyCollateral` never reads the oracle); `borrow` of 1 USDC reverts
`MarketClosed(WEEKEND)` (`0x3e363de9…05`); `SessionGuard.price()` and `SessionGate.priceOf(AAPLt)`
revert the same way; `AAPLt.isPaused(feature)` answers `false` for features 0–3.

Not yet on Sepolia: the `wire` step (Cobalt composite policy and seize exemption for Morpho, the
desk and the keeper), the CreditDesk itself, and a feed mirror keeper. **The TestPriceFeeds hold
their deploy-time answer (updatedAt 2026-10-03 14:27:20 UTC); with the default 24 h heartbeat plus
2 h tolerance the gate reports `FEED_STALE` from Sun 4 Oct 16:27 UTC (21:57 IST) until something
calls `setAnswer`.**

### 6.2 Base mainnet (chain 8453)

Nothing deployed: there is no mainnet deployer key yet. Constants the code relies on: Morpho
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
| boundline.xyz / boundline.app | same Cloudflare account | still serve the old v1 site; repointing is a human decision |

## 7. Keys, accounts and secrets (locations only, never values)

- Test-only Base Sepolia keys from the old project live **outside the repo** in a 0600 env file on
  the deployer's machine (`~/.boundline/base-sepolia.env`; scrub this path before the repo goes
  public). Variables: `BOUNDLINE_TESTNET_DEPLOYER_KEY` (`0x2f0d…2a4E`, about 0.05 ETH and 5 USDC
  after tonight), `BOUNDLINE_TESTNET_BORROWER_KEY` (`0xB789…82Fc`, 0.63 ETH, 3 USDC, 990 AAPLt;
  once pasted in a chat, so Sepolia-only forever), `BOUNDLINE_TESTNET_RISK_SIGNER_KEY`
  (`0x592D…5B89`, unfunded), `BOUNDLINE_TESTNET_RECOVERY_OPERATOR_KEY` (`0x4490…7cAA`, unfunded),
  `BOUNDLINE_ETHERSCAN_API_KEY` (works as `BASESCAN_API_KEY` for `--verify` on both networks),
  `BOUNDLINE_ALCHEMY_API_KEY`. Load with `set -a; . <file>; set +a` and pass
  `--private-key "$VAR"`; never echo a value, never point these keys at chain 8453.
- Cloudflare: `wrangler` holds an OAuth login on the deployer's machine (scopes: workers, KV, D1,
  pages, zone read; **no R2**). Account id `d1dc74d76398a3583271827dd3384c07`.
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

Operational lessons: parallel Bash calls in one Claude session share the shell cwd, so always use
absolute paths and `forge --root`; zsh needs quotes around globs like `--include=*.sol`; a view
called inside `vm.prank` consumes the prank; `sepolia.base.org` is load-balanced and its nodes
disagree on the head for a few seconds, so run one broadcaster per key at a time, pass `--slow`, and
retry a `nonce too low`; `mainnet.base.org` rate-limits Cloudflare egress, hence the RPC fallback
list; KV on the free tier allows 1,000 writes a day, hence the throttle; macOS has no `timeout`.

## 9. Verification state (3 Oct 2026, late evening)

```sh
forge test --root contracts     # 104 passed, 1 skipped (fork test without BASE_RPC_URL), 10 suites
pnpm test                       # 141 vitest: calendar 98, chain 14, observatory 29
pnpm typecheck                  # clean
BASE_RPC_URL=<archive rpc> forge test --root contracts --match-path 'test/fork/*'   # live Morpho fork proof
```

Per Foundry suite: MarketCalendar 18, MarketCalendarDifferential 2, SessionOracles 34, CreditDesk 24,
IssueTestStocks 6, TestPriceFeed 6, MirrorOracleRegistry 5, MockB20 5, MockCLPool 4, fork 1 (skips
without an RPC). Under base-forge v1.1.0: 101 passed, 4 skipped (fork plus three Cobalt-only cases).

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

## 11. Open items

**Clocked**
- Sun 4 Oct before 16:27 UTC (21:57 IST): feed mirror keeper for the Sepolia TestPriceFeeds (mainnet
  Chainlink answers mirrored on a cron; needs a keeper key and Cloudflare secret), or the Sepolia gate
  shows `FEED_STALE` at the Sunday 20:00 ET reopen.
- Sun 4 Oct 20:00 ET = Mon 5 Oct 05:30 IST: the mainnet reopen. The Observatory is live to capture it.

**Next build items (dependency order)**: Sepolia CreditDesk deploy plus `wire`; indexer Worker + D1
with the hash-chained daily root and reconciliation; Hono API skeleton; Cobalt composite-policy and
scheduled-multiplier drills; pre-liquidation contracts, Protector and keeper with validity
transactions; AaveDesk and ProtectionVault; Reserve; fork replay harness; router, self-repaying and
local-money legs; SDK, widget, app, console, x402, MCP; drills, evidence, docs, deck, videos.

**Human-only**: mainnet deployer and keeper keys with ETH; USDC seed (about $300); each developer's
AAPLc position; CDP project (paymaster, Node RPC); Builder Code; Arena project with both developers;
Cloudflare re-login with the R2 scope if exports are wanted; decision on boundline.xyz; Circle faucet
top-ups for the Sepolia book.

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

## 13. How to keep this file true

At the end of a session: bump the "Last update" line, add the session's row to the ledger in
`docs/BUILD.md`, append to sections 6, 9, 10 and 11 here (addresses, counts, decisions, open items),
and commit the two files together with the work. Numbers in this file are copied from the tool
output of that session, never estimated.
