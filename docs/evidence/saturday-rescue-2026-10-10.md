# Saturday rescue, 9–11 Oct 2026 (Base Sepolia): evidence

Machine-readable record: `saturday-rescue-2026-10-10.json` (sections `staging`, then `friday`, `atClose`, `saturday`,
`monday` as the weekend runs). Procedure: `docs/runbooks/saturday-rescue-2026-10-10.md`. Close `1791590400`
(Fri 9 Oct 20:00 ET = Sat 10 Oct 05:30 IST); reopen and capture run `1791763200` (Sun 11 Oct 20:00 ET = Mon 12 Oct 05:30 IST).

## Staging, Thu 8 Oct 2026 (OVERNIGHT session, gate OPEN, AAPLt feed 335.683)

**Why the staging changed.** `Protector.sizing` reports `fullCloseAllowed` whenever the seized collateral fits on the
position; it does not look at the sale pool's USDC, and the keeper does not simulate before arming. The MockSwapPool held
1.805321 USDC against a drill debt of 1.805454 (both started at 2 USDC and fall together; the gap is accrued interest), and
at the mirrored DEX TWAP the 200 bps weekend haircut alone puts the drill position at 58.26%, inside the 58% band. Left as
it was, the keeper would have armed a close-out every minute from Sat 05:30 IST and each would have reverted on the pool's
exact-output swap (`ERC20InsufficientBalance`).

| Step | Transaction | Block | Result |
| --- | --- | --- | --- |
| drill position: `USDC.approve(Morpho, 0.06)` | `0xa4c16a9152419bda10635d3d894dfd602455d568c90ddf079e1af3d1a94465bf` | 47,837,874 | |
| drill position: `Morpho.repay(0.06 USDC, onBehalf = deployer)` | `0x345aeea78f3e19955461de49b8f1f32845a17102d2c70eeeec00e042c9b7b939` | 47,837,876 | debt 1.805454 → 1.745454 USDC; shadow LTV at the feed 57.18% → 55.28%; pool headroom −0.000133 → +0.059867 USDC |
| line 1: `desk.withdrawCollateral(1, 998,000,000 raw)` | `0xbc42e1792a8dbb6172d3684c01667e4a0bef27a7c5bd4c65df8f0a86860fd5c5` | 47,837,476 | collateral 10 → 0.02 AAPLt (the policy LTV held) |
| line 1: `desk.draw(1, 1.62 USDC)` | `0xd2de1e4727e9a3754b8cc9a3e56e090e8add6d092562ecd3fdf48f2d9e4426ce` | 47,837,481 | debt 1.600174 → 3.220174 USDC, LTV 47.96% at 335.683 |
| line 1: `USDC.approve(vault, 0.4)` | `0xa0673e92341f1a8f3232899fb69f1d7f014ffecbf461d0cce3af4f895bb13776` | 47,837,485 | |
| line 1: `DeskProtectionVault.deposit(0.4 USDC)` | `0x070e87e80d92a37906396ffbfd3c37f30498452f7bd29defc0b81cf13f337928` | 47,837,487 | the borrower's own reserve, step one of the ladder |
| mock pool: `setAverageTick(3600, −12125)` | `0xcd177bfea00c8c42645c9b45eedcca20ef7b64866edfdd9eb0278305531998a2` | 47,837,901 | the mainnet AAPLc/USDC 1h TWAP (336.1675, +14.4 bps over the feed) |
| mock pool: `setSlot0(…, −12125)` | `0xd4517a08343688c7706e356a64578bde15969442174c89afd7366ba7d06e116b` | 47,837,903 | |
| mock pool: `setPrice36(3.3617e36)` | `0xaec35885ad3c0d0ed648176efca87222f39448754548a8d34bc1cd9d9a029f13` | 47,837,905 | `ShadowGuard.twapPrice36()` = 3361675058416728161502400149334752128, equal to the computed quote |
| vault: `setKeeper(0x4066…0373)` | `0x0154bde33ecbf5cfe11c0651c839533f724e71af75f25e60510628b872ba93b8` | 47,838,039 | the keeper Worker's vault job (shared protect signer) now drives line 1 |

(Line 1 also repaid 0.01 USDC while held during the keeper-hold drill: debt 3.210175 USDC.)

**State after staging, and if the feed were held at the mirrored TWAP (shadow price 329.444):**

| Position | Collateral | Debt | LTV at the feed | Shadow LTV held | Standing |
| --- | --- | --- | --- | --- | --- |
| drill (deployer, Protector band 58%–62.5%) | 940,611 raw AAPLt | 1.745454 USDC | 55.28% | 56.33% | below the band |
| line 1 (borrower, vault grace 52%, target 45%) | 2,000,000 raw AAPLt | 3.210175 USDC | 47.82% | 48.72% | below grace |

**Saturday plan (8 Oct numbers):** step 1, TWAP to tick −11695 (322.02): drill 58.80% → Protector close-out (seize ≈ 559,612
raw AAPLt, repay 1.745454 USDC from the pool's 1.805321); step 2, TWAP to tick −11096 (303.30): line 1 54.00% → vault
repay 0.535090 USDC = 0.400000 user reserve + 0.135090 Reserve advance (fee 0.001351, settled Monday in session).

## Friday, at the close, Saturday, Monday

**Friday: the mirror was not applied** (JSON `friday`). The Friday step was a one-shot job set for 04:43 IST; the machine
running it slept, the dry run started at 05:40:36 IST, ten minutes after the 05:30 IST close, and its only failing check
was the close itself. A mirror after the close would have moved the held shadow price unrecorded, so the previous mirror
(tick −12125, 336.1675 USD) stayed. It made no material difference: the mock sat 6 ticks (about 0.06%) under the mainnet
1h TWAP (tick −12131, 336.3693 USD), and mirroring would have moved the drill position from 56.33% to 56.30% and line 1
from 48.67% to 48.64% while held.

**At the close: nothing acted** (JSON `atClose`, read at Sat 06:41 and 19:07 IST). The gate answered
`MARKET_CLOSED(WEEKEND)` with AAPLt held at 336.844; the keeper's `/v1/protect` showed both targets `BELOW_BAND` with the
venue oracle off (drill 56.33%, line 1 48.67%), `/v1/vault` showed line 1 `BELOW_GRACE`, nothing was armed, and the
protection signer's balance did not move: the keeper signed nothing while the feed was held, as it should when nothing is
in the band.

**Saturday: the two recorded rescues were not run** (JSON `saturday`). They needed an operator to move the mock DEX
during the closed window and nobody did. The same two actions ran on **Mon 12 Oct in the REGULAR session under a staged
frozen feed** (the AAPLt test feed held stale, which the `ShadowGuard` treats exactly like a weekend): the keeper closed
the drill position out (`0x9774913eecd620da53019d701f10c8e90400cb6497030785a2e374360d280352`) and repaid line 1 down the
ladder (`0x47ac5279c4804e73d05f1e8d813775514e4f8b8b09c6ffc7b014fac1956e1d24`), each as a validity transaction, while a raw
liquidation was refused `FeedStale`. Recorded as a feed-outage rescue, not as a weekend:
`docs/evidence/feed-outage-rescue-2026-10-12.md`.

**Monday: the reopen was captured live** (JSON `monday`). Zero rounds on all ten feeds while closed; first prints 21 to
53 s after Sun 20:00 ET (AAPLc −5.8 bps, MSTRc +201.0 bps); the Observatory's capture and the chain reconstruction agree
on every field (`docs/evidence/reopen-2026-10-11.md`). The keeper mirrored AAPLc's first print onto the Sepolia AAPLt feed
229 s behind mainnet (`0xdc69fd45842948d33732530a37de97bc96a81008c6df457271c9ccfe89e93c45`). No weekend advance existed to
settle; the feed-outage rescue's advance was settled in session (`0x7b71e812afff01285f20eb4af568a334834dda6b463e5242cd8da7fc8636df9f`)
and harvested into the Reserve (`0x5b6874d4c3b9bf415e453c0f1d199a5b406c1b163b5a5e4404815602e8ab11c3`).
