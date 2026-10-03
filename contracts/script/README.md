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

### Tonight on Sepolia, with a funded deployer key

```bash
cd contracts
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org BASESCAN_API_KEY=...
# 1. calendar, mirror registry, test feeds, gate, guards (one run, verified)
forge script script/DeployOracles.s.sol --tc DeployOracles --sig "runSepolia()" \
  --rpc-url base_sepolia --broadcast --verify --account <keystore>
# 2. real B20 test stocks through the precompile (Base's Foundry build; stock forge cannot simulate them)
MINT_TO=<teammate> base-forge script script/IssueTestStocks.s.sol --tc IssueTestStocks \
  --rpc-url base_sepolia --broadcast --account <keystore>
# 3. rerun 1 with the real tokens so the guards price them: AAPLt_TOKEN=<from step 2> ...
# 4. the Sepolia market on the AAPLt guard
COLLATERAL=<AAPLt> ORACLE=<AAPLt SessionGuard> forge script script/CreateSessionSafeMarket.s.sol \
  --rpc-url base_sepolia --broadcast --account <keystore>
# 5. wire Morpho, the desk and the keeper once they exist
base-forge script script/IssueTestStocks.s.sol --tc IssueTestStocks --sig "wire(address,address[])" \
  <AAPLt> "[0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb,<desk>,<keeper>]" --rpc-url base_sepolia --broadcast --account <keystore>
```

## Which Foundry build runs what (verified 3 Oct 2026)

| Build | B20 precompiles | Composite policies (Cobalt) | `SEIZE_EXEMPT_POLICY` scope |
| --- | --- | --- | --- |
| stock `forge` 1.7.1 | none; tests etch base-std's reference mocks | yes (mocks) | yes (mocks) |
| `base-forge` v1.1.0 (stable) | live, **Beryl** | no: `createCompositePolicy` reverts with its own selector, the three `wire` tests skip | yes |
| `base-forge` nightly (1.6.0-nightly, 3 Oct) | live, Denim-leaning | yes | **no**: `updatePolicy(SEIZE_EXEMPT_POLICY, …)` reverts `UnsupportedPolicyType` |

None of the local builds is Cobalt-exact. Keep `base-forge` at v1.1.0 (`base-foundryup --install v1.1.0`)
and treat Base Sepolia, reached with `base-forge … --rpc-url base_sepolia`, as the only source of truth
for Cobalt behaviour (composite policies, seize-exempt wiring, scheduled multipliers).
