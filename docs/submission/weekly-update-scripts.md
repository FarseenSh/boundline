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
| 0:46–0:55 | "And a replay of real Aave and Morpho positions on a mainnet fork: through weekend gaps, three liquidations on the raw venues, none with Boundline." | Observatory, the assurance panel |
| 0:55–1:00 | "This weekend: a live rescue while the feeds are frozen." | Observatory ribbon, next transition Fri 20:00 ET |

Numbers if asked on screen: 53 commits from 3 to 8 Oct; 240 Foundry tests and 691 TypeScript tests; eight services live.

## Update 2: Mon 12 Oct 2026, the weekend (record after the 05:30 IST reopen)

`[pending: fill every bracket from the evidence; delete any line whose event did not happen]`

| Time | Spoken | Screen |
| --- | --- | --- |
| 0:00–0:08 | "This is Boundline's update for the weekend of the tenth of October." | Logo |
| 0:08–0:22 | "Friday at eight p.m. Eastern, every Coinbase stock feed froze, and our markets stopped pricing them. Borrows and liquidations were refused all weekend; repaying stayed open." | Observatory ribbon (WEEKEND), the feed table with ages |
| 0:22–0:40 | "On Saturday `[pending: what moved, by how much]`. Our keeper `[pending: what it did: the close-out and the vault repay, amounts]`, in transactions Base would only include while the feed was still frozen." | Basescan `[pending: hashes]`, the keeper's `/v1/protect` |
| 0:40–0:52 | "Sunday at eight the feeds reopened: first prints `[pending]` seconds after the bell, gaps of `[pending]` basis points, captured live by our Observatory." | Observatory `/v1/captures`, run `1791763200` |
| 0:52–1:00 | "Next: mainnet, and our first design partners." | Deck, ask slide |
