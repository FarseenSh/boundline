# Feed-outage rescue on Base Sepolia, Mon 12 Oct 2026

The Saturday rescue's two actions (`docs/runbooks/saturday-rescue-2026-10-10.md`), run in the REGULAR session under a
staged frozen feed, end to end with no human in the protection loop: the keeper Worker closed out one position on the
Protector and repaid another down the vault's funding ladder, each as a Cobalt validity transaction conditioned on the
frozen feed, while a plain liquidation on the same market was refused. The advance was then settled in session and its
fee harvested into the Reserve. Machine-readable record: `feed-outage-rescue-2026-10-12.json` (a snapshot of every number
before and after each step). Script: `scripts/sepolia/outage_rescue.py`.

**Why in session, and what is staged.** The 9 to 11 Oct weekend passed without the two recorded rescues (nobody ran
them during the closed window; the keeper watched both targets for 48 hours and, both being below the band, signed
nothing: `saturday-rescue-2026-10-10.md`). The `ShadowGuard` treats `FEED_STALE` exactly like `MARKET_CLOSED`
(`heldFeed` in `ShadowGuard.shadowPrice`), so a feed that stops printing inside a session takes the same protection path
as a weekend. The staging is the 8 Oct stale-feed drill's: the keeper's mirror of AAPLt was held (KV switch) and the
AAPLt test feed rewritten to the same round and answer with an `updatedAt` 27 hours old (the gate's heartbeat is 24 h
plus 2 h of tolerance). Everything after that was the keeper's own doing. The mock DEX TWAP was moved by the operator
(`scripts/sepolia/twap.py`), as on the runbook's Saturday. This is a feed-outage rescue, not a weekend one.

## Timeline (Base Sepolia, block numbers; every transaction status 1)

| Step | What | Transaction | Block |
| --- | --- | --- | --- |
| before | gate `OPEN` (REGULAR), AAPLt feed 340.745 (mirrored mainnet round `36893488147419103552`); drill position 54.47% and line 1 47.06% at the feed, both `BELOW_BAND`; pool 1.798160 USDC; vault: 0.4 USDC user reserve, 1.0 USDC advance liquidity | | 48,027,437 |
| hold | keeper mirror held on all three symbols (KV), mirror key quiet for 70 s (nonce 162) | | |
| stale | `TestPriceFeed(AAPLt).setRoundData(same round, same answer, updatedAt 1791726186)` by the mirror key: 27 h before block time | `0x9d1e1d550847b754de0de3e6257966becd9e6817ecb9adc486c049f4ff81b00b` | 48,027,552 |
| | gate `FEED_STALE` in the REGULAR session; `ShadowGuard` source `TWAP`, 329.4442 USD (TWAP 336.1675 less 200 bps); `SessionGuard.price()` reverts `FeedStale(AAPLt, 1791726186, 93600)`; line 1 quote `FEED_STALE`, obligation `HOLD_FEED`; drill 56.34%, line 1 48.67% at the shadow price; hold narrowed to AAPLt so NVDAt and TSLAt kept mirroring | | 48,027,552 |
| | **a plain liquidation is refused:** `Morpho.liquidate(AAPLt market, 0xB789…82Fc, 1 raw, 0, 0x)` from the deployer (eth_call) reverts `FeedStale(0xB200…4141, 1791726186, 93600)` | | 48,027,552 |
| step 1 | mock TWAP to tick −11695 (322.0194 USD): `setAverageTick` `0x5f52ff5d97816268f8afc177e56862ba3dda3af6ed17dba470a8b59348b676ad`, `setSlot0` `0x3152874ba6f2fc020a072287b2c2795771c440e1e6ba499ac32fdf008efc2d30`, `setPrice36` `0x3ed88979691062f5c968640f7d8d55b7f6014b3984508c62c4c5c7bb499ea71f` | | 48,027,589–593 |
| | drill position 58.81% at the shadow price 315.5790: `IN_BAND` (58% < LTV ≤ 62.5%), venue oracle down, so only a full close-out may run; line 1 50.81% (below its 52% grace) | | 48,027,594 |
| | **the keeper armed the close-out at head 48,027,595** (signer `0x4066…0373`, nonce 67) as a validity transaction with the predicate "AAPLt feed slot 5 = 1791726186" | | |
| | **`Protector.protect` included:** `PreLiquidate` seized 559,715 raw AAPLt and repaid 1.745740 USDC (every share, 1,745,326,212,175); the Protector sold 542,123 raw on the pool at the TWAP and kept 17,592 raw as the incentive; venue price 340.745 (the frozen feed), shadow price 315.5790; decision #3 `0x8e37f401efd376e635a1eed57f083dd0fa80f1a92efe1976af83fc70e3968aea`; 468,917 gas; slot 5 at inclusion = 1791726186 (the predicate held) | `0x9774913eecd620da53019d701f10c8e90400cb6497030785a2e374360d280352` | 48,027,596 |
| | the same `Morpho.liquidate` eth_call, same moment: still `FeedStale` | | 48,027,609 |
| step 2 | mock TWAP to tick −11086 (302.9945 USD): `0x38ac7a73874d9c7a0c49daada52908d546a53c2038b4bcf99e4efe2ddb3310f2`, `0x70b29c528c05772643ea6913188a12c0ef893d6191806864dfd87a96c30e4fd9`, `0x4ce6a33ce5b619fac03eb9fad4a38908d71803a12cdd11201e956b69967b5f46` | | 48,027,642–646 |
| | line 1 54.00% at the shadow price 296.9346: over the vault job's grace (52%), still under the Protector's band (58%) | | 48,027,647 |
| | **the keeper armed the vault repay at head 48,027,655** (nonce 68), validity transaction, same predicate | | |
| | **`DeskProtectionVault.protect(1, 0.54 USDC)` included:** 0.400000 from the borrower's own reserve + 0.140000 Reserve advance (fee 1% = 0.0014), paid through `desk.repay`; debt 3.203537 → 2.663537 USDC; line 1 44.90% (target 45%); vault decision `0xcacc2f5793921b5aff4cbf0a587f50472f05ade4235a2b1552fc57838cb112ab`; the desk's `Repaid` and `Decision` in the same transaction; 315,168 gas; slot 5 at inclusion = 1791726186 | `0x47ac5279c4804e73d05f1e8d813775514e4f8b8b09c6ffc7b014fac1956e1d24` | 48,027,656 |
| restore | mock TWAP mirrored from the mainnet AAPLc/USDC 1h TWAP (tick −12242, 340.1236 USD): `0xb57cfd4727f92127b9931313ac61cf78e755c0e1b691da1c008d99a72a9e04ef`, `0x74e4a8c1b780e6e5fc6847c2a199bf0f5238e32952d013a86fa6353602c53b78`, `0xdba402b2009bce5fb00ea475348125dac6bc7bba6a3482ce2c0346ee683088db`; KV hold released | | 48,027,688–694 |
| | the keeper Worker's mirror wrote the live mainnet round back (updatedAt 1791816167): gate `OPEN`, line 1 obligation `OPEN`, 39.13% at the feed | `0xd532f47f5671b7955bb69e3f4748ee84ade58ce7920a80e7619a50b21e47d8b4` | 48,027,746 |
| settle | the borrower approves and settles the advance in session: `repayAdvance(1, 0.141400)` = 0.14 principal + 0.0014 fee (`AdvanceSettled`) | approve `0x4c8cd0ac62e1ce6788eda6daed06643f1df6d20370bd71f1fe7a27fa7fbb756d`, settle `0x7b71e812afff01285f20eb4af568a334834dda6b463e5242cd8da7fc8636df9f` | 48,027,776 / 778 |
| harvest | `BoundlineReserve.harvest(vault)` by the manager: totalAssets 2.003400 USDC on 2.0 shares, **1 share = 1.0017 USDC** (1.0010 after the 7 Oct cycle) | `0x5b6874d4c3b9bf415e453c0f1d199a5b406c1b163b5a5e4404815602e8ab11c3` | 48,027,791 |

## What it shows

- **Protection acts on a frozen price without trusting it.** Both actions were sized at the TWAP shadow price and
  executed while the venue's own oracle refused to price; the frozen 340.745 never priced anything.
- **The validity transactions did their job.** Each landed one or two blocks after the keeper armed it, and the feed's
  `updatedAt` slot equalled the frozen round's value at inclusion. Had the feed printed first, neither could have
  landed on the new price.
- **The venue stayed shut for everyone else.** A raw `Morpho.liquidate` against the same market reverted `FeedStale`
  before and after the close-out: on a session-safe market only Boundline's protection path, through Morpho's own
  audited pre-liquidation contract, could act.
- **The funding ladder worked as designed.** The user's own reserve paid first, the Reserve's advance only the rest,
  and the advance came back with its fee in session, raising the Reserve's share price.

Left behind: the drill position is closed (380,896 raw AAPLt collateral, no debt) and the sale pool holds 0.052420 USDC,
so a repeat needs a fresh borrow and a pool top-up. Gas spent by the keeper's signer: 0.0000047 ETH for both actions (balance 0.004838641 → 0.004833936 ETH).
