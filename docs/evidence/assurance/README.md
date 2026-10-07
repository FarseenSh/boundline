# Assurance replays

Nightly (and on demand) replay of real Base mainnet positions through a weekend on a fork: what the
raw venue does to them at the Sunday 20:00 ET reopen when the feed prints a gap, and what happens
when Boundline's keeper acts on Saturday at the DEX price instead. One file pair per run,
`<date>.json` (machine, hashed) and `<date>.md` (table), plus the scrubbed `<date>.forge.log`.
The latest JSON is also published to the Observatory's KV as `assurance-latest` and served at
`https://boundline-observatory.papermind-ai.workers.dev/v1/assurance`.

## What a run does

1. **Fork** Base mainnet at a pinned block (`REPLAY_FORK_BLOCK`, else the head at start) through an
   archive RPC (the Alchemy free tier is enough: everything after the fork point is local).
2. **Positions.** The Morpho Steakhouse AAPLc/USDC borrower from the protection fork test, and the
   real Aave V4 MAG7 borrowers the indexer has seen (`/v1/venues/aave/borrowers`): every candidate is
   read on the fork and the largest USDC debt and the lowest health above 1.0 with AAPLc collateral
   are kept. Each venue also gets a **staged** row: the same real position brought to the edge of the
   band at Friday's close (Morpho: venue LTV 0.56; Aave: health 1.05) with a borrow on the fork, so
   the contrast between the paths is visible. Unstaged rows are the positions exactly as they stood.
3. **Friday close.** `vm.warp` to Fri 20:00 ET minus a minute; the feed's latest transmission is
   rewritten with the held answer and a timestamp just before the close ("Friday's last print").
   Opt-ins are applied as the user would sign them once: `Morpho.setAuthorization(preLiquidation)`,
   `Spoke.setUserPositionManager(Giver)`.
4. **Saturday 10:00 ET.** The feed is frozen. The weekend DEX move is a `MockSwapPool` (a
   Slipstream-shaped pool) set to the gapped price; it is the `ShadowGuard`'s TWAP source and the
   `Protector`'s sale venue. The real Aerodrome pool's TWAP cannot be moved on a fork without trading
   through it, so this is the one simulated input and it is labelled as such.
5. **Two paths from one snapshot.** *Raw*: nothing happens. *Boundline*: on Morpho the `Protector`
   runs the partial pre-liquidation its on-chain `sizing` allows when the position is inside the band
   (preLltv 0.58 to LLTV 0.625 at the shadow price); past the band, where Morpho's audited contract
   refuses (`LiquidatablePosition`), the Reserve's repay rung pays debt down to the band's edge
   (`Morpho.repay` reads no oracle). On Aave the `ProtectionVault` repays through the Giver, funded by
   a Reserve advance, sized to health 1.02 at the gapped price.
6. **Reopen.** `vm.warp` to Sun 20:00 ET + 12 s; the gapped answer is written with a fresh timestamp.
   Both paths read the venue's own health and a funded liquidator tries a real liquidation
   (`Morpho.liquidate` for 0.01 AAPLc, `Spoke.liquidationCall` for 1% of the debt). The row records
   whether the venue let it through.

Gaps: −3%, −8%, −15%. The run fails (and the nightly job goes red) if any Boundline row is
liquidatable at the reopen or a liquidation goes through on the protected path.

## Price forcing: the aggregator slot

The Coinbase AAPL feed proxy `0x787f13dEa48Db0897CbCDD985de77809D837F988` fronts an
`AccessControlledOCR2Aggregator 1.0.0` at `0xc37B6F754e90D4Cca1f533F5a08f7d532b3d0d9D`. The latest
round lives in `s_transmissions[roundId]` (mapping slot 12) as one packed word:

```
bits 0..191   int192 answer (8 decimals)
bits 192..223 uint32 observationsTimestamp  (startedAt through the proxy)
bits 224..255 uint32 transmissionTimestamp  (updatedAt through the proxy)
```

The harness finds the slot two ways and aborts unless they agree: it records the storage reads of
`latestRoundData()` (`vm.record` / `vm.accesses`, Foundry's form of the prestate tracer) and keeps the
read slot whose low 192 bits equal the answer; and it computes `keccak256(abi.encode(roundId, 12))`
with the aggregator's round id taken from the proxy's (`proxyRoundId = phaseId << 64 | aggRound`,
the aggregator itself refuses direct reads with `No access`). The rewrite is `vm.store` on that
slot, the equivalent of `anvil_setStorageAt`. The Morpho market oracle (MorphoChainlinkOracleV2 on
the proxy) and the Aave spoke oracle both read it, so one write moves both venues. Alchemy's free
tier does not expose `debug_traceCall`, which is why the prestate tracer is not used over RPC; the
storage scan in `scripts/replay` notes confirms the same slot from outside Foundry
(`cast storage <aggregator> keccak256(abi.encode(roundId, 12))`).

The round id is kept; only the answer and the two timestamps change. The venues do not look at round
ids; the SessionGate looks at `updatedAt` and the session, which is why the reopen write carries a
fresh timestamp.

## Rerunning

```sh
set -a; . ~/.boundline/base-sepolia.env; set +a         # BOUNDLINE_ALCHEMY_API_KEY, never printed
pnpm replay -- --date 2026-10-07                         # writes docs/evidence/assurance/2026-10-07.{json,md,forge.log}
pnpm replay -- --date 2026-10-07 --block 52295860 --kv   # pinned block, and publish to KV
scripts/replay/nightly.sh                                # what the nightly job runs
```

`FOUNDRY_PROFILE` defaults to `lane-b`; the harness is `contracts/test/fork/ReplayFork.t.sol` and
needs `base-forge` (`FOUNDRY_BASE=true`) because every sale and liquidation moves a B20 token. Pass
`--forge-log <file>` to rebuild the evidence from a saved log without touching the chain.

## Evidence file

`version`, `ranAt`, `chainId`, `forkBlock`, `forkBlockTime`, `scenarios[]` (`id`, `gapBps`,
`positions[]` with `venue`, `address`, `market`, `collateralSymbol`, `debtUsdc`, `raw{hfBefore,
hfSaturdayHeld, hfAtReopen, liquidatableSaturday, liquidatableAtReopen, liquidationExecuted}`,
`boundline{action, actionAt, amountUsdc, standing, shadowPrice36, hfAfterSaturday, hfAfter,
liquidatableAtReopen, liquidationExecuted}` and the staging facts), `summary` (`positions`,
`scenarios`, `rawLiquidatable`, `boundlineLiquidatable`, `pass`), `method`, `candidates`,
`artifact`, and `evidenceHash = keccak256(utf8(canonical JSON without evidenceHash))` where
canonical means keys sorted at every level and no whitespace. Health values are the venue's WAD
numbers as decimal strings; `∞` in the tables is a position without debt.

The same document is the KV value Lane E's Observatory panel renders; extra keys beyond the panel's
schema are informational.
