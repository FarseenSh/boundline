# Before the repository goes public

The repo is local git on `main` today. It must be public (or shared with `hackathon@colosseum.com`) before the
submission. Pushing keeps every commit date; never rewrite or backdate history.

## 1. Secrets scan (run Thu 8 Oct 2026, base commit `fa25261`)

What was scanned: the 451 tracked files, and every line added in every commit on every branch (`git log --all -p`).

| Pattern | Working tree | History |
| --- | --- | --- |
| a private key assigned next to `KEY` / `SECRET` / `PRIVATE` (`0x` + 64 hex) | none | none |
| a bare 64-hex value after `PRIVATE_KEY=` | none | none |
| a keyed RPC URL (Alchemy `/v2/<key>`, CDP `/rpc/v1/<net>/<key>`, Infura, Tenderly, QuickNode) | none | none |
| an Etherscan/Basescan or Cloudflare token assigned in a file | none | none |
| a partner-key literal (`sk_…`, `bl_…`, `pk_…`) | none | none |
| a mnemonic or a PEM private key | none | none |
| any of `DEPLOYER_KEY`, `KEEPER_KEY`, `PROTECT_KEY`, `VALIDITY_KEY`, `BORROWER_KEY`, `RISK_SIGNER_KEY`, `RECOVERY_OPERATOR_KEY`, `ALCHEMY_API_KEY`, `ETHERSCAN_API_KEY` committed with a value | none | 0 lines |

Two 64-hex literals do appear next to the word "key", and both are deliberate, well-known dummy scalars with zero
balance on Base and Base Sepolia:

- `apps/keeper/src/chain.ts:68` `WARMUP_KEY` = the scalar 1 (address `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf`),
  used to build the signing tables at module load; the code comment says so.
- `apps/keeper/test/protect.test.ts:102` = the scalar 2 (address `0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF`), a test key.

`scripts/replay/run.ts:51` builds an Alchemy URL from the environment variable, not a literal.

Re-run before pushing (prints locations and redacted matches only):

```sh
git grep -n -I -i -E "(key|secret|mnemonic).{0,40}0x[0-9a-fA-F]{64}" -- . ':!pnpm-lock.yaml'   # expect the two dummy scalars above
git grep -n -E "g\.alchemy\.com/v2/[A-Za-z0-9_-]{20,}|developer\.coinbase\.com/rpc/v1/[a-z-]+/[A-Za-z0-9_-]{20,}"   # expect nothing
git log --all -p --no-color | grep -c -E "^\+.*(DEPLOYER_KEY|KEEPER_KEY|PROTECT_KEY|VALIDITY_KEY|BORROWER_KEY|ALCHEMY_API_KEY|ETHERSCAN_API_KEY)\s*=\s*['\"]?[0-9A-Za-z]{20,}"   # expect 0
```

Where the real secrets live (never in the repo): `~/.boundline/` on the deployer's machine (Sepolia test keys, the API
partner key, the Cloudflare internal token) and Cloudflare Worker secrets. `.gitignore` already excludes `.env*`
(except `.env.example`, which holds names only), `.dev.vars*`, `*.pem`, `*.key`, `.wrangler/`, Foundry `out*/` and
`cache*/`, and `broadcast/**/dry-run/`. The committed `contracts/broadcast/` records hold transactions and addresses,
no keys.

## 2. Files that mention local paths

These name local paths (`~/.boundline`, `/Users/farseen`), not secrets. They are the build log and operator notes; keep
them, or replace the paths with `<keys dir>` if preferred.

| Mentions | File |
| ---: | --- |
| 7 | `docs/CONTEXT.md` |
| 3 | `docs/BUILD.md` |
| 2 | `apps/api/README.md` |
| 2 | `docs/runbooks/saturday-rescue-2026-10-10.md` |
| 1 | `apps/indexer/README.md` |
| 1 | `apps/keeper/README.md` |
| 1 | `deployments/base-sepolia.json` |
| 1 | `docs/evidence/assurance/README.md` |
| 1 | `scripts/replay/nightly.sh` |

`docs/CONTEXT.md` also names the plan files in `/Users/farseen/BaseFlow/reports/`, which will not exist for a reader;
that is fine for a build log.

## 3. Authorship (Colosseum checks who did the work)

All 53 commits (3 to 8 Oct 2026) are by `Farseen Shaikh <90364321+FarseenSh@users.noreply.github.com>`.
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
`BASE_RPC_URL`) and `.github/workflows/nightly.yml` (the replay at 03:00 UTC) have never run. Repository secrets:

| Secret | Used by |
| --- | --- |
| `BASE_RPC_URL` (an archive endpoint) or `ALCHEMY_KEY` | the fork job and the nightly replay |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | the nightly replay publishing `assurance-latest` to the Observatory's KV |

Until the nightly workflow has run, say "the replay" (first run 7 Oct 2026), not "nightly", in the submission.

## 6. Logged-out check (Saturday, before recording and again before submitting)

Open each in a private window: the site, app, Observatory, console, API `/health`, agent `/v1/tools`, keeper
`/v1/protect`, indexer `/v1/sources`, the repository, both videos (unlisted, not private), and five Basescan links from
the evidence index.
