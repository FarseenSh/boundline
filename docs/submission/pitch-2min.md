# Pitch video, 2:00 (the presentation video)

Colosseum's guidance for this video: team background, the problem, who it is for, validation (even informal), the
vision; it is usually the first thing judges watch and decides the shortlist. No buzzwords, nothing flashy, under the
limit. This script is 2:00 at about 155 words a minute (the per-beat count is at the end). Record it in one take per beat; cut on the
beat boundaries.

Slides: `docs/deck/boundline.pdf` (slide numbers below). Screen captures are named where a live page is better than
a slide. Speak the numbers exactly as written; each one has a source in `docs/submission/SUBMISSION.md`.

| Time | Beat | Spoken (exact words) | On screen |
| --- | --- | --- | --- |
| 0:00–0:08 | Team | "I'm Farseen Shaikh, `TODO-HUMAN: five words on who you are`. With `TODO-HUMAN: teammate`, I build credit infrastructure for tokenized stocks on Base." | Slide 1 (title), names under the wordmark |
| 0:08–0:33 | The problem | "Coinbase's tokenized stocks trade on Base around the clock. Their price feeds don't: they hold Friday's close until Sunday night. On each of the last two weekends, all ten feeds printed nothing for two full days. Aave and Morpho, the two lending markets for these stocks on Base, read that frozen price and liquidate at any hour. When the feed reopens, the weekend's move lands in one block." | Slide 2: the 9–11 Oct table (held print, first print, gap), captured live |
| 0:33–0:46 | What Boundline is | "Boundline lets you borrow against your stocks on Base, get paid in your own currency, and never be liquidated while Wall Street is closed. Wallets and brokers embed it, and pay per line and per protected position." | Slide 3 (one line + who pays) |
| 0:46–1:16 | The product, one weekend | "A partner switches it on; the user borrows in one tap. Friday, eight p.m.: the feed freezes, and our markets stop pricing it. No borrows, no liquidations, but repaying always works. Saturday, Apple's token falls on Aerodrome. Our keeper sees it at the live price and acts: a small sale paid for by the collateral itself, or a repay from a reserve. Base includes that transaction only while the feed is still frozen. Sunday night the feed reopens, and nothing bad happens." | Slide 5 (the weekend timeline), then a 3-second cut of the Observatory's weekend-gaps panel (the 9–11 Oct reopen, captured live) |
| 1:16–1:36 | What is live | "It runs on Base Sepolia today, on real B20 test stocks mirrored from mainnet. On Monday we froze a feed mid-session: our keeper closed one position and repaid another at the live price, while a plain liquidation was refused. On a mainnet fork, staged positions that the raw venues liquidated survived with Boundline." | Slide 7 (what is live, hashes); Basescan of `0x9774913e…0352` for 2 s |
| 1:36–1:46 | Validation | "Today one point seven million dollars is borrowed against tokenized stocks on Aave's stock market on Base, every dollar priced on a feed that freezes each weekend." `TODO-HUMAN: if there is one real conversation or opt-in, add it as one sentence ("<name> told us …") and cut a sentence elsewhere.` | Observatory, Aave V4 panel (or `/v1/venues/aave/reserves`) |
| 1:46–2:00 | Vision and ask | "Every stock that comes on chain will need this layer. We're raising a one-million-dollar seed to take Boundline to mainnet with two design partners. Boundline: never liquidated while Wall Street is closed." | Slide 11 (ask) → slide 12 (links) |

## Notes for the take

- "Two full days" is exact: on both 2–4 and 9–11 Oct every feed printed zero rounds through the whole 48-hour closed
  window, and by the reopen no feed had printed for 52 to 58 hours (`docs/evidence/reopen-2026-10-04.md`,
  `docs/evidence/reopen-2026-10-11.md`; the second weekend was captured live and matches the chain field for field).
- The Monday sentence is exact and must not become "Saturday": on Mon 12 Oct, in the REGULAR session, the AAPLt test
  feed was held stale on Base Sepolia (a staged feed outage, which the oracles treat exactly like a weekend); the keeper
  closed out the drill position as a validity transaction (`0x9774913e…0352`, one block after it armed) and repaid line 1
  down the vault's ladder (`0x47ac5279…1d24`), while a raw `Morpho.liquidate` reverted `FeedStale`
  (`docs/evidence/feed-outage-rescue-2026-10-12.md`). The 9–11 Oct weekend itself passed with both positions below the
  band, so the keeper signed nothing.
- The replay sentence is exact: in the 7 Oct run the −15% gap took 2 raw liquidations and the −8% gap 1 (the −3% gap
  none), and all three were the two real positions staged near their limit; the three positions taken as they stood
  stayed healthy even at −15% (`docs/evidence/assurance/2026-10-07.md`). If a judge asks, say so; do not round it up.
- The 6 Oct automatic protections (`0x982c7327…b695` at 12:27 UTC and `0x6d45ddc9…40d9` at 13:56 UTC, both armed by the
  keeper Worker with no human action) are the fallback if asked for an action with nothing staged at all.
- "One point seven million dollars" is the Aave V4 MAG7 stock spoke read at Base block 52,517,725 (Mon 12 Oct, about
  17:06 UTC) through the Observatory's `/v1/venues/aave/reserves` and `/v1/tokens`: 1,729,470 USDC of debt against $5.14M
  of tokenized-stock collateral. Re-read on recording day and say the number you see, rounded down.
- Mainnet: nothing is deployed there as of 12 Oct. If the deploy lands before recording, replace "It runs on Base
  Sepolia today" with what is on mainnet, in one sentence, and nothing more.
- Do not say "first", "only" or "revolutionary". Do not say "audited" about Boundline's own contracts (Morpho's
  pre-liquidation is audited; ours are tested, not audited).
