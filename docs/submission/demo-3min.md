# Product demo, 3:00

Colosseum's guidance for the demo: "the how": the core features, the stack, how the work was prioritised, and why the
chain integration is built the way it is. Keep it under three minutes. This script is 2:57 at about 150 words a
minute; every beat names the exact URL, the clicks, and the hash to show.

**Honest framing, said once in beat 1 and never contradicted:** everything that writes runs on Base Sepolia (with real
B20 test stocks whose feeds mirror mainnet); Base mainnet is read live by the Observatory and exercised on mainnet
forks. `[pending: mainnet]` If a mainnet deploy exists on recording day, add it to beat 3 and to beat 1's sentence, and
nothing more.

## When to record what

The gate refuses every draw from Fri 9 Oct 20:00 ET (Sat 10 Oct 05:30 IST) to Sun 11 Oct 20:00 ET (Mon 12 Oct 05:30
IST). So:

| Beat | Record | Why |
| --- | --- | --- |
| 4 (borrow) | **Fri 9 Oct, before 05:30 IST Sat** (best: the US session, 19:00 IST Fri → 01:30 IST Sat) | the draw only passes while the feed is live |
| 2, 3, 5 (Observatory, refusal, rescue) | **Sat 10 Oct** | the ribbon reads WEEKEND, the feeds are held, the rescue happens |
| 1, 6, 7 | any time | slides and the console |

## Before recording (checklist)

- [ ] `TODO-HUMAN + main`: the recording wallet. AAPLt is a real B20 asset whose receiver policy admits only
      allowlisted holders, so a fresh Base Account cannot receive it. Either admit the recording wallet to the AAPLt
      holders allowlist and send it a few AAPLt plus Sepolia ETH (deployer-signed, Lane K1's tooling), or use the
      borrower test wallet `0xB789aD318945B37566E2549F65526Cc269a482Fc` in an injected wallet (its key is test-only).
- [ ] The market has liquidity for the draw: `https://boundline-app.papermind-ai.workers.dev/borrow` shows capacity > 0.
- [ ] **Beat 4 on the borrower test wallet draws on line 1, which is Saturday's vault target.** Line 1 has about $0.16 of
      capacity and the partner policy's smallest draw is $1, so the batch must add shares. Enter exactly **0.01 AAPLt and
      $1, receive EURCt**: line 1 goes to about 42.6% at the held TWAP and Saturday's step 2 still works (the script picks
      the tick, about −21%). Do not add more than ~0.013 AAPLt: step 2 would then need the TWAP more than 30% under the
      held feed, where the ShadowGuard stops pricing and the vault cannot act. After recording, run
      `python3 -I scripts/sepolia/twap.py show` and check line 1 is below 52% (runbook, Friday step 1).
- [ ] Browser: a clean profile, 1440 × 900, zoom 110%, dark mode; close other tabs; notifications off.
- [ ] Terminal: large font; `foundry` installed (`cast`); commands for beat 3 pasted in a scratch file.
- [ ] Paymaster: off until the CDP project exists (`TODO-HUMAN`), so the wallet pays Sepolia gas. Do not claim sponsored
      gas on screen while it is off.

## Script

| Time | Beat | Spoken (exact words) | On screen: URL, clicks, hash |
| --- | --- | --- | --- |
| 0:00–0:15 | 1. The shape | "This is Boundline, layer by layer: an onchain market calendar, a verdict on every price, protection that runs on weekends, credit lines, and the partner surface. Everything here runs on Base Sepolia or reads Base mainnet, and every claim has a hash." | Deck slide 4 (layers). |
| 0:15–0:45 | 2. The Observatory, mainnet | "The Observatory reads Base mainnet every minute. Here's the session, and when the feeds next move. Each Coinbase stock feed, its age, and how far the twenty-four-seven Aerodrome price already sits from it. Real Aave V4 positions: health at the frozen feed, and at the live price. The last weekend on record: fifty-two hours with no update. And the replay: real positions through a weekend gap on a fork, raw venue against Boundline." | `https://boundline-observatory.papermind-ai.workers.dev` → hover the session ribbon (WEEKEND, next transition Sun 20:00 ET) → scroll the feed table (age column, divergence) → Aave V4 positions panel (venue HF vs shadow HF) → Weekend gaps panel (2–4 Oct, 52 h) → the assurance panel (3 raw vs 0). |
| 0:45–1:05 | 3. The guard at the venue | "This is our oracle on a Morpho market, on a real Saturday, the third of October. Asked for a price while the feed is frozen, it refuses: market closed, weekend. So nobody can borrow or liquidate against a stale price. Adding collateral still works; here's the borrower doing it that same Saturday." | Terminal: `cast call --rpc-url https://sepolia.base.org --block 47634983 0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854 "price()(uint256)"` → `execution reverted, data: 0x3e363de9…0005` (`MarketClosed(5)`, 5 = WEEKEND). Then `https://sepolia.basescan.org/tx/0x01191a773774584bdbf4a72aff4397c870bf455c3277d7d0adf8396a42cb760b` (supplyCollateral, success, block 47,634,983). |
| 1:05–1:45 | 4. Borrow, one tap (recorded Friday) | "Now the user side. The Boundline app is our own first partner. I sign in on Base Sepolia. The quote comes from the partner API: capacity, the session, and the reason if it's refused. I'll receive euros. One tap sends one batch: authorise the desk on Morpho, add collateral, draw, and swap the USDC into a euro stablecoin, behind the same session check. The statement shows the draw, with its decision hash." | `https://boundline-app.papermind-ai.workers.dev` → Connect → `/borrow` → amount → "Receive as: EURCt" (local amount and slippage bound visible) → Borrow → wallet shows one batch → confirm → preconfirmation → `/statements` → the new Decision row (hash). `[pending: the route card from POST /v1/route: venue, market, rate, protection, plan hash]` |
| 1:45–2:25 | 5. Saturday | "Saturday. The feed is frozen; the token has moved on Aerodrome. Our keeper sized this position on chain: inside the protection band, at the live price. It signed the protection and sent it as a validity transaction, so Base includes it only while the feed's storage slot still holds Friday's round. Here it is: collateral sold at the live price, debt repaid. A plain liquidation on the same market is refused. And on a fork of mainnet, a real Morpho position pushed close to its limit, through a fifteen percent gap: the raw venue liquidates it at the reopen; with Boundline's Saturday repay, it survives." | `[pending: Saturday 10 Oct]` `https://boundline-keeper.papermind-ai.workers.dev/v1/protect` (standing IN_BAND → NO_POSITION) → `https://sepolia.basescan.org/tx/<saturday hash>` → Logs tab: `Protected` (seized, repaid, shadow price) → terminal: the refused raw `Morpho.liquidate` `cast call` → `MarketClosed`. Then `docs/evidence/assurance/2026-10-07.md`, table gap-15, row "Steakhouse AAPLc borrower, staged to venue LTV 0.56": raw 0.9486 liquidatable, went through; Boundline pre-repay 831.53 USDC, 1.0994 at reopen, refused. |
| 2:25–2:45 | 6. Partners and agents | "Partners get a console: every obligation, each line's decisions as a timeline, policy versions they sign, drills with recorded runs, and an evidence export whose hash the page recomputes. Agents get the same data over MCP, and a keyless call pays one cent over x402." | `https://boundline-console.papermind-ai.workers.dev` → Obligations → line 1 → timeline → Drills `[pending: Thursday's drills: issuer pause → TRANSFER_PAUSED, scheduled 2-for-1 → haircut, blocked receiver refused]` → Evidence → "hash matches". Terminal: `curl -i https://boundline-api.papermind-ai.workers.dev/v1/positions/0xB789aD318945B37566E2549F65526Cc269a482Fc/shadow` → `HTTP/2 402` with the payment requirements. |
| 2:45–2:57 | 7. Why Base | "None of this exists off Base: B20 precompiles, Coinbase's oracle registry, Cobalt validity transactions, Base Account batches. Boundline: borrow against your stocks, never liquidated while Wall Street is closed." | Deck slide 12 (links). |

## Fallback for beat 5 if Saturday's rescue did not land

Say instead: "On the sixth of October our keeper did this on its own, twice: it found an opted-in position inside the
band, pre-liquidated a slice at the live price as a validity transaction, and brought it back to the band edge." Show
`https://sepolia.basescan.org/tx/0x982c7327efa9f0460b92501a4322ec5dc730e5faaca3ce1d87dc80f708dfb695` (Logs: `Protected`,
52,273 raw AAPLt seized, 0.171377 USDC repaid; shadow LTV 60.12% → 58.00%), then the Reserve-funded repay
`https://sepolia.basescan.org/tx/0x28c1ec4479d58ff7e362499b3e0b3f41517a1ec7ee4cd2fa83523de2ca5c08a4` (0.5 USDC from the
user's reserve plus a 0.2 USDC Reserve advance). Keep the replay sentence.

## What not to say

- Not "audited" about Boundline's contracts (Morpho's pre-liquidation is audited; ours are tested).
- Not "mainnet" for anything that ran on Sepolia or a fork.
- Not "sponsored gas" or "Builder Code" while those are switched off (`TODO-HUMAN: CDP project, Builder Code`).
- Not "real users": the Sepolia positions are the team's test wallets. Real borrowers appear only as mainnet reads.
