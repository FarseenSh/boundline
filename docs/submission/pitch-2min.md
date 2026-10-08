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
| 0:08–0:33 | The problem | "Coinbase's tokenized stocks trade on Base around the clock. Their price feeds don't: they hold Friday's close until Sunday night. Over the first weekend of October, all ten feeds printed nothing for fifty-two hours. Aave and Morpho, the two lending markets for these stocks on Base, read that frozen price and liquidate at any hour. When the feed reopens, the weekend's move lands in one block." | Slide 2: the 52-hour table (held print, first print, gap) |
| 0:33–0:46 | What Boundline is | "Boundline lets you borrow against your stocks on Base, get paid in your own currency, and never be liquidated while Wall Street is closed. Wallets and brokers embed it, and pay per line and per protected position." | Slide 3 (one line + who pays) |
| 0:46–1:16 | The product, one weekend | "A partner switches it on; the user borrows in one tap. Friday, eight p.m.: the feed freezes, and our markets stop pricing it. No borrows, no liquidations, but repaying always works. Saturday, Apple's token falls on Aerodrome. Our keeper sees it at the live price and acts: a small sale paid for by the collateral itself, or a repay from a reserve. Base includes that transaction only while the feed is still frozen. Sunday night the feed reopens, and nothing bad happens." | Slide 5 (the weekend timeline), then a 3-second cut of the Observatory ribbon showing WEEKEND |
| 1:16–1:36 | What is live | "It runs on Base Sepolia today, on real B20 test stocks mirrored from mainnet. Our keeper has already protected a position on its own, twice. And our replay takes mainnet positions through weekend gaps of up to fifteen percent: three liquidations on the raw venues, none with Boundline." `[pending: if the Saturday 10 Oct rescue landed, replace the middle sentence with "On Saturday it protected a position while the feed was frozen; here is the transaction."]` | Slide 7 (what is live, hashes); Basescan of `0x982c7327…b695` for 2 s |
| 1:36–1:46 | Validation | "Today, twenty-eight borrowers owe three hundred and seventy thousand dollars on Aave's stock market on Base, every one priced on a feed that freezes each weekend." `TODO-HUMAN: if there is one real conversation or opt-in, add it as one sentence ("<name> told us …") and cut a sentence elsewhere.` | Observatory, Aave V4 positions panel |
| 1:46–2:00 | Vision and ask | "Every stock that comes on chain will need this layer. We're raising a one-million-dollar seed to take Boundline to mainnet with two design partners. Boundline: never liquidated while Wall Street is closed." | Slide 11 (ask) → slide 12 (links) |

## Notes for the take

- The replay sentence is exact: in the 7 Oct run the −15% gap took 2 raw liquidations and the −8% gap 1 (the −3% gap
  none), three in total, and two of the five positions were real positions staged closer to the line
  (`docs/evidence/assurance/2026-10-07.md`). If a judge asks, say so; do not round it up.
- "Twice" is exact: `0x982c7327…b695` (6 Oct 12:27 UTC) and `0x6d45ddc9…40d9` (6 Oct 13:56 UTC), both armed by the keeper
  Worker with no human action.
- "$370,000" is the 8 Oct 06:51 UTC snapshot ($371,476 over 28 positions). Re-read `/v1/venues/aave/positions` on
  recording day and say the number you see, rounded down.
- `[pending: mainnet]` If a mainnet deploy happens before recording, replace "It runs today on Base Sepolia" with what
  is on mainnet, and nothing more.
- Do not say "first", "only" or "revolutionary". Do not say "audited" about Boundline's own contracts (Morpho's
  pre-liquidation is audited; ours are tested, not audited).
