# Liquidations on Base mainnet's B20 credit venues, 25 Sep to 12 Oct 2026

Every liquidation on the two live credit venues for Coinbase's tokenized stocks on Base, from Fri 25 Sep 2026 20:00 ET
(the close before the first weekend) to Mon 12 Oct 2026 16:00 UTC, read from the chain. The span covers three weekends
whose feeds were held, each closed window, and the hours after each reopen. Machine-readable record:
`liquidations-2026-09-25-to-10-12.json`.

## What was scanned

- **Blocks 51,795,727 to 52,515,727** (720,001 blocks; timestamps 1790380801 to 1791820801), every block in the span,
  1,000-block windows (the public gateway's maximum), **1,442 `eth_getLogs` queries** on `https://base.gateway.tenderly.co`.
  Each hit was re-read on an archive RPC: receipt status, the log in the receipt, block timestamp, the feed's round at
  that block.
- **Morpho Blue**: `Liquidate` on the 13 B20 markets (ids in the JSON, from `apps/indexer/src/sources.ts`), and
  `PreLiquidate` from any contract on those markets (Morpho's audited pre-liquidation contracts).
- **Aave V4 MAG7 spoke** `0x17905Db0e4A3514467539956c084180616AE7B8D`: `LiquidationCall` and `ReportDeficit` (v0.5.11
  event signatures, the same topics the indexer decodes).
- **Positive controls in the same queries**: 248 Morpho `Repay`s on the B20 markets and 772 `Repay`s on the spoke came
  back, so an empty answer means no event, not a broken query.

## Result

| Venue | Liquidations | Pre-liquidations | Deficits reported | Inside a closed window | Within 6 h after a reopen |
| --- | ---: | ---: | ---: | ---: | ---: |
| Morpho Blue, 13 B20 markets | 0 | 0 | | 0 | 0 |
| Aave V4 MAG7 spoke | **2** | | 0 | 0 | 0 |

Both liquidations happened on Thursdays during regular trading hours, with fresh feeds. Neither was priced on a held
feed:

| Time | Session | Collateral | Borrower | Debt repaid | Collateral removed | Feed at that block (age) | Bonus at the feed | Transaction (block) |
| --- | --- | --- | --- | ---: | ---: | --- | ---: | --- |
| Thu 1 Oct 2026 10:21:59 ET (14:21:59 UTC) | REGULAR | MSFTc | `0x26d595dddbad81bf976ef6f24686a12a800b141f` | 9.866689 USDC | 0.02003981 MSFTc ($10.35) | 516.70 (19 min) | 4.95% | `0xeae435367fbfdd29003822bce54b02f1bb692a412d0790fbcc6400dc7dcfa035` (52,037,586) |
| Thu 8 Oct 2026 13:30:53 ET (17:30:53 UTC) | REGULAR | TSLAc | `0x37619647c8efc03b1f9dce061890316073b3a051` | 137.079874 USDC | 0.38882916 TSLAc ($143.84) | 369.927 (19 min) | 4.93% | `0x98dbba0de970f877cb0410d7c762ac1370d5451802f66419cf770c3b21228538` (52,345,653) |

Both were executed by the same liquidator contract `0xa14f2d3c5b761e4038dcf72216e60227ba11debf` (called from
`0x7a874be3d3713d6b7767c36d2abd5488da6dc2e1`). The collateral went out in underlying assets (`receiveShares` false), and no
premium debt was involved. Neither collateral has an Aerodrome pool in our book, so there is no DEX price to compare.

## The debt that sat on a frozen price each weekend

Read at Saturday 12:00 UTC, inside each closed window: `totalBorrowAssets` of the 13 Morpho B20 markets, and the spoke's
`getReserveTotalDebt(7)` (USDC, the MAG7 spoke's only borrowable reserve).

| Weekend | Block | Morpho B20 debt | Aave V4 MAG7 USDC debt | Total priced at Friday's feed, liquidation open | Liquidations while closed |
| --- | --- | ---: | ---: | ---: | ---: |
| Fri 25 Sep 20:00 ET to Sun 27 Sep 20:00 ET | 51,817,327 | 104,933.04 | 405,892.51 | 510,825.56 USDC | 0 |
| Fri 2 Oct 20:00 ET to Sun 4 Oct 20:00 ET | 52,119,727 | 79,576.33 | 1,148,845.70 | 1,228,422.03 USDC | 0 |
| Fri 9 Oct 20:00 ET to Sun 11 Oct 20:00 ET | 52,422,127 | 15,825.65 | 1,548,054.36 | 1,563,880.01 USDC | 0 |

## What it means, honestly

- **Liquidation on these venues is live and active.** A liquidator bot took two Aave V4 MAG7 positions in 17 days, at a
  4.9% bonus each, both while the market was open. So the venue Boundline sits on does liquidate tokenized stocks.
- **No weekend liquidation happened in these three weekends**, and none in the hours after a reopen. The weekend gaps were
  small: −5.8 to +201.0 bps at the 11 Oct reopen and −7.5 to +282 bps at the 4 Oct one (`reopen-2026-10-11.md`,
  `reopen-2026-10-04.md`), not enough to push a position through its limit. The risk Boundline addresses is the exposure
  shown above, debt priced at a frozen feed for 48 hours with liquidation open, rising to $1.56M by 10 Oct. It is not an
  observed weekend loss.
- **Aave's share grew fast.** The spoke's USDC debt went from 0.41M to 1.55M across the three weekends, while Morpho's
  B20 debt fell from 0.10M to 0.016M.
