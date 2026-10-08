# Validity transactions: re-arming with the same bytes versus a new hash (Base Sepolia, 8 Oct 2026)

On 6 Oct 2026 a validity transaction whose predicate had already turned true was re-submitted seven times with
identical bytes, each accepted by the sequencer, before the eighth was included
(`docs/evidence/validity-transactions-sepolia.md`). The open question from that day: when an armed action must be
re-armed after its 30-block bound has passed, should the keeper re-send the same signed bytes, or re-sign (same nonce,
a new hash)? This experiment answers it on Base Sepolia's sequencer, and the keeper was changed the same day.

## Setup

| Item | Value |
| --- | --- |
| Sequencer | `https://sepolia-sequencer.base.org`, `base_sendRawTransactionValidity` |
| Key | the validity demo key `0xEcC07A1D6306B56f9684F5555C2dE87174Dc6AAE` (test-only; never the keeper Worker's keys) |
| Action | a 0-value self-transfer; from run 2 on, each trial carries its own 32-byte payload so no two trials can share a hash |
| Predicate | `storage(MarketCalendar 0x7057…96B8, slot 0)`, which holds the calendar's owner (`0x…2f0d9b1f16cd702259c6cc259e8d5e5455282a4e`) and does not change: `!=` that value is false, `=` is true; plus `block_number <= head + 30` |
| Gas | base fee 0.006 gwei (`eth_gasPrice` 6,000,000 wei throughout); tip 0.001 gwei, raised as described below |
| Script | `apps/keeper/scripts/rearm-experiment.ts` (results JSON and logs kept with this file's numbers) |

Each trial:

1. **Phase 1**: sign the transaction at nonce N and arm it with the false predicate (`!=`) and a 30-block bound. It
   cannot land; the bound passes.
2. **Phase 2**: re-arm with the true predicate (`=`) and a fresh 30-block bound, again after every expiry, up to five
   (run 1: three) times:
   - **same**: the identical signed bytes from phase 1;
   - **new**: re-signed at the same nonce with the tip 20% higher than the last (a new hash every time).
3. **Control**: a fresh transaction, never submitted before, armed once with the true predicate.

Latency is counted in blocks from the first true-predicate submission to the block of the receipt.

## Trials

Run 1 re-sent identical bytes and was stopped by hand once the pattern was clear (and once it was clear that a stuck
transaction leaves its nonce free, so a later trial must not reuse its bytes). From run 2 on, every trial carries its
own payload and tips only rise at a reused nonce. Runs 3 and 4 were cut short by an RPC rate limit (run 3, after its
fifth trial's five submissions) and by hand at the coordinator's request (run 4, after its second trial, with a third
trial's false-predicate arming at nonce 8 left to expire unincluded); the trials below are every one that reached a
result. Latency is in blocks (about 2 s each).

| run | strategy | nonce | phase 1 (false predicate) | true-predicate submissions at head | result |
| --- | --- | --- | --- | --- | --- |
| 1 | same | 3 | head 47837983, bound 47838013 | 47838015, 47838047, 47838079 | **not included**: stopped after 3 true-predicate submissions (about 96 blocks); never included (no receipt, unknown to the node); nonce 3 was later taken by run 2's control |
| 2 | control | 3 | none (fresh) | 47838104 | included in block 47838106: **2 blocks** after the first true-predicate submission ([`0xb5d4f83e…a66f`](https://sepolia.basescan.org/tx/0xb5d4f83e4c668069f0fd3cc3578c38bbf697f69cade6500aba2dc51756a1a66f), 22280 gas) |
| 3 | control | 4 | none (fresh) | 47838118 | included in block 47838119: **1 block** after the first true-predicate submission ([`0x4bafbe65…0b19`](https://sepolia.basescan.org/tx/0x4bafbe653ca15cfa0e7066c20d4b30fa3f665897229334387443035f8a060b19), 22280 gas) |
| 3 | new | 5 | `0xefa83d1dcc8d928f257a7ccf68740337d4bc1058cc7d915070b91f64bd750525` head 47838119, bound 47838149 | 47838151 | included in block 47838153: **2 blocks** after the first true-predicate submission ([`0x3c3c6095…05ee`](https://sepolia.basescan.org/tx/0x3c3c6095386aacf37e045f7971f1b4151ab70b26cd8813ff16e6a4ad2f7c05ee), 22280 gas) |
| 3 | same | 6 | `0xd87feb50f307e73645f8a8ea0ac4090f3cd90d769392d801e61969d1496b4736` head 47838153, bound 47838183 | 47838185, 47838217, 47838249, 47838281, 47838313 | **not included**: not included after 5 re-arms |
| 3 | control | 6 | none (fresh) | 47838345 | included in block 47838347: **2 blocks** after the first true-predicate submission ([`0xa9b47983…9854`](https://sepolia.basescan.org/tx/0xa9b47983feb8632888156e2d621530138f47ca1e276a68add44cf5dfb0ab9854), 22280 gas) |
| 3 | same | 7 | bound 47838377 (hash not logged) | 47838379, 47838411, 47838443, 47838475, 47838507 | **not included**: 5 true-predicate submissions accepted, none included; the script then hit an RPC rate limit; nonce 7 was still unused when run 4 began |
| 4 | new | 7 | `0x2613a3643178c1f12b3a32fd5bb7cd401406d24fb25ab4db905953e83e33e3b0` head 47838560, bound 47838590 | 47838592 | included in block 47838593: **1 block** after the first true-predicate submission ([`0x19dd5fa8…d97b`](https://sepolia.basescan.org/tx/0x19dd5fa86eac5be603194235b5e88fa8f4a4896f6e19ea1bbacdf26680c4d97b), 22280 gas) |
| 4 | same | 8 | `0x83836763c814584415fed1c4a6d5fc9cbe4723c60597cd148d86fe9335d0b4dc` head 47838593, bound 47838623 | 47838625, 47838657, 47838689, 47838721, 47838753 | **not included**: not included after 5 re-arms |

Same-bytes hashes, none ever included (`eth_getTransactionReceipt` and `eth_getTransactionByHash` both answer null for
the two checked by hand, and every nonce they held was later taken by another trial's transaction or is still free):

- run 1, nonce 3: `0x8add3dffac4b7131b6172ed09d07a88aa74fe9d3b687625b1c8bd14c00ab36ef`
- run 3, nonce 6: `0xd87feb50f307e73645f8a8ea0ac4090f3cd90d769392d801e61969d1496b4736`
- run 3, nonce 7: (not logged)
- run 4, nonce 8: `0x83836763c814584415fed1c4a6d5fc9cbe4723c60597cd148d86fe9335d0b4dc`

## What the data shows, and what it does not

**Shows.** On Base Sepolia's sequencer on 8 Oct 2026, a validity transaction whose bytes were first submitted with a
predicate that could not hold, and expired, was **never included** when the same bytes were re-submitted with a true
predicate: 0 of 4 trials, 18 accepted submissions, each held for its full 30-block window (three to five windows, about 3 to
5 minutes of true predicate, per trial). Re-signing the same nonce with a higher tip (a new hash) landed in **1 and 2 blocks** (2 of 2), as
fast as never-submitted controls (**1, 2 and 2 blocks**, 3 of 3).

**Does not show.** The samples are small (4 same, 2 new, 3 control: below the five per arm the plan asked for, because
two runs were cut short); the result is lopsided enough that the operational rule is safe, but the sizes should be read
as such. It does not show *why* the sequencer drops known hashes (it may cache the first submission's predicates per
hash, or ignore re-submitted hashes; Base does not document it). It does not test a re-submission of identical bytes
whose predicate is unchanged and true from the first submission, the Saturday case, where the first submission lands at
once and no re-arm is needed (6 Oct, `0x6b17288f…49dd` and the keeper's `0x982c7327…b695`: both next block). The 6 Oct
transaction that did land on its eighth identical re-submission is not contradicted, only not reproduced: with the
same predicate throughout, inclusion may be possible but late; with a changed predicate it never happened here.

## Findings

1. **Identical bytes re-submitted after their bound expired are accepted and never included.** The sequencer answers
   each re-submission with the hash (no error), yet none of the same-bytes trials landed with a true predicate
   (18 accepted true-predicate submissions across four trials). On-chain, those hashes have no receipt and
   are unknown to the node; the nonces they held were later consumed by other transactions.
2. **A re-signed transaction lands at once.** Every new-hash trial (same nonce, tip 20% higher, its first false
   submission expired) was included within 1 and 2 blocks after its first true-predicate submission (2 of 2).
3. **A fresh transaction with a true predicate lands at once** (within 1, 2 and 2 blocks; 3 of 3): the controls
   match the new-hash trials, so re-signing removes the penalty entirely.
4. This explains 6 Oct: the `!=` repay's re-arms after the flip were the same bytes the sequencer had already seen; the
   one that finally landed did so for a reason the sequencer does not document. The rule for the keeper is simple and
   does not depend on why: **never re-send a validity transaction's bytes after its bound has passed; re-sign.**

## What changed in the keeper (same day)

- `rearmFees` (`apps/keeper/src/protect.ts`): an episode's first arming uses the base fees; every later arming re-signs
  with the tip **and** the fee cap 25% higher per 30-block window since the episode began (both must rise at least 10%
  for the sequencer to accept a replacement while an older submission is still alive). A second attempt inside one
  tick (after `already known` or `replacement transaction underpriced`) re-signs two steps up. The episode's starting
  head is kept in the keeper's KV state.
- Both the Protector job and the vault job use it. The vault job had briefly signed byte-identical re-arms (cent-rounded
  amounts, fixed fee steps) to avoid `underpriced` answers; this experiment showed that was the wrong trade, and it was
  replaced before the vault job ever armed an action.
- Every action is also simulated from the signer before it is signed (`eth_call` at `latest` and `pending`), so a
  re-arm never spends gas on a transaction that would revert.

## Cost

The validity key went from 0.004997452355219076 ETH (read at 07:31 UTC, before run 1) to 0.004996757219107216 ETH
(07:57 UTC): **0.000000695136111860 ETH** for the five included 22,280-gas transactions. Submissions that were never
included cost nothing. The keeper Worker's keys were not used.
