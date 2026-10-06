#!/usr/bin/env bash
# Admit the protection stack to a Boundline test stock's Cobalt policies on Base Sepolia, as raw `cast` calls.
#
# After `wire-sepolia.sh` the stock's TRANSFER_RECEIVER_POLICY is INTERSECT(blocklist, holders allowlist) and its
# SEIZE_EXEMPT_POLICY is an allowlist of the venues. The Protector (receives seized collateral), the pre-liquidation
# contract and the mock pool (receives the collateral it buys) must be on both lists or every transfer to them
# reverts PolicyForbids inside Morpho. Both writes are `updateAllowlist(id, true, accounts)` from the policy admin;
# each is tried first as eth_call from the sender (the chain's own Cobalt precompiles run it) and aborts on a revert.
#
# Usage:
#   TOKEN=0xB200…4141 ACCOUNTS=<protector>,<preLiquidation>,<pool> DEPLOYER_KEY="$BOUNDLINE_TESTNET_DEPLOYER_KEY" \
#     contracts/script/wire-protection-sepolia.sh            # writes
#   TOKEN=… ACCOUNTS=… SENDER=0x2f0d…2a4E contracts/script/wire-protection-sepolia.sh   # check only
#
# Env: TOKEN, ACCOUNTS (required); RPC_URL [https://sepolia.base.org]; ALLOWLIST_ID [the holders allowlist, read
#      as the composite's second child]; COMPOSITE_ID [token.policyId(TRANSFER_RECEIVER_POLICY)];
#      SEIZE_EXEMPT_ID [token.policyId(SEIZE_EXEMPT_POLICY)]; DEPLOYER_KEY or SENDER; CAST [cast].
set -euo pipefail

CAST="${CAST:-cast}"
RPC_URL="${RPC_URL:-https://sepolia.base.org}"
REGISTRY=0x8453000000000000000000000000000000000002
: "${TOKEN:?set TOKEN to the B20 test stock}"
: "${ACCOUNTS:?set ACCOUNTS to a comma-separated list: Protector, pre-liquidation contract, pool}"

if [[ -n "${DEPLOYER_KEY:-}" ]]; then
  MODE=send
  SENDER="${SENDER:-$("$CAST" wallet address --private-key "$DEPLOYER_KEY")}"
else
  MODE=check
  : "${SENDER:?set SENDER (the policy admin) for a check-only run, or DEPLOYER_KEY to write}"
fi

TRANSFER_RECEIVER_POLICY=$("$CAST" keccak TRANSFER_RECEIVER_POLICY)
SEIZE_EXEMPT_POLICY=$("$CAST" keccak SEIZE_EXEMPT_POLICY)
ACCOUNT_ARRAY="[${ACCOUNTS}]"

call() { "$CAST" call --rpc-url "$RPC_URL" "$@"; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
log() { printf '%s\n' "$*" >&2; }

check() {
  local what=$1; shift
  local out
  if ! out=$(call --from "$SENDER" "$@" 2>&1); then
    log "ABORT: $what would revert: $out"
    exit 1
  fi
  log "ok   $what${out:+ -> $out}"
}

send() {
  local what=$1; shift
  check "$what" "$@"
  [[ $MODE == send ]] || return 0
  local receipt status hash
  receipt=$("$CAST" send --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" --json "$@")
  status=$(printf '%s' "$receipt" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  hash=$(printf '%s' "$receipt" | python3 -c 'import json,sys; print(json.load(sys.stdin)["transactionHash"])')
  if [[ $status != 0x1 && $status != 1 ]]; then
    log "ABORT: $what failed on chain: $hash"
    exit 1
  fi
  log "sent $what: $hash"
  printf '%s\n' "$hash"
}

COMPOSITE_ID="${COMPOSITE_ID:-$(call "$TOKEN" 'policyId(bytes32)(uint64)' "$TRANSFER_RECEIVER_POLICY" | cut -d' ' -f1)}"
SEIZE_EXEMPT_ID="${SEIZE_EXEMPT_ID:-$(call "$TOKEN" 'policyId(bytes32)(uint64)' "$SEIZE_EXEMPT_POLICY" | cut -d' ' -f1)}"
[[ $(( COMPOSITE_ID >> 56 )) == 3 ]] || { log "ABORT: TRANSFER_RECEIVER_POLICY $COMPOSITE_ID is not an INTERSECT composite; run wire-sepolia.sh first"; exit 1; }
[[ $(( SEIZE_EXEMPT_ID >> 56 )) == 1 ]] || { log "ABORT: SEIZE_EXEMPT_POLICY $SEIZE_EXEMPT_ID is not an allowlist; run wire-sepolia.sh first"; exit 1; }
if [[ -z "${ALLOWLIST_ID:-}" ]]; then
  children=$(call "$REGISTRY" 'compositePolicyChildIds(uint64)(uint64[])' "$COMPOSITE_ID")
  # children prints like "[157, 72057594037928092 [7.205e16]]": the allowlist is the child whose top byte is 1
  ALLOWLIST_ID=$(printf '%s' "$children" | python3 -c '
import re, sys
ids = [int(x) for x in re.findall(r"\b\d+\b", sys.stdin.read()) if "." not in x]
print(next((i for i in ids if i >> 56 == 1), ""))')
fi
[[ -n "$ALLOWLIST_ID" ]] || { log "ABORT: no allowlist child found under composite $COMPOSITE_ID"; exit 1; }
log "mode=$MODE sender=$SENDER token=$TOKEN accounts=$ACCOUNT_ARRAY composite=$COMPOSITE_ID allowlist=$ALLOWLIST_ID seizeExempt=$SEIZE_EXEMPT_ID"

for id in "$ALLOWLIST_ID" "$SEIZE_EXEMPT_ID"; do
  admin=$(call "$REGISTRY" 'policyAdmin(uint64)(address)' "$id")
  [[ $(lower "$admin") == "$(lower "$SENDER")" ]] || { log "ABORT: policy $id is administered by $admin, not $SENDER"; exit 1; }
done

TX1=$(send "updateAllowlist($ALLOWLIST_ID, true, $ACCOUNT_ARRAY)" "$REGISTRY" 'updateAllowlist(uint64,bool,address[])' "$ALLOWLIST_ID" true "$ACCOUNT_ARRAY")
TX2=$(send "updateAllowlist($SEIZE_EXEMPT_ID, true, $ACCOUNT_ARRAY)" "$REGISTRY" 'updateAllowlist(uint64,bool,address[])' "$SEIZE_EXEMPT_ID" true "$ACCOUNT_ARRAY")
[[ $MODE == send ]] || { log "check complete: both writes would succeed from $SENDER"; exit 0; }

log "verifying"
IFS=',' read -r -a list <<< "$ACCOUNTS"
for a in "${list[@]}"; do
  [[ $(call "$REGISTRY" 'isAuthorized(uint64,address)(bool)' "$COMPOSITE_ID" "$a") == true ]] || { log "FAIL: $a cannot receive $TOKEN"; exit 1; }
  [[ $(call "$REGISTRY" 'isAuthorized(uint64,address)(bool)' "$SEIZE_EXEMPT_ID" "$a") == true ]] || { log "FAIL: $a is not seize-exempt"; exit 1; }
done
printf '{ "token": "%s", "allowlist": %s, "seizeExempt": %s, "allowlistTx": "%s", "seizeExemptTx": "%s" }\n' "$TOKEN" "$ALLOWLIST_ID" "$SEIZE_EXEMPT_ID" "$TX1" "$TX2"
