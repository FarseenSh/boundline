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
