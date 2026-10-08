#!/usr/bin/env bash
# The Boundline mainnet footprint in one ordered, resumable run (contracts/script/DeployMainnet.s.sol), with
# post-deploy checks. Runbook: docs/runbooks/mainnet-deploy.md.
#
#   KEEPER=0x… ./deploy-mainnet.sh plan        # simulate against Base mainnet: plan, gas, checks; nothing sent
#   KEEPER=0x… ./deploy-mainnet.sh rehearse    # deploy on a local base-anvil fork of mainnet, price it at today's fees
#   KEEPER=0x… MAINNET_DEPLOYER_KEY=… ./deploy-mainnet.sh broadcast [--resume]   # the real run
#   ./deploy-mainnet.sh check                  # re-run the post-deploy checks against the state file's addresses
#
# Env: KEEPER (required), BASE_RPC_URL (default https://mainnet.base.org; an archive or keyed RPC is better),
# STATE_FILE (default deployments/base-mainnet.json), ETHERSCAN_API_KEY (for --verify), and every optional knob of
# DeployMainnet.s.sol (FINAL_OWNER, PARTNER_ID, PARTNER_ADMIN, SEED_USDC, RESERVE_DEPOSIT, RESERVE_ALLOCATE,
# DESK_ADVANCE_CAP, AAVE_ADVANCE_CAP, ADVANCE_FEE_BPS, MIN_ETH). A re-run exports the state file's addresses so
# every component already deployed is reused; `--resume` additionally replays a broadcast forge left unfinished.
# The deployer key is read from MAINNET_DEPLOYER_KEY and never printed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$CONTRACTS/.." && pwd)"
MODE="${1:-plan}"
RESUME="${2:-}"
RPC="${BASE_RPC_URL:-https://mainnet.base.org}"
STATE_FILE="${STATE_FILE:-$REPO/deployments/base-mainnet.json}"
FORGE="${FORGE:-$HOME/.foundry/bin/base-forge}"
ANVIL="${ANVIL:-$HOME/.foundry/bin/base-anvil}"
if [[ ! -x "$FORGE" ]]; then
  echo "base-forge not found at $FORGE; falling back to forge (the gate's precompile reads will fail closed in checks)" >&2
  FORGE="$(command -v forge)"
fi
export FOUNDRY_BASE=true

die() { echo "deploy-mainnet: $*" >&2; exit 1; }

# Export the state file's addresses (KEY: "0x…") as env so DeployMainnet reuses them.
export_state() {
  [[ -f "$STATE_FILE" ]] || return 0
  echo "reusing addresses from $STATE_FILE"
  while IFS='=' read -r k v; do
    [[ -n "$k" && -z "${!k:-}" ]] && export "$k=$v"
  done < <(python3 -I -c 'import json,sys
d=json.load(open(sys.argv[1]))
for k,v in d.items():
    if isinstance(v,str) and v.startswith("0x") and len(v)==42 and int(v,16)!=0: print(f"{k}={v}")' "$STATE_FILE")
}

# Cut the JSON between the markers out of a forge log into the state file (atomic replace).
write_state() {
  local log="$1" out="$2"
  python3 -I -c 'import json,re,sys
text=open(sys.argv[1]).read()
m=re.search(r"BOUNDLINE-STATE-BEGIN\s*(\{.*?\})\s*BOUNDLINE-STATE-END", text, re.S)
if not m: sys.exit("no state block in the log")
block=re.sub(r"^\s+", "", m.group(1), flags=re.M)
state=json.loads(block)
tmp=sys.argv[2]+".tmp"; json.dump(state, open(tmp,"w"), indent=2); open(tmp,"a").write("\n")
import os; os.replace(tmp, sys.argv[2]); print("state written to", sys.argv[2])' "$log" "$out"
}

run_script() { # args: rpc, extra forge args…
  local rpc="$1"; shift
  (cd "$CONTRACTS" && "$FORGE" script script/DeployMainnet.s.sol --tc DeployMainnet --root "$CONTRACTS" \
    --rpc-url "$rpc" --skip 'test/**' "$@")
}

need_keeper() { [[ -n "${KEEPER:-}" ]] || die "KEEPER is required (the keeper Worker's mainnet signer)"; }

case "$MODE" in
  plan)
    export_state
    need_keeper
    chain="$(cast chain-id --rpc-url "$RPC")"; [[ "$chain" == "8453" ]] || die "RPC chain id is $chain, not 8453"
    run_script "$RPC" --sender "${SENDER:-0x000000000000000000000000000000000000dEaD}"
    ;;

  rehearse)
    need_keeper
    PORT="${ANVIL_PORT:-8611}"
    LOCAL="http://127.0.0.1:$PORT"
    SENDER="${SENDER:-0xB0D11E0000000000000000000000000000000D01}"
    WORK="$(mktemp -d -t boundline-rehearsal)"
    "$ANVIL" --fork-url "$RPC" --port "$PORT" --chain-id 8453 --auto-impersonate --silent > "$WORK/anvil.log" 2>&1 &
    ANVIL_PID=$!
    trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
    for _ in $(seq 1 60); do cast block-number --rpc-url "$LOCAL" >/dev/null 2>&1 && break; sleep 0.5; done
    echo "fork of Base mainnet at block $(cast block-number --rpc-url "$LOCAL") on $LOCAL"
    cast rpc --rpc-url "$LOCAL" anvil_setBalance "$SENDER" 0xDE0B6B3A7640000 >/dev/null
    # Broadcast records of a rehearsal must never land in contracts/broadcast (committed real deploys only).
    FOUNDRY_BROADCAST="$WORK/broadcast" STATE_FILE= run_script "$LOCAL" --broadcast --unlocked --sender "$SENDER" --slow \
      | tee "$WORK/forge.log"
    write_state "$WORK/forge.log" "$WORK/state.json"
    python3 -I "$HERE/DeployMainnet.cost.py" "$WORK/broadcast/DeployMainnet.s.sol/8453/run-latest.json" "$LOCAL" "$RPC"
    echo "rehearsal artefacts in $WORK"
    ;;

  broadcast)
    chain="$(cast chain-id --rpc-url "$RPC")"; [[ "$chain" == "8453" ]] || die "RPC chain id is $chain, not 8453"
    if [[ -n "${UNLOCKED_SENDER:-}" ]]; then
      # Testing the re-run path on a local fork only: an impersonated sender, records kept out of the repo.
      [[ "$RPC" == http://127.0.0.1:* || "$RPC" == http://localhost:* ]] || die "UNLOCKED_SENDER is for a local fork only"
      export FOUNDRY_BROADCAST="${FOUNDRY_BROADCAST:-$(mktemp -d -t boundline-fork-broadcast)}"
      extra=(--broadcast --slow --unlocked --sender "$UNLOCKED_SENDER")
    else
      [[ -n "${MAINNET_DEPLOYER_KEY:-}" ]] || die "MAINNET_DEPLOYER_KEY is required for a broadcast"
      extra=(--broadcast --slow --private-key "$MAINNET_DEPLOYER_KEY")
    fi
    export_state
    need_keeper
    LOG="$(mktemp -t boundline-mainnet-deploy)"
    [[ -n "${ETHERSCAN_API_KEY:-}" ]] && extra+=(--verify --etherscan-api-key "$ETHERSCAN_API_KEY")
    [[ "$RESUME" == "--resume" ]] && extra+=(--resume)
    run_script "$RPC" "${extra[@]}" | tee "$LOG"
    write_state "$LOG" "$STATE_FILE"
    echo "next: ./deploy-mainnet.sh check   (and acceptOwnership() from FINAL_OWNER when one was set)"
    ;;

  check)
    [[ -f "$STATE_FILE" ]] || die "no state file at $STATE_FILE"
    export_state
    run_script "$RPC" --sig "check()"
    ;;

  *) die "unknown mode $MODE (plan | rehearse | broadcast [--resume] | check)" ;;
esac
