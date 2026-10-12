# Before the repository goes public

The repo is local git on `main` today. It must be public (or shared with `hackathon@colosseum.com`) before the
submission. Pushing keeps every commit date; never rewrite or backdate history.

## 1. Secrets scan (re-run Mon 12 Oct 2026, base commit `ec86941`)

What was scanned: every tracked file, and every line added in every commit on every branch (`git log --all -p`).

| Pattern | Working tree | History |
| --- | --- | --- |
| a private key assigned next to `KEY` / `SECRET` / `PRIVATE` (`0x` + 64 hex) | 9 matches, all benign (below) | none beyond those |
| a keyed RPC URL (Alchemy `/v2/<key>`, CDP `/rpc/v1/<net>/<key>`) | none | none |
| any of `DEPLOYER_KEY`, `KEEPER_KEY`, `PROTECT_KEY`, `VALIDITY_KEY`, `BORROWER_KEY`, `ALCHEMY_API_KEY`, `ETHERSCAN_API_KEY` committed with a value | none | 0 lines |

The nine 64-hex literals the key pattern matches, each checked by hand:

- Well-known dummy scalars with zero balance on Base and Base Sepolia: `apps/keeper/src/chain.ts:70` `WARMUP_KEY` = the
  scalar 1 (builds the signing tables at module load; the code comment says so), `apps/keeper/src/warm.ts:38` = 2 (commented
  "not a secret"), and the test keys 2, 3 and 4 in `apps/keeper/test/protect.test.ts:102`, `vault.test.ts:191`,
  `harvest.test.ts:84` and `preflight.test.ts:18`.
- `apps/api/test/route.test.ts:19` `TEST_SIGNER_KEY`: anvil's first public test account (`0xac09…ff80`), published in
  Foundry's documentation; it signs typed data in a unit test only.
- Two lines that mention "key" next to a transaction hash, not a key: `docs/evidence/feed-outage-rescue-2026-10-12.md:25`
  ("by the mirror key" next to the stale-round transaction) and the drills row of `docs/submission/SUBMISSION.md` ("keeper
  hold" next to its transaction).

`scripts/replay/run.ts` builds an Alchemy URL from the environment variable, not a literal; the Sepolia scripts read keys
by environment-variable name and pass them to `cast` without printing them.

Re-run before pushing (prints locations and redacted matches only):

```sh
git grep -n -I -i -E "(key|secret|mnemonic).{0,40}0x[0-9a-fA-F]{64}" -- . ':!pnpm-lock.yaml' \
  | sed -E 's/0x([0-9a-fA-F]{6})[0-9a-fA-F]{52}([0-9a-fA-F]{6})/0x\1…\2/g'   # expect the nine lines above
git grep -n -E "g\.alchemy\.com/v2/[A-Za-z0-9_-]{20,}|developer\.coinbase\.com/rpc/v1/[a-z-]+/[A-Za-z0-9_-]{20,}"   # expect nothing
git log --all -p --no-color | grep -c -E "^\+.*(DEPLOYER_KEY|KEEPER_KEY|PROTECT_KEY|VALIDITY_KEY|BORROWER_KEY|ALCHEMY_API_KEY|ETHERSCAN_API_KEY)\s*=\s*['\"]?[0-9A-Za-z]{20,}"   # expect 0
```

Where the real secrets live (never in the repo): `~/.boundline/` on the deployer's machine (Sepolia test keys, the API
partner key, the Cloudflare internal token, and the mainnet keys once created) and Cloudflare Worker secrets. `.gitignore`
already excludes `.env*` (except `.env.example`, which holds names only), `.dev.vars*`, `*.pem`, `*.key`, `.wrangler/`,
Foundry `out*/` and `cache*/`, and `broadcast/**/dry-run/`. The committed `contracts/broadcast/` records hold
transactions and addresses, no keys.

## 2. Files that mention local paths

These name local paths (`~/.boundline`, `/Users/farseen`), not secrets (recounted 12 Oct with
`git grep -c -E "~/\.boundline|/Users/farseen"`). They are the build log and operator notes; keep them, or replace the
paths with `<keys dir>` if preferred.

| Mentions | File |
| ---: | --- |
| 12 | `docs/CONTEXT.md` |
| 3 | `docs/BUILD.md` |
| 3 | `docs/submission/PUBLIC-REPO-CHECKLIST.md` (this file) |
| 2 | `apps/api/README.md` |
| 2 | `apps/keeper/README.md` |
| 2 | `docs/runbooks/saturday-rescue-2026-10-10.md` |
| 2 | `scripts/sepolia/drills.py` |
| 1 | `apps/indexer/README.md` |
| 1 | `apps/indexer/scripts/seize-history.py` |
| 1 | `apps/keeper/scripts/rearm-experiment.ts` |
| 1 | `deployments/base-sepolia.json` |
| 1 | `docs/evidence/assurance/README.md` |
| 1 | `docs/runbooks/mainnet-deploy.md` |
| 1 | `scripts/drills/run-fork-drills.sh` |
| 1 | `scripts/replay/nightly.sh` |
| 1 | each of `scripts/sepolia/bl.py`, `friday.py`, `harvest.py`, `outage_rescue.py`, `stage_drill_position.py`, `stage_line1.py`, `twap.py` (the `set -a; . ~/.boundline/base-sepolia.env` usage line) |

`docs/CONTEXT.md` also names the plan files in `/Users/farseen/BaseFlow/reports/`, which will not exist for a reader;
that is fine for a build log.

## 3. Authorship (Colosseum checks who did the work)

All 98 commits (Sat 3 to Mon 12 Oct 2026) are by `Farseen Shaikh <90364321+FarseenSh@users.noreply.github.com>`.
`TODO-HUMAN: if a second developer is on the roster, their work must be in this repository under their own GitHub
identity before submission; otherwise the roster is Farseen alone.`

## 4. Publish

1. `TODO-HUMAN:` create the repository (public, MIT, no template files, no README so the local one wins).
2. `git remote add origin <url>` and `git push -u origin main` (dates preserved; never rebase or backdate).
3. Open the repo logged out: the README renders, the Basescan and Workers links open, `docs/submission/` is visible.
4. Put the URL in `docs/submission/SUBMISSION.md` (GitHub field), the deck's last slide (`docs/deck/boundline.typ`,
   rebuild the PDF) and the site.
5. If the repository must stay private for any reason, grant read access to `hackathon@colosseum.com` instead.

## 5. CI and the nightly replay need secrets once the remote exists

`.github/workflows/ci.yml` (contracts build/test/fmt, TypeScript build/typecheck/test, a fork job gated on
`BASE_RPC_URL`) and `.github/workflows/nightly.yml` (the replay at 03:00 UTC) have never run. `forge fmt --check` failed on
`src/payout/LocalPayoutRouter.sol`, `test/fork/PayoutFork.t.sol` and `test/payout/LocalPayoutRouter.t.sol` until 12 Oct;
they were formatted in `ec86941`, so the contracts job's fmt step passes. Repository secrets:

| Secret | Used by |
| --- | --- |
| `BASE_RPC_URL` (an archive endpoint) or `ALCHEMY_KEY` | the fork job and the nightly replay |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | the nightly replay publishing `assurance-latest` to the Observatory's KV |

Until the nightly workflow has run, say "the replay" (first run 7 Oct 2026), not "nightly", in the submission.

## 6. Logged-out check (before recording, and again before submitting)

Open each in a private window: the site, app, Observatory, console, API `/health`, agent `/v1/tools`, keeper
`/v1/protect`, indexer `/v1/sources`, the repository, both videos (unlisted, not private), and five Basescan links from
the evidence index. On 12 Oct the Cloudflare account ran out of D1's free daily read quota and every D1-backed route
(the indexer, the Observatory's position panels, the API's obligations, the console and the app's statements through
them) answered 500 for a few hours; the account has been on Workers Paid since that evening and the Observatory's reads
are indexed (migration 0004). Still check that the indexer's `/v1/sources` and the Observatory's `/v1/positions` answer
200 before recording.
