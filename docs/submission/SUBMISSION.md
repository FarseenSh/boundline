# Boundline: Colosseum Crypto World's Fair submission

Final text for every field of the Colosseum portal, in the order the portal asks for it. Paste field by field.
Every number and hash below is copied from `deployments/base-sepolia.json`, `docs/evidence/`, `docs/CONTEXT.md` or a
live endpoint read on Thu 8 Oct 2026; the source is named next to it. Two kinds of gaps are marked:

- `TODO-HUMAN: …` a fact only the team can supply or a decision only the team can take.
- `[pending: …]` work landing between Thu 8 and Mon 12 Oct 2026; fill it from the evidence when it exists, or delete
  the sentence. Never ship a pending slot as written.

Deadline: Mon 12 Oct 2026 23:59 PT = **Tue 13 Oct 2026 12:29 IST**. Submit Sun 11 Oct evening IST; update the reopen
hashes on Mon 12 Oct after 05:30 IST (the feeds reopen Sun 11 Oct 20:00 ET, onchain calendar `nextTransition` = `1791763200`).

---

## Project name

Boundline

## One-line description

Borrow against your stocks on Base. Paid in your currency. Never liquidated while Wall Street is closed.

## Description

**The problem.** Coinbase's tokenized stocks (B20 assets) trade on Base every hour of every day. Their Chainlink price
feeds do not: they publish from Sunday 20:00 ET to Friday 20:00 ET and hold Friday's close in between. Over the
2 to 4 October weekend all ten feeds printed zero rounds for 52 hours while the stocks kept trading on Aerodrome
(`docs/evidence/reopen-2026-10-04.md`). The two live credit venues for these stocks on Base, Aave V4's Equities Hub and
Morpho's B20 markets, read that held price with no staleness, pause or market-hours check, and liquidation is open at any
hour. When the feed reopens on Sunday night the whole weekend's move prints in one block (the first prints came 23 to 53
seconds after 20:00 ET), and a position that gapped through its limit is taken before its owner can act. Base's own
documentation says "never settle or liquidate against a frozen feed". Nothing on Base enforces it, and Aave's risk
provider describes session-aware handling as "a future stage".

**What Boundline is.** The session-aware credit layer for tokenized stocks on Base, which wallets and brokers embed to
offer a line of credit against a user's stocks:

- **An onchain NYSE calendar and a verdict engine.** `MarketCalendar` knows every session (pre-market, regular, post,
  overnight, weekend, holiday, early closes, US daylight saving by rule). `SessionGate` decides per stock whether a price
  is safe to use, from the session, the feed's age, the Coinbase OracleRegistry pause flag and the issuer's transfer
  pause, and fails closed on any bad read.
- **Oracles that refuse to price a frozen feed.** `SessionGuard` is a Morpho oracle that reverts while the feed is held,
  so on Boundline's markets `borrow`, `withdrawCollateral` and `liquidate` stop on the weekend while `repay` and
  `supplyCollateral` keep working. `ShadowGuard` prices positions at the 24/7 Aerodrome TWAP less a haircut, so
  protection can act on Saturday at the price the market actually shows.
- **Protection seven days a week.** Inside a narrow band below the venue's liquidation line, Morpho's audited
  pre-liquidation contract with `ShadowGuard` as its oracle lets Boundline's `Protector` sell a small slice of the
  collateral at the live price and repay from the proceeds, paid for by the collateral itself (on Boundline's own
  session-safe markets a weekend action is a full close-out instead, because Morpho re-checks the frozen market
  oracle on any partial). Where a sale cannot run, a
  protective repay runs down a funding ladder (the user's reserve, the partner's reserve, then a bounded advance from
  the Boundline Reserve, an ERC-4626 vault for capital providers) and is settled in the next open session.
- **Actions that Base itself conditions on the feed.** The keeper submits each protective action as a Cobalt validity
  transaction: Base includes it only while the feed's storage slot still shows the held round (or only once it shows
  a new one), so a rescue planned on a frozen price can never land on a different one.
- **Credit lines a partner can embed.** Partner-scoped self-custody lines on Morpho (`CreditDesk`) and Aave V4
  (`AaveDesk`) with per-partner policy (tickers, LTV below the venue's limit, draw bounds, exposure caps, eligibility),
  a decision hash on every action, a partner API with x402-metered public routes, an SDK with one-tap batched borrows
  for Base Account, a local-money payout leg (USDC swapped into a local stablecoin in the same batch), a partner
  console, an MCP surface for agents, and the Boundline app as partner #1.
- **Watched in public.** The Boundline Observatory watches every Coinbase stock feed, registry flag, DEX price and real
  Aave and Morpho position on Base mainnet every minute, and a replay harness (built to run nightly) forks mainnet and
  takes real positions through Friday close, a −3/−8/−15% gap and the Sunday reopen, raw venue versus Boundline.

Boundline never holds a stock or a loan: the user keeps their own Morpho or Aave position and authorises Boundline's
contracts, or the venue's own audited ones, with one signature, and can revoke in one call.

**What is live** (all on Base Sepolia unless marked; every transaction is on sepolia.basescan.org; full hashes in the
evidence index below):

- The full stack runs on Base Sepolia against **real B20 test stocks** (AAPLt, NVDAt, TSLAt, issued through Base's B20
  factory precompile with Cobalt composite receiver policies), whose feeds a keeper mirrors from mainnet every minute,
  so the sandbox freezes, goes stale and reopens exactly when mainnet does.
- **The refusal on a real weekend:** on Sat 3 Oct a borrower posted 10 AAPLt as collateral (a sent transaction,
  succeeded) and a borrow attempt (`eth_call`) reverted `MarketClosed(WEEKEND)`. Anyone can replay it:
  `SessionGuard.price()` at block 47,634,983 reverts `0x3e363de9…05`.
- **A partner line, in session:** a 5 USDC draw through the CreditDesk during the PRE session on Tue 6 Oct at the
  SessionGuard price of $332.67, then repays, all quoted and recorded by the partner API and the indexer.
- **Automatic protection, twice:** the keeper Worker found an opted-in position inside the band and pre-liquidated it
  at the ShadowGuard price as a validity transaction, with no human in the loop (Tue 6 Oct 12:27 UTC: shadow LTV
  60.12% → 58.00%, 0.171377 USDC repaid from the sale of 52,273 raw AAPLt), and again 89 minutes later when the
  price moved it back in (0.023302 USDC).
- **Validity transactions** with storage predicates on the feed's `updatedAt` slot, both forms: "only while the feed is
  held" (included in the next block) and "only once the feed prints" (held by the sequencer until the round changed).
- **The Reserve at work:** two protective repays on a live line (Wed 7 Oct; the path never reads the oracle, so it
  works at any hour), the second funded partly by a 0.2 USDC Reserve advance, settled by the borrower with its 1% fee
  and harvested into the Reserve's share price (1 share = 1.001 USDC).
- **Local money:** 0.5 USDC swapped into 0.46 EURCt by the payout router inside the borrow flow, gated on an open
  session.
- **x402:** two keyless API calls paid $0.01 in test USDC each through the x402.org facilitator.
- **Mainnet, read-only and on forks:** the Observatory reads the ten Coinbase stock feeds, all 13 Morpho B20 markets and
  the Aave V4 MAG7 spoke live every minute (8 Oct, 06:51 UTC: 28 Aave positions with $371,476 of debt against $828,749
  of collateral; 53 Morpho positions, 15,774.75 USDC borrowed across the 13 markets). Fork tests prove each mechanism
  against the live mainnet contracts: a SessionGuard market on the live Morpho; the Protector pre-liquidating a real
  Steakhouse AAPLc borrower on a Saturday and selling on the real Aerodrome pool; an 80 USDC Saturday repay through
  Aave's live Giver for a real MAG7 borrower; a payout swap on the real Aerodrome EURC pool. The replay of 7 Oct
  (fork block 52,295,895): across 5 positions × 3 gaps, the raw venues let 3 liquidations through at the reopen,
  Boundline 0 (evidence hash `0xa626f099…3c45`).
- `[pending: Saturday 10 Oct rescue — the keeper's held-feed validity transaction on Base Sepolia, with its hash]`
- `[pending: Thursday's drills — stale feed, registry pause, issuer transfer pause, scheduled multiplier, ineligible receiver, keeper hold, venue halt and bad-debt probe — with hashes]`
- `[pending: route plans, webhooks, the dividend harvester]`
- `[pending: mainnet — SessionGuard, the session-safe AAPLc market and the pre-liquidations on the Steakhouse markets, deployed as soon as a funded mainnet key exists]`

**Built in the window:** 53 commits from Sat 3 Oct to Thu 8 Oct 2026 in a new repository; 240 Foundry tests (unit,
fuzz, invariant, differential) plus five mainnet-fork suites that run against an archive RPC; 691 TypeScript tests;
eight Cloudflare Workers live.
`TODO-HUMAN: refresh the counts on submission day (git log | wc -l, forge test, pnpm test).`

## Blockchains and tools integrated

| Integration | What Boundline does with it |
| --- | --- |
| **Base Sepolia** | The product sandbox: every contract deployed and verified on sepolia.basescan.org, live lines, live protection, drills |
| **Base mainnet** | Live reads every minute (feeds, registry, 13 Morpho B20 markets, Aave V4 MAG7 spoke, Aerodrome pools); mainnet-fork proofs; the replay harness. `[pending: mainnet deploys]` |
| **B20 assets (Coinbase tokenized stocks)** | Collateral; `isPaused` transfer-pause reads; `isAuthorized` preflight on both legs of every transfer; UI multiplier and scheduled `newUIMultiplier`/`effectiveAt` reads for the corporate-action haircut |
| **B20 factory precompile (Cobalt)** | Issued the three test stocks with roles, a supply cap, an allowlist and a blocklist policy |
| **Cobalt composite policies and seize-exempt lists** | `INTERSECT(issuer blocklist, partner allowlist)` on the receiver scope of each test stock; the venues listed on `SEIZE_EXEMPT_POLICY` |
| **Cobalt validity transactions** (`base_sendRawTransactionValidity`) | The keeper's protective actions carry a storage predicate on the feed's `updatedAt` slot and a block-number bound |
| **Coinbase OracleRegistry** | Pause flag and multiplier per stock, inside every verdict |
| **Chainlink Coinbase stock feeds** | Prices, `updatedAt`, the full round history (weekend reconstruction, gap tracker, reopen capture) |
| **Morpho Blue** | Session-safe markets whose oracle is `SessionGuard`; partner lines through the user's own position (`setAuthorization`); 13 B20 markets read live |
| **Morpho pre-liquidation** (audited; vendored with only the pragma and import paths changed, logic identical) | Protected mode with `ShadowGuard` as the pre-liquidation oracle and Boundline's `Protector` as the pre-liquidator |
| **Aave V4 Equities Hub (MAG7 spoke)** | Lines through Aave's Taker (`borrowOnBehalfOf`), protective repay through the Giver (`repayOnBehalfOf`), recovery through `withdrawOnBehalfOf`; proven on a mainnet fork against the live spoke; every position read live |
| **Aerodrome Slipstream** | The 24/7 price: `observe()` TWAP for shadow health and `ShadowGuard`; the Protector's sale venue; the EURC/USDC pool for local-money payouts |
| **Base Account and EIP-5792** | One `wallet_sendCalls` batch (authorise, approve, add collateral, draw, payout) from the app and the SDK |
| **ERC-7677 paymaster, ERC-8021 Builder Code** | Wired as batch capabilities in the SDK and app; switched on by configuration. `TODO-HUMAN: CDP project (paymaster URL) and Builder Code from dashboard.base.org` |
| **Flashblocks** | 200 ms preconfirmation polling after a batch |
| **x402** | `POST /v1/quotes` and `GET /v1/positions/:addr/shadow` metered at $0.01 USDC for keyless callers through the x402.org facilitator |
| **USDC (Circle)** | The loan asset everywhere |
| **MCP** | An agent surface (`session`, `positions`, `shadowHealth`, `quote`, `protect`, `route`) over streamable HTTP |
| **Foundry and base-forge** | Contracts, unit/fuzz/invariant/differential tests, mainnet-fork tests with B20 precompiles |
| **OpenZeppelin 5.7** | ERC-4626 (the Reserve), access control, reentrancy guards |
| **Cloudflare Workers, D1, KV** | The Observatory, keeper, indexer, partner API, app, console, agent and site |

## Team

`TODO-HUMAN: confirm the roster. Colosseum requires the roster to match who did the work, and every member must be
registered on the Arena before the deadline. Today all 53 commits are by Farseen Shaikh; a second developer must have
commits under their own GitHub identity before submission, or the roster lists Farseen alone.`

- **Farseen Shaikh**, `TODO-HUMAN: role` · builder of Boundline's contracts, keeper and data plane ·
  admitted to the MSc Data Science at TU Berlin (incoming) · GitHub `FarseenSh` ·
  `TODO-HUMAN: two lines of background (prior work, why this problem)`
- `TODO-HUMAN: second developer — name, role, background, GitHub`

## Team location

India

## Logo

`docs/submission/logo.png` (1040 × 256, wordmark) and `docs/submission/logo-mark.png` (512 × 512, square mark);
vector versions `logo.svg`, `logo-mark.svg`.

## GitHub repository

`TODO-HUMAN: public repository URL` (MIT). Before publishing, run `docs/submission/PUBLIC-REPO-CHECKLIST.md`.

## Presentation video (2:00)

`TODO-HUMAN: unlisted YouTube link, tested logged out`. Script: `docs/submission/pitch-2min.md`.

## Product demo (≤ 3:00)

`TODO-HUMAN: unlisted YouTube link, tested logged out`. Script: `docs/submission/demo-3min.md`.

## Tracks

**Base.** Boundline is built on Base primitives that exist nowhere else (B20 precompiles, the Coinbase OracleRegistry,
Cobalt validity transactions and composite policies) and composes with the two live Base credit venues.

Other tracks are not selected: entering one honestly needs a real deployment and a real position on that chain, and we
have neither on Robinhood Chain or Arbitrum One today. `TODO-HUMAN: revisit only if a real deployment exists by Sunday.`

## Go-to-market, demand validation, distribution

**Who pays.** Wallets, neobrokers and fintechs outside the US that list Coinbase's tokenized stocks and want to offer a
line of credit without funding or running the risk layer (B2B2C); Morpho curators and Aave integrators who want
protected positions and a session-safe oracle; issuers who need session-aware credit rails for the stocks they bring to
Base.

**Demand we can show today.**

- *Real exposure.* As of 8 Oct 2026 06:51 UTC the Observatory counts 28 open positions on Aave V4's stock spoke on Base
  with $371,476 of USDC debt against $828,749 of stock collateral, and 53 positions across the 13 Morpho B20 markets
  with 15,774.75 USDC borrowed; every one of them is priced on a feed that freezes for 52 hours every weekend.
- *The problem is named in public by the people closest to it.* Aave's risk provider LlamaRisk calls session-dependent
  parameters and feed safeguards "a future stage"; Base's documentation says "never settle or liquidate against a
  frozen feed"; a 25 Sep 2026 piece in eGamers describes the frozen equity feed outright.
- *Base asked for this product.* Base's Request for Builders lists "Tokenized Portfolios as Collateral" and an SBLOC
  embedded B2B2C for brokerages; Base's Tokenized Stocks request names "self-repaying structures".
- `TODO-HUMAN: conversations held (names, dates, what they said), Base office hours attended, protected-mode opt-ins
  from real borrowers, any partner interest in writing. Delete this line if there are none; do not pad.`

**Distribution.**

1. *Protected mode for existing borrowers, one signature.* Every borrower on the Morpho B20 markets can opt into
   protection by authorising Morpho's own audited pre-liquidation contract; the Observatory already lists each of them
   with the health they would have at the weekend DEX price, which is the opt-in list. `[pending: mainnet]`
2. *The Observatory as the public artifact.* Live weekend data nobody else publishes (feed age, DEX gap, positions at
   risk, the reopen capture), shared every weekend; it is how venues, curators and issuers find Boundline.
3. *Partner embed.* A partner API, an SDK and a reference app; a wallet integrates in a day and keeps its own brand.
4. *Agents.* An MCP surface and x402-metered endpoints, so an agent with a wallet can price, monitor and protect a
   position without an account.
5. *The oracle as a standard.* Curators can list markets on `SessionGuard` or use `ShadowGuard` as a pre-liquidation
   oracle today, MIT-licensed.

**Business model.** A platform fee per partner; 20 to 50 bps on originations; 10 to 25 bps a year on protected
notional; metered API calls through x402 ($0.01 a quote or shadow-health read today); the Reserve's advance fee (1% per
advance on Sepolia) and the pre-liquidation incentive accrue to Reserve capital providers. Boundline never lends its own
balance sheet against stocks; capital comes from the venues and the Reserve.

**What the seed buys.** $1M over 12 months: 40% engineering (smart-contract and risk), 20% legal and structure, 15%
security (two audits), 15% capital and partnerships (seed the Reserve, curator agreements), 10% go-to-market.
Milestones: three design partners live on mainnet, $5M of protected notional, the oracle adopted by one curator, a
third venue.

## Public goods

Boundline's public infrastructure is MIT-licensed, deployed, and usable by anyone without asking us:

- **The B20 Credit Observatory** (https://boundline-observatory.papermind-ai.workers.dev): every Coinbase stock feed,
  session, registry flag, DEX price and real Aave and Morpho position on Base, minute by minute, with an open JSON API
  (`/v1/tokens`, `/v1/sessions`, `/v1/venues/morpho/markets`, `/v1/venues/aave/positions`, `/v1/gaps`, `/v1/assurance`).
- **`MarketCalendar`**: an onchain NYSE calendar (sessions, holidays, early closes, daylight saving), verified against
  Python's tz database and a TypeScript port on 5,643 instants with zero disagreements; TypeScript twin
  `@boundline/calendar`.
- **`SessionGate`, `SessionGuard`, `ShadowGuard`**: a drop-in session-aware oracle for any Morpho market and a
  live-price pre-liquidation oracle, for any curator on Base.
- **The weekend dataset**: the reconstructed 2 to 4 Oct weekend on all ten feeds (`docs/evidence/reopen-2026-10-04.*`)
  and the script that rebuilds any weekend from the chain (`scripts/reopen-evidence.py`, standard library only).
- **The replay harness**: a fork harness that takes real positions through weekend gaps and publishes the result with
  a hash (`scripts/replay`, `docs/evidence/assurance/`); built to run nightly from CI, first run 7 Oct 2026.
  `TODO-HUMAN: the nightly schedule needs the GitHub remote and its secrets; until then say "replay", not "nightly".`

We submit these as a public good in their own right: they are useful to every venue, curator, issuer and risk team on
Base whether or not anyone uses Boundline's credit lines.

## University

`TODO-HUMAN: decide the University checkbox truthfully before ticking it. The facts as known: Farseen Shaikh has been
admitted to the MSc Data Science at TU Berlin and is not yet enrolled; the second developer's student status is
unknown.` Suggested wording if the team ticks it:

> Farseen Shaikh is an incoming MSc Data Science student at Technische Universität Berlin (admitted for the
> `TODO-HUMAN: term` intake, not yet enrolled at the time of submission). `TODO-HUMAN: second developer's status.`

University name: Technische Universität Berlin.

## Prior work (the form's question, one sentence)

Boundline was written from scratch in a new repository starting on 3 October 2026, inside the contest window; an earlier
prototype of the idea (BaseFlow, August to September 2026, a separate repository) informed the design, and none of its
code was carried over.

`TODO-HUMAN: confirm this sentence is accurate as worded before submitting.`

## Links

| What | URL |
| --- | --- |
| Site | https://boundline-site.papermind-ai.workers.dev |
| App (partner #1, Base Sepolia) | https://boundline-app.papermind-ai.workers.dev |
| Observatory (Base mainnet, live) | https://boundline-observatory.papermind-ai.workers.dev |
| Partner console | https://boundline-console.papermind-ai.workers.dev |
| Partner API | https://boundline-api.papermind-ai.workers.dev/health |
| Agent surface (MCP) | https://boundline-agent.papermind-ai.workers.dev/v1/tools |
| Keeper (live sizing) | https://boundline-keeper.papermind-ai.workers.dev/v1/protect |
| Indexer | https://boundline-indexer.papermind-ai.workers.dev/v1/sources |
| Repository | `TODO-HUMAN` |
| X | `TODO-HUMAN` |

`TODO-HUMAN: if boundline.xyz is repointed to the site, replace the workers.dev links.`

## Evidence index

Every row can be checked by a stranger: open the link or run the command. Base Sepolia transactions are at
`https://sepolia.basescan.org/tx/<hash>`.

| Claim | Evidence |
| --- | --- |
| The feeds held for 52 h over 2–4 Oct, zero rounds on ten feeds, first prints 23–53 s after 20:00 ET | `docs/evidence/reopen-2026-10-04.md` (rebuild: `python3 scripts/reopen-evidence.py`) |
| A borrow on a SessionGuard market reverts on the weekend | `cast call --rpc-url https://sepolia.base.org --block 47634983 0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854 "price()(uint256)"` → `MarketClosed(5)` = `0x3e363de9…05` |
| Collateral can still be added on the weekend | `0x01191a773774584bdbf4a72aff4397c870bf455c3277d7d0adf8396a42cb760b` (block 47,634,983) |
| The same oracle prices in session | `cast call --rpc-url https://sepolia.base.org 0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854 "price()(uint256)"` on a weekday |
| A partner line drew in the PRE session | `0x661ebb1abc30e1fffe987b4598b006004ed746943afcc1e67ea82595854b8bac` (5 USDC, $332.67, Decision `0xdaa6562f…c816`) |
| A partial repay on the line | `0xe3bc2f0b3a58975b5870d624fd4772656deab41ef9fbc3b5c0f727d3f464771b` |
| Validity transaction, "only while held" | `0x6b17288ff94723934a83a308ad4d350fd4403c639777bb2317646f3834c949dd` (block 47,760,060) |
| Validity transaction, "only once the feed prints" | `0xbbd8463132d3863f135ce30e5618d92919e4c3832b80b76510e97f18b99cb2fb` (block 47,763,777); `docs/evidence/validity-transactions-sepolia.md` |
| The keeper pre-liquidated an in-band position automatically | `0x982c7327efa9f0460b92501a4322ec5dc730e5faaca3ce1d87dc80f708dfb695` (block 47,760,683; shadow LTV 60.12% → 58.00%) |
| …and again when the price moved it back into the band | `0x6d45ddc95b314de50f3a3375b2d764302e07a920869fd2000fa768fdc84a40d9` (block 47,763,353; 0.023302 USDC repaid at $330.92) |
| Protective repays on a live line through the vault's ladder, one funded by a Reserve advance | `0xa0efe0c47d788acb8e0f756b62ebf01e155cb33c553d6e4ccdfc2d20065c9f07`, `0x28c1ec4479d58ff7e362499b3e0b3f41517a1ec7ee4cd2fa83523de2ca5c08a4` |
| The advance settled with its fee, the fee harvested by the Reserve | `0x14c4ffbdd12e2a52785b28c1837fd9c9cff2400b07bf22e2922faf96152cdb9a`, `0xf257476420589a5455369f2337802911420427909f803684bd15d0173984da67` |
| USDC paid out as a local stablecoin in session | `0x9090633cf6559f5935a9e5659f4faa7ad6b278e4db93c8141154d2aded5b5bd3` (0.5 USDC → 0.46 EURCt) |
| x402 settlements | `0x8816d08fb7d6fadb8983f116bb4963bb5040e9666db6f15076272eb81cf5c6ff`, `0x055981d83ca73612b1677326f1ecb5847c9ccbfcdcad1b8a25f3a2c81eaca8f9` |
| B20 test stock issued through the factory precompile | AAPLt `0x4f4a6d6f23a7d5eca48ec8bcfb350e9f675473f369cf181c580dd0bc7767f570` |
| Cobalt composite receiver policy | `0xfef401e631bf24be3d4eedbb25ed55772db4f27f29b9ebeb78a2a0139955a2ba`, bound in `0x422f3d99d94f148afb3ba7b222f6a8932430b7bbeb3dfa25685299340ae37fdc` |
| The session-safe Morpho market | `0x9ac34b99a822927dc8219aa8292b4781c4afc9e84251f073a988006dff62b0a9` (id `0x4a03b124…8047`) |
| Replay of 7 Oct: raw 3 liquidations, Boundline 0 | `docs/evidence/assurance/2026-10-07.md`, hash `0xa626f0997c74896d125080de615e1407fdc4abb6d8f8296ce62caabbc8793c45`; live at `/v1/assurance` |
| Mainnet-fork proofs | `contracts/test/fork/` (`SessionGuardMorpho`, `ProtectionFork`, `AaveFork`, `PayoutFork`, `ReplayFork`); run with an archive RPC (README) |
| Every contract address | `deployments/base-sepolia.json`, `docs/CONTEXT.md` §6.1 |
| `[pending]` | Saturday rescue; Thursday's drills; route plans and webhooks; mainnet deploys; Sunday reopen capture (`/v1/captures`, run `1791763200`) |
