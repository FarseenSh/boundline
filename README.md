# Boundline

**Borrow against your stocks on Base. Paid in your currency. Never liquidated while Wall Street is closed.**

Coinbase's tokenized stocks (B20 assets) trade on Base every hour of every day. Their Chainlink feeds publish from
Sunday 20:00 ET to Friday 20:00 ET and hold Friday's close in between: over each of the last two weekends (2 to 4 and
9 to 11 October 2026) all ten feeds printed zero rounds through the whole 48-hour closed window while the stocks kept
trading on Aerodrome. The two live credit venues for
these stocks on Base, Aave V4's Equities Hub and Morpho's B20 markets, read that held price with no staleness, pause or
market-hours check and liquidate at any hour, so the weekend's move lands in one block at the Sunday reopen. Base's
docs say "never settle or liquidate against a frozen feed". Boundline is the credit layer that enforces it:

- an onchain NYSE calendar and a verdict engine that decide, per stock, whether a price is safe to use;
- Morpho oracles that refuse to price a held feed (borrow, withdraw and liquidate stop; repay and add-collateral never do);
- protection that runs while the feed is frozen (a weekend, a holiday, a stale feed) at the 24/7 DEX price: Morpho's
  audited pre-liquidation with a live-price oracle, and protective repays down a funding ladder that ends at an ERC-4626
  Reserve, submitted as Cobalt validity transactions that Base includes only while the feed is still frozen;
- partner-scoped, self-custody credit lines on Morpho and Aave V4 with a partner API, SDK, console, app, local-money
  payout and an MCP agent surface;
- a public Observatory over Base mainnet and a replay harness that takes real positions through weekend gaps.

Boundline never holds a stock or a loan: users keep their own venue position and authorise contracts with one
signature.

## What runs where

| Network | What |
| --- | --- |
| **Base Sepolia** | Everything that writes: three real B20 test stocks issued through the B20 factory precompile with Cobalt composite policies, their feeds mirrored from mainnet every minute, session-safe Morpho markets, the CreditDesk with live lines, protected mode (pre-liquidation + Protector), the Reserve and the desk-side protection vault, the payout router. Every contract is verified on sepolia.basescan.org. |
| **Base mainnet** | Read live every minute by the Observatory (ten Coinbase stock feeds, the OracleRegistry, every Morpho B20 market, the Aave V4 MAG7 spoke, Aerodrome pools; on 12 Oct the stock spoke carried 1,729,470 USDC of debt against $5.14M of tokenized-stock collateral and the 14 Morpho B20 markets 16,315.76 USDC); every mechanism proven against the live contracts on mainnet forks; the replay harness. Nothing is deployed on mainnet yet: the whole footprint is one rehearsed command (`contracts/script/deploy-mainnet.sh`, 50 transactions). |

## Live

| Service | URL |
| --- | --- |
| Site | https://boundline-site.papermind-ai.workers.dev |
| App (partner #1, Base Sepolia) | https://boundline-app.papermind-ai.workers.dev |
| Observatory (Base mainnet) | https://boundline-observatory.papermind-ai.workers.dev |
| Partner console | https://boundline-console.papermind-ai.workers.dev |
| Partner API | https://boundline-api.papermind-ai.workers.dev/health |
| Agent surface (MCP + REST) | https://boundline-agent.papermind-ai.workers.dev/v1/tools |
| Keeper (live protection sizing) | https://boundline-keeper.papermind-ai.workers.dev/v1/protect |
| Indexer | https://boundline-indexer.papermind-ai.workers.dev/v1/sources |

## Verify every claim

Nothing below needs a key. `cast` is Foundry's CLI.

**1. A session-safe Morpho market refuses a frozen price.** Ask the AAPLt `SessionGuard` for a price at a block from
Saturday 3 October 2026:

```sh
cast call --rpc-url https://sepolia.base.org --block 47634983 \
  0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854 "price()(uint256)"
# execution reverted, data: 0x3e363de9…0005  →  MarketClosed(5), 5 = WEEKEND
```

On a weekday it prices (`cast call … "price()(uint256)"` without `--block` → `3.356e36` = $335.683 on Thu 8 Oct). In the
same Saturday block the borrower added collateral, which never reads the oracle:
[`0x01191a77…760b`](https://sepolia.basescan.org/tx/0x01191a773774584bdbf4a72aff4397c870bf455c3277d7d0adf8396a42cb760b).

**2. The calendar and the verdict.**

```sh
cast call --rpc-url https://sepolia.base.org 0x70575eb938645A9D3E18Dda035f5A6a7713696B8 \
  "sessionAt(uint256)(uint8)" 1791633600          # Sat 10 Oct 12:00 UTC → 5 (WEEKEND)
cast call --rpc-url https://sepolia.base.org 0x70575eb938645A9D3E18Dda035f5A6a7713696B8 \
  "nextTransition(uint256,uint256)(uint8,uint256)" 1791633600 7   # → 4 (OVERNIGHT) at 1791763200 = Sun 11 Oct 20:00 ET
cast call --rpc-url https://sepolia.base.org 0x92f59437d4ef5CDcEAe2CcDE89B03A7B4B1Ae427 \
  "check(address)((uint8,uint8,int256,uint256,uint256,bool,bool))" 0xB2000000000000000000000E063E65377cA34141
# (state, session, answer, updatedAt, multiplier, registryPaused, transferPaused); state 0 = OPEN, 1 = MARKET_CLOSED
```

**3. The transactions.** All on Base Sepolia; open them on Basescan.

| What | Transaction |
| --- | --- |
| A 5 USDC draw on a partner line in the PRE session at $332.67 (6 Oct) | [`0x661ebb1a…8bac`](https://sepolia.basescan.org/tx/0x661ebb1abc30e1fffe987b4598b006004ed746943afcc1e67ea82595854b8bac) |
| A partial repay on the same line | [`0xe3bc2f0b…771b`](https://sepolia.basescan.org/tx/0xe3bc2f0b3a58975b5870d624fd4772656deab41ef9fbc3b5c0f727d3f464771b) |
| Validity transaction included only while the feed's `updatedAt` slot held its round | [`0x6b17288f…49dd`](https://sepolia.basescan.org/tx/0x6b17288ff94723934a83a308ad4d350fd4403c639777bb2317646f3834c949dd) |
| Validity transaction held by the sequencer until the feed printed a new round | [`0xbbd84631…b2fb`](https://sepolia.basescan.org/tx/0xbbd8463132d3863f135ce30e5618d92919e4c3832b80b76510e97f18b99cb2fb) |
| The keeper's automatic pre-liquidation of an in-band position at the live price (shadow LTV 60.12% → 58.00%) | [`0x982c7327…b695`](https://sepolia.basescan.org/tx/0x982c7327efa9f0460b92501a4322ec5dc730e5faaca3ce1d87dc80f708dfb695) |
| …and its second one when the price moved the position back into the band | [`0x6d45ddc9…40d9`](https://sepolia.basescan.org/tx/0x6d45ddc95b314de50f3a3375b2d764302e07a920869fd2000fa768fdc84a40d9) |
| Protective repays on a live line through the vault's ladder (a repay never reads the oracle, so the path works at any hour), the second partly funded by a Reserve advance | [`0xa0efe0c4…9f07`](https://sepolia.basescan.org/tx/0xa0efe0c47d788acb8e0f756b62ebf01e155cb33c553d6e4ccdfc2d20065c9f07), [`0x28c1ec44…08a4`](https://sepolia.basescan.org/tx/0x28c1ec4479d58ff7e362499b3e0b3f41517a1ec7ee4cd2fa83523de2ca5c08a4) |
| The advance settled with its 1% fee; the fee harvested into the Reserve's share price | [`0x14c4ffbd…db9a`](https://sepolia.basescan.org/tx/0x14c4ffbdd12e2a52785b28c1837fd9c9cff2400b07bf22e2922faf96152cdb9a), [`0xf2574764…da67`](https://sepolia.basescan.org/tx/0xf257476420589a5455369f2337802911420427909f803684bd15d0173984da67) |
| 0.5 USDC paid out as 0.46 EURCt inside an open session | [`0x9090633c…5bd3`](https://sepolia.basescan.org/tx/0x9090633cf6559f5935a9e5659f4faa7ad6b278e4db93c8141154d2aded5b5bd3) |
| Two x402 settlements for keyless API calls ($0.01 test USDC each) | [`0x8816d08f…c6ff`](https://sepolia.basescan.org/tx/0x8816d08fb7d6fadb8983f116bb4963bb5040e9666db6f15076272eb81cf5c6ff), [`0x055981d8…a8f9`](https://sepolia.basescan.org/tx/0x055981d83ca73612b1677326f1ecb5847c9ccbfcdcad1b8a25f3a2c81eaca8f9) |
| Drills on Base Sepolia: a stale feed, a registry pause, an issuer transfer pause, a keeper hold (the repay still landed) | [`0x84064c22…8429`](https://sepolia.basescan.org/tx/0x84064c22e3ba4b33456c4a04721c66070a88a2c19fd67811072a5ccaecad8429), [`0x7b9fc996…53cb`](https://sepolia.basescan.org/tx/0x7b9fc996d3c579a68d6e7eb0b98a851f8c46f4f93c9172d09cef60a2f75b53cb), [`0x73a518fa…7bc7`](https://sepolia.basescan.org/tx/0x73a518fa185fa8217aefd78f99ab51b677e8ae98c14024fa7f184d33f0c17bc7), [`0x1ad33de3…42f3`](https://sepolia.basescan.org/tx/0x1ad33de32096ff96df24df5184a74d006db9764bedcb2c8d30d81c4f308642f3); every run in [`docs/evidence/drills/`](docs/evidence/drills) |
| Webhooks: a hold and a release on a live line, delivered HMAC-signed 84 s and 170 s later | [`0x5dd9d8df…42b7`](https://sepolia.basescan.org/tx/0x5dd9d8df6cac14096e4b0ae3e6eafe6553a0de8a760b271bf0e3438fe91e42b7), [`0xd1687fdf…2514`](https://sepolia.basescan.org/tx/0xd1687fdf25da3e4aeed84fde4d731431d35ccd4304ac02d9564111eb33202514) |
| The self-repaying leg: a dividend multiplier step harvested into a desk line's loan, then re-based on the step down | [`0xa44b7867…f680`](https://sepolia.basescan.org/tx/0xa44b786744d8246b9352914d843ee96723314d5fd74e2fcaecdafcf85624f680), [`0xaa136601…ae66`](https://sepolia.basescan.org/tx/0xaa136601955d0db9b78243f2e6ee24cc609c0c53ba3bf5013c060466e7efae66) |
| …and by the keeper Worker on its own, three blocks after the step | [`0xb1312b5f…4616`](https://sepolia.basescan.org/tx/0xb1312b5f7844d1ae1cc2c38e001552f611a457bd605ffb634ffe2d24b1124616), [`0x3827eb33…cf2d`](https://sepolia.basescan.org/tx/0x3827eb336f540895113f3f0d2f66dc3e155fdc3309f32c01c386e0025e47cf2d) |
| A feed-outage rescue (12 Oct, REGULAR session, the AAPLt test feed held stale by the operator, which the oracles treat like a weekend): the keeper closed out an in-band position at the TWAP shadow price as a validity transaction on the frozen feed slot, one block after arming; a raw `Morpho.liquidate` on the same market reverted `FeedStale` | [`0x9774913e…0352`](https://sepolia.basescan.org/tx/0x9774913eecd620da53019d701f10c8e90400cb6497030785a2e374360d280352) |
| …and the vault's ladder repaid another line under the same frozen feed (0.40 USDC from the borrower's reserve + 0.14 Reserve advance, 54.00% → 44.90%), settled in session with its fee and harvested (1 share = 1.0017 USDC) | [`0x47ac5279…1d24`](https://sepolia.basescan.org/tx/0x47ac5279c4804e73d05f1e8d813775514e4f8b8b09c6ffc7b014fac1956e1d24), [`0x7b71e812…df9f`](https://sepolia.basescan.org/tx/0x7b71e812afff01285f20eb4af568a334834dda6b463e5242cd8da7fc8636df9f), [`0x5b6874d4…11c3`](https://sepolia.basescan.org/tx/0x5b6874d4c3b9bf415e453c0f1d199a5b406c1b163b5a5e4404815602e8ab11c3) |

Every address and every other hash: [`deployments/base-sepolia.json`](deployments/base-sepolia.json).

**4. The data.**

```sh
curl -s https://boundline-observatory.papermind-ai.workers.dev/v1/sessions          # session, feed liveness, next transition
curl -s https://boundline-observatory.papermind-ai.workers.dev/v1/tokens            # every Coinbase stock feed vs the DEX
curl -s https://boundline-observatory.papermind-ai.workers.dev/v1/venues/aave/positions   # real Aave V4 positions, shadow health
curl -s https://boundline-observatory.papermind-ai.workers.dev/v1/assurance         # the latest replay result and its hash
curl -si https://boundline-api.papermind-ai.workers.dev/v1/positions/0xB789aD318945B37566E2549F65526Cc269a482Fc/shadow | head -1   # HTTP 402: x402-metered without a key
```

**5. The evidence files.**

| File | What it shows |
| --- | --- |
| [`docs/evidence/reopen-2026-10-04.md`](docs/evidence/reopen-2026-10-04.md) | The 2–4 Oct weekend on all ten feeds: zero rounds through the 48 h closed window (no feed had printed for 52 to 58 h by the reopen), first prints 23–53 s after 20:00 ET, gaps −7.5 to +282 bps; rebuild with `BASE_RPC_URL=<archive rpc> python3 scripts/reopen-evidence.py --close 1790985600 --reopen 1791158400 --out <file>` |
| [`docs/evidence/reopen-2026-10-11.md`](docs/evidence/reopen-2026-10-11.md) | The 9–11 Oct weekend, captured live by the Observatory and reconstructed from the chain, agreeing on every field: zero rounds on ten feeds, first prints 21–53 s after 20:00 ET (AAPLc −5.8 bps, MSTRc +201.0 bps), the transaction of every first print |
| [`docs/evidence/feed-outage-rescue-2026-10-12.md`](docs/evidence/feed-outage-rescue-2026-10-12.md) | The keeper's close-out and ladder repay under a staged frozen feed on Base Sepolia, block by block, with the refused raw liquidation and the settlement |
| [`docs/evidence/validity-transactions-sepolia.md`](docs/evidence/validity-transactions-sepolia.md) | How the sequencer treats validity transactions (the 32-block bound, re-arming, "not before" vs "as soon as") |
| [`docs/evidence/assurance/2026-10-07.md`](docs/evidence/assurance/2026-10-07.md) | The replay: 5 positions (3 as they stood, 2 real positions staged near their limit) × gaps of −3/−8/−15% at fork block 52,295,895; the raw venues liquidated the staged positions 3 times at the reopen, Boundline's path 0; the three as they stood stayed healthy even at −15%; hash `0xa626f0997c74896d125080de615e1407fdc4abb6d8f8296ce62caabbc8793c45` |
| [`docs/evidence/drills/`](docs/evidence/drills) | Drill runs with every transaction (also served by the API at `/v1/drills` and shown in the console) |

**6. The tests.**

```sh
pnpm install
forge test --root contracts            # 264 passed; 8 mainnet-fork tests skip without BASE_RPC_URL
pnpm test                              # 897 tests across the packages and apps
pnpm typecheck
# mainnet-fork suites (live Morpho, Aave V4 spoke, Aerodrome pools), with Base's Foundry for the B20 precompiles:
#   base-foundryup --install v1.1.0
BASE_RPC_URL=<archive rpc> FOUNDRY_BASE=true ~/.foundry/bin/base-forge test --root contracts --match-path 'test/fork/*'
#   then the same with 'test/drills/*' (the Aave hub halt, the bad-debt probe) and 'test/harvest/*' (a real dividend)
pnpm replay                            # the replay harness (scripts/replay/run.ts), writes docs/evidence/assurance/<date>.*
```

## How it is built

| Layer | Component | Decides |
| --- | --- | --- |
| Time | `MarketCalendar`, `@boundline/calendar` | which NYSE session an instant belongs to; three independent implementations agree on 5,643 instants |
| Verdict | `SessionGate` | per stock: `MARKET_CLOSED > FEED_PAUSED > TRANSFER_PAUSED > FEED_INVALID > FEED_STALE > OPEN`; fails closed |
| Venue oracle | `SessionGuard` (Morpho `IOracle`) | reverts unless `OPEN`, so borrow, withdraw and liquidate stop while the feed is held |
| Protection oracle | `ShadowGuard` | the fresh feed in session; the Aerodrome TWAP less a haircut while held, bounded against the held feed |
| Credit | `CreditDesk` (Morpho), `AaveDesk` (Aave V4) | partner-scoped self-custody lines, policy, decision hashes |
| Protection | Morpho pre-liquidation + `Protector`; `ProtectionVault` (Aave), `DeskProtectionVault` (Morpho) | any-hour pre-liquidation in the band; any-hour repay down the ladder; recovery in session only |
| Capital | `BoundlineReserve` (ERC-4626) | capital providers fund bounded advances; utilisation cap, cooldown |
| Payout | `LocalPayoutRouter` | USDC → a local stablecoin at the end of the borrow batch, slippage- and session-checked |
| Keeper, data | `apps/keeper`, `apps/observatory`, `apps/indexer`, `scripts/replay` | mirroring, validity-transaction protection, snapshots, hash-chained roots, the replay |
| Partners | `apps/api`, `packages/sdk`, `packages/router`, `apps/app`, `apps/console`, `apps/agent` | keys, quotes, obligations, x402, batches, the reference app, the console, MCP |

One page each: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## Layout

| Path | What |
|---|---|
| `contracts/` | Foundry. `src/`: `calendar/`, `oracle/` (SessionGate, SessionGuard, ShadowGuard), `desk/` (CreditDesk), `protection/` (Protector, vendored Morpho pre-liquidation), `aave/` (AaveDesk, ProtectionVault), `reserve/` (BoundlineReserve, DeskProtectionVault), `payout/`, `harvest/` (DividendHarvester), `test/` (Sepolia simulators). `test/`: unit, fuzz and invariant suites, plus `fork/`, `drills/` and `harvest/` against a mainnet archive RPC. `script/` (deploys; `script/README.md` has the recipes) |
| `packages/calendar` | The calendar in TypeScript, checked against the Solidity one |
| `packages/chain` | Base mainnet and Sepolia addresses, ABIs, viem clients, price math |
| `packages/sdk` | `@boundline/sdk`: reads, quotes, prepared calls, `wallet_sendCalls` batches, the payout leg |
| `packages/router` | The credit router: venue and market by session, LTV, liquidity, protection and rate |
| `packages/ledger` | The five-way conservation ledger for protection and liquidation events |
| `apps/observatory` | The B20 credit Observatory (Cloudflare Worker): snapshots, reopen captures, positions, gaps, assurance |
| `apps/keeper` | Mirrors mainnet feeds onto Sepolia; arms protection as validity transactions |
| `apps/indexer` | Events into D1 with hash-chained daily roots and reconciliation |
| `apps/api` | The partner API; x402-metered public routes |
| `apps/app`, `apps/console`, `apps/site`, `apps/agent` | The reference app, the partner console, the landing page, the MCP agent surface |
| `scripts/` | `replay/` (the replay harness), `drills/` (the fork drills), `sepolia/` (the Sepolia operator's tools: drills, the TWAP mirror, the feed-outage rescue), `reopen-evidence.py` (weekend reconstruction), `gen-calendar-tests.py` |
| `deployments/` | Addresses, transactions and live proofs per network |
| `docs/` | `ARCHITECTURE.md`, `THREAT-MODEL.md`, `evidence/`, `runbooks/`, `submission/`, and `CONTEXT.md` + `BUILD.md` (the build log) |

## Licence

MIT (see `LICENSE`). Two exceptions keep their own headers: `contracts/src/libraries/TickMath.sol` (Uniswap,
GPL-2.0-or-later) and the vendored Morpho pre-liquidation contracts in `contracts/src/protection/vendor/`
(GPL-2.0-or-later).
