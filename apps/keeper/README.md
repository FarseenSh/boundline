# @boundline/keeper

The Boundline keeper: a Cloudflare Worker with a one-minute cron. Its first job is the **Sepolia feed
mirror**: it copies the Chainlink round of each Coinbase tokenized stock on Base mainnet onto the matching
Boundline `TestPriceFeed` on Base Sepolia, and the mainnet OracleRegistry params (multiplier, paused) onto the
Sepolia `MirrorOracleRegistry`. Without it the Sepolia feeds hold their deploy-time answer and the
`SessionGate` reports `FEED_STALE` 26 hours after the deploy (Sun 4 Oct 2026 16:27 UTC). Later jobs
(shadow-health protection, validity transactions) land in this Worker too.

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
- `GET /v1/config`: jobs, cron, pairs, registries, RPC hosts (keys redacted).

## Configuration

Vars in `wrangler.jsonc` (comma-separated fallback lists, first wins):

| Var | Value |
| --- | --- |
| `BASE_RPC_URL` | `https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org` |
| `BASE_SEPOLIA_RPC_URL` | `https://sepolia.base.org,https://base-sepolia-rpc.publicnode.com,https://base-sepolia.drpc.org` (each answered `eth_chainId` 0x14a34 and a Multicall3 call on 3 Oct 2026; `base-sepolia.public.blastapi.io` is shut down) |
| `MIRROR_HOLD_FEED`, `MIRROR_HOLD_REGISTRY` | symbols the mirror leaves alone during a drill (see "Drills by hand"); blank |

Secrets (never in the file):

| Secret | Purpose |
| --- | --- |
| `KEEPER_KEY` | the keeper's private key, test-only Base Sepolia, owner of the feeds and registry |
| `BASE_RPC_URL_PRIVATE`, `BASE_SEPOLIA_RPC_URL_PRIVATE` | optional keyed RPCs, tried before the public lists |

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

The next tick would undo a drill because mainnet differs, so **hold the symbol first**: the vars
`MIRROR_HOLD_FEED` and `MIRROR_HOLD_REGISTRY` (comma-separated symbols, blank = none) make the mirror skip that
symbol's feed or registry writes (`planAll` reports `skip` / `held (MIRROR_HOLD_…)`; `/v1/config` shows `hold`).
Set them without a redeploy from the dashboard, or in `wrangler.jsonc` followed by `pnpm exec wrangler deploy`,
run the drill, record the evidence, then clear the hold: the next tick restores mainnet's state. The keeper key
also sends the drill transactions, so keep the drill to one transaction between two ticks (a tick sends at most
one transaction and skips while one is pending) or send it from another owner.

## Tests

`pnpm --filter @boundline/keeper test` (vitest, no network): the planners, nonce rule and lag maths
(`test/plan.test.ts`), the tick against a fake chain (`test/tick.test.ts`: in-sync, feed-then-registry order
with contiguous nonces, in-flight skip, no-key mode, rejected send, receipt timeout, reverted receipt, failed
reads, pure `planAll`), the status builder (`test/status.test.ts`) and the routes (`test/smoke.test.ts`).
`pnpm --filter @boundline/keeper typecheck` for the types.

## CPU budget (why the adapter is hand-rolled)

The account runs on the Workers Free plan: **10 ms of CPU per invocation**. On 6 Oct 2026 every cron tick of this
Worker was ending `outcome: exceededCpu` (`wrangler tail`), and the Sepolia feeds lagged mainnet by one round for
hours. Measured in Node (JIT on): viem's `privateKeyToAccount` costs 17.8 ms the first time an isolate uses it
(noble-curves builds its base-point tables), a signature 1.6 ms, and viem's generic multicall decode 17 ms warm.
So `src/chain.ts` keeps only viem's transport (RPC fallback) and local signer, and `src/raw.ts` builds the few
calls by hand: Multicall3 `aggregate3` for the reads, `setRoundData` / `setOracleParams` calldata for the writes,
EIP-1559 fields filled from one `eth_gasPrice` read (tip 0.001 gwei, max fee 3x gas price, 160k gas), then
`eth_sendRawTransaction`. The signer's one-time cost is paid at module evaluation (its own startup budget) with a
non-secret warm-up key, and clients and the account are memoised per isolate. `test/raw.test.ts` checks every
encoder and decoder against viem's. Watch it with `pnpm exec wrangler tail boundline-keeper --format json`: the
`outcome` and `cpuTime` fields per event are the truth.
