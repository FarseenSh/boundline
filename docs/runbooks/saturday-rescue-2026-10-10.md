# Runbook: the Saturday rescue over the 9–11 Oct 2026 weekend (Base Sepolia)

Rewritten Thu 8 Oct 2026 from live reads (first version Wed 7 Oct). Goal: two real weekend rescues while the feeds are
held, both armed by the keeper Worker as validity transactions, recorded with hashes, with the Observatory capturing the
Fri 20:00 ET close and the Sun 20:00 ET reopen around them:

1. **Shadow pre-liquidation close-out** (Protector) of the deployer's opted-in drill position, directly on Morpho.
2. **Protective repay down the ladder** (DeskProtectionVault) on desk line 1: the user's reserve first, then a Reserve
   advance, settled in session on Monday.

Everything is on Base Sepolia with the test-only keys in `~/.boundline/base-sepolia.env`
(`set -a; . ~/.boundline/base-sepolia.env; set +a`; never print a value; never chain 8453). Scripts:
`scripts/sepolia/twap.py` (the mock DEX TWAP), `scripts/sepolia/record_protect.py` (a Protector action into a drill run),
`scripts/sepolia/bl.py` (shared helpers). Every number below was read on chain on 8 Oct (blocks 47,837,4xx–47,837,9xx);
recompute on the day with `python3 -I scripts/sepolia/twap.py show`.

## What changed on 8 Oct (read first)

- **The keeper does not simulate before arming, and `Protector.sizing` does not look at the sale pool's USDC.**
  `fullCloseAllowed` is true whenever the seized collateral fits on the position, so an `IN_BAND` position whose close-out
  the MockSwapPool cannot pay would be armed every minute and revert every time (the pool's exact-output swap fails with
  `ERC20InsufficientBalance`), burning the protect signer's 0.0048 ETH. On 8 Oct the pool held 1.805321 USDC against a drill
  debt of 1.805454 (both started at 2 USDC and fall together on each pre-liquidation; the gap is accrued interest), and the
  200 bps weekend haircut alone moves the drill position from 57.18% (feed) to 58.26% (mirrored DEX TWAP), inside the
  58% band, at the close. Left alone, the revert loop would have started at Sat 05:30 IST.
- **Fixed by pre-positioning, not by a pool top-up:** the deployer repaid 0.06 USDC on its own position
  (`0x345aeea78f3e19955461de49b8f1f32845a17102d2c70eeeec00e042c9b7b939`, block 47,837,876). Debt 1.745454 USDC, pool headroom
  **+0.059867 USDC** (the pool can pay a full close-out), and at the mirrored TWAP the position sits at **56.33%** while held:
  below the band unless the DEX trades ~2.7% under the held feed at the close.
- The earlier idea of keeping the pool short at the close "so the keeper logs not payable" is withdrawn: today's keeper
  would arm and revert, not log. If the keeper gains a pre-arm `eth_call` of `protect` (follow-up for the keeper lane), a
  short pool becomes a clean refusal and that variant can come back.
- **There is no line 4.** `openLine` reverts `LineExists` for the same partner, user and market, and a second partner would
  share the borrower's single Morpho position on the market. **Line 1** (the borrower's AAPLt line) was shaped instead.

## Clock (IST = ET + 9:30 while the US is on daylight time)

| When (ET) | When (IST) | Unix | What |
| --- | --- | --- | --- |
| Fri 9 Oct, before 19:45 | Sat 10 Oct, before 05:15 | | **Friday steps below** |
| Fri 9 Oct 19:45 | Sat 10 Oct 05:15 | | Observatory capture arms itself for the close (no action) |
| Fri 9 Oct 20:00 | Sat 10 Oct 05:30 | `1791590400` | feeds hold Friday's last round; `SessionGate` = `MARKET_CLOSED(WEEKEND)`; ShadowGuard switches to the pool TWAP less 200 bps |
| Sat 10 Oct, any time | Sat 10 Oct, after 05:30 | | **Saturday steps below**, with screen recording |
| Sun 11 Oct 19:45 | Mon 12 Oct 05:15 | | capture arms for the reopen |
| Sun 11 Oct 20:00 | Mon 12 Oct 05:30 | `1791763200` | first prints (the capture run id is `1791763200` = Mon 12 Oct 00:00 UTC); Monday steps once the feed is fresh |
| Tue 13 Oct | Tue 13 Oct 12:29 | | submission deadline |

## The two positions (state 8 Oct 2026)

| | Drill position (Protector target 2) | Desk line 1 (vault target) |
| --- | --- | --- |
| owner | deployer `0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E`, directly on Morpho | borrower `0xB789aD318945B37566E2549F65526Cc269a482Fc`, through the CreditDesk `0x39aB…399a` |
| market | AAPLt/USDC `0x4a03…8047`, LLTV 62.5%, oracle = SessionGuard | same market, same oracle |
| collateral | 940,611 raw AAPLt (0.00940611) | 2,000,000 raw AAPLt (0.02) |
| debt | 1.745454 USDC | 3.210175 USDC (after the keeper-hold drill's 0.01 repay) |
| LTV at the feed (335.683) | 55.28% | 47.82% |
| shadow LTV while held, TWAP mirrored (tick −12125, 336.1675) | 56.33% (`BELOW_BAND`) | 48.72% (below grace) |
| protection | pre-liquidation `0xdcae…33a1`: band 58% < shadow LTV ≤ 62.5%, preLIF 1.01–1.02, preLCF 1.0; **while closed only a full close-out can pass** (Morpho's `withdrawCollateral` re-checks health at the SessionGuard, which reverts) | DeskProtectionVault `0x87f6…f38c`: keeper job grace 52%, target 45% (`VAULT_TARGETS` on the keeper; check `/v1/vault`); user reserve **0.4 USDC**; Reserve advance liquidity 1.0 USDC, cap 2.0 per line, fee 1% |
| sale venue / funding | MockSwapPool `0x5069…081b`: 1.805321 USDC, headroom +0.059867 over the debt | the vault's own USDC (user reserve, then the Reserve's allocation) |
| 8 Oct staging txs | `Morpho.repay` 0.06 USDC: approve `0xa4c16a9152419bda10635d3d894dfd602455d568c90ddf079e1af3d1a94465bf`, repay `0x345aeea78f3e19955461de49b8f1f32845a17102d2c70eeeec00e042c9b7b939` | `withdrawCollateral` 9.98 AAPLt `0xbc42e1792a8dbb6172d3684c01667e4a0bef27a7c5bd4c65df8f0a86860fd5c5`; `draw` 1.62 USDC `0xd2de1e4727e9a3754b8cc9a3e56e090e8add6d092562ecd3fdf48f2d9e4426ce`; reserve `deposit` 0.4 USDC `0x070e87e80d92a37906396ffbfd3c37f30498452f7bd29defc0b81cf13f337928` |

**9 Oct update (the live dividend harvest on line 1, `docs/evidence/drills/dividend-harvest.json`):** line 1 is now
1,998,934 raw AAPLt against 3.206725 USDC (48.69% at the mirrored TWAP while held); the drill position's debt is 1.745526
and the pool holds 1.801739 USDC (headroom +0.056213, still above +0.03). The same commands give the same ticks: step 1
`--who drill --bps 5880` = tick −11695 (drill 58.80%, line 1 50.83%), step 2 `--who line1 --bps 5400` = tick −11096
(54.00%). Step 2's repay to 45% is now ≈ **0.5347 USDC = 0.4 user reserve + ≈ 0.1347 advance** (fee ≈ 0.0013; Monday's
settlement ≈ 0.1360). The borrower's Morpho authorisation of the harvester `0x5b1d…D58E` changes nothing on Saturday:
`harvest` is operator-only and refuses outside an OPEN session.

The two positions are the same Morpho market, so one TWAP moves both. The vault's grace (52%) sits below the band (58%), so
on line 1 the repay always comes first; the drill position has no vault target and is the Protector's case.

Thresholds while the feed is held (debts above; the shadow price is the TWAP × 0.98):

| Event | Shadow price | TWAP | DEX vs a 335.683 feed |
| --- | --- | --- | --- |
| drill position enters the band (58%) | < 319.94 | < 326.47 | −2.74% |
| line 1 crosses grace (52%) | < 308.67 | < 314.97 | −6.17% |
| drill position above LLTV (62.5%: nothing can pre-liquidate it) | < 296.91 | < 302.96 | −9.75% |

## Friday 9 Oct, before 20:00 ET (before Sat 05:15 IST)

1. **Mirror the real DEX** (the deployer owns the pool's swap price):
   `python3 -I scripts/sepolia/twap.py mirror` (copies the live Aerodrome AAPLc/USDC 1h TWAP from mainnet onto the mock:
   `setAverageTick(3600, tick)`, `setSlot0`, `setPrice36`; checks `ShadowGuard.twapPrice36()` equals the computed quote).
   Then `python3 -I scripts/sepolia/twap.py show` and check, at the mirrored TWAP while held: drill position below 58%,
   line 1 below 52%, `mock.poolUsdc` ≥ the drill debt + 0.03. If the headroom is gone (interest, an in-session partial),
   top the pool up: `cast send --rpc-url https://sepolia.base.org --private-key "$BOUNDLINE_TESTNET_DEPLOYER_KEY" 0x036CbD53842c5426634e7929541eC2318f3dCF7e "transfer(address,uint256)" 0x5069f3753961efcaea8c7f6ec49a182e2c40081b 500000`.
   **Never leave an `IN_BAND` position next to a pool that cannot pay** (see "What changed").
2. **Keeper health**: `curl -s https://boundline-keeper.papermind-ai.workers.dev/v1/status` (mirror key ≥ 0.005 ETH, all three
   pairs `in-sync`); `/v1/protect` (signer `0x4066…0373` ≥ 0.003 ETH, both targets `BELOW_BAND`); `/v1/vault` (line 1
   present, below grace, the vault's keeper equal to the signer: `DeskProtectionVault.setKeeper(0x40668755c993A551dB05E844fF9150A0C00a0373)`
   was to be sent by the deployer once the keeper's vault job reported `not-keeper`); `/v1/config` **hold empty** (vars
   `MIRROR_HOLD_*` and the KV key `hold`: the feed must hold the real Friday round, mirrored from mainnet).
3. **The recording wallet**: a fresh Base Account cannot receive the test stocks. Their receiver policies are
   `INTERSECT(issuer blocklist, holders allowlist)`: AAPLt allowlist `72057594037928092` (composite `216172782113783970`),
   NVDAt `72057594037928094` (`216172782113783972`), TSLAt `72057594037928096` (`216172782113783973`). If the demo is
   recorded with a new wallet, the human gives the address; then (and only then) the deployer, as policy admin, admits it with
   `PolicyRegistry(0x8453…0002).updateAllowlist(<allowlist>, true, [<wallet>])` on each stock and funds it with test shares
   (and Sepolia ETH/USDC) before recording. Otherwise record with the borrower test wallet `0xB789…82Fc` (already admitted on
   all three; note it is EIP-7702-delegated to MetaMask's verified `EIP7702StatelessDeleGator` `0x63c0…e32b`, a MetaMask smart
   account that still signs as the EOA).
4. **Observatory**: `GET https://boundline-observatory.papermind-ai.workers.dev/v1/sessions` → `nextFeedTransition` =
   `{ at: 1791590400, kind: "close" }`. Nothing to arm.
5. **Record the "before"** state (twap.py `show` output, `/v1/protect`, `/v1/vault`, block number) into
   `docs/evidence/saturday-rescue-2026-10-10.json` (`friday` section).

## At the close (automatic, Sat 05:30 IST)

The feeds hold; the gate answers `MARKET_CLOSED(WEEKEND)`; the SessionGuard reverts, so Morpho's `borrow`,
`withdrawCollateral` and `liquidate` revert on the market while `repay` and `supplyCollateral` stay open; the ShadowGuard
prices AAPLt at the pool TWAP less 200 bps. Expected: `/v1/protect` → `venueOracleLive: false`, both targets `BELOW_BAND`;
`/v1/vault` → line 1 below grace; nothing armed. If the DEX gapped more than ~2.7% under the feed into the close, the
drill position enters the band and the keeper closes it out at once (the pool can pay): record it as in Saturday step 1.

## Saturday 10 Oct (any time after 05:30 IST; screen recording on)

0. **Confirm the hold**: `/v1/sessions` → `state: WEEKEND`, `isFeedLive: false`; `/v1/protect` → `venueOracleLive: false`;
   keeper `/v1/status` → the Sepolia AAPLt feed equals mainnet's last Friday round.
   **Order rule (keeper since 8 Oct, deploy `abcce602`):** the keeper simulates every action from its signer before signing
   (`eth_call` at `latest` and `pending`); a simulated revert is never signed and puts that target on a **150-block (~5 min)
   backoff** that a pool top-up alone does not lift. So if the pool needs USDC, top it up **before** moving the TWAP, never
   after. `/v1/protect?simulate=…` and `/v1/vault` show the simulation result and any backoff (`untilHead`).
1. **Protector close-out of the drill position.** `python3 -I scripts/sepolia/twap.py ltv --who drill --bps 5880`
   (8 Oct numbers: TWAP tick −11695 = 322.02, −4.2% from the mirror; drill shadow LTV 58.80%; line 1 50.86%, still below
   grace). Within a minute `/v1/protect` shows the drill target `IN_BAND`, `maxSeizedAssets: 0`, `fullCloseAllowed: true`,
   decision `close`; the keeper signs `protect(preLiq, borrower, 0, borrowShares, 0, deadline)` and submits it through the
   sequencer with the held predicate (`storage(AAPLt feed, slot 5) = held updatedAt`, bound 30 blocks). The seized collateral
   (debt × preLIF / shadow price: 8 Oct numbers 1.745454 × 1.01178 / 315.579 ≈ 0.005596 AAPLt, 559,612 raw) is sold on the pool for exactly the debt; the rest returns to the position.
   Record it: `python3 -I scripts/sepolia/record_protect.py <txHash> --append --label "Sat 10 Oct 2026, WEEKEND: ..."`
   (sizing before and after, the predicate's slot value at inclusion, the gate's state). Check the Morpho position has
   `borrowShares = 0`. Then the refusal a raw liquidator meets on the same market, at the same moment:
   `cast call --rpc-url https://sepolia.base.org --from 0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb "liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)" "(<marketParams of 0x4a03…8047>)" 0xB789aD318945B37566E2549F65526Cc269a482Fc 1 0 0x`
   → reverts `MarketClosed(5)` (WEEKEND) from the SessionGuard. Record the call and its revert.
2. **Vault ladder on line 1** (only after step 1 landed: the same TWAP would otherwise put the drill position at 62.43%,
   just under LLTV). `python3 -I scripts/sepolia/twap.py ltv --who line1 --bps 5400` (8 Oct numbers: TWAP tick −11096 =
   303.30, −9.8% from the mirror; line 1 shadow LTV 54.00%). The window that works: any TWAP tick from **−11473** (line 1 at 52.00%, TWAP 314.95) to **−10382** (57.998%, TWAP 282.40). Line 1's position is also the Protector's target 1 (band from 58%), so staying under 58% means the vault acts and the Protector stays `BELOW_BAND`; the TWAP stays within the ShadowGuard's 30% deviation limit (−9.65% at −11096). Within a minute `/v1/vault` shows line 1 over grace; the keeper
   arms `DeskProtectionVault.protect(1, amount)` as a validity transaction (held predicate). Expected amount to the 45% target
   ≈ **0.535090 USDC = 0.400000 from the user reserve + 0.135090 Reserve advance** (fee 1% = 0.001351, settled Monday).
   Verify the vault's `Protected` event (fromUser, fromPartner, fromAdvance, debtBefore, debtAfter, decision hash) and the
   desk's `Repaid`/`Decision`, `advanceOf(1)`, `userBalance(borrower)` = 0. Record it in
   `docs/evidence/saturday-rescue-2026-10-10.json` (`saturday` section) and as a run of the `protection` drill.
3. **Restore the honest shadow price**: `python3 -I scripts/sepolia/twap.py mirror`.
4. Add both proofs to `deployments/base-sepolia.json` and the evidence index.

## Monday 12 Oct (after the Sun 20:00 ET reopen = Mon 05:30 IST, once the AAPLt feed has printed)

1. **Reopen capture**: `GET /v1/captures` → the run `1791763200` (Mon 12 Oct 00:00 UTC = Sun 11 Oct 20:00 ET): first-print
   hashes, lag and gap per feed into the submission before Tue 13 Oct 12:29 IST.
2. **Settle the advance** in an open session: the borrower approves the vault and calls `repayAdvance(1, principal + fee)`
   (≈ 0.136441 USDC); `AdvanceSettled` with the decision hash; the Reserve's manager (deployer) calls `harvest` on the Reserve
   to fold the fee into the share price. Record all three.
3. If a `!=`-predicate transaction is armed for the first block after the print, run it from the Worker, not a laptop
   (6 Oct: the laptop loop missed the flip during a network outage).

## Failure modes

- **A revert every minute from `0x4066…0373`** (close-out armed, pool cannot pay): top the pool up at once (Friday step 1),
  or move the TWAP back up out of the band (`twap.py mirror`). Root cause: no pre-arm simulation in the keeper.
- `ABOVE_LLTV` (shadow LTV > 62.5%): pre-liquidation refuses, only a repay can help; move the TWAP up a little, the keeper
  re-evaluates every minute.
- `NO_SHADOW_PRICE`: the ShadowGuard refused (TWAP more than 30% from the held feed, issuer or transfer pause, no TWAP);
  check `ShadowGuard.shadowPrice()` with `cast call`.
- `replacement transaction underpriced`: two transactions on one nonce. The Protector job and the vault job share the
  protect signer; the keeper signs at most one per tick and skips while one is in flight. Never sign with `0x4066…0373`
  by hand.
- `already known`: the same validity bytes re-submitted while the bound lives; the job re-arms after 35 s.
- Vault job `not-keeper`: `DeskProtectionVault.keeper()` is still the deployer; send `setKeeper(0x40668755c993A551dB05E844fF9150A0C00a0373)`.
- A hold left on: `/v1/config` must show an empty hold (vars and KV) before the close, or the Sepolia feed will not hold the
  real Friday round. Clear the KV hold with
  `cd apps/keeper && pnpm exec wrangler kv key delete --remote --namespace-id a648931723db46ca90aef102b0fe83bb hold`.
- Line 1 `HELD` by the desk keeper: repays still land (shown live 8 Oct, drill `keeper-hold`); release with the mirror key.
