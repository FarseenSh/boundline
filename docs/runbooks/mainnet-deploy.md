# Runbook: Boundline on Base mainnet

Written Thu 8 Oct 2026. Rehearsed end to end the same day on base-anvil forks of Base mainnet (blocks 52,327,262
and 52,327,370): every phase deployed, 33 of 33 post-deploy checks passed, a re-run deployed nothing. Nothing has
been sent to mainnet: there is no mainnet key yet. Never point a test-only key (`~/.boundline/base-sepolia.env`) at
chain 8453.

## What a funded key buys

One run of `contracts/script/DeployMainnet.s.sol` (driven by `contracts/script/deploy-mainnet.sh`) puts the whole
footprint on mainnet, in dependency order:

| Phase | Contracts and calls |
| --- | --- |
| 1 Oracles | `MarketCalendar` with 2026 loaded; `SessionGate` on the Coinbase OracleRegistry `0x3f3E…5CaD` with all ten Coinbase feeds; `SessionGuard` and `ShadowGuard` (1 h Aerodrome TWAP, 200 bps haircut while held) for AAPLc and NVDAc, the two stocks with a 24/7 Aerodrome pool |
| 2 Market | the session-safe AAPLc/USDC Morpho market (SessionGuard oracle, AdaptiveCurveIrm, LLTV 62.5%); USDC supply only with `SEED_USDC` |
| 3 Desk | `CreditDesk` + `CreditDeskLib` with B20 enforcement on the PolicyRegistry precompile; the market registered; partner `boundline-app`; AAPLc ticker policy (LTV 50%, draws 1 to 100 USDC, cap 500) |
| 4 Protection | `Protector` (routes to the Aerodrome AAPLc and NVDAc pools); three pre-liquidation contracts on Morpho's official factory `0x8cd1…2aef`: Steakhouse AAPLc `0xae1a…3c28`, Steakhouse NVDAc `0xb4b4…3d13`, the session-safe market; band 58% to 62.5%, close factor 100%, incentive 1% to 2%, priced by the stock's ShadowGuard |
| 5 Aave V4 | `AaveDesk` + `AaveDeskLib` and `ProtectionVault` on the MAG7 spoke `0x1790…7B8D` (AAPLc reserve 0 as collateral, USDC reserve 7), partner and reserve policy |
| 6 Capital | `BoundlineReserve` (ERC-4626, cooldown 1 h, utilisation cap 80%) funding both protection vaults; `DeskProtectionVault` registered on the desk; deposits only with `RESERVE_DEPOSIT` / `RESERVE_ALLOCATE` |
| 7 Payout | `LocalPayoutRouter` on the gate (the EURC leg uses Aerodrome's EURC/USDC pool per call) |
| 8 Harvest | `DividendHarvester` (the self-repaying leg) with the same two routes |
| 9 Handover | with `FINAL_OWNER`: ownership offered on the eleven owned contracts (a Safe is the right owner) |

METAc and GOOGLc get feeds on the gate but no ShadowGuard and no pre-liquidation: our book has no 24/7 pool for
them. A pool (or another live price) comes first.

## Cost, measured

| Run | Transactions | Gas used | Fees used | Total |
| --- | --- | --- | --- | --- |
| Rehearsal 1, fork block 52,327,262 | 50 | 50,982,984 | base 0.005 gwei, priority 0.001 gwei | 0.00030824 ETH ($0.79 at ETH $2,571.12) |
| Rehearsal 2 through `deploy-mainnet.sh rehearse`, block 52,327,370 | 50 | 50,982,984 | base 0.005009 gwei (max of 20 blocks), priority 0.001046 gwei (median) | 0.00031116 ETH ($0.80) |

The L1 data fee is included as `GasPriceOracle.getL1FeeUpperBound` per transaction: 0.00000249 ETH for 214,400 bytes
of calldata. forge's own pre-flight estimate is 67,492,795 gas (it pads by 30%). **Fund the deployer with 0.005 ETH**
(about 16 times the measured cost, room for a fee spike); the script refuses to broadcast below `MIN_ETH` (default
0.002 ETH). **Fund the keeper with 0.002 ETH**: one protection on Sepolia used 486,363 gas, about 0.000003 ETH at these
fees. USDC is optional: `SEED_USDC` seeds the session-safe market, `RESERVE_DEPOSIT` the Reserve (the plan's "about
$300" covers both).

## Keys

- `MAINNET_DEPLOYER_KEY`: a fresh key used only for this; it owns everything unless `FINAL_OWNER` is set. Never
  printed by the script; pass it through the environment.
- `KEEPER`: the keeper Worker's mainnet signer, another fresh key, stored only as a Cloudflare secret (as `PROTECT_KEY`
  is on Sepolia). The script makes it the keeper of the Protector, both desks, both vaults and the harvester. The
  6 Oct rule still applies (a waiting validity transaction holds a nonce): when the Worker runs several signing jobs,
  give each its own key with `setKeeper` on the contract that job drives.

## Commands

```sh
cd contracts
export BASE_RPC_URL=<keyed Base mainnet RPC>        # Alchemy works; mainnet.base.org rate-limits
export KEEPER=0x…                                    # the keeper Worker's mainnet address
script/deploy-mainnet.sh plan                         # simulate against mainnet: addresses, gas, the 33 checks; sends nothing
script/deploy-mainnet.sh rehearse                     # deploy on a local base-anvil fork, then price it at today's fees
MAINNET_DEPLOYER_KEY=… ETHERSCAN_API_KEY=… \
  script/deploy-mainnet.sh broadcast                  # the real run; writes deployments/base-mainnet.json
script/deploy-mainnet.sh check                        # the 33 post-deploy checks against the state file, any time
script/deploy-mainnet.sh broadcast --resume           # only if forge stopped mid-broadcast
```

The driver runs `base-forge` with `FOUNDRY_BASE=true`: the checks read the OracleRegistry and the B20 precompiles,
which stock forge cannot execute (the gate would fail closed as `FEED_PAUSED`). A re-run exports every address in the
state file, so nothing already deployed is deployed again (rehearsed: `No transactions to broadcast`, deployer nonce
unchanged, the same 33 checks). Pre-liquidation addresses cannot be predicted from our vendored build (the official
factory's creation code differs), which is why re-runs take them from the state file rather than computing them.
A rehearsal never writes `contracts/broadcast/` (the committed record of real deploys): the driver points
`FOUNDRY_BROADCAST` at a temporary directory.

## Verify

- `check` prints PASS or FAIL per item: gate on the calendar and the registry, ten feeds bound, 2026 loaded, both
  guards and shadow guards, the AAPLc SessionGuard and ShadowGuard pricing the fresh feed (in session; printed as INFO
  when closed), the market on Morpho, the desk (gate, B20 enforcement, market, partner, policy, keeper, protection
  vault, owner), the Protector (keeper, routes), each pre-liquidation (on the factory, market id, Morpho, ShadowGuard
  oracle, preLltv), the Aave desk (reserve, partner, policy), the Reserve and both vaults (sinks, funders, keepers),
  the payout router and the harvester (wiring, routes).
- Basescan: `ETHERSCAN_API_KEY=$BOUNDLINE_ETHERSCAN_API_KEY` verifies through Etherscan v2 (checked 8 Oct: the contract
  module answers for chain 8453 with this key; the logs module does not, the free tier blocks Base mainnet logs).
  Fallback: `forge verify-contract --verifier sourcify` (Sourcify serves chain 8453; Morpho is verified there).
- Record the state file in `docs/CONTEXT.md` §6.2 and the addresses in the apps' config (keeper targets, SDK
  `mainnet` desk, API `MARKETS`).
- With `FINAL_OWNER`: call `acceptOwnership()` from it on the calendar, gate, both ShadowGuards, both desks, the
  Protector, both vaults, the Reserve and the harvester.

## After the deploy: what the script does not do

- Keeper Worker: mainnet protection targets (the three pre-liquidations and every borrower who opted in) and the
  mainnet sequencer for validity transactions, `base_sendRawTransactionValidity` on `https://mainnet-sequencer.base.org`
  (Sepolia used `sepolia-sequencer.base.org`, block bound at most 32 blocks ahead). Send one harmless validity
  transaction first.
- Lock the gate's feeds (`lockFeed`, irreversible) once the configuration is final.
- The first real lines: the team's AAPLc positions open through the app on the session-safe market.

## Opt-in for existing borrowers, one signature each

| Venue | The signature | What it allows |
| --- | --- | --- |
| Morpho, Steakhouse AAPLc or NVDAc | `Morpho.setAuthorization(<PRELIQ_STEAKHOUSE_*>, true)` (gasless: `setAuthorizationWithSig`) | Morpho's audited pre-liquidation contract, never a Boundline one, may pre-liquidate inside the 58% to 62.5% band at the ShadowGuard price; on these markets (the oracle serves the held price) partials run at any hour. Revoke with `false`. |
| Aave V4 MAG7 | the enrolment batch of `AaveEnrolment`: `setUserPositionManager(Taker)`, `setUserPositionManager(Giver)`, `Taker.approveBorrow(spoke, 7, aaveDesk, cap)`, or the `WithSig` variants through the SignatureGateway `0x5d48…05A7` | lines through the AaveDesk; for protection alone, enabling the Giver lets the ProtectionVault repay at any hour |
| Dividends (any Morpho B20 position or desk line) | `Morpho.setAuthorization(<HARVESTER>, true)` + `harvester.enroll(marketId, lineId, 1)` in one `wallet_sendCalls` batch | in an open session, each cash dividend's equivalent collateral is sold and repays the loan; the share count is kept |

## Dividends: what the multiplier does (the harvester's design, verified 8 Oct 2026)

Chainlink's Coinbase feeds report the token's total return value, the share price times the OracleRegistry
multiplier; one token is redeemable for `multiplier` shares and raw balances never change. On mainnet the registry
multiplier equals the token's own `multiplier()` (AAPLc 1.0, GOOGLc 1.000377118676784179, METAc 1.000313792289598084,
NVDAc 1.000537939576369481), each moved once by an issuer `announce`; NVDAc's is Coinbase corporate action
`0d25ab63-6a9b-4f46-93fd-9d7f6fae92da` ("Cash Dividend", tx `0x7aef5d1292d0f78b1cdc05518301553fc7220e5a0022d98b822dc09ac925ddcd`,
block 52,041,960, 1 Oct 2026 16:47:47 UTC), GOOGLc's tx `0xcd45e69e5b84d3f1808fe832d73c1ff7f332c7447bdf9c87925f196240ffeb00`
(block 51,310,619), METAc's tx `0x1219ccb952aab976f83a67ec998b34c951a867e2ea8409484b8cd657f1dc6a5a` (block 51,910,997).
So `raw × feed` already counts every dividend (multiplying again is the v1 double count); what is harvestable is the
collateral equal in value to the dividend, `raw × (m1 − m0) / m1`, which leaves the borrower exactly the shares they
held at `m0`. Steps above 5%, falls, and anything while the registry is paused are re-based, never sold (splits).
Fork proof on the real dividend (`test/harvest/HarvestFork.t.sol`, base-forge): borrower `0xcBFB…f2E6` on the
Steakhouse NVDAc market, 4.88797212 NVDAc against 425.113070 USDC; 262,801 raw NVDAc of dividend collateral
($0.605099 at the feed's $230.25), 259,715 raw sold on the Aerodrome pool, 0.599048 USDC repaid, 3,086 raw back on the
position.
