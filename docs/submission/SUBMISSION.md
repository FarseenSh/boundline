# Boundline: Colosseum Crypto World's Fair submission

Final text for every field of the Colosseum portal, in the order the portal asks for it. Paste field by field.
Every number and hash below is copied from `deployments/base-sepolia.json`, `docs/evidence/`, `docs/CONTEXT.md` or a
live endpoint read between Thu 8 and Mon 12 Oct 2026; the source is named next to it. One kind of gap is marked:

- `TODO-HUMAN: …` a fact only the team can supply or a decision only the team can take.

Deadline: Mon 12 Oct 2026 23:59 PT = **Tue 13 Oct 2026 12:29 IST**. Upload well before it: Colosseum's clock is the
official one and the rules allow one submission per team.

---

## Project name

Boundline

## One-line description

Borrow against your stocks on Base. Paid in your currency. Never liquidated while Wall Street is closed.

## Description

**The problem.** Coinbase's tokenized stocks (B20 assets) trade on Base every hour of every day. Their Chainlink price
feeds do not: they publish from Sunday 20:00 ET to Friday 20:00 ET and hold Friday's close in between. Over each of
the last two weekends (2 to 4 and 9 to 11 October) all ten feeds printed zero rounds through the whole 48-hour closed
window, and by the reopen none had printed for 52 to 58 hours, while the stocks kept trading on Aerodrome
(`docs/evidence/reopen-2026-10-04.md`, `docs/evidence/reopen-2026-10-11.md`). The two live credit venues for these stocks on Base, Aave V4's Equities Hub and
Morpho's B20 markets, read that held price with no staleness, pause or market-hours check, and liquidation is open at any
hour. When the feed reopens on Sunday night the whole weekend's move prints at once (the first prints came 21 to 53
seconds after 20:00 ET on both weekends; on 11 October MSTRc reopened +201 bps and SNDKc +145 bps from the held value),
and a position that gapped through its limit is taken before its owner can act. Base's own
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
- **Dividends that repay the loan.** A cash dividend on a Coinbase stock arrives as a multiplier step; with the
  borrower's opt-in, the `DividendHarvester` sweeps exactly the dividend-equivalent collateral into the loan in the next
  open session, so the share count is unchanged and the debt falls. Splits and falls re-base without selling.
- **Credit lines a partner can embed.** Partner-scoped self-custody lines on Morpho (`CreditDesk`) and Aave V4
  (`AaveDesk`) with per-partner policy (tickers, LTV below the venue's limit, draw bounds, exposure caps, eligibility),
  a decision hash on every action, a partner API with x402-metered public routes, an SDK with one-tap batched borrows
  for Base Account, a local-money payout leg (USDC swapped into a local stablecoin in the same batch), a partner
  console, an MCP surface for agents, and the Boundline app as partner #1.
- **Watched in public.** The Boundline Observatory watches every Coinbase stock feed, registry flag, DEX price and real
  Aave and Morpho position on Base mainnet every minute and records each weekend's reopen as it happens, and a replay
  harness forks mainnet and takes real positions through Friday close, a −3/−8/−15% gap and the Sunday reopen, raw
  venue versus Boundline.

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
- **Mainnet, read-only and on forks:** the Observatory reads the ten Coinbase stock feeds, every Morpho B20 market (14 on
  12 Oct) and the Aave V4 MAG7 spoke live every minute (12 Oct: 1,729,470 USDC of debt on the spoke against $5.14M of
  stock collateral; 16,315.76 USDC borrowed across the Morpho markets). Fork tests prove each mechanism
  against the live mainnet contracts: a SessionGuard market on the live Morpho; the Protector pre-liquidating a real
  Steakhouse AAPLc borrower on a Saturday and selling on the real Aerodrome pool; an 80 USDC Saturday repay through
  Aave's live Giver for a real MAG7 borrower; a payout swap on the real Aerodrome EURC pool. The replay of 7 Oct
  (fork block 52,295,895) took 5 real positions (3 as they stood, 2 staged near their limit) through −3/−8/−15% gaps:
  the three as they stood stayed healthy even at −15%; the raw venues liquidated the two staged ones 3 times at the
  reopen, and Boundline's path 0 times (evidence hash `0xa626f099…3c45`).
- **The weekend, watched live:** the Observatory captured the Sun 11 Oct reopen on all ten feeds as it happened, and a
  reconstruction from the chain matches it field for field, with the transaction that transmitted every first print:
  zero rounds through the 48-hour closed window, first prints 21 to 53 seconds after 20:00 ET, from −5.8 bps (AAPLc) to
  +201 bps (MSTRc); the keeper mirrored the reopen onto the Sepolia test stocks within 19 to 317 seconds. Over that
  weekend it watched both protection targets for 48 hours; both stayed below the band, so it signed nothing.
- **A rescue while the feed is frozen** (Mon 12 Oct, a feed outage staged on Sepolia: the AAPLt test feed held stale,
  which `ShadowGuard` treats exactly like a weekend): with the venue's oracle refusing to price, the keeper Worker
  closed out an opted-in position at the TWAP shadow price as a validity transaction about 14 seconds after the DEX
  price moved it into the band (559,715 raw AAPLt seized, 1.745740 USDC repaid), while a plain `Morpho.liquidate` on the same market reverted
  `FeedStale`; then it repaid a desk line from 54.00% to 44.90% down the funding ladder (0.40 USDC from the borrower's own
  reserve, 0.14 USDC advanced by the Reserve). Both actions landed only because the feed's slot still held the frozen
  round. Once the feed was live the borrower settled the advance with its fee and the Reserve harvested it (one share
  1.0010 → 1.0017 USDC). This is the Saturday rescue we planned for 10 Oct, which nobody ran during the weekend; it
  ran on Monday under a staged outage and is labelled that way everywhere.
- **Drills with recorded runs** (Thu 8 Oct; the partner API serves each at `/v1/drills/<id>` with every hash): a stale
  feed (the gate answers `FEED_STALE`, the draw is refused, the obligation holds `HOLD_FEED` until the keeper's next
  mirrored round), a registry pause (`FEED_PAUSED`; collateral can still be added), an issuer transfer pause
  (`TRANSFER_PAUSED`, `HOLD_TRANSFER`), a scheduled lower multiplier (capacity haircut by next/current, cleared when the
  issuer cancels), an ineligible receiver (the desk refuses a withdrawal the stock's Cobalt policy would forbid, by name,
  before Morpho is called) and a keeper hold (a held line refuses draws and still takes repays). Two more on mainnet
  forks: the real 24 Sep Aave V4 hub halt replayed (the desk quotes `VENUE_HALTED` and refuses by name before the venue
  does), and a bad-debt probe on a real Steakhouse AAPLc borrower: at a −45% reopen print the raw venue wrote off 853.92
  USDC of bad debt; a session-safe oracle alone still wrote off 852.96 (it refuses a held price, it does not prevent a
  gap); with protection on, seven pre-liquidations as the DEX walked down left 0.00 USDC of bad debt and the borrower kept
  3.5457 AAPLc.
- **Webhooks, end to end:** a hold and a release on a live line (`0x5dd9d8df…42b7`, `0xd1687fdf…2514`) reached a
  partner's receiver HMAC-signed, signatures valid, 84 s and 170 s after their blocks.
- **Route plans:** `POST /v1/route` answers where a stock should be borrowed against, live on both chains (Sepolia: 0.02
  AAPLt → the AAPLt market, 3.36 USDC of capacity at 1.56% APR with pre-liquidation; mainnet: 1 AAPLc → the Steakhouse
  AAPLc market, 184.63 USDC at 5.46%), stored per line for the partner.
- **The self-repaying leg** (Fri 9 Oct): a cash dividend on a Coinbase stock arrives as a registry multiplier step, and
  the `DividendHarvester` sweeps the dividend-equivalent collateral into the loan in the next open session, so the
  borrower keeps their share count and the debt falls. Live on a desk line, with NVDAc's real 1 Oct step replayed on the
  test stock's registry mirror: a Morpho flash loan repaid 0.003582 USDC through the desk first, the 1,075 raw AAPLt of
  dividend collateral were withdrawn and sold on the pool and the rest supplied back, LTV not higher
  (`0xa44b7867…f680`); when the step was removed the next harvest re-based without selling (`0xaa136601…ae66`). Then
  with no operator: the keeper Worker found the replayed step and harvested it three blocks later (`0xb1312b5f…4616`),
  and re-based on its own when the step was removed (`0x3827eb33…cf2d`). Base's Tokenized Stocks request asks for
  "self-repaying structures".
- **On Base mainnet since 13 Oct:** the whole footprint (calendar, the gate bound to all ten Coinbase feeds,
  SessionGuards and ShadowGuards on AAPLc and NVDAc, the session-safe AAPLc market, the desk, the Protector and
  pre-liquidations on the Steakhouse AAPLc and NVDAc markets and the session-safe one, the Aave desk, both vaults, the
  Reserve, the payout router and the harvester) went out through one ordered, resumable script from a fresh key: 50
  transactions in blocks 52,530,874–52,530,925 (00:24–00:26 UTC), 0.00031 ETH (about $0.78) of gas, every address as
  rehearsed on a fork, 16 contracts verified on Basescan, 33 of 33 post-deploy checks against mainnet. The session-safe
  market is unseeded and no mainnet borrower has opted into protection yet, so nothing has been lent or protected on
  mainnet; the product runs on Base Sepolia.

**Built in the window:** 118 commits from Sat 3 Oct to Tue 13 Oct 2026 in a new repository; 264 Foundry tests (unit,
fuzz, invariant, differential) plus eight mainnet-fork suites that run against an archive RPC; 898 TypeScript tests;
eight Cloudflare Workers live; the footprint deployed on Base mainnet.
`TODO-HUMAN: if you commit again before submitting, bump the commit count (git rev-list --count HEAD).`

## Blockchains and tools integrated

| Integration | What Boundline does with it |
| --- | --- |
| **Base Sepolia** | The product sandbox: every contract deployed and verified on sepolia.basescan.org, live lines, live protection, drills |
| **Base mainnet** | Live reads every minute (feeds, registry, every Morpho B20 market, Aave V4 MAG7 spoke, Aerodrome pools); the live reopen capture; mainnet-fork proofs; the replay harness; Boundline's footprint deployed on 13 Oct (`deployments/base-mainnet.json`, 16 contracts verified on Basescan) |
| **B20 assets (Coinbase tokenized stocks)** | Collateral; `isPaused` transfer-pause reads; `isAuthorized` preflight on both legs of every transfer; UI multiplier and scheduled `newUIMultiplier`/`effectiveAt` reads for the corporate-action haircut |
| **B20 factory precompile (Cobalt)** | Issued the three test stocks with roles, a supply cap, an allowlist and a blocklist policy |
| **Cobalt composite policies and seize-exempt lists** | `INTERSECT(issuer blocklist, partner allowlist)` on the receiver scope of each test stock; the venues listed on `SEIZE_EXEMPT_POLICY` |
| **Cobalt validity transactions** (`base_sendRawTransactionValidity`) | The keeper's protective actions carry a storage predicate on the feed's `updatedAt` slot and a block-number bound |
| **Coinbase OracleRegistry** | Pause flag and multiplier per stock, inside every verdict |
| **Chainlink Coinbase stock feeds** | Prices, `updatedAt`, the full round history (weekend reconstruction, gap tracker, reopen capture) |
| **Morpho Blue** | Session-safe markets whose oracle is `SessionGuard`; partner lines through the user's own position (`setAuthorization`); every B20 market read live (14 on 12 Oct) |
| **Morpho pre-liquidation** (audited; vendored with only the pragma and import paths changed, logic identical) | Protected mode with `ShadowGuard` as the pre-liquidation oracle and Boundline's `Protector` as the pre-liquidator |
| **Aave V4 Equities Hub (MAG7 spoke)** | Lines through Aave's Taker (`borrowOnBehalfOf`), protective repay through the Giver (`repayOnBehalfOf`), recovery through `withdrawOnBehalfOf`; proven on a mainnet fork against the live spoke; every position read live |
| **Aerodrome Slipstream** | The 24/7 price: `observe()` TWAP for shadow health and `ShadowGuard`; the Protector's sale venue; the EURC/USDC pool for local-money payouts |
| **Base Account and EIP-5792** | One `wallet_sendCalls` batch (authorise, approve, add collateral, draw, payout) from the app and the SDK |
| **ERC-7677 paymaster, ERC-8021 Builder Code** | Wired as batch capabilities in the SDK and app (the suffix checked against Base's worked example); switched off until a CDP paymaster URL and a Builder Code are configured, so no transaction so far was sponsored |
| **Flashblocks** | 200 ms preconfirmation polling after a batch |
| **x402** | `POST /v1/quotes` and `GET /v1/positions/:addr/shadow` metered at $0.01 USDC for keyless callers through the x402.org facilitator |
| **USDC (Circle)** | The loan asset everywhere |
| **MCP** | An agent surface (`session`, `positions`, `shadowHealth`, `quote`, `protect`, `route`) over streamable HTTP |
| **Foundry and base-forge** | Contracts, unit/fuzz/invariant/differential tests, mainnet-fork tests with B20 precompiles |
| **OpenZeppelin 5.7** | ERC-4626 (the Reserve), access control, reentrancy guards |
| **Cloudflare Workers, D1, KV** | The Observatory, keeper, indexer, partner API, app, console, agent and site |

## Team

`TODO-HUMAN: confirm the roster. Colosseum requires the roster to match who did the work, and every member must be
registered on the Arena before the deadline. As of 12 Oct every commit in the repository is by Farseen Shaikh; a second
developer must have commits under their own GitHub identity before submission, or the roster lists Farseen alone.`

- **Farseen Shaikh**, `TODO-HUMAN: role` · builder of Boundline's contracts, keeper and data plane ·
  admitted to the MSc Data Science at TU Berlin (incoming) · GitHub `FarseenSh` ·
  `TODO-HUMAN: two lines of background (prior work, why this problem)`
- `TODO-HUMAN: second developer — name, role, background, GitHub`

## Team location

India

## Logo

`docs/submission/logo.png` (1040 × 256, the lockup on ink) and `docs/submission/logo-mark.png` (512 × 512, the tile);
vector versions `logo.svg`, `logo-mark.svg`. The mark is "bl, with the weekend held": a lowercase b, the boundary at
Friday 20:00 ET as the l, and the 48 held hours as a hatched band. The full kit (favicons, avatar, lockups, social
cards, rules) is in `docs/brand/`.

## GitHub repository

https://github.com/FarseenSh/boundline (MIT).

## Presentation video (2:00)

`TODO-HUMAN: unlisted YouTube link, tested logged out`. Script: `docs/submission/pitch-2min.md`.

## Product demo (≤ 3:00)

`TODO-HUMAN: unlisted YouTube link, tested logged out`. Script: `docs/submission/demo-3min.md`.

## Tracks

**Base.** Boundline is built on Base primitives that exist nowhere else (B20 precompiles, the Coinbase OracleRegistry,
Cobalt validity transactions and composite policies) and composes with the two live Base credit venues.

Other tracks are not selected: entering one honestly needs a real deployment and a real position on that chain, and we
have neither on Robinhood Chain or Arbitrum One.

## Go-to-market, demand validation, distribution

**Who pays.** Wallets, neobrokers and fintechs outside the US that list Coinbase's tokenized stocks and want to offer a
line of credit without funding or running the risk layer (B2B2C); Morpho curators and Aave integrators who want
protected positions and a session-safe oracle; issuers who need session-aware credit rails for the stocks they bring to
Base.

**Demand we can show today.**

- *Real exposure.* On 12 Oct 2026 (Base block 52,517,725) Aave V4's stock spoke on Base carries **1,729,470 USDC of
  debt against $5.14M of tokenized-stock collateral** (AAPLc, AMZNc, GOOGLc, METAc, MSFTc, NVDAc, TSLAc; 5.27M USDC
  supplied), and the 14 Morpho B20 markets 16,315.76 USDC; every dollar of it is priced on a feed that holds Friday's
  close for 48 hours every weekend while liquidation stays open. The Observatory follows the positions one by one (at
  least 28 on Aave, the borrowers seen since 5 Oct, and 53 on Morpho on 8 Oct) with their health at the frozen feed and at
  the DEX price.
- *The exposure is growing, and the liquidators are already there.* Debt priced at Friday's frozen feeds on the two
  venues, read at noon UTC each Saturday: 510,826 USDC (26 Sep), 1,228,422 (3 Oct), 1,563,880 (10 Oct), with liquidation
  open the whole time. No weekend liquidation has happened yet (we checked every block from 25 Sep to 12 Oct; the reopen
  gaps were −7.5 to +282 bps and no position was close enough), but a liquidation bot took two Aave positions in that
  window, MSFTc on 1 Oct and TSLAc on 8 Oct, at a 4.9% bonus each, during market hours
  (`docs/evidence/liquidations-2026-09-25-to-10-12.md`).
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
   with the health they would have at the weekend DEX price, which is the opt-in list. On mainnet those pre-liquidation
   contracts exist since 13 Oct, created on Morpho's official factory for both Steakhouse markets (AAPLc
   `0x50353Fd5…7e2F`, NVDAc `0x8d2573D1…Cc8f`).
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

- **The B20 Credit Observatory** (https://observatory.boundline.xyz): every Coinbase stock feed,
  session, registry flag, DEX price and real Aave and Morpho position on Base, minute by minute, with an open JSON API
  (`/v1/tokens`, `/v1/sessions`, `/v1/venues/morpho/markets`, `/v1/venues/aave/positions`, `/v1/gaps`, `/v1/assurance`).
- **`MarketCalendar`**: an onchain NYSE calendar (sessions, holidays, early closes, daylight saving), verified against
  Python's tz database and a TypeScript port on 5,643 instants with zero disagreements; TypeScript twin
  `@boundline/calendar`.
- **`SessionGate`, `SessionGuard`, `ShadowGuard`**: a drop-in session-aware oracle for any Morpho market and a
  live-price pre-liquidation oracle, for any curator on Base.
- **The weekend dataset**: two weekends on all ten feeds, 2 to 4 Oct reconstructed from the chain
  (`docs/evidence/reopen-2026-10-04.*`) and 9 to 11 Oct captured live and confirmed from the chain with every
  transmitting transaction (`docs/evidence/reopen-2026-10-11.*`), and the script that rebuilds any weekend from the chain
  (`scripts/reopen-evidence.py`, standard library only).
- **The replay harness**: a fork harness that takes real positions through weekend gaps and publishes the result with
  a hash (`scripts/replay`, `docs/evidence/assurance/`); first run 7 Oct 2026, with a nightly CI schedule that starts
  once the repository's secrets are set.

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
| Site | https://boundline.xyz |
| App (partner #1, Base Sepolia) | https://app.boundline.xyz |
| Observatory (Base mainnet, live) | https://observatory.boundline.xyz |
| Partner console | https://console.boundline.xyz |
| Partner API | https://api.boundline.xyz/health |
| Agent surface (MCP) | https://agent.boundline.xyz/v1/tools |
| Keeper (live sizing) | https://keeper.boundline.xyz/v1/protect |
| Indexer | https://indexer.boundline.xyz/v1/sources |
| Repository | https://github.com/FarseenSh/boundline |
| X | `TODO-HUMAN` |

Every service also still answers on its original workers.dev URL (for example https://boundline-app.papermind-ai.workers.dev); boundline.app redirects to boundline.xyz.

## Evidence index

Every row can be checked by a stranger: open the link or run the command. Base Sepolia transactions are at
`https://sepolia.basescan.org/tx/<hash>`, Base mainnet ones at `https://basescan.org/tx/<hash>`.

| Claim | Evidence |
| --- | --- |
| Debt priced at frozen feeds each Saturday: 0.51M → 1.23M → 1.56M USDC (26 Sep, 3 Oct, 10 Oct); no weekend liquidation in 720,001 blocks; two Aave liquidations in market hours | `docs/evidence/liquidations-2026-09-25-to-10-12.md` (+ .json): `0xeae435367fbfdd29003822bce54b02f1bb692a412d0790fbcc6400dc7dcfa035`, `0x98dbba0de970f877cb0410d7c762ac1370d5451802f66419cf770c3b21228538` (Base mainnet) |
| Zero rounds on ten feeds through the 48 h closed window of 2–4 Oct, first prints 23–53 s after 20:00 ET | `docs/evidence/reopen-2026-10-04.md` (rebuild: `python3 scripts/reopen-evidence.py`) |
| The same on 9–11 Oct, captured live by the Observatory and matched field for field from the chain; first prints 21–53 s after 20:00 ET | `docs/evidence/reopen-2026-10-11.md`; e.g. AAPLc's first print `0x3be1174f22e542c01b640815c9950f9f9913e5ea0bfab7fb4c635e35ecd32533` (Base mainnet block 52,486,952); live capture at `https://observatory.boundline.xyz/v1/captures` |
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
| Replay of 7 Oct: the raw venues liquidated the two staged positions 3 times, Boundline 0; the three positions as they stood stayed healthy at −15% | `docs/evidence/assurance/2026-10-07.md`, hash `0xa626f0997c74896d125080de615e1407fdc4abb6d8f8296ce62caabbc8793c45`; live at `/v1/assurance`; reproduced field for field on 13 Oct: `pnpm tsx scripts/replay/run.ts --date 2026-10-07 --block 52295895 --candidates-from docs/evidence/assurance/2026-10-07.json --out /tmp/replay` |
| Mainnet-fork proofs | `contracts/test/fork/` (`SessionGuardMorpho`, `ProtectionFork`, `AaveFork`, `PayoutFork`, `ReplayFork`), `contracts/test/drills/`, `HarvestFork`: each pinned to the block its evidence was taken at; 25 of 25 pass against an archive RPC on 13 Oct (README) |
| Every contract address | `deployments/base-sepolia.json` and `deployments/base-mainnet.json`, `docs/CONTEXT.md` §6.1–6.2 |
| Drills: stale feed, registry pause, issuer transfer pause, scheduled multiplier, ineligible receiver, keeper hold | `docs/evidence/drills/*.json`, live at `/v1/drills` (with a partner key); e.g. stale feed `0x84064c22e3ba4b33456c4a04721c66070a88a2c19fd67811072a5ccaecad8429`, registry pause `0x7b9fc996d3c579a68d6e7eb0b98a851f8c46f4f93c9172d09cef60a2f75b53cb`, issuer pause `0x73a518fa185fa8217aefd78f99ab51b677e8ae98c14024fa7f184d33f0c17bc7`, keeper hold `0x7c11ac686dff9ad21b4dbe647dc3d8abb76b808e87af8ccaecd2905d3bb39ef1` and the repay that landed while held `0x1ad33de32096ff96df24df5184a74d006db9764bedcb2c8d30d81c4f308642f3` |
| Fork drills: the Aave V4 hub halt replayed; bad debt at a −45% reopen, raw 853.92 USDC, protected 0.00 | `docs/evidence/drills/venue-halt.json` (71 of 71 checks), `docs/evidence/drills/bad-debt-probe.json` (75 of 75); `contracts/test/drills/` |
| Webhooks delivered HMAC-signed, 84 s and 170 s after the block | `0x5dd9d8df6cac14096e4b0ae3e6eafe6553a0de8a760b271bf0e3438fe91e42b7`, `0xd1687fdf25da3e4aeed84fde4d731431d35ccd4304ac02d9564111eb33202514`; `deployments/base-sepolia.json` (`proofs`) |
| A dividend harvested into a desk line's loan; the step removed, re-based without a sale | `0xa44b786744d8246b9352914d843ee96723314d5fd74e2fcaecdafcf85624f680`, `0xaa136601955d0db9b78243f2e6ee24cc609c0c53ba3bf5013c060466e7efae66`; `docs/evidence/drills/dividend-harvest.json` |
| …and by the keeper Worker with no operator, harvest then re-base | `0xb1312b5f7844d1ae1cc2c38e001552f611a457bd605ffb634ffe2d24b1124616`, `0x3827eb336f540895113f3f0d2f66dc3e155fdc3309f32c01c386e0025e47cf2d`; live at `https://keeper.boundline.xyz/v1/harvest` |
| Under a staged frozen feed (Sepolia, 12 Oct): the gate answers `FEED_STALE` in session | `0x9d1e1d550847b754de0de3e6257966becd9e6817ecb9adc486c049f4ff81b00b` (the stale round written under a hold of the keeper's mirror); `docs/evidence/feed-outage-rescue-2026-10-12.md` |
| …the keeper closed out an in-band position at the TWAP shadow price as a validity transaction, in the block after it armed (7 blocks after the DEX price moved) | `0x9774913eecd620da53019d701f10c8e90400cb6497030785a2e374360d280352` (block 48,027,596; 559,715 raw AAPLt seized, 1.745740 USDC repaid; feed slot 5 = the frozen `updatedAt` at inclusion) |
| …while a plain liquidation on the same market was refused | `cast call --rpc-url https://sepolia.base.org --block 48027596 --from 0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb "liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)" "(0x036CbD53842c5426634e7929541eC2318f3dCF7e,0xB2000000000000000000000E063E65377cA34141,0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854,0x46415998764C29aB2a25CbeA6254146D50D22687,625000000000000000)" 0xB789aD318945B37566E2549F65526Cc269a482Fc 1 0 0x` → reverts `0x604190ac…` = `FeedStale(AAPLt, 1791726186, 93600)` |
| …and repaid a desk line down the funding ladder (user reserve, then a Reserve advance), settled and harvested in session | `0x47ac5279c4804e73d05f1e8d813775514e4f8b8b09c6ffc7b014fac1956e1d24` (0.40 + 0.14 USDC, 54.00% → 44.90%); settle `0x7b71e812afff01285f20eb4af568a334834dda6b463e5242cd8da7fc8636df9f`; harvest `0x5b6874d4c3b9bf415e453c0f1d199a5b406c1b163b5a5e4404815602e8ab11c3`; `docs/evidence/drills/reserve-ladder.json` |
| Boundline on Base mainnet: 50 transactions on 13 Oct, 16 contracts verified, 33 of 33 checks against mainnet | `deployments/base-mainnet.json`; the desk `https://basescan.org/address/0x1671166DB8B93057Fa9a95b052b86c30E7B6a7Dd#code`, created in `0x6ca4ed1683471fe9810dc1a7260d19bf00d6c01e0e36b4a51a23d3d7fcbf1f40`; the session-safe AAPLc market `0xb50ecaba…1d28`, created in `0xf2bc11d1eeba35e4335929034a042334d797dda50b7c5d5a74f764da406b4ff7`; rerun the checks: `KEEPER=0x82093784Ade31543404b8AD949E49F314af7612c contracts/script/deploy-mainnet.sh check`; `docs/runbooks/mainnet-deploy.md` |
