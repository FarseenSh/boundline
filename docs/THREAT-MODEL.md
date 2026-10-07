# Threat model

What can go wrong, who can cause it, what the code does about it, and what is still open. Status
as of Wed 7 Oct 2026. Amounts on the live venues are tens to hundreds of dollars by design until an
audit.

## Assets at risk

- The user's collateral (B20 shares in their own Morpho or Aave position) and their drawn USDC.
- Reserve capital (user and partner reserves in the vaults, capital providers' deposits in the Reserve).
- The integrity of the record (decision hashes, daily roots, evidence).
- Keeper and signer keys; partner API keys.

## Actors

| Actor | Can | Cannot |
| --- | --- | --- |
| User (line owner) | open, draw, repay, add or withdraw collateral, close, opt in or out of protection, revoke any authorisation in one call | act on another user's line |
| Partner admin | set its own policy (tickers, LTV below LLTV, draw bounds, caps, eligibility hook, signer), fund the partner reserve, withdraw it | custody, move a user's collateral, raise LTV above the venue's LLTV (clamped at quote time) |
| Keeper | `hold`/`release` lines, run protection (repay, pre-liquidate inside the band, recover in session), mirror simulators on Sepolia | draw, withdraw to itself, sell at a held price, exceed the on-chain `sizing` cap or the advance cap |
| Owner (Boundline) | register markets, create partners, set the keeper, pause advances and recoveries, set advance terms | touch user funds; pausing stops advances, not repayments or withdrawals |
| Anyone | repay or add collateral to any line (can only help), read everything, pay per call through x402 | anything else |

## Threats and mitigations

| # | Threat | Mitigation | Status |
| --- | --- | --- | --- |
| T1 | **Liquidation at a held price** (weekend, holiday, stale feed): the venue reads Friday's close while the market has moved | `SessionGuard` reverts `price()` unless the gate is `OPEN`, so `liquidate` cannot execute on Boundline's markets while the feed is held; on third-party markets (Aave, Steakhouse) protection runs at the live DEX price instead | proven (fork + Sepolia live) |
| T2 | **Gap at the reopen** takes the position in the first block | protection while held: shadow pre-liquidation in the band, protective repay down the ladder; nightly replay measures the raw-vs-Boundline outcome at −3/−8/−15% | Sepolia automated drill done; mainnet positions replayed on a fork (7 Oct) |
| T3 | **Manipulated DEX price** moves the shadow oracle | time-weighted price (TWAP window 5 min to 1 day), haircut, `maxDeviationBps` against the held feed (reverts `ShadowDeviation` beyond it), actions sized by the on-chain `sizing` and bounded by Morpho's own pre-liquidation maths (`preLCF`, `preLIF`) | implemented; window and bounds are owner-set per guard |
| T4 | **Stale or invalid feed** (no round within the heartbeat, negative answer, zero round) | `FEED_STALE` / `FEED_INVALID` precedence in the gate; the keeper mirrors mainnet's real staleness onto Sepolia, so the sandbox fails the same way | implemented, drilled by hand (Thursday's drill set renders it) |
| T5 | **Issuer actions**: registry pause, transfer pause, corporate-action multiplier, seize | gate precedence (`FEED_PAUSED`, `TRANSFER_PAUSED`), corporate-action haircut when a lower multiplier is scheduled within 7 days, B20 `isAuthorized` preflight on both legs, seize-exempt lists on the venues, seize watch planned on `RoleGranted(SEIZE_ROLE)` | gate and haircut implemented; seize watch open |
| T6 | **Keeper key compromise** | the keeper can only repay, pre-liquidate inside the band, recover in session to the vault, and mirror a testnet; every amount is capped on chain (`sizing`, advance cap per user/line, utilisation cap); separate keys per job (mirror, protection, validity demo) so one compromise or one stuck nonce does not block the others; keys are Cloudflare secrets, never in the repo | implemented |
| T7 | **Partner key leak** | hashed in D1, bearer only, the app Worker holds it as a secret so it never reaches a browser; idempotency keys scope replays per partner | implemented; rotation endpoint open |
| T8 | **Reserve capital loss** from a Monday gap beyond the advance buffer | advances bounded by the distance from the grace line to LLTV, settled in the next open session at a fresh price, utilisation cap and cooldown on the Reserve, `writeDown` records a realised loss honestly; the nightly replay measures the buffer against the real gap history | contracts 7 Oct; mainnet exposure zero until keys and audit |
| T9 | **Validity transaction misuse**: a pre-signed action lands in a state the decision did not assume | the predicate pins the feed's `updatedAt` slot to the round the decision was made on, with a 30-block bound; predicates do not simulate, so every check also lives in the contract (`sizing`, `deadline`, `maxCollateralSold`) | implemented; measured semantics "not before", not "as soon as" |
| T10 | **Reentrancy / callback abuse** in the Protector's sale and the vaults | `ReentrancyGuard` on every state-changing entry; the swap callback checks `msg.sender == pool` and pays exactly the owed amount; the Protector approves the pre-liquidation contract only for `repaidAssets` | implemented, tested |
| T11 | **Oracle or registry call failure** (reverting token, bad feed) | the gate uses low-level staticcalls and fails closed (`paused` / `invalid`) rather than reverting the caller | implemented, tested |
| T12 | **Evidence tampering** | decision hashes are chain-, contract- and nonce-bound and emitted on chain; the indexer's daily root is a hash chain over canonical event hashes; evidence files carry their own keccak; replay evidence names the fork block | implemented; public reproduction requires the public repo (before submission) |
| T13 | **Front-running a protection action** | a pre-liquidation benefits the position (incentive near 1.0, proceeds repay the debt); the seized collateral is sold on the collateral's own pool inside the callback, so there is no open leg to sandwich beyond the swap's own bound (`maxCollateralSold`) | implemented |
| T14 | **Cloud platform limits** (CPU cap, cron not firing) | every Worker hand-rolls its hot path, module-scope warm-ups, one transaction per tick, no receipt waits; service-binding fallbacks for crons; the plan upgrade is a human item | mitigated on 6 Oct; plan confirmation open |
| T15 | **Wrong calendar** (DST, early close, holiday) | three independent implementations agree; the calendar is append-only and `UNKNOWN` (fail closed) for a year without data | implemented |

## Out of scope for the hackathon build

Audit (CertiK side track applied for), mainnet capital beyond test amounts, governance of the
owner key (multisig later), legal structure of the Reserve, KYC beyond the eligibility hook (Base
Verify on Sepolia, EIP-712 partner attestation fallback).

## Open items that matter for safety

- Seize watch on `RoleGranted(SEIZE_ROLE)` and `PolicyUpdated(SEIZE_EXEMPT_POLICY)`.
- Partner key rotation.
- The desk's `recoverCollateral` lands with the freeze redeploy (10 Oct); until then the Sepolia
  Morpho-side vault's recovery path is unit- and fork-proven only.
- A validity transaction's re-arm should carry a new hash (same nonce, higher tip); measured on 6 Oct.
