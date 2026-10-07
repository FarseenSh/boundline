# Runbook: the Saturday rescue over the 9–11 Oct 2026 weekend (Base Sepolia)

Written Wed 7 Oct 2026. Goal: the keeper's protection job performs a real weekend rescue while the
feeds are held, recorded with hashes, and the Observatory captures the Fri 20:00 ET close and the
Sun 20:00 ET reopen around it. Every step below is on Base Sepolia with the test-only keys in
`~/.boundline/base-sepolia.env` (`set -a; . ~/.boundline/base-sepolia.env; set +a`; never print a value;
never chain 8453).

## Clock (IST = ET + 9:30 while the US is on daylight time)

| When (ET) | When (IST) | What |
| --- | --- | --- |
| Fri 9 Oct 19:45 | Sat 10 Oct 05:15 | Observatory capture arms itself for the close (no action) |
| Fri 9 Oct 20:00 | Sat 10 Oct 05:30 | Feeds hold Friday's last round; `SessionGate` = `MARKET_CLOSED(WEEKEND)` |
| Sat 10 Oct, any time | Sat 10 Oct, afternoon IST | **the drill below**: move the DEX mock price, the keeper rescues |
| Sun 11 Oct 19:45 | Mon 12 Oct 05:15 | capture arms for the reopen |
| Sun 11 Oct 20:00 | Mon 12 Oct 05:30 | first prints; hashes into the submission (deadline Tue 13 Oct 12:29 IST) |

## The position that gets rescued

The deployer's drill position from 6 Oct, directly on Morpho (outside the desk), opted into the AAPLt
pre-liquidation `0xdcae…33a1` and watched by the keeper (`PROTECT_TARGETS`, second entry):

| Item | Value (read live before acting) |
| --- | --- |
| borrower | `0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E` (deployer) |
| market | AAPLt/USDC `0x4a03…8047`, LLTV 62.5%, oracle = SessionGuard |
| pre-liquidation | preLltv 58%, preLCF 1.0, preLIF 1.01–1.02, oracle = ShadowGuard (`0x7a53…3f65`, pool TWAP −200 bps while held) |
| state after the 6 Oct partial | shadow LTV 58.00%, debt ≈ 2.0 USDC, collateral ≈ 947,727 raw AAPLt |
| shadow price source | `MockSwapPool` `0x5069…081b` (owner = deployer): `setPrice36` sets the swap price, `setAverageTick`/`setSlot0` set the TWAP the ShadowGuard reads (it is a `MockCLPool`) |

Why this one and not a desk line: on a SessionGuard market **while closed only a full close-out can
pass** (`PreLiquidation.onMorphoRepay` → `Morpho.withdrawCollateral` re-checks health at the market
oracle, which reverts `MarketClosed`; `Protector.sizing` reports `maxSeizedAssets = 0` and
`fullCloseAllowed = true` when preLCF covers every share and the pool can pay). So the Saturday action
is a close-out of a small position, not a partial. The desk lines (1–3) stay far below the band and are
the subjects of the any-hour protective **repay** path instead (DeskProtectionVault, Lane A of 7 Oct),
which the keeper can drive on Thursday once its grace job exists.

## Friday 9 Oct, before 20:00 ET (before Sat 05:30 IST)

1. Read the position: `curl -s https://boundline-keeper.papermind-ai.workers.dev/v1/protect` → second
   target: `standing`, `shadowLtvWad`, `debtAssets`, `collateral`, `fullCloseSeizedAssets`.
2. Make sure the pool can pay the close-out: the MockSwapPool must hold USDC ≥ `debtAssets × 1.02` plus
   margin (it held 1.805 USDC on 7 Oct 19:20 IST; debt ≈ 2.0 USDC → top up at least 0.5 USDC):
   `cast send --rpc-url https://sepolia.base.org --private-key "$BOUNDLINE_TESTNET_DEPLOYER_KEY" 0x036CbD53842c5426634e7929541eC2318f3dCF7e "transfer(address,uint256)" 0x5069f3753961efcaea8c7f6ec49a182e2c40081b 1000000`
   (Circle faucet top-ups are the human step if the deployer runs short.)
3. Check the keeper is healthy: `/v1/status` (keeper ETH ≥ 0.005), `/v1/protect` (`signer` `0x4066…0373`,
   ETH ≥ 0.003), `/v1/config` (`hold` empty). Do not touch `MIRROR_HOLD_*`: the feed must hold the real
   Friday round, mirrored from mainnet, exactly like the real thing.
4. Observatory: `GET /v1/sessions` shows `nextFeedTransition.kind = close` at `1791590400` (Fri 20:00 ET).
   Nothing to arm; it records itself.
5. Record the "before" sizing JSON and the block in `docs/evidence/saturday-rescue-2026-10-10.md`.

## Saturday 10 Oct (any time after 05:30 IST; the feed is held)

1. Confirm the hold: `/v1/sessions` → `state: WEEKEND`, `isFeedLive: false`; the keeper's `/v1/status`
   shows the Sepolia AAPLt feed equal to mainnet's last Friday round; `/v1/protect` → `venueOracleLive:
   false`, standing `BELOW_BAND`.
2. Move the DEX price down 4–6% (from 58.0% shadow LTV, −4% → 60.4%, −6% → 61.7%; stay under 62.5% or
   the standing becomes `ABOVE_LLTV` and nothing can rescue it). On the MockSwapPool (deployer is owner):
   set the swap price and the TWAP consistently. `price36 = price × 1e36 × 1e6 / 1e8`-style scaling as
   recorded in the json note (`$332.69 = 3.3267e36`); the TWAP tick for a price `P` (USDC per AAPLt, token0
   USDC 6 dec, token1 AAPLt 8 dec) is `tick = floor(log(1e6 / (P × 1e8)) / log(1.0001))` (the 6 Oct value:
   `-12021` for $332.69). Compute both with Python, then:
   `cast send … 0x5069…081b "setPrice36(uint256)" <p36>` and `cast send … 0x5069…081b "setAverageTick(uint32,int24)" 3600 <tick>`
   (check `MockCLPool.setAverageTick`'s signature in `contracts/src/test/MockCLPool.sol` before sending).
3. Watch the keeper: within a minute `/v1/protect` shows `IN_BAND`, `maxSeizedAssets: 0`,
   `fullCloseAllowed: true`, decision `close`; the job signs `protect(preLiq, borrower, fullCloseSeizedAssets,
   borrowShares, maxCollateralSold, deadline)` and submits it as a validity transaction with the held
   predicate (`storage(feed, slot 5) = held updatedAt`). The log line (`wrangler tail --format json` from
   `apps/keeper`) carries the hash; the sequencer includes it in the next block or two.
4. Verify: `cast rpc eth_getTransactionReceipt <hash>`; the `Protected` event with the decision hash;
   Morpho position `borrowShares = 0`; `/v1/protect` → `NO_POSITION`. Read the SessionGate: still
   `MARKET_CLOSED(WEEKEND)`, so a raw `Morpho.liquidate` call on the same market would revert
   (`cast call --from <anyone> Morpho "liquidate(...)"` → `MarketClosed`) — record that call too.
5. Put the pool price back (`setPrice36`, `setAverageTick` to the live TWAP) so the shadow price is honest
   again for the Observatory's weekend panel.
6. Write `docs/evidence/saturday-rescue-2026-10-10.md/.json` (timeline, hashes, sizing before/after, the
   validity predicate, the refused raw liquidation) and add the proof to `deployments/base-sepolia.json`.

## Monday 12 Oct 05:30 IST (Sun 20:00 ET reopen)

`GET /v1/captures` → the run for `1791849600`; the first-print hashes and the gap per feed go into the
submission text. If the keeper has a `!=`-predicate transaction armed for the first block (the
"first block after the feed prints" case, `apps/keeper/scripts/validity-tx.ts --loop`), run it from the
Worker, not a laptop (6 Oct lesson: the laptop loop missed the flip during a network outage).

## Failure modes seen so far

- `replacement transaction underpriced`: the protection signer shares a nonce with another pending
  transaction → each signing job has its own key now; never sign with `0x4066…0373` by hand.
- `already known`: the same validity bytes re-submitted while the bound lives; the job re-arms once after 35 s.
- A `fullCloseAllowed: false` with `IN_BAND`: the pool cannot pay (`fullCloseSeizedAssets > collateral` or
  USDC short) → top up the pool (step 2 of Friday).
- `ABOVE_LLTV`: the price was moved too far; move it back up a little, the keeper re-evaluates every minute.
