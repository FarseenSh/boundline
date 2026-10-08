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

To be filled from the runbook's steps, with `scripts/sepolia/record_protect.py` for the Protector action.
