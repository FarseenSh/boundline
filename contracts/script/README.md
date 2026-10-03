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
