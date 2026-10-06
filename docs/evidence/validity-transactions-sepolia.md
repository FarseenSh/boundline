# Validity transactions on Base Sepolia: the keeper's conditional actions

Cobalt's `base_sendRawTransactionValidity` lets a signed transaction carry inclusion predicates: Base includes it only
while a storage slot matches, and only up to a block-number bound. Boundline uses it for the keeper's protective
actions (plan M13): the Saturday repay or shadow pre-liquidation runs only while the feed still shows the held
round; the first-block-after-reopen action runs only once the feed has printed. Exercised live on 6 Oct 2026.

## Setup

| Item | Value |
| --- | --- |
| Sequencer endpoint | `https://sepolia-sequencer.base.org` (docs: "Connect to Base", transaction submission) |
| Predicate target | AAPLt `TestPriceFeed` `0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a`, storage slot 5 = `_updatedAt` (forge inspect storage-layout) |
| Held value | `0x…6ac3e55b` = 1791223131, the mirrored mainnet round's `updatedAt` |
| Action | `CreditDesk.repay(1, 100000)`: 0.1 USDC onto line 1, signed by the test key `0xEcC07A1D6306B56f9684F5555C2dE87174Dc6AAE` |
| Tooling | `apps/keeper/scripts/validity-tx.ts` (one-off), `apps/keeper/src/protect-job.ts` (the keeper's job) |

## What the sequencer enforces (measured)

1. A `block_number` upper bound is mandatory, and it may sit at most **32 blocks ahead of the head** (about 64 s on
   2 s blocks). A bound of head + 3000 was refused: `block-number predicate at index 1 expires too far in the future:
   last satisfiable block 47763039 exceeds the maximum permitted block 47760071` (head 47760039).
2. Re-submitting the same signed transaction while its previous bound is alive answers `-32000 already known`; after
   the bound passes, the same bytes are accepted again with a new bound. So an action that waits for a state change
   is **re-armed every cycle** (same nonce, same hash, moving window), which is what the keeper does each tick.
3. Predicates read raw storage and do not simulate; the repay still carries every check in the contract.

## Transactions

| # | Predicate | Result |
| --- | --- | --- |
| 1 | `storage(feed, 5) = held` and `block_number <= head+30` ("only while the feed is still held") | accepted and included in the next block: [`0x6b17288f…49dd`](https://sepolia.basescan.org/tx/0x6b17288ff94723934a83a308ad4d350fd4403c639777bb2317646f3834c949dd), block 47760060, success, 183,098 gas, `Repaid(1, 100000)` |
| 2 | `storage(feed, 5) != held` ("only once the feed prints a new round"), re-armed every 15 s | accepted at 12:07:28 UTC (`0xbbd84631…b2fb`), held by the sequencer while the slot stayed equal; see below for the block it landed in |

The second transaction is the first-block pattern from the plan: the keeper does not watch the feed and race; Base
holds the transaction and includes it in the block where the predicate flips.

## The keeper's own action (automated)

With the Protector live, the keeper Worker's protection job found the drill position (0.01 AAPLt, 2 USDC debt,
shadow LTV 60.1%, band 58% to 62.5%) IN_BAND, took the partial that `Protector.sizing` allows and armed it as a
validity transaction with the held-feed predicate. Base included it in block 47760683:
[`0x982c7327…b695`](https://sepolia.basescan.org/tx/0x982c7327efa9f0460b92501a4322ec5dc730e5faaca3ce1d87dc80f708dfb695),
486,363 gas. Inside one transaction: Morpho `Repay` and `WithdrawCollateral`, 52,273 raw AAPLt seized and sold on the
pool, 0.171377 USDC repaid, `PreLiquidate` and `Protected` emitted. The position moved from 60.12% to exactly 58.00%
shadow LTV, the band edge the contract enforces, and the Protector kept 757 raw AAPLt as the incentive.

Lesson from the first two ticks: the protection signer shared a key with the waiting `!=` transaction above, so the
sequencer answered `replacement transaction underpriced` on the colliding nonce. Each job now has its own key.

## Result of transaction 2 (the "once the feed prints" repay)

Included in block 47763777 at 14:10:42 UTC, status success, 183,098 gas, `Repaid(1, 100000)`:
[`0xbbd84631…b2fb`](https://sepolia.basescan.org/tx/0xbbd8463132d3863f135ce30e5618d92919e4c3832b80b76510e97f18b99cb2fb). In that block the
feed's slot held `0x…6ac500c1` = 1791295681, the `updatedAt` of mainnet AAPLc round …520 (14:08:01 UTC), mirrored by the
keeper in block 47763713. The predicate had been `!=` the held round since the earlier print …519 (`0x…6ac4fdb3`,
13:54:59 UTC, mirrored in block 47763323 at 13:55:34).

What the log shows between the flip and the inclusion (67 submissions over two hours in total):

| UTC | Event |
| --- | --- |
| ~13:50 to 14:02 | the operator machine lost network (`fetch failed`); no arming could be renewed, so the arming alive at 13:50 expired within a minute and **none was alive when the slot flipped at 13:55:34** |
| 14:02:41, 14:03:46, 14:04:51, 14:05:55, 14:07:00, 14:08:04, 14:09:09 | seven re-arms accepted by the sequencer with the predicate already satisfied and a fresh 30-block bound; **none was included** |
| 14:09:57 | eighth re-arm accepted (bound 47763784) |
| 14:10:42 | included in block 47763777; the next re-arm answered `nonce too low: next nonce 3` |

The base fee was 0.005 gwei in every sampled block from 47763323 to 47763790 and the transaction's cap was 0.021
gwei, so fees were not the gate. Two lessons for the keeper, both now reflected in its design notes:

1. **A validity transaction guarantees "not before", not "as soon as".** Re-submitting the same signed bytes after a
   bound expires is accepted (`already known` while the old bound lives, a fresh hash acknowledgement after) but did
   not lead to inclusion seven times in a row with a true predicate; how the sequencer re-evaluates a re-submitted known
   hash is not documented. The next experiment is to re-sign each re-arm with a new hash (same nonce, slightly higher
   tip) instead of identical bytes, and to measure inclusion latency per re-arm.
2. **The arming must be renewed from infrastructure that stays online.** The keeper Worker re-arms every minute from
   Cloudflare; the laptop loop here missed the flip because of a twelve-minute network outage.
