#!/usr/bin/env bash
# Cobalt wire step for one Boundline test stock on Base Sepolia, as raw `cast` calls.
#
# Does exactly what IssueTestStocks.wire(token, venues) does, without base-forge: that build simulates
# every script locally with Beryl precompiles, where createCompositePolicy reverts, so the Cobalt step
# can never be broadcast from it. `cast send` does not simulate; the chain's own precompiles run the
# calls. Before every write the same call is made as eth_call from the sender and the script aborts on
# a revert, because eth_call executes the live Cobalt precompiles too.
#
# Steps (admin = the account holding DEFAULT_ADMIN_ROLE on the token and the policy admin of both lists):
#   1. updateAllowlist(allowlistId, true, venues)                 venues may receive mints and transfers
#   2. createCompositePolicy(admin, INTERSECT, [blocklist, allowlist])
#   3. token.updatePolicy(TRANSFER_RECEIVER_POLICY, compositeId)  receivers = allowlisted and not blocked
#   4. createPolicyWithAccounts(admin, ALLOWLIST, venues)
#   5. token.updatePolicy(SEIZE_EXEMPT_POLICY, seizeExemptId)     venue balances are never seizable
#
# Usage:
#   TOKEN=0xB200…4141 VENUES=0xBBBB…FFCb,<desk>,<keeper> DEPLOYER_KEY="$BOUNDLINE_TESTNET_DEPLOYER_KEY" \
#     contracts/script/wire-sepolia.sh            # writes
#   TOKEN=… VENUES=… SENDER=0x2f0d…2a4E contracts/script/wire-sepolia.sh   # check only (no key): eth_calls
#
# Env: TOKEN (required), VENUES (required, comma-separated), RPC_URL [https://sepolia.base.org],
#      ALLOWLIST_ID [token.policyId(MINT_RECEIVER_POLICY)], BLOCKLIST_ID [token.policyId(TRANSFER_RECEIVER_POLICY)],
#      DEPLOYER_KEY (the admin key; when unset the script only checks), SENDER [derived from the key],
#      CAST [cast on PATH]. Never put a key literal on the command line; pass it through the environment.
set -euo pipefail

CAST="${CAST:-cast}"
RPC_URL="${RPC_URL:-https://sepolia.base.org}"
REGISTRY=0x8453000000000000000000000000000000000002
: "${TOKEN:?set TOKEN to the B20 test stock}"
: "${VENUES:?set VENUES to a comma-separated list, e.g. Morpho,desk,keeper}"

if [[ -n "${DEPLOYER_KEY:-}" ]]; then
  MODE=send
  SENDER="${SENDER:-$("$CAST" wallet address --private-key "$DEPLOYER_KEY")}"
else
  MODE=check
  : "${SENDER:?set SENDER (the admin address) for a check-only run, or DEPLOYER_KEY to write}"
fi

ALLOWLIST_TYPE=1   # IPolicyRegistry.PolicyType.ALLOWLIST
INTERSECT_TYPE=3   # IPolicyRegistry.PolicyType.INTERSECT
TRANSFER_RECEIVER_POLICY=$("$CAST" keccak TRANSFER_RECEIVER_POLICY)
MINT_RECEIVER_POLICY=$("$CAST" keccak MINT_RECEIVER_POLICY)
SEIZE_EXEMPT_POLICY=$("$CAST" keccak SEIZE_EXEMPT_POLICY)
POLICY_CREATED_TOPIC=$("$CAST" sig-event 'PolicyCreated(uint64,address,uint8)')
VENUE_ARRAY="[${VENUES}]"

call() { "$CAST" call --rpc-url "$RPC_URL" "$@"; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }   # macOS ships bash 3.2: no ${var,,}
log() { printf '%s\n' "$*" >&2; }

# eth_call from the sender; aborts on revert. Prints the decoded return value when a type is given.
check() {
  local what=$1; shift
  local out attempt
  # sepolia.base.org is load-balanced and its nodes trail each other by a few seconds: a policy created by the
  # previous send can be PolicyNotFound on the node that answers this eth_call. Retry before aborting
  # (6 Oct 2026: the NVDAt wire aborted on exactly that, with the policy already mined).
  for attempt in 1 2 3 4 5 6; do
    if out=$(call --from "$SENDER" "$@" 2>&1); then
      printf '%s\n' "$out"
      return 0
    fi
    log "retry $attempt/6: $what reverted on this node ($(printf '%s' "$out" | tail -1 | cut -c1-120)); waiting 4 s"
    sleep 4
  done
  log "ABORT: $what would revert: $out"
  exit 1
}

# Sends after a successful check. In check mode it stops after the eth_call. Prints the tx hash.
send() {
  local what=$1; shift
  check "$what" "$@" >/dev/null
  [[ $MODE == send ]] || return 0
  local receipt
  receipt=$("$CAST" send --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" --json "$@")
  LAST_RECEIPT="$receipt"
  local status hash
  status=$(printf '%s' "$receipt" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  hash=$(printf '%s' "$receipt" | python3 -c 'import json,sys; print(json.load(sys.stdin)["transactionHash"])')
  if [[ $status != 0x1 && $status != 1 ]]; then
    log "ABORT: $what failed on chain: $hash"
    exit 1
  fi
  log "sent $what: $hash"
}

# The id of the policy created in the last receipt (PolicyCreated topic 1), as a decimal.
created_id() {
  printf '%s' "$LAST_RECEIPT" | python3 -c '
import json, sys
r = json.load(sys.stdin)
topic = sys.argv[1].lower(); reg = sys.argv[2].lower()
ids = [int(l["topics"][1], 16) for l in r["logs"] if l["address"].lower() == reg and l["topics"][0].lower() == topic]
if not ids: sys.exit("no PolicyCreated log in the receipt")
print(ids[-1])' "$POLICY_CREATED_TOPIC" "$REGISTRY"
}

log "mode=$MODE sender=$SENDER token=$TOKEN venues=$VENUE_ARRAY rpc=$RPC_URL"

ALLOWLIST_ID="${ALLOWLIST_ID:-$(call "$TOKEN" 'policyId(bytes32)(uint64)' "$MINT_RECEIVER_POLICY" | cut -d' ' -f1)}"
BLOCKLIST_ID="${BLOCKLIST_ID:-$(call "$TOKEN" 'policyId(bytes32)(uint64)' "$TRANSFER_RECEIVER_POLICY" | cut -d' ' -f1)}"
log "allowlist=$ALLOWLIST_ID blocklist=$BLOCKLIST_ID"

# Preconditions: both lists exist, are ours, and have the expected type (top byte of the id).
for pair in "$ALLOWLIST_ID:$ALLOWLIST_TYPE:allowlist" "$BLOCKLIST_ID:0:blocklist"; do
  id=${pair%%:*}; rest=${pair#*:}; kind=${rest%%:*}; name=${rest#*:}
  [[ $id != 0 ]] || { log "ABORT: the $name id is 0 (ALWAYS_ALLOW sentinel); issue the stock with IssueTestStocks first"; exit 1; }
  [[ $(( id >> 56 )) == "$kind" ]] || { log "ABORT: $name id $id is not of type $kind"; exit 1; }
  [[ $(call "$REGISTRY" 'policyExists(uint64)(bool)' "$id") == true ]] || { log "ABORT: $name $id does not exist"; exit 1; }
  admin=$(call "$REGISTRY" 'policyAdmin(uint64)(address)' "$id")
  [[ $(lower "$admin") == "$(lower "$SENDER")" ]] || { log "ABORT: $name $id is administered by $admin, not $SENDER"; exit 1; }
done
[[ $(call "$TOKEN" 'hasRole(bytes32,address)(bool)' 0x0000000000000000000000000000000000000000000000000000000000000000 "$SENDER") == true ]] \
  || { log "ABORT: $SENDER does not hold DEFAULT_ADMIN_ROLE on $TOKEN"; exit 1; }

# 1. venues onto the holders allowlist
send "updateAllowlist($ALLOWLIST_ID, true, $VENUE_ARRAY)" "$REGISTRY" 'updateAllowlist(uint64,bool,address[])' "$ALLOWLIST_ID" true "$VENUE_ARRAY"

# 2. composite INTERSECT(blocklist, allowlist)
WOULD_BE=$(check "createCompositePolicy(INTERSECT, [$BLOCKLIST_ID,$ALLOWLIST_ID])" "$REGISTRY" 'createCompositePolicy(address,uint8,uint64[])(uint64)' "$SENDER" "$INTERSECT_TYPE" "[$BLOCKLIST_ID,$ALLOWLIST_ID]" | cut -d' ' -f1)
if [[ $MODE == send ]]; then
  send "createCompositePolicy" "$REGISTRY" 'createCompositePolicy(address,uint8,uint64[])' "$SENDER" "$INTERSECT_TYPE" "[$BLOCKLIST_ID,$ALLOWLIST_ID]"
  COMPOSITE_ID=$(created_id)
  log "composite id from the receipt: $COMPOSITE_ID (eth_call predicted $WOULD_BE)"
  # 3. bind it as the receiver policy
  send "token.updatePolicy(TRANSFER_RECEIVER_POLICY, $COMPOSITE_ID)" "$TOKEN" 'updatePolicy(bytes32,uint64)' "$TRANSFER_RECEIVER_POLICY" "$COMPOSITE_ID"
else
  log "check: composite would get id $WOULD_BE; probing the receiver scope by re-binding the existing blocklist"
  check "token.updatePolicy(TRANSFER_RECEIVER_POLICY, $BLOCKLIST_ID) [probe]" "$TOKEN" 'updatePolicy(bytes32,uint64)' "$TRANSFER_RECEIVER_POLICY" "$BLOCKLIST_ID" >/dev/null
fi

# 4. seize-exempt allowlist of the venues
SEIZE_WOULD_BE=$(check "createPolicyWithAccounts(ALLOWLIST, $VENUE_ARRAY)" "$REGISTRY" 'createPolicyWithAccounts(address,uint8,address[])(uint64)' "$SENDER" "$ALLOWLIST_TYPE" "$VENUE_ARRAY" | cut -d' ' -f1)
if [[ $MODE == send ]]; then
  send "createPolicyWithAccounts (seize-exempt)" "$REGISTRY" 'createPolicyWithAccounts(address,uint8,address[])' "$SENDER" "$ALLOWLIST_TYPE" "$VENUE_ARRAY"
  SEIZE_EXEMPT_ID=$(created_id)
  log "seize-exempt id from the receipt: $SEIZE_EXEMPT_ID (eth_call predicted $SEIZE_WOULD_BE)"
  # 5. bind it
  send "token.updatePolicy(SEIZE_EXEMPT_POLICY, $SEIZE_EXEMPT_ID)" "$TOKEN" 'updatePolicy(bytes32,uint64)' "$SEIZE_EXEMPT_POLICY" "$SEIZE_EXEMPT_ID"
else
  log "check: seize-exempt list would get id $SEIZE_WOULD_BE; probing the scope with the existing allowlist"
  check "token.updatePolicy(SEIZE_EXEMPT_POLICY, $ALLOWLIST_ID) [probe]" "$TOKEN" 'updatePolicy(bytes32,uint64)' "$SEIZE_EXEMPT_POLICY" "$ALLOWLIST_ID" >/dev/null
  log "check complete: every write would succeed from $SENDER"
  exit 0
fi

# Verification after the writes.
log "verifying"
bound=$(call "$TOKEN" 'policyId(bytes32)(uint64)' "$TRANSFER_RECEIVER_POLICY" | cut -d' ' -f1)
[[ $bound == "$COMPOSITE_ID" ]] || { log "FAIL: TRANSFER_RECEIVER_POLICY is $bound, expected $COMPOSITE_ID"; exit 1; }
bound=$(call "$TOKEN" 'policyId(bytes32)(uint64)' "$SEIZE_EXEMPT_POLICY" | cut -d' ' -f1)
[[ $bound == "$SEIZE_EXEMPT_ID" ]] || { log "FAIL: SEIZE_EXEMPT_POLICY is $bound, expected $SEIZE_EXEMPT_ID"; exit 1; }
log "children of $COMPOSITE_ID: $(call "$REGISTRY" 'compositePolicyChildIds(uint64)(uint64[])' "$COMPOSITE_ID")"
IFS=',' read -r -a venue_list <<< "$VENUES"
for v in "${venue_list[@]}"; do
  [[ $(call "$REGISTRY" 'isAuthorized(uint64,address)(bool)' "$COMPOSITE_ID" "$v") == true ]] || { log "FAIL: $v not authorized to receive"; exit 1; }
  [[ $(call "$REGISTRY" 'isAuthorized(uint64,address)(bool)' "$SEIZE_EXEMPT_ID" "$v") == true ]] || { log "FAIL: $v not seize-exempt"; exit 1; }
done
[[ $(call "$REGISTRY" 'isAuthorized(uint64,address)(bool)' "$COMPOSITE_ID" "$SENDER") == true ]] || { log "FAIL: the admin can no longer receive"; exit 1; }
[[ $(call "$REGISTRY" 'isAuthorized(uint64,address)(bool)' "$COMPOSITE_ID" 0x000000000000000000000000000000000000dEaD) == false ]] || { log "FAIL: a stranger can receive"; exit 1; }
printf '{ "token": "%s", "transferReceiverPolicy": %s, "seizeExemptPolicy": %s }\n' "$TOKEN" "$COMPOSITE_ID" "$SEIZE_EXEMPT_ID"
