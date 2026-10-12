# Product demo, 3:00

Colosseum's guidance for the demo: "the how": the core features, the stack, how the work was prioritised, and why the
chain integration is built the way it is. Keep it under three minutes. This script is 2:56 at about 150 words a minute
(440 spoken words); every beat names the exact URL, the clicks, and the hash to show.

**Honest framing, said once in beat 1 and never contradicted:** everything that writes runs on Base Sepolia (with real
B20 test stocks whose feeds mirror mainnet); Base mainnet is read live by the Observatory and exercised on mainnet
forks. Nothing is deployed on mainnet as of Mon 12 Oct. *Optional, only if mainnet is deployed before recording:* add
one sentence to beat 1 ("and since tonight the oracles, the session-safe market and the pre-liquidations are on Base
mainnet") and the Basescan link of the deploy to beat 3, and nothing more.

## When to record what

Recording happens Mon 12 Oct night or Tue 13 Oct morning IST, in a live session: REGULAR until 01:30 IST, POST until
05:30 IST, then OVERNIGHT. The gate refuses draws only while the feeds are held; the next close is Fri 16 Oct 20:00 ET.
So every beat can be recorded in one sitting, with one precondition:

| Precondition | Why |
| --- | --- |
| **D1 is back:** `https://boundline-indexer.papermind-ai.workers.dev/v1/sources` and the Observatory's `/v1/positions` answer 200 | On 12 Oct the Cloudflare account ran out of D1's free daily read quota and every D1-backed route answered 500 until the 00:00 UTC reset (05:30 IST): the indexer, the Observatory's position panels, the API's obligations and route plans, the console's timelines and the app's statements. It comes back at 05:30 IST, or as soon as the Workers Paid plan is active. |
| The API serves the 12 Oct runs: the console's Drills page lists 14 drills and `protection` has 3 runs | The drill runs are bundled into the API at build time; until it is redeployed the console shows 13 drills without Monday's runs. |

## Before recording (checklist)

- [ ] `TODO-HUMAN + main`: the recording wallet. AAPLt is a real B20 asset whose receiver policy admits only
      allowlisted holders, so a fresh Base Account cannot receive it. Either admit the recording wallet to the AAPLt
      holders allowlist and send it a few AAPLt plus Sepolia ETH (deployer-signed, Lane K1's tooling), or use the
      borrower test wallet `0xB789aD318945B37566E2549F65526Cc269a482Fc` in an injected wallet (its key is test-only).
- [ ] The market has liquidity for the draw: 7.34 USDC free on the AAPLt market on 12 Oct;
      `https://boundline-app.papermind-ai.workers.dev/borrow` shows capacity > 0.
- [ ] **Beat 4 on the borrower test wallet draws on line 1.** After Monday's ladder repay line 1 sits at 39.1% with 0.74
      USDC of capacity, under the partner policy's $1 minimum draw, so the batch must add shares: enter **0.01 AAPLt and
      $1, receive EURCt** (about 2.4 USDC of capacity with the added share). The weekend sizing limit of the old runbook
      no longer applies.
- [ ] Browser: a clean profile, 1440 × 900, zoom 110%, dark mode; close other tabs; notifications off.
- [ ] Terminal: large font; `foundry` installed (`cast`); the two commands for beats 3 and 5 pasted in a scratch file.
- [ ] Paymaster: off until the CDP project exists (`TODO-HUMAN`), so the wallet pays Sepolia gas. Do not claim sponsored
      gas on screen while it is off.

## Script

| Time | Beat | Spoken (exact words) | On screen: URL, clicks, hash |
| --- | --- | --- | --- |
| 0:00–0:15 | 1. The shape | "This is Boundline, layer by layer: an onchain market calendar, a verdict on every price, protection that runs while the feed is frozen, credit lines, and the partner surface. Everything here runs on Base Sepolia or reads Base mainnet, and every claim has a hash." | Deck slide 4 (layers). |
| 0:15–0:45 | 2. The Observatory, mainnet | "The Observatory reads Base mainnet every minute. Here's the session, and when the feeds next freeze: Friday, eight p.m. Eastern. Each Coinbase stock feed, its age, and how far the twenty-four-seven Aerodrome price sits from it. Real Aave V4 positions: health at the feed, and at the live price. The last weekend, captured live: forty-eight hours with no update, every feed back within a minute of the reopen. And the replay: real positions through a weekend gap on a fork, raw venue against Boundline." | `https://boundline-observatory.papermind-ai.workers.dev` → hover the session ribbon (the live session, next feed transition Fri 16 Oct 20:00 ET, close) → scroll the feed table (age column, divergence) → Aave V4 positions panel (venue HF vs shadow HF) → Weekend gaps panel (the 9–11 Oct reopen, run `1791763200`) → the assurance panel. |
| 0:45–1:05 | 3. The guard at the venue | "This is our oracle on a Morpho market, on a real Saturday, the third of October. Asked for a price while the feed is frozen, it refuses: market closed, weekend. So nobody can borrow or liquidate against a stale price. Adding collateral still works; here's the borrower doing it that same Saturday." | Terminal: `cast call --rpc-url https://sepolia.base.org --block 47634983 0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854 "price()(uint256)"` → `execution reverted, data: 0x3e363de9…0005` (`MarketClosed(5)`, 5 = WEEKEND). Then `https://sepolia.basescan.org/tx/0x01191a773774584bdbf4a72aff4397c870bf455c3277d7d0adf8396a42cb760b` (supplyCollateral, success, block 47,634,983). |
| 1:05–1:45 | 4. Borrow, one tap | "Now the user side. The Boundline app is our own first partner. I sign in on Base Sepolia. The quote comes from the partner API: capacity, the session, and the reason if it's refused. The route card shows where the line is booked and that it's protected. I'll receive euros. One tap sends one batch: authorise the desk on Morpho, add collateral, draw, and swap the USDC into a euro stablecoin, behind the same session check. The statement shows the draw, with its decision hash." | `https://boundline-app.papermind-ai.workers.dev` → Connect → `/borrow` → amount (0.01 AAPLt, $1) → the route card from `POST /v1/route` (venue, market, rate, protection `pre-liquidation`, plan hash) → "Receive as: EURCt" (local amount and slippage bound visible) → Borrow → wallet shows one batch → confirm → preconfirmation → `/statements` → the new Decision row (hash). |
| 1:45–2:25 | 5. A frozen feed, protected | "Protection. On Monday we froze the Apple test feed mid-session, an outage our oracles treat exactly like a weekend, and moved the DEX down. The keeper sized this position on chain, inside the band at the live price, and sent the close-out as a validity transaction Base includes only while the feed slot holds the frozen round. One block later: collateral sold, debt repaid. A plain liquidation, same moment: refused, feed stale. The vault then repaid another line from the borrower's reserve and a Reserve advance. On a mainnet fork, staged positions the raw venue liquidated survived on Boundline's path." | `https://sepolia.basescan.org/tx/0x9774913eecd620da53019d701f10c8e90400cb6497030785a2e374360d280352` → Logs tab: `Protected` (559,715 raw AAPLt seized, 1.745740 USDC repaid, shadow price 315.58 against the frozen 340.745). Terminal: the refused raw liquidation at the same block (command below) → `execution reverted, data: 0x604190ac…` = `FeedStale(AAPLt, 1791726186, 93600)`. Then `https://sepolia.basescan.org/tx/0x47ac5279c4804e73d05f1e8d813775514e4f8b8b09c6ffc7b014fac1956e1d24` → Logs: the vault's `Protected` (0.40 from the user, 0.14 advance). Then `docs/evidence/assurance/2026-10-07.md`, table gap-15, row "Steakhouse AAPLc borrower, staged to venue LTV 0.56": raw 0.9486 liquidatable, went through; Boundline pre-repay 831.53 USDC, 1.0994 at reopen, refused. |
| 2:25–2:45 | 6. Partners and agents | "Partners get a console: every obligation, each line's decisions as a timeline, policy versions they sign, drills with recorded runs, and an evidence export whose hash the page recomputes. Agents get the same data over MCP, and a keyless call pays one cent over x402." | `https://boundline-console.papermind-ai.workers.dev` → Obligations → line 1 → timeline → Drills (issuer transfer pause → `TRANSFER_PAUSED`; scheduled multiplier → capacity 592.39 → 296.20; ineligible receiver refused by name; reserve ladder, 12 Oct) → Evidence → "hash matches". Terminal: `curl -i https://boundline-api.papermind-ai.workers.dev/v1/positions/0xB789aD318945B37566E2549F65526Cc269a482Fc/shadow` → `HTTP/2 402` with the payment requirements. |
| 2:45–3:00 | 7. Why Base | "None of this exists off Base: B20 precompiles, Coinbase's oracle registry, Cobalt validity transactions, Base Account batches. Boundline: borrow against your stocks, never liquidated while Wall Street is closed." | Deck slide 12 (links). |

Beat 5's refused liquidation, the same market at the block that included the close-out (the deployer as caller, one raw
share of the borrower's collateral):

```sh
cast call --rpc-url https://sepolia.base.org --block 48027596 --from 0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E \
  0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb \
  "liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)" \
  "(0x036CbD53842c5426634e7929541eC2318f3dCF7e,0xB2000000000000000000000E063E65377cA34141,0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854,0x46415998764C29aB2a25CbeA6254146D50D22687,625000000000000000)" \
  0xB789aD318945B37566E2549F65526Cc269a482Fc 1 0 0x
# execution reverted, data: 0x604190ac… → FeedStale(0xB200…4141, 1791726186, 93600)
```

The market tuple is `Morpho.idToMarketParams(0x4a03b124…8047)`: USDC, AAPLt, the AAPLt `SessionGuard`, the
AdaptiveCurveIrm, LLTV 62.5%. Checked on 12 Oct: it reverts as shown.

## Alternative for beat 5

If a judge-proof action with nothing staged is preferred, use the keeper's two automatic protections of 6 Oct in
session: "On the sixth of October our keeper did this on its own, twice: it found an opted-in position inside the band,
pre-liquidated a slice at the live price as a validity transaction, and brought it back to the band edge." Show
`https://sepolia.basescan.org/tx/0x982c7327efa9f0460b92501a4322ec5dc730e5faaca3ce1d87dc80f708dfb695` (Logs: `Protected`,
52,273 raw AAPLt seized, 0.171377 USDC repaid; shadow LTV 60.12% → 58.00%). Keep the replay sentence. A fresh live
action on camera would need the drill position re-staged (it was closed out on 12 Oct) and the sale pool topped up (it
holds 0.052420 USDC).

## What not to say

- Not "audited" about Boundline's contracts (Morpho's pre-liquidation is audited; ours are tested).
- Not "mainnet" for anything that ran on Sepolia or a fork.
- Not "Saturday" or "weekend" for the 12 Oct rescue: it ran in the REGULAR session under a staged frozen feed.
- Not "real positions were liquidated" about the replay: every raw liquidation in the 7 Oct run was a position staged near
  its limit; the three positions taken as they stood stayed healthy.
- Not "sponsored gas" or "Builder Code" while those are switched off (`TODO-HUMAN: CDP project, Builder Code`).
- Not "real users": the Sepolia positions are the team's test wallets. Real borrowers appear only as mainnet reads.
