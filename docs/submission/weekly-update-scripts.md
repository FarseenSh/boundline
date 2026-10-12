# Weekly update videos (60 s each)

Colosseum strongly recommends one-minute weekly updates; they show the judges how fast the team ships. Each script is
about 150 spoken words. Screen: the live pages named per line, or the deck. `TODO-HUMAN: check whether any earlier
weekly update was posted on the Arena; if not, post update 1 now and update 2 on Monday.`

## Update 1: Thu 8 Oct 2026, the build week (record and post today)

| Time | Spoken | Screen |
| --- | --- | --- |
| 0:00–0:08 | "This is Boundline's update for the week of the third of October." | Logo |
| 0:08–0:22 | "We started from an empty repository on Saturday. By that night our market calendar and oracles were live on Base Sepolia, and on a real weekend our Morpho market refused to price the frozen feed: the borrow was refused, the collateral was accepted." | Terminal: the `price()` call at block 47634983 reverting `MarketClosed(WEEKEND)` |
| 0:22–0:34 | "On Tuesday came the first draw on a partner line in session, and our keeper pre-liquidated a position on its own, twice, as a Cobalt validity transaction." | Basescan `0x982c7327…b695` |
| 0:34–0:46 | "Wednesday: the Reserve funded a protective repay, payouts in a local stablecoin, a partner API metered by x402, a partner console, and an MCP server for agents." | Console, then the app's "Receive as" |
| 0:46–0:55 | "And a replay of real Aave and Morpho positions on a mainnet fork, two of them staged near their limit: through weekend gaps, the raw venues liquidated the staged ones, Boundline none." | Observatory, the assurance panel |
| 0:55–1:00 | "Next: the weekend, watched live." | Observatory ribbon, next transition Fri 20:00 ET |

Numbers if asked on screen (as of Thu 8 Oct): 53 commits from 3 to 8 Oct; 240 Foundry tests and 691 TypeScript tests;
eight services live. If update 1 is posted late, keep its words: every line describes what existed on 8 Oct.

## Update 2: Mon 12 Oct 2026, the weekend and the reopen

| Time | Spoken | Screen |
| --- | --- | --- |
| 0:00–0:05 | "This is Boundline's update for the weekend of the tenth of October." | Logo |
| 0:05–0:25 | "Friday at eight p.m. Eastern, every Coinbase stock feed froze, and our markets stopped pricing them. Borrows and liquidations were refused all weekend; repaying stayed open. Our keeper watched both protected positions for forty-eight hours; neither came near its limit, so it signed nothing." | Observatory weekend-gaps panel; `docs/evidence/saturday-rescue-2026-10-10.md` (at the close) |
| 0:25–0:41 | "Sunday at eight the feeds reopened: first prints twenty-one to fifty-three seconds after the bell, gaps from minus six to plus two hundred and one basis points, captured live by our Observatory and matched against the chain." | Observatory `/v1/captures`, run `1791763200`; `docs/evidence/reopen-2026-10-11.md` |
| 0:41–0:56 | "Then we froze a feed on purpose, mid-session on Base Sepolia. Our keeper closed one position and repaid another at the live price, in transactions Base would only include while the feed stayed frozen. A plain liquidation was refused." | Basescan `0x9774913e…0352` (Logs: `Protected`), then `0x47ac5279…1d24` |
| 0:56–1:00 | "Next: mainnet, and our first design partners." | Deck, ask slide |

Numbers if asked on screen (as of Mon 12 Oct): 98 commits from 3 to 12 Oct; 264 Foundry tests and 897 TypeScript tests;
eight services live; 14 drills with recorded runs.
