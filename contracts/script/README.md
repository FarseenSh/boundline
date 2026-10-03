# Deploy scripts

Every script dry-runs locally with no RPC and no key:

```bash
cd contracts
forge script script/DeployCalendar.s.sol
forge script script/DeploySepoliaSimulators.s.sol
```

Against a network, add `--rpc-url base_sepolia` (or `base`), `--broadcast` and a signer
(`--account <keystore>` or `--private-key`). The RPC aliases in `foundry.toml` read
`BASE_SEPOLIA_RPC_URL` / `BASE_RPC_URL`; `--verify` reads `BASESCAN_API_KEY`.

| Script | Env | Default |
| --- | --- | --- |
| `DeployCalendar.s.sol` | `CALENDAR_OWNER` | the broadcaster |
| `DeploySepoliaSimulators.s.sol` | `TEST_STOCK_SYMBOLS` (comma-separated) | `AAPLt,NVDAt,TSLAt` |
| | `TEST_STOCK_ANSWERS` (comma-separated, 8 decimals) | `100e8` each |
| | `SIMULATOR_OWNER` | the broadcaster |

`DeployCalendar` deploys with the broadcaster as owner so it can load 2026 in the same run,
then calls `transferOwnership(CALENDAR_OWNER)`; `MarketCalendar` is `Ownable2Step`, so the
new owner must call `acceptOwnership()` afterwards. The simulators use single-step `Ownable`
and change hands immediately.

## Oracle stack, market and test stocks

Three more scripts, all dry-runnable locally with no RPC and no key. Each file holds helper
contracts next to the script, so pass `--tc <ScriptName>`.

```bash
cd contracts
# Sepolia oracle stack on simulators (calendar, mirror registry, test feeds, gate, guards)
forge script script/DeployOracles.s.sol --tc DeployOracles --sig "runSepolia()"
# Mainnet oracle stack on the real feeds and registry; keyless local run needs the stubs
DRY_RUN_ETCH=true forge script script/DeployOracles.s.sol --tc DeployOracles --sig "runMainnet()"
# Test stocks through the B20 factory precompile, local simulation on base-std's mocks
ETCH_MOCKS=true forge script script/IssueTestStocks.s.sol --tc IssueTestStocks
# The session-safe Morpho market needs a chain: without an RPC it stops with NoRpc
COLLATERAL=<stock> ORACLE=<SessionGuard> forge script script/CreateSessionSafeMarket.s.sol --rpc-url base
```

| Script | Env | Default |
| --- | --- | --- |
| `DeployOracles.s.sol` `runSepolia()` | `TEST_STOCK_SYMBOLS` | `AAPLt,NVDAt,TSLAt` |
| | `<SYMBOL>_TOKEN`, `<SYMBOL>_FEED`, `<SYMBOL>_POOL` | deploy a `MockB20` and a `TestPriceFeed`; no ShadowGuard without a pool |
| | `<SYMBOL>_PRICE_E8` | `100e8` |
| | `TEST_STOCK_MINT` (minted to the broadcaster on a fresh `MockB20`) | `1_000e8` |
| | `CALENDAR`, `REGISTRY` | deploy a `MarketCalendar` (2026 loaded) and a `MirrorOracleRegistry` |
| | `LOCK_FEEDS`, `ORACLE_OWNER` | no lock, broadcaster keeps ownership |
| `DeployOracles.s.sol` `runMainnet()` | `GUARD_SYMBOLS` (SessionGuards; AAPLc and NVDAc always get one with a ShadowGuard) | `AAPLc,NVDAc` |
| | `CALENDAR`, `LOCK_FEEDS`, `ORACLE_OWNER` | as above |
| | `DRY_RUN_ETCH` | `false` |
| `CreateSessionSafeMarket.s.sol` `run()` | `COLLATERAL` (required), `ORACLE` or `DEPLOY_ORACLE=true` + `FEED` (+ `REGISTRY` off mainnet) | |
| | `LLTV` | `0.625e18` |
| `CreateSessionSafeMarket.s.sol` `seed()` | `SEED_USDC` (base units), same `COLLATERAL`/`ORACLE`/`LLTV` | |
| `IssueTestStocks.s.sol` `run()` / `issue(string)` | `TEST_STOCK_SYMBOLS`, `MINT_TO` (comma-separated extra holders) | `AAPLt,NVDAt,TSLAt`, none |
| | `TEST_STOCK_MINT` per holder, `TEST_STOCK_SUPPLY_CAP` | `1_000e8`, `1_000_000e8` |
| | `ETCH_MOCKS` | `false` |
| `IssueTestStocks.s.sol` `wire(address,address[])` | the token and the venues (Morpho, the desk, the keeper) | |

`DRY_RUN_ETCH=true` etches a feed stub at each Chainlink proxy address and a pool stub at the
two Aerodrome pools, because the real contracts have no code off-chain and `setFeed` reads
`decimals()`. It is refused inside a broadcast, so a stub can never stand in for a real feed.
Without it a keyless local `runMainnet()` stops with `FeedHasNoCode`.

`IssueTestStocks` talks to Base's precompiles (B20 factory, policy registry). Stock forge
cannot execute them, not even against an RPC, because they have no bytecode; a real run
needs Base's Foundry build: `base-forge script ... --rpc-url base_sepolia --broadcast`.
`ETCH_MOCKS=true` etches base-std's reference mocks for a keyless local simulation and is
refused in a broadcast (policy ids from the mocks would not match the chain). Under Base's
Foundry build (`~/.foundry/bin/base-forge`) the precompiles are live and cannot be etched, so
the scripts and `test/script/IssueTestStocks.t.sol` detect them and use them directly. Note
that base-forge v1.1.0 ships **Beryl** precompiles: `createCompositePolicy` (Cobalt) reverts
there, so `wire` stops with `CompositePoliciesUnavailable` and the three composite tests are
skipped; a `base-foundryup --install nightly` build or Base Sepolia itself runs them. Per symbol it
creates an allowlist of holders (broadcaster plus `MINT_TO`) bound to `MINT_RECEIVER_POLICY`,
an empty blocklist bound to both transfer scopes, then the asset with roles, supply cap and
`batchMint` in the factory initCalls, and prints the predicted and actual token address.
`wire` adds the venues to that allowlist, binds `INTERSECT(blocklist, allowlist)` to
`TRANSFER_RECEIVER_POLICY` and lists the venues on `SEIZE_EXEMPT_POLICY`, so Morpho's
balances are never seizable and withdrawals can still reach the holders.

`CreateSessionSafeMarket` is permissionless `Morpho.createMarket` with the AdaptiveCurveIrm;
it checks the IRM and LLTV are enabled and that the market does not exist, and prints the id.
With `DEPLOY_ORACLE=true FEED=<proxy>` it deploys a calendar, gate and SessionGuard for the
collateral in the same run, which is how the whole proof can be simulated against mainnet:

```bash
COLLATERAL=0xb200000000000000000000C2e324d24d7eEcd1fb FEED=0x787f13dEa48Db0897CbCDD985de77809D837F988 \
DEPLOY_ORACLE=true forge script script/CreateSessionSafeMarket.s.sol --rpc-url base \
  --sender 0x0000000000000000000000000000000000000001
```

### Deployed on Base Sepolia (3 Oct 2026)

Run from the test-only deployer `0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E` with `base-forge`; the test stocks are
real B20 assets (one byte of code, executed by the node), so every script that touches them runs under Base's build.
Full record with transaction hashes and proofs: `deployments/base-sepolia.json`. All nine Solidity contracts are
verified on sepolia.basescan.org.

| Contract | Address |
| --- | --- |
| MarketCalendar (2026 loaded) | `0x70575eb938645A9D3E18Dda035f5A6a7713696B8` |
| MirrorOracleRegistry | `0xc78A796710be93774310ff8Cf467EaABCeAb4655` |
| SessionGate | `0x92f59437d4ef5CDcEAe2CcDE89B03A7B4B1Ae427` |
| AAPLt (B20) / TestPriceFeed / SessionGuard | `0xB2000000000000000000000E063E65377cA34141` / `0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a` / `0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854` |
| NVDAt (B20) / TestPriceFeed / SessionGuard | `0xB200000000000000000000AEd76Eae58870E2ae6` / `0x097dCec820dCF11b5e8d0fA698b86714f96dB0e2` / `0xcEDcD908aB8B12766147459fb34F8C6Da4aA7518` |
| TSLAt (B20) / TestPriceFeed / SessionGuard | `0xb200000000000000000000Af3FB2181a8772F804` / `0x5CB94874E3a54F36Bc8DD9c85405ea300e5b43a1` / `0xcADf92BBDC997fDb5920FF0Ba95B4d2d2b8389B3` |
| Morpho market AAPLt/USDC, AdaptiveCurveIrm, LLTV 62.5% | id `0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047` |

The order that worked, one deploy instead of two:

```bash
cd contracts   # key sourced into the shell, never on the command line as a literal
MINT_TO=<holders> base-forge script script/IssueTestStocks.s.sol --tc IssueTestStocks --rpc-url base_sepolia --broadcast --private-key "$KEY"
AAPLt_TOKEN=<...> NVDAt_TOKEN=<...> TSLAt_TOKEN=<...> AAPLt_PRICE_E8=33366495000 ... \
  base-forge script script/DeployOracles.s.sol --tc DeployOracles --sig "runSepolia()" --rpc-url base_sepolia --broadcast --verify --private-key "$KEY"
COLLATERAL=<AAPLt> ORACLE=<AAPLt guard> base-forge script script/CreateSessionSafeMarket.s.sol --rpc-url base_sepolia --broadcast --private-key "$KEY"
SEED_USDC=10000000 COLLATERAL=<AAPLt> ORACLE=<AAPLt guard> base-forge script script/CreateSessionSafeMarket.s.sol --sig "seed()" --rpc-url base_sepolia --broadcast --slow --private-key "$KEY"
```

Live proof on the public venue: the borrower `0xB789aD318945B37566E2549F65526Cc269a482Fc` holds 10 AAPLt as
collateral (supplied during the weekend session, since `supplyCollateral` never reads the oracle) and a weekend
`borrow` reverts `MarketClosed(WEEKEND)`; `cast call` prints it as `0x3e363de9…05`.

Still to run on Sepolia: step 5 `wire` (Cobalt composite receiver policy and `SEIZE_EXEMPT_POLICY` for Morpho, the
desk and the keeper) once the desk and keeper exist, and the feed mirror keeper: the TestPriceFeeds hold their
deploy-time answer, so the gate reports `FEED_STALE` from Sun 4 Oct 16:27 UTC until something calls `setAnswer`.

Lessons: `sepolia.base.org` is load-balanced and its nodes disagree on the head for a few seconds, so a forge
broadcast started right after a `cast send` from the same key fetched a stale nonce and failed with `nonce too low`;
run one broadcaster per key at a time, pass `--slow`, and retry after a few seconds. Under base-forge the local
simulation uses Beryl precompiles even against a Cobalt chain, so anything Cobalt-only (`wire`) cannot be broadcast
from it; send that calldata with `cast send`, which does not simulate.

### Contract sizes

`CreditDesk` keeps its pricing and venue logic in `CreditDeskLib`, an external library linked at deploy time and
run with DELEGATECALL, so every transfer, approval and Morpho call still happens as the desk and reverts bubble up
unchanged. At the project's 10,000 optimizer runs the desk is 19,738 runtime bytes (4,838 under EIP-170) and the
library 15,073; before the split the desk was 28,271 and only fit at 200 runs, which is how the Sepolia desk at
`0x39aBaDc0aAa12D1F7e259b89536Aa1848997399a` was deployed (it keeps working; the next deploy uses the default runs).
`forge script` deploys the library before the desk in the same run and records it under `libraries` in the
broadcast file; `DeployCreditDesk` also reads the linked address back from the desk bytecode and prints it in its
JSON block. To reuse an already deployed library, pass `--libraries src/desk/CreditDeskLib.sol:CreditDeskLib:<address>`.
CI runs `forge build --sizes --skip test --skip script` so a future overflow fails the build; the test tree is
skipped because base-std's `MockB20Factory` is over the limit by design.

## Which Foundry build runs what (verified 3 Oct 2026)

| Build | B20 precompiles | Composite policies (Cobalt) | `SEIZE_EXEMPT_POLICY` scope |
| --- | --- | --- | --- |
| stock `forge` 1.7.1 | none; tests etch base-std's reference mocks | yes (mocks) | yes (mocks) |
| `base-forge` v1.1.0 (stable) | live, **Beryl** | no: `createCompositePolicy` reverts with its own selector, the three `wire` tests skip | yes |
| `base-forge` nightly (1.6.0-nightly, 3 Oct) | live, Denim-leaning | yes | **no**: `updatePolicy(SEIZE_EXEMPT_POLICY, …)` reverts `UnsupportedPolicyType` |

None of the local builds is Cobalt-exact. Keep `base-forge` at v1.1.0 (`base-foundryup --install v1.1.0`)
and treat Base Sepolia, reached with `base-forge … --rpc-url base_sepolia`, as the only source of truth
for Cobalt behaviour (composite policies, seize-exempt wiring, scheduled multipliers).

## CreditDesk on Sepolia: `DeployCreditDesk.s.sol` and the Cobalt wire step

`DeployCreditDesk` (`--tc DeployCreditDesk`) deploys the desk and, in the same run, registers the
session-safe market, creates the first partner and sets that partner's ticker policy for the market's
collateral. It needs an RPC (`registerMarket` reads the market from Morpho). The broadcaster becomes
the desk owner and, unless `PARTNER_ADMIN` says otherwise, the partner admin, which is what allows the
ticker policy in the same run (`setTickerPolicy` is partner-admin only; with another admin the script
skips it and says so). Partner ids are the name's UTF-8 bytes left-aligned in a `bytes32`, the same
encoding as a Solidity string literal (`partnerIdOf`). Tests: `test/script/DeployCreditDesk.t.sol`
(9 tests on the etched mainnet Morpho, including the gate-mismatch, missing-market and LTV-above-LLTV
refusals and the env parsing).

| Env | Default |
| --- | --- |
| `GATE`, `KEEPER`, `COLLATERAL`, `ORACLE` | required |
| `MORPHO`, `IRM`, `LLTV` | `0xBBBB…FFCb`, AdaptiveCurveIrm, `0.625e18` |
| `LOAN_TOKEN` | USDC on 8453 and 84532, required elsewhere |
| `ENFORCE_B20`, `POLICY_REGISTRY` | `true` on 8453 and 84532 (else `false`); the precompile when enforcing |
| `PARTNER_ID`, `PARTNER_ADMIN`, `PARTNER_SIGNER`, `PARTNER_EXPOSURE_CAP` | `boundline-app`, broadcaster, none, `1_000e6` |
| `MAX_LTV_WAD`, `MIN_DRAW`, `MAX_DRAW`, `TICKER_EXPOSURE_CAP` | `0.5e18`, `1e6`, `100e6`, `500e6` |

**The desk is above the EIP-170 size limit at the project's 10,000 optimizer runs** (measured 3 Oct
2026 with `forge build --sizes`), so deploy it with fewer runs through an env override; tests never
enforce the limit, which is why the suite was green:

| Setting | CreditDesk runtime bytes | Margin to 24,576 |
| --- | --- | --- |
| optimizer 10,000 runs (project default) | 28,271 | over by 3,695 |
| 1,000 runs | 25,559 | over by 983 |
| **200 runs** | **23,634** | 942 spare |
| via-IR, 10,000 runs | 26,016 | over by 1,440 |
| via-IR, 200 runs | 21,337 | 3,239 spare |

Keyless simulation against Base Sepolia (Base's build, because the collateral is a real B20 asset) and
the broadcast, both at 200 runs:

```bash
cd contracts
export GATE=0x92f59437d4ef5CDcEAe2CcDE89B03A7B4B1Ae427 KEEPER=<keeper> \
  COLLATERAL=0xB2000000000000000000000E063E65377cA34141 ORACLE=0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854
FOUNDRY_OPTIMIZER_RUNS=200 base-forge script script/DeployCreditDesk.s.sol --tc DeployCreditDesk \
  --rpc-url base_sepolia --sender <deployer>                                   # simulate: ~7.4M gas
FOUNDRY_OPTIMIZER_RUNS=200 base-forge script script/DeployCreditDesk.s.sol --tc DeployCreditDesk \
  --rpc-url base_sepolia --broadcast --verify --private-key "$KEY"             # deploy + verify
```

`--verify` submits the settings of the same invocation, so the override must be on the verify run too.
Every other contract keeps the project default; only the desk is compiled differently, and the
mainnet deploy will need the same override until the desk is split.

### Wire step: `wire-sepolia.sh`

The Cobalt policy wiring (`IssueTestStocks.wire`) cannot be broadcast from `base-forge` v1.1.0: its
local simulation runs Beryl precompiles, where `createCompositePolicy` reverts, so the script never
reaches the chain. `wire-sepolia.sh` performs the same five writes as raw `cast send` calls, which do
not simulate, and before each write makes the identical call as `eth_call` from the sender and aborts on
a revert (eth_call executes the live Cobalt precompiles). Policy ids are read back from the
`PolicyCreated` log of each receipt rather than predicted, because the registry's counters are shared
with every other issuer on Sepolia. Without `DEPLOYER_KEY` the script only checks:

```bash
# check (no key): every write is tried as eth_call from SENDER
TOKEN=0xB2000000000000000000000E063E65377cA34141 VENUES=0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb,<desk>,<keeper> \
  SENDER=<deployer> contracts/script/wire-sepolia.sh
# write: key passed through the environment, never as a literal
TOKEN=… VENUES=… DEPLOYER_KEY="$BOUNDLINE_TESTNET_DEPLOYER_KEY" contracts/script/wire-sepolia.sh
```

Verified read-only on Base Sepolia on 3 Oct 2026 from the deployer for AAPLt (allowlist
72057594037928092, blocklist 157): `updateAllowlist` returns, `createCompositePolicy(INTERSECT,
[157, allowlist])` would get id 216172782113783970, `createPolicyWithAccounts(ALLOWLIST, venues)` would
get 72057594037928098, and `updatePolicy` on both `TRANSFER_RECEIVER_POLICY` and `SEIZE_EXEMPT_POLICY`
returns, so the seize-exempt scope exists on Sepolia's Cobalt even though the nightly local build
rejects it. A stranger is refused with `AccessControlUnauthorizedAccount`, and a composite with a
bogus child reverts. Run it after the desk exists so the desk is among the venues; the order inside is
allowlist first, so holders can keep receiving while the composite is bound.
