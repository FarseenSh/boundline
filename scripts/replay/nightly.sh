#!/usr/bin/env bash
# Nightly assurance: fork Base mainnet, replay the real positions through the weekend gap scenarios, write
# docs/evidence/assurance/<date>.{json,md,forge.log} and publish the JSON to the Observatory's KV as
# `assurance-latest` (served at /v1/assurance). Exits non-zero when Boundline left a position liquidatable.
#
# Needs: base-forge at ~/.foundry/bin (base-foundryup), pnpm, and either BASE_RPC_URL (archive) or
# BOUNDLINE_ALCHEMY_API_KEY. The upload needs a wrangler login or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
# Locally: `set -a; . ~/.boundline/base-sepolia.env; set +a; scripts/replay/nightly.sh`. Keys never print.
set -euo pipefail
cd "$(dirname "$0")/../.."
DATE="${REPLAY_DATE:-$(date -u +%Y-%m-%d)}"
if [ -z "${BASE_RPC_URL:-}" ] && [ -z "${BOUNDLINE_ALCHEMY_API_KEY:-}" ]; then
  echo "nightly: no BASE_RPC_URL or BOUNDLINE_ALCHEMY_API_KEY; skipping" >&2
  exit 0
fi
export PATH="$HOME/.foundry/bin:$PATH"
command -v base-forge >/dev/null || { echo "nightly: base-forge missing (run base-foundryup)" >&2; exit 2; }
ARGS=(--date "$DATE")
[ -n "${REPLAY_FORK_BLOCK:-}" ] && ARGS+=(--block "$REPLAY_FORK_BLOCK")
[ "${REPLAY_PUBLISH:-1}" = "1" ] && ARGS+=(--kv)
pnpm tsx scripts/replay/run.ts "${ARGS[@]}"
