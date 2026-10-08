#!/usr/bin/env bash
# Fork drills: run the venue-halt and bad-debt-probe drills (contracts/test/drills) under base-forge against a Base
# mainnet fork pinned at one block, reconcile the probe's flows with @boundline/ledger, verify the 24 Sep 2026 halt
# transactions on chain, and write docs/evidence/drills/venue-halt.json and docs/evidence/drills/bad-debt-probe.json.
# Exits non-zero when a check fails or a ledger event does not reconcile.
#
# Needs: base-forge at ~/.foundry/bin (base-foundryup), pnpm, and either BASE_RPC_URL (archive) or
# BOUNDLINE_ALCHEMY_API_KEY. Locally: `set -a; . ~/.boundline/base-sepolia.env; set +a; scripts/drills/run-fork-drills.sh`.
# Pin a block with DRILL_FORK_BLOCK=<n>, run one drill with DRILL_ONLY=venue-halt|bad-debt-probe; FOUNDRY_PROFILE
# defaults to lane-d. Keys never print.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ -z "${BASE_RPC_URL:-}" ] && [ -z "${BOUNDLINE_ALCHEMY_API_KEY:-}" ]; then
  echo "fork drills: no BASE_RPC_URL or BOUNDLINE_ALCHEMY_API_KEY; skipping" >&2
  exit 0
fi
export PATH="$HOME/.foundry/bin:$PATH"
command -v base-forge >/dev/null || { echo "fork drills: base-forge missing (run base-foundryup)" >&2; exit 2; }
ARGS=()
[ -n "${DRILL_FORK_BLOCK:-}" ] && ARGS+=(--block "$DRILL_FORK_BLOCK")
[ -n "${DRILL_ONLY:-}" ] && ARGS+=(--only "$DRILL_ONLY")
pnpm tsx scripts/drills/run-fork-drills.ts "${ARGS[@]+"${ARGS[@]}"}"
