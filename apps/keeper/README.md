# @boundline/keeper

The Boundline keeper: a Cloudflare Worker with a one-minute cron. Its first job is the **Sepolia feed
mirror**: it copies the Chainlink round of each Coinbase tokenized stock on Base mainnet onto the matching
Boundline `TestPriceFeed` on Base Sepolia, and the mainnet OracleRegistry params (multiplier, paused) onto the
Sepolia `MirrorOracleRegistry`. Without it the Sepolia feeds hold their deploy-time answer and the
`SessionGate` reports `FEED_STALE` 26 hours after the deploy (Sun 4 Oct 2026 16:27 UTC). Since 6 Oct the same cron
runs the **protection job** (the Protector's shadow pre-liquidation, armed as a validity transaction), and since
8 Oct the **vault job** (an any-hour protective repay of CreditDesk lines through the DeskProtectionVault ladder) and
**events** (grace, grace.cleared, protect) for the partner API. Order inside a tick: protection, vault, events, mirror.

Pairs (`src/config.ts`, Sepolia addresses from `deployments/base-sepolia.json`):

| Sepolia | mirrors | mainnet feed |
| --- | --- | --- |
| AAPLt `0xB200…4141`, feed `0xa652…e52a` | AAPLc | `0x787f13dEa48Db0897CbCDD985de77809D837F988` |
| NVDAt `0xB200…2ae6`, feed `0x097d…B0e2` | NVDAc | `0x04689a41629776563E6822F76f2e57D148d28513` |
| TSLAt `0xb200…F804`, feed `0x5CB9…43a1` | TSLAc | `0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4` |

Registry: mainnet `0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD` → Sepolia `0xc78A796710be93774310ff8Cf467EaABCeAb4655`.
Keeper key address: `0x28A50Eb7C2Db2B04638D3b226c724A1Cfe999894` (owner of the three feeds and the registry since 3 Oct 2026).

## How a tick works (`src/tick.ts`, `src/plan.ts`)

1. Read both chains in one multicall each: `latestRoundData()` on every feed and `getOracleParams(token)` on
   each registry.
2. Plan per pair, purely: `planFeedMirror` writes the whole mainnet round with `setRoundData(roundId, answer,
   startedAt, updatedAt, answeredInRound)` when any field differs (or Sepolia is unreadable); it is **faithful**,
   so a held weekend round or a paused token on mainnet shows up on Sepolia exactly as on mainnet. An all-zero
   mainnet round is refused. `planRegistryMirror` writes `setOracleParams(token, multiplier, paused)` when they differ.
3. Nothing to do → stop. No `KEEPER_KEY` → report only.
4. Read the keeper's `latest` and `pending` nonces; if `pending > latest` a previous tick is still in flight →
   skip this tick (no duplicate sends).
5. Send feed updates first, then registry updates, with explicit contiguous nonces from the pending nonce, at
   most `MAX_TX_PER_TICK` of them (default 1; the var `MAX_TX_PER_TICK` overrides). A tick never waits for a
   receipt: the next tick's nonce check covers a transaction still in flight, and a revert shows up as the plan
   still differing a minute later. A rejected send stops the tick; the next tick starts from the chain's nonce
   again. A tick never throws.
6. Log one JSON line per tick (`skipped`, `planned`, `sent`, per-tx hash and status, per-symbol plans).

## Routes

- `GET /health`
- `GET /` and `GET /v1/status`: both sides of every pair (roundId, answer, price, updatedAt, age), `inSync`,
  `lagSeconds`, registry params both sides, keeper address and Sepolia ETH balance, block numbers, a summary.
  Read-only; it never sends.
- `GET /v1/protect`: the protection job's live view (every target's `Protector.sizing` and decision, and the
  pre-flight simulation when there is an action; never signs). `?simulate=close` runs the pre-flight on a hypothetical
  full close-out of every target right now (eth_call from the signer), for checking the decoder against live state.
- `GET /v1/vault`: the vault job's live view: `keeperStatus` (`keeper` once the vault's `keeper()` is the
  protection signer, `not-keeper` before), per line the debt, collateral, shadow price and shadow/venue LTV, grace and
  target, the repay it would make (`amountUsdc`), the whole ladder (`fromUser`, `fromPartner`, `fromAdvance`), the
  decision, the pre-flight simulation, and the state (lines in grace, armed episodes, backoffs). Never signs.
  `?simulate=<raw USDC>` runs the pre-flight on a hypothetical `protect(lineId, amount)` right now.
- `GET /v1/events/probe`: proves the `API_EVENTS` binding without side effects (it sends an event of a type the API
  refuses; the API's validation answer comes back).
- `GET /v1/config`: every job with its signer and config, the warm-up result, the hold switch, cron, pairs,
  registries, RPC hosts (keys redacted).

## Configuration

Vars in `wrangler.jsonc` (comma-separated fallback lists, first wins):

| Var | Value |
| --- | --- |
| `BASE_RPC_URL` | `https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org` |
| `BASE_SEPOLIA_RPC_URL` | `https://sepolia.base.org,https://base-sepolia-rpc.publicnode.com,https://base-sepolia.drpc.org` (each answered `eth_chainId` 0x14a34 and a Multicall3 call on 3 Oct 2026; `base-sepolia.public.blastapi.io` is shut down) |
| `MIRROR_HOLD_FEED`, `MIRROR_HOLD_REGISTRY` | symbols the mirror leaves alone during a drill (see "Drills by hand"); blank |
| `PROTECTOR`, `PROTECT_TARGETS` | the protection job: the Protector and `preLiq:borrower:feed:slot,...` |
| `BASE_SEPOLIA_SEQUENCER_URL` | `https://sepolia-sequencer.base.org` (`base_sendRawTransactionValidity`) |
| `DESK_PROTECTION_VAULT`, `CREDIT_DESK` | the vault job: `0x87f6…f38c` and `0x39aB…399a` |
| `VAULT_TARGETS` | `lineId:graceLtvBps:targetLtvBps:shadowOracle:feed:slot,...`; since 8 Oct `1:5200:4500:<AAPLt ShadowGuard>:<AAPLt feed>:5` |

Bindings: KV `KEEPER_STATE` (`a648931723db46ca90aef102b0fe83bb`: key `hold` = the drill hold switch, key `state` =
the event state); `API_EVENTS` (an RPC binding to `boundline-api`, entrypoint `Events`) once the API serves it.

Secrets (never in the file):

| Secret | Purpose |
| --- | --- |
| `KEEPER_KEY` | the keeper's private key, test-only Base Sepolia, owner of the feeds and registry (the mirror's signer) |
| `PROTECT_KEY` | the protection signer `0x4066…0373`: the Protector's keeper and, once the vault's owner points `setKeeper` at it, the vault's keeper; shared by the two protection jobs |
| `BASE_RPC_URL_PRIVATE`, `BASE_SEPOLIA_RPC_URL_PRIVATE` | optional keyed RPCs, tried before the public lists |

## The vault job (`src/vault.ts`, `src/vault-job.ts`)

The repay gate of plan M6: a repay can never hurt the borrower, so it is the one action that is safe on a held feed.
Per tick, one JSON-RPC batch reads the head, one Multicall3 (the vault's `keeper()` and `paused()`, then per line the
desk's `line` and `capacity` quote, the ShadowGuard's `price()` and the vault's `previewProtect(line, 2^128-1)`, which
answers the whole ladder), every predicate slot, the signer's nonces and the gas price. The desk's quote fills
collateral and debt before any refusal, so one view works at any hour.

- **Shadow LTV** = debt / (collateral × ShadowGuard price): the fresh feed in session, the pool TWAP less 200 bps
  while the feed is held. At or above `graceLtvBps` the line is `IN_GRACE` and the repay is debt − target ×
  collateral value, rounded **up to a whole cent** (a stable amount keeps the decision and its backoff fingerprint
  still while the price holds), never more than the debt, capped to what the ladder holds (user reserve, partner
  reserve, advance room; only the reserves while the vault is paused).
- **Signing:** `vault.protect(lineId, amount)` with the protection signer, after a clean pre-flight simulation,
  armed as a validity transaction exactly as the Protector's action: predicate `storage(feed, slot) = the round the
  decision was read at`, bound head + 30, re-armed with a new hash and rising fees (next section).
- **One signer, two jobs:** at most one signature per tick; the Protector goes first, and the vault job stands down
  (`signer-busy`) in any tick where a Protector target wanted to act, or while the signer has a transaction in flight
  (`in-flight`). Until the vault's `keeper()` is the signer the job reports `not-keeper` and never signs.
- Line 1 is the Saturday drill line (Lane K1, 8 Oct: 0.02 AAPLt, 3.220174 USDC, 0.4 USDC user reserve, 1 USDC advance
  room): 47.96% at the feed, 52% grace, 45% target. With the feed held, a TWAP about 8% under the held price puts it in
  grace; the Protector's band for the same position starts at 58%, so the vault acts first.

## Pre-flight, backoff and re-arm fees (8 Oct 2026)

**Every action is simulated before it is signed** (Lane K1's finding: `Protector.sizing` does not see the sale pool's
USDC, so an in-band close-out the pool cannot pay would be signed, included and reverted every minute, burning the
signer's ETH). Both jobs `eth_call` the exact calldata they would sign, from the signer, at `latest` (mandatory) and
`pending` (a revert blocks; an unavailable answer does not). A revert is decoded by its 4-byte selector
(`src/reverts.ts`, 98 errors from the forge artifacts plus `Error(string)` and `Panic`), the decision becomes
`would-revert` with that error, nothing is signed and no event is sent. A simulation that cannot run at all is
`simulation-unavailable` (no signature this tick). The target then **backs off** for 150 blocks (about five ticks)
unless its fingerprint changes (the inputs that decide the action, without the debt interest moves every block: for
the Protector the standing, shares, collateral, shadow price and close-out flag; for the vault the cent-rounded amount,
the ladder, pause and line status, shadow price). Backoffs live in the KV state next to the event state.

Verified live on 8 Oct with `?simulate=` (eth_call from the signer, nothing signed): a close-out of either Protector
target reverts `NotInBand(uint8)`; `protect(1, 0.01 USDC)` on the vault simulates `ok`; `protect(1, 5 USDC)` reverts
`AdvanceCapExceeded(uint256,uint256,uint256)`.

**Re-arms change the hash** (`rearmFees` in `src/protect.ts`). Measured the same day
(`docs/evidence/validity-rearm-2026-10-08.md`): identical bytes re-submitted after their bound expired were accepted
but never included, while a re-signed transaction (same nonce) landed in two blocks. So an episode's first arming uses
the base fees and every later arming re-signs with tip and fee cap both 25% higher per 30-block window since the
episode began (the episode's head is in the KV state), which also makes it a valid replacement of a live submission.
A second attempt inside one tick (after `already known` or `underpriced`) re-signs two steps up.

On Saturday, mind the order: top up the sale pool **before** the price move that puts a position in band, or the
close-out's first simulation reverts (`Unpaid`) and the target backs off for up to five minutes (a price move changes
the fingerprint and ends the backoff early).

## Events (`src/events.ts`)

Edge-triggered, for the partner API's webhooks (plan M7): `grace` when a desk line enters grace (or a Protector target
enters its band), `grace.cleared` on a definite exit (a failed read or a missing shadow price never clears it),
`protect` once per arming episode (`phase: armed`, the first submission's hash) and once more when the contract's own
`Protected` log appears (`phase: executed`, the transaction and decision hashes, the amounts by ladder step). State
(KV `state`: lines in grace, armed episodes) is written only when it changes, never per re-arm, far inside the free
tier's 1,000 writes a day; an episode not executed within 450 blocks is dropped. Events go through the `API_EVENTS`
binding (`Events.ingest`) when it exists; until then they are logged in the tick's `events` line.

## Deploy

```sh
cd /Users/farseen/boundline/apps/keeper
set -a; . "$KEY_FILE"; set +a                         # the operator's 0600 env file, never echoed
printf '%s' "$BOUNDLINE_TESTNET_KEEPER_KEY" | pnpm exec wrangler secret put KEEPER_KEY
pnpm exec wrangler deploy
```

Verify after the first tick (a minute):

```sh
curl -s https://boundline-keeper.<subdomain>.workers.dev/v1/status | python3 -m json.tool | head -60
# Sepolia AAPLt feed must now carry mainnet's round (roundId, answer, startedAt, updatedAt, answeredInRound):
cast call --rpc-url https://sepolia.base.org 0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a "latestRoundData()(uint80,int256,uint256,uint256,uint80)"
cast call --rpc-url https://mainnet.base.org 0x787f13dEa48Db0897CbCDD985de77809D837F988 "latestRoundData()(uint80,int256,uint256,uint256,uint80)"
cast call --rpc-url https://sepolia.base.org 0xc78A796710be93774310ff8Cf467EaABCeAb4655 "getOracleParams(address)(uint256,bool)" 0xB2000000000000000000000E063E65377cA34141
pnpm exec wrangler tail --format pretty      # one JSON line per tick
```

A keyless live status from a laptop, no deploy needed: `pnpm --filter @boundline/keeper exec tsx scripts/status.ts`.

## Gas budget

`setRoundData` rewrites five storage slots and emits `AnswerUpdated`: about 45,000–55,000 gas (measure the first
receipts with `cast receipt <hash> gasUsed`). Base Sepolia gas is about 0.006 gwei, so one update costs
roughly 0.0000003 ETH; the keeper's 0.01 ETH covers tens of thousands of updates. Coinbase feeds update on a
0.5% deviation or a 24 h heartbeat: a volatile trading day moves a feed a few dozen times, so expect on the
order of 50–150 Sepolia transactions a day across the three pairs during trading hours and none on weekends.
Watch `keeper.balanceEth` on `/v1/status`; top up from the deployer with `cast send --value`.

## Drills by hand

The keeper key also lets an operator stage states the gate must refuse. Load the key file, never paste a key:

```sh
set -a; . "$KEY_FILE"; set +a
RPC=https://sepolia.base.org; FEED=0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a; REG=0xc78A796710be93774310ff8Cf467EaABCeAb4655; AAPLT=0xB2000000000000000000000E063E65377cA34141
# stale feed: same answer, updatedAt 30 h ago
cast send --rpc-url $RPC --private-key "$BOUNDLINE_TESTNET_KEEPER_KEY" $FEED "setAnswerAt(int256,uint256)" 33366495000 $(( $(date +%s) - 108000 ))
# issuer pause on the registry
cast send --rpc-url $RPC --private-key "$BOUNDLINE_TESTNET_KEEPER_KEY" $REG "setOracleParams(address,uint256,bool)" $AAPLT 1000000000000000000 true
# corporate action: 2-for-1 multiplier
cast send --rpc-url $RPC --private-key "$BOUNDLINE_TESTNET_KEEPER_KEY" $REG "setOracleParams(address,uint256,bool)" $AAPLT 2000000000000000000 false
```

The next tick would undo a drill because mainnet differs, so **hold the symbol first**. Since 8 Oct 2026 the hold is a
runtime switch: the KV namespace `KEEPER_STATE` (`a648931723db46ca90aef102b0fe83bb`), key `hold`, JSON
`{"feed": [...], "registry": [...]}`, read once per tick and united with the vars `MIRROR_HOLD_FEED` /
`MIRROR_HOLD_REGISTRY` (comma lists, still honoured). No redeploy, effective from the next tick:

```sh
cd /Users/farseen/boundline/apps/keeper
# hold TSLAt's feed and registry mirror (the drill's symbol)
pnpm exec wrangler kv key put --remote --namespace-id a648931723db46ca90aef102b0fe83bb hold '{"feed":["TSLAt"],"registry":["TSLAt"]}'
# hold everything (drills that sign with the mirror key: the Worker then never broadcasts from it at the same time)
pnpm exec wrangler kv key put --remote --namespace-id a648931723db46ca90aef102b0fe83bb hold '{"feed":["AAPLt","NVDAt","TSLAt"],"registry":["AAPLt","NVDAt","TSLAt"]}'
# check: hold, holdSource ("kv", "vars", "vars+kv" or "none") and the per-pair plan ("held (feed hold); unheld: …")
curl -s https://boundline-keeper.papermind-ai.workers.dev/v1/config | python3 -m json.tool | grep -A3 '"hold'
curl -s https://boundline-keeper.papermind-ai.workers.dev/v1/status | python3 -c "import json,sys;[print(p['symbol'],p['feed']['plan'],'|',p['registry']['plan']) for p in json.load(sys.stdin)['pairs']]"
# release: the next tick restores mainnet's state on Sepolia
pnpm exec wrangler kv key delete --remote --namespace-id a648931723db46ca90aef102b0fe83bb hold
```

A malformed value holds nothing (and `/v1/config` shows `holdKvError`); a failed KV read falls back to the vars. KV is
eventually consistent: allow up to a minute before trusting a change in another region (it was immediate here). The
tick log line carries `hold` while anything is held. The keeper key also sends the drill transactions, so hold every
symbol while a drill signs with it (the mirror then sends nothing from that key), or keep the drill to one transaction
between two ticks (a tick sends at most one transaction and skips while one is pending).

## Tests

`pnpm --filter @boundline/keeper test` (vitest, no network): the planners, nonce rule and lag maths
(`test/plan.test.ts`), the tick against a fake chain (`test/tick.test.ts`: in-sync, feed-then-registry order
with contiguous nonces, in-flight skip, no-key mode, rejected send, receipt timeout, reverted receipt, failed
reads, pure `planAll`), the status builder (`test/status.test.ts`), the routes and the hold switch
(`test/smoke.test.ts`), the Protector job (`test/protect.test.ts`), the vault job (`test/vault.test.ts`: codecs
against viem, sizing on line 1's live numbers, the ladder against the contract's min chain on 2,000 random cases,
signing, shared-signer rules, re-arm fees), events, state and the RPC client (`test/events.test.ts`, which also proves
the module-scope warm-up runs every path) and the pre-flight (`test/preflight.test.ts`: every selector in
`src/reverts.ts` checked against viem, would-revert and backoff on both jobs). 116 tests on 8 Oct 2026 (65 before).
`pnpm --filter @boundline/keeper typecheck` for the types; `scripts/bench-cpu.ts` for the CPU of a cold tick.

## CPU budget (why the adapter is hand-rolled)

The account runs on the Workers Free plan: **10 ms of CPU per invocation**. On 6 Oct 2026 every cron tick of this
Worker was ending `outcome: exceededCpu` (`wrangler tail`), and the Sepolia feeds lagged mainnet by one round for
hours. Measured in Node (JIT on): viem's `privateKeyToAccount` costs 17.8 ms the first time an isolate uses it
(noble-curves builds its base-point tables), a signature 1.6 ms, and viem's generic multicall decode 17 ms warm.
So `src/raw.ts` builds the few calls by hand: Multicall3 `aggregate3` for the reads, `setRoundData` /
`setOracleParams` calldata for the writes, EIP-1559 fields filled from one `eth_gasPrice` read (tip 0.001 gwei, max
fee 3x gas price, 160k gas), then `eth_sendRawTransaction`. `test/raw.test.ts` checks every encoder and decoder
against viem's.

**8 Oct 2026: the cold-isolate cost.** The cap is enforced unevenly (that morning the indexer's ticks died at
`cpuTime 10` while a 28 ms keeper tick right after a deploy ended `ok`), so the keeper is kept under it rather than
relying on leniency. `scripts/bench-cpu.ts` replays recorded RPC answers through the Worker's own `scheduled`
handler in a fresh Node process: the first tick paid **34–36 ms** (26–28 ms with `--jitless`), every later one
0.7–4 ms. The difference is compilation: on a cold isolate every function on the path is compiled the first time it
runs, and viem's request stack (fallback transport, http transport, retries, ids, bigint-aware stringify) is a lot of
code. Two changes:

1. **`src/rpc.ts`**: the whole request path is one small client (ordered fallback, JSON-RPC batches, one fetch per
   batch). The mirror reads each chain in one batch, the vault job does all its reads in one batch, and viem is left
   only for the local-account signer.
2. **`src/warm.ts`**: at module evaluation (startup has its own budget) the Worker runs every cron path once against
   an in-memory fake (the Protector job arming a partial, the vault job arming a repay, the mirror sending a
   `setRoundData`, the event transitions, the JSON of every report), with throwaway keys, no I/O and no timers, so a
   fresh isolate's first tick starts compiled. `/v1/config` → `warmUp` shows it ran (`ok`, and what it exercised);
   `test/events.test.ts` proves every path in it executes.

Bench after both (harness warmed so its own Node `Response` code is not counted; with the pre-flight simulation in):
first tick **5.0 ms** idle, **8.9 ms** with a Protector signature, **8.9 ms** with a vault signature (Node's
`process.cpuUsage` also counts background JIT and GC threads, so these are upper bounds); later ticks 0.7–1.7 ms. The
account derivation for the real keys stays per isolate (0.4 ms) and a signature with warm code is 0.7 ms. Live
(`wrangler tail`, 8 Oct 07:25–07:45 UTC, versions `334350ea` to `4da42ed3`): nine cron ticks, every one `ok`, at
**5, 4, 2, 3, 6, 5, 5, 3 and 3 ms** CPU, the first tick after each deploy included; the final version `abcce602`
(07:44–07:49 UTC): **5, 4, 3, 3 and 3 ms**, all `ok` (that morning, before: 28 ms on the first tick after a deploy
and 8 ms idle). Worker startup with the warm-up: 37–61 ms (the limit is 1 s).
Watch it with `pnpm exec wrangler tail boundline-keeper --format json`: `outcome` and `cpuTime` per event are the truth.
