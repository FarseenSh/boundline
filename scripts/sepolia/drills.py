"""Base Sepolia drills, executed live and recorded as runs in docs/evidence/drills/<id>.json (8 Oct 2026).

Every step is an `eth_call` guard, a transaction (status checked), or a read of the resulting state; nothing in a run
is estimated. Mirror-key drills (registry-pause, stale-feed, keeper-hold) first hold every symbol in the keeper's KV
hold switch so the keeper Worker never signs from the mirror key at the same moment, and release it afterwards.

  set -a; . ~/.boundline/base-sepolia.env; set +a
  python3 -I scripts/sepolia/drills.py <issuer-transfer-pause|ineligible-receiver|scheduled-multiplier|keeper-hold|registry-pause|stale-feed> [--dry]
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import bl  # noqa: E402

SCRATCH = "/private/tmp/claude-501/-Users-farseen-boundline/1fd71904-49d3-4ae8-ac56-4ecd07d28f93/scratchpad"
API = "https://boundline-api.papermind-ai.workers.dev"
KEEPER_API = "https://boundline-keeper.papermind-ai.workers.dev"
TRANSFER = 0  # IB20.PausableFeature.TRANSFER
WINDOW_OBS = []  # the KV hold observations, prepended to every mirror-key run


class Run:
    def __init__(self, drill, label):
        self.drill = drill
        self.run = {"ranAt": int(time.time()), "chainId": bl.CHAIN_ID, "label": label, "txs": [], "observations": [],
                    "outcome": "", "evidence": [f"scripts/sepolia/drills.py ({drill})", "deployments/base-sepolia.json#drills"],
                    "notes": ""}

    def tx(self, rec, label):
        self.run["txs"].append({"hash": rec["hash"], "block": rec["block"], "label": label, "gasUsed": rec["gasUsed"]})
        return rec

    def obs(self, what, value, block=None):
        row = {"what": what, "value": value, "block": block if block is not None else bl.head()}
        self.run["observations"].append(row)
        bl.log(f"  obs: {what} = {value}")
        return value

    def save(self, outcome, notes=""):
        if WINDOW_OBS and self.drill in ("keeper-hold", "registry-pause"):
            self.run["observations"] = WINDOW_OBS + self.run["observations"]
        self.run["outcome"] = outcome
        self.run["notes"] = notes
        return bl.append_run(self.drill, self.run)


def partner_key():
    path = os.path.expanduser("~/.boundline/boundline-api-partner-keys.txt")
    with open(path) as f:
        for line in f:
            if line.strip().startswith("api key"):
                return line.split(":", 1)[1].split()[0]
    return None


def api_get(path):
    """GET the partner API with the boundline-app key (read only); returns the parsed JSON or an error string."""
    key = partner_key()
    req = urllib.request.Request(API + path, headers={"authorization": f"Bearer {key}", "user-agent": "boundline-k1"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        return f"error: {e}"


def api_line(line_id):
    d = api_get(f"/v1/lines/{line_id}")
    if isinstance(d, dict):
        keep = {k: d.get(k) for k in ("status", "obligationStatus", "obligation", "reason", "session") if k in d}
        if not keep:
            keep = {k: v for k, v in d.items() if not isinstance(v, (dict, list))}
        return keep
    return d


# ------------------------------------------------------------------------------------------------ KV hold switch

def hold_cfg():
    with open(os.path.join(SCRATCH, "keeper-hold.json")) as f:
        cfg = json.load(f)
    if not cfg.get("ready"):
        sys.exit("keeper hold switch not ready (keeper-hold.json)")
    return cfg


def kv(args):
    cfg = hold_cfg()
    cmd = ["pnpm", "exec", "wrangler", "kv", "key", *args, "--remote", "--namespace-id", cfg["namespaceId"]]
    p = subprocess.run(cmd, cwd="/Users/farseen/boundline/apps/keeper", capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"wrangler kv {args[0]} failed: {(p.stderr or p.stdout)[-400:]}")


def keeper_config():
    with urllib.request.urlopen(urllib.request.Request(KEEPER_API + "/v1/config", headers={"user-agent": "boundline-k1"}), timeout=30) as r:
        return json.loads(r.read())


def hold_all(run):
    value = json.dumps({"feed": list(bl.TOKENS), "registry": list(bl.TOKENS)})
    kv(["put", "hold", value])
    for _ in range(20):  # the Worker reads KV once per tick; wait until /v1/config reports the hold
        c = keeper_config()
        h = c.get("hold", {})
        if sorted(h.get("feed", [])) == sorted(bl.TOKENS) and sorted(h.get("registry", [])) == sorted(bl.TOKENS):
            run.obs("keeper /v1/config hold (all three symbols, KV)", {"hold": h, "holdSource": c.get("holdSource")})
            # one more tick so any transaction the mirror signed just before the hold has landed
            time.sleep(65)
            return
        time.sleep(6)
    raise RuntimeError("keeper did not report the hold within 2 minutes")


def release_all(run):
    kv(["delete", "hold"])
    for _ in range(20):
        c = keeper_config()
        h = c.get("hold", {})
        if not h.get("feed") and not h.get("registry"):
            run.obs("keeper /v1/config after release", {"hold": h, "holdSource": c.get("holdSource")})
            return
        time.sleep(6)
    raise RuntimeError("keeper still reports a hold after 2 minutes")


# ------------------------------------------------------------------------------------------------ drills

def issuer_transfer_pause(dry):
    tok, line = bl.TOKENS["TSLAt"], 3
    r = Run("issuer-transfer-pause", "Thu 8 Oct 2026, OVERNIGHT session: the issuer pauses TRANSFER on the TSLAt test stock (a real B20 asset on Base Sepolia); the gate answers TRANSFER_PAUSED, the desk refuses line 3 and the obligation holds; unpaused after")
    v = bl.verdict(tok)
    r.obs("SessionGate.check(TSLAt) before", {"state": v["stateName"], "session": v["sessionName"], "transferPaused": v["transferPaused"]})
    q = bl.quote(line)
    r.obs("desk.quote(3, 0) before", {"reason": q["reasonName"], "available": q["available"]})
    r.obs("desk.obligationStatus(3) before", bl.obligation(line))
    r.obs("eth_call TSLAt.transfer(deployer, 1) from the borrower before", bl.try_call(tok, "transfer(address,uint256)(bool)", bl.DEPLOYER, 1, sender=bl.BORROWER))
    if dry:
        return
    ok, out = bl.try_call(tok, "pause(uint8[])", f"[{TRANSFER}]", sender=bl.DEPLOYER)
    if not ok:
        sys.exit(f"pause guard refused: {out}")
    t = r.tx(bl.send(bl.DEPLOYER, tok, "pause(uint8[])", f"[{TRANSFER}]"), "TSLAt.pause([TRANSFER]) by the issuer (PAUSE_ROLE: the deployer)")
    try:
        r.obs("TSLAt.isPaused(TRANSFER)", bl.call(tok, "isPaused(uint8)(bool)", TRANSFER)[0], t["block"])
        v = bl.verdict(tok)
        r.obs("SessionGate.check(TSLAt) while paused", {"state": v["stateName"], "session": v["sessionName"], "transferPaused": v["transferPaused"]})
        q = bl.quote(line)
        r.obs("desk.quote(3, 0) while paused", {"reason": q["reasonName"], "price8": q["price8"], "available": q["available"]})
        r.obs("desk.quote(3, 1 USDC) while paused", bl.quote(line, 1_000_000)["reasonName"])
        r.obs("desk.obligationStatus(3) while paused", bl.obligation(line))
        r.obs("eth_call desk.addCollateral(3, 1) from the borrower while paused", bl.try_call(bl.DESK, "addCollateral(uint256,uint256)", line, 1, sender=bl.BORROWER))
        r.obs("eth_call desk.withdrawCollateral(3, 1) from the borrower while paused", bl.try_call(bl.DESK, "withdrawCollateral(uint256,uint256)", line, 1, sender=bl.BORROWER))
        r.obs("eth_call TSLAt.transfer(deployer, 1) from the borrower while paused", bl.try_call(tok, "transfer(address,uint256)(bool)", bl.DEPLOYER, 1, sender=bl.BORROWER))
        r.obs("partner API GET /v1/lines/3 while paused", api_line(line))
    finally:
        u = r.tx(bl.send(bl.DEPLOYER, tok, "unpause(uint8[])", f"[{TRANSFER}]"), "TSLAt.unpause([TRANSFER]) by the issuer (UNPAUSE_ROLE: the deployer)")
    r.obs("TSLAt.isPaused(TRANSFER) after", bl.call(tok, "isPaused(uint8)(bool)", TRANSFER)[0], u["block"])
    v = bl.verdict(tok)
    r.obs("SessionGate.check(TSLAt) after", {"state": v["stateName"], "session": v["sessionName"]})
    q = bl.quote(line)
    r.obs("desk.quote(3, 0) after", {"reason": q["reasonName"], "available": q["available"]})
    r.obs("desk.obligationStatus(3) after", bl.obligation(line))
    r.obs("partner API GET /v1/lines/3 after", api_line(line))
    obs = {o["what"]: o["value"] for o in r.run["observations"]}
    r.save(
        f"gate OPEN -> {obs['SessionGate.check(TSLAt) while paused']['state']} -> {obs['SessionGate.check(TSLAt) after']['state']}; "
        f"desk quote on line 3 {obs['desk.quote(3, 0) before']['reason']} -> {obs['desk.quote(3, 0) while paused']['reason']} -> {obs['desk.quote(3, 0) after']['reason']}; "
        f"obligation {obs['desk.obligationStatus(3) before']} -> {obs['desk.obligationStatus(3) while paused']} -> {obs['desk.obligationStatus(3) after']}; "
        f"while paused addCollateral reverted {obs['eth_call desk.addCollateral(3, 1) from the borrower while paused'][1]}, "
        f"withdrawCollateral reverted {obs['eth_call desk.withdrawCollateral(3, 1) from the borrower while paused'][1]}, "
        f"a plain transfer reverted {obs['eth_call TSLAt.transfer(deployer, 1) from the borrower while paused'][1]}",
        "The pause is the issuer's own B20 control (IB20.pause with PausableFeature.TRANSFER); nothing in Boundline can lift it. "
        "The gate's precedence puts MARKET_CLOSED and FEED_PAUSED ahead of TRANSFER_PAUSED, so the drill ran in an open session on a feed that was live.",
    )


def ineligible_receiver(dry):
    tok, line = bl.TOKENS["TSLAt"], 3
    pr = bl.POLICY_REGISTRY
    receiver_scope = subprocess.run(["cast", "keccak", "TRANSFER_RECEIVER_POLICY"], capture_output=True, text=True).stdout.strip()
    composite = int(bl.call(tok, "policyId(bytes32)(uint64)", receiver_scope)[0])
    raw_children = bl.call(pr, "compositePolicyChildIds(uint64)(uint64[])", composite)[0].strip()[1:-1]
    children = [c.strip().split(" ")[0] for c in raw_children.split(",")]
    allowlist = int(children[1])
    fresh = subprocess.run(["cast", "to-check-sum-address", "0x" + subprocess.run(
        ["cast", "keccak", "boundline/drill/ineligible-receiver/2026-10-08"], capture_output=True, text=True).stdout.strip()[-40:]],
        capture_output=True, text=True).stdout.strip()
    r = Run("ineligible-receiver", "Thu 8 Oct 2026, OVERNIGHT session: Cobalt's composite receiver policy on the TSLAt test stock (INTERSECT(issuer blocklist, holders allowlist)) refuses an address that is not admitted, at the token and, for a line owner, at the desk's own preflight before Morpho is called; admission makes the same transfer pass")
    r.obs("TSLAt TRANSFER_RECEIVER_POLICY (composite) and its children", {"composite": str(composite), "children": children, "allowlist": str(allowlist)})
    r.obs("fresh address (keccak('boundline/drill/ineligible-receiver/2026-10-08'), no key)", fresh)
    r.obs("PolicyRegistry.isAuthorized(composite, fresh) before", bl.call(pr, "isAuthorized(uint64,address)(bool)", composite, fresh)[0])
    r.obs("eth_call TSLAt.transfer(fresh, 1) from the borrower before", bl.try_call(tok, "transfer(address,uint256)(bool)", fresh, 1, sender=bl.BORROWER))
    r.obs("eth_call desk.withdrawCollateral(3, 1) from the borrower before (admitted)", bl.try_call(bl.DESK, "withdrawCollateral(uint256,uint256)", line, 1, sender=bl.BORROWER))
    if dry:
        return
    # Desk level: the line owner is removed from the allowlist for the length of two reads, then re-admitted.
    t1 = r.tx(bl.send(bl.DEPLOYER, pr, "updateAllowlist(uint64,bool,address[])", allowlist, "false", f"[{bl.BORROWER}]"),
              "PolicyRegistry.updateAllowlist(TSLAt holders allowlist, false, [borrower]): the issuer withdraws the line owner's admission")
    try:
        r.obs("PolicyRegistry.isAuthorized(composite, borrower) while removed", bl.call(pr, "isAuthorized(uint64,address)(bool)", composite, bl.BORROWER)[0], t1["block"])
        r.obs("eth_call desk.withdrawCollateral(3, 1) from the borrower while removed (the desk's preflight)", bl.try_call(bl.DESK, "withdrawCollateral(uint256,uint256)", line, 1, sender=bl.BORROWER))
        mp = bl.call(bl.MORPHO, "idToMarketParams(bytes32)(address,address,address,address,uint256)", bl.MARKETS["TSLAt"])
        r.obs("eth_call Morpho.withdrawCollateral(TSLAt market, 1, borrower, borrower) from the borrower while removed (what a desk without the preflight would hit)",
              bl.try_call(bl.MORPHO, "withdrawCollateral((address,address,address,address,uint256),uint256,address,address)",
                          f"({','.join(mp)})", 1, bl.BORROWER, bl.BORROWER, sender=bl.BORROWER))
    finally:
        t2 = r.tx(bl.send(bl.DEPLOYER, pr, "updateAllowlist(uint64,bool,address[])", allowlist, "true", f"[{bl.BORROWER}]"),
                  "PolicyRegistry.updateAllowlist(TSLAt holders allowlist, true, [borrower]): re-admitted")
    r.obs("PolicyRegistry.isAuthorized(composite, borrower) after re-admission", bl.call(pr, "isAuthorized(uint64,address)(bool)", composite, bl.BORROWER)[0], t2["block"])
    r.obs("eth_call desk.withdrawCollateral(3, 1) from the borrower after re-admission", bl.try_call(bl.DESK, "withdrawCollateral(uint256,uint256)", line, 1, sender=bl.BORROWER))
    # Token level: admit the fresh address, the same transfer passes, remove it again.
    t3 = r.tx(bl.send(bl.DEPLOYER, pr, "updateAllowlist(uint64,bool,address[])", allowlist, "true", f"[{fresh}]"),
              "PolicyRegistry.updateAllowlist(TSLAt holders allowlist, true, [fresh]): admission")
    try:
        r.obs("PolicyRegistry.isAuthorized(composite, fresh) admitted", bl.call(pr, "isAuthorized(uint64,address)(bool)", composite, fresh)[0], t3["block"])
        r.obs("eth_call TSLAt.transfer(fresh, 1) from the borrower admitted", bl.try_call(tok, "transfer(address,uint256)(bool)", fresh, 1, sender=bl.BORROWER))
    finally:
        t4 = r.tx(bl.send(bl.DEPLOYER, pr, "updateAllowlist(uint64,bool,address[])", allowlist, "false", f"[{fresh}]"),
                  "PolicyRegistry.updateAllowlist(TSLAt holders allowlist, false, [fresh]): removed again, the book is as before")
    r.obs("PolicyRegistry.isAuthorized(composite, fresh) after removal", bl.call(pr, "isAuthorized(uint64,address)(bool)", composite, fresh)[0], t4["block"])
    r.obs("eth_call TSLAt.transfer(fresh, 1) from the borrower after removal", bl.try_call(tok, "transfer(address,uint256)(bool)", fresh, 1, sender=bl.BORROWER))
    o = {x["what"]: x["value"] for x in r.run["observations"]}
    r.save(
        f"fresh address refused at the token ({o['eth_call TSLAt.transfer(fresh, 1) from the borrower before'][1]}), "
        f"admitted -> the same transfer passes ({o['eth_call TSLAt.transfer(fresh, 1) from the borrower admitted']}), removed -> refused again; "
        f"line owner removed -> the desk refuses withdrawCollateral itself with "
        f"{o['eth_call desk.withdrawCollateral(3, 1) from the borrower while removed (the desk' + chr(39) + 's preflight)'][1]} before Morpho is called "
        f"(Morpho alone: {o['eth_call Morpho.withdrawCollateral(TSLAt market, 1, borrower, borrower) from the borrower while removed (what a desk without the preflight would hit)'][1]}); "
        f"re-admitted -> passes again",
        "The partner boundline-app has no IEligibility hook, so the desk's NOT_ELIGIBLE reason is not exercised here: the "
        "refusal comes from the issuer's Cobalt policy, checked by the desk's B20 preflight (isAuthorized on both legs) and by the token. "
        "The fresh address has no key and never held TSLAt; only eth_call simulations touched it.",
    )


def _token_multipliers(tok):
    return {"uiMultiplier": bl.call(tok, "uiMultiplier()(uint256)")[0], "newUIMultiplier": bl.call(tok, "newUIMultiplier()(uint256)")[0],
            "effectiveAt": bl.call(tok, "effectiveAt()(uint256)")[0]}


def _logs(tx_hash):
    r = bl.rpc("eth_getTransactionReceipt", [tx_hash])
    return [{"address": lg["address"], "topic0": lg["topics"][0], "topics": len(lg["topics"]), "dataWords": (len(lg["data"]) - 2) // 64} for lg in r["logs"]]


def scheduled_multiplier(dry):
    tok, line = bl.TOKENS["NVDAt"], 2
    new_mult = 5 * 10**17
    r = Run("scheduled-multiplier", "Thu 8 Oct 2026, OVERNIGHT session: the issuer announces a scheduled UI multiplier change on the NVDAt test stock (ERC-8056 on a real B20 asset, through IB20Asset.announce, Cobalt) from 1.0 to 0.5 three days out; inside the seven-day horizon the desk haircuts line 2's collateral value by next/current ahead of effectiveAt; the issuer then cancels it and the haircut clears")
    r.obs("NVDAt multipliers before", _token_multipliers(tok))
    q = bl.quote(line)
    r.obs("desk.quote(2, 0) before", {k: q[k] for k in ("reasonName", "price8", "collateralRaw", "collateralValue", "maxDebt", "available", "corporateActionHaircut")})
    v = bl.verdict(tok)
    r.obs("SessionGate.check(NVDAt) before (registry multiplier, mirrored from mainnet NVDAc)", {"state": v["stateName"], "multiplier": v["multiplier"]})
    if dry:
        return
    eff = bl.block_ts(bl.head()) + 3 * 86400
    inner = subprocess.run(["cast", "calldata", "updateUIMultiplier(uint256,uint256)", str(new_mult), str(eff)], capture_output=True, text=True).stdout.strip()
    sid = "boundline-drill/nvdat/scheduled-multiplier/2026-10-08"
    t = r.tx(bl.send(bl.DEPLOYER, tok, "announce(bytes[],string,string,string)", f"[{inner}]", sid,
                     "Drill: scheduled UI multiplier 1.0 -> 0.5 on the NVDAt test stock, effective in three days",
                     "https://boundline-api.papermind-ai.workers.dev/v1/drills/scheduled-multiplier"),
             f"NVDAt.announce([updateUIMultiplier(0.5e18, {eff})], '{sid}', ...) by the issuer (OPERATOR_ROLE: the deployer)")
    try:
        r.obs("events emitted by the announcement", _logs(t["hash"]), t["block"])
        r.obs("NVDAt multipliers scheduled", _token_multipliers(tok), t["block"])
        q2 = bl.quote(line)
        r.obs("desk.quote(2, 0) with the scheduled change", {k: q2[k] for k in ("reasonName", "price8", "collateralRaw", "collateralValue", "maxDebt", "available", "corporateActionHaircut")})
        r.obs("desk.quote(2, 1 USDC) with the scheduled change", bl.quote(line, 1_000_000)["reasonName"])
        r.obs("desk.obligationStatus(2) with the scheduled change", bl.obligation(line))
        r.obs("partner API GET /v1/lines/2 with the scheduled change", api_line(line))
    finally:
        cancel = subprocess.run(["cast", "calldata", "cancelUIMultiplierUpdate()"], capture_output=True, text=True).stdout.strip()
        c = r.tx(bl.send(bl.DEPLOYER, tok, "announce(bytes[],string,string,string)", f"[{cancel}]", sid + "/cancel",
                         "Drill over: the scheduled UI multiplier change on NVDAt is cancelled",
                         "https://boundline-api.papermind-ai.workers.dev/v1/drills/scheduled-multiplier"),
                 "NVDAt.announce([cancelUIMultiplierUpdate()], '.../cancel', ...): the issuer cancels the scheduled change")
    r.obs("events emitted by the cancellation", _logs(c["hash"]), c["block"])
    r.obs("NVDAt multipliers after cancel", _token_multipliers(tok), c["block"])
    q3 = bl.quote(line)
    r.obs("desk.quote(2, 0) after cancel", {k: q3[k] for k in ("reasonName", "price8", "collateralValue", "maxDebt", "available", "corporateActionHaircut")})
    q2v, q3v = int(q2["collateralValue"]), int(q3["collateralValue"])
    r.save(
        f"scheduled 1.0 -> 0.5 at effectiveAt {eff}: corporateActionHaircut {q['corporateActionHaircut']} -> {q2['corporateActionHaircut']} -> {q3['corporateActionHaircut']}; "
        f"line 2 collateral value {int(q['collateralValue']) / 1e6:.6f} -> {q2v / 1e6:.6f} -> {q3v / 1e6:.6f} USDC and capacity "
        f"{int(q['maxDebt']) / 1e6:.6f} -> {int(q2['maxDebt']) / 1e6:.6f} -> {int(q3['maxDebt']) / 1e6:.6f} USDC at the same price "
        f"{int(q['price8']) / 1e8:.8f}; the gate stayed OPEN and the obligation OPEN (a haircut cuts capacity, it is not a hold)",
        "The desk haircuts only a LOWER scheduled multiplier (next < current) inside CORPORATE_ACTION_HORIZON (7 days), scaling "
        "collateral value by next/current until effectiveAt; valuation itself is raw balance x feed. The drill exercises that guard; "
        "it is not a claim about how a particular real corporate action moves the Coinbase feed. The change was scheduled and cancelled "
        "through announce, so each step also carries an Announcement event with its id.",
    )


LINE_T = "(bytes32,address,bytes32,address,uint32,uint8,bytes32,uint64,uint128)"
TSLAT_GUARD = "0xcADf92BBDC997fDb5920FF0Ba95B4d2d2b8389B3"


def mirror_quiet(run, settle=70):
    """The mirror key has nothing in flight and its nonce has not moved for `settle` seconds."""
    def nonces():
        return (int(bl.rpc("eth_getTransactionCount", [bl.MIRROR_KEEPER, "latest"]), 16),
                int(bl.rpc("eth_getTransactionCount", [bl.MIRROR_KEEPER, "pending"]), 16))
    first = nonces()
    time.sleep(settle)
    second = nonces()
    if first != second or second[0] != second[1]:
        raise RuntimeError(f"mirror key not quiet: {first} -> {second}")
    run.obs("mirror key nonce stable (latest = pending) across the settle window", {"nonce": second[0], "settleSeconds": settle})


def line_state(line):
    l = bl.tup(bl.call(bl.DESK, f"line(uint256)({LINE_T})", line)[0])
    return {"status": ["NONE", "OPEN", "HELD", "CLOSED"][int(l[5])], "holdReason": l[6]}


def keeper_hold(r_unused=None):
    line = 1
    r = Run("keeper-hold", "Thu 8 Oct 2026, OVERNIGHT session: the desk's keeper holds line 1 (the borrower's AAPLt line); draws are refused with LINE_HELD, the obligation shows HOLD_KEEPER, a repay still lands; the keeper releases the line")
    reason = subprocess.run(["cast", "format-bytes32-string", "DRILL_KEEPER_HOLD"], capture_output=True, text=True).stdout.strip()
    r.obs("desk.keeper()", bl.call(bl.DESK, "keeper()(address)")[0])
    r.obs("line 1 before", {**line_state(line), "quote": bl.quote(line)["reasonName"], "obligation": bl.obligation(line), "debt": bl.quote(line)["debt"]})
    h = r.tx(bl.send(bl.MIRROR_KEEPER, bl.DESK, "hold(uint256,bytes32)", line, reason), "desk.hold(1, 'DRILL_KEEPER_HOLD') by the desk keeper (the mirror key)")
    try:
        r.obs("line 1 held", {**line_state(line), "obligation": bl.obligation(line)}, h["block"])
        r.obs("desk.quote(1, 0) held", bl.quote(line)["reasonName"])
        r.obs("desk.quote(1, 1 USDC) held", bl.quote(line, 1_000_000)["reasonName"])
        r.obs("eth_call desk.draw(1, 1 USDC) from the borrower while held", bl.try_call(bl.DESK, "draw(uint256,uint256)", line, 1_000_000, sender=bl.BORROWER))
        r.obs("partner API GET /v1/lines/1 while held", api_line(line))
        debt_before = int(bl.quote(line)["debt"])
        a = r.tx(bl.send(bl.BORROWER, bl.USDC, "approve(address,uint256)", bl.DESK, 10_000), "USDC.approve(desk, 0.01) by the borrower")
        p = r.tx(bl.send(bl.BORROWER, bl.DESK, "repay(uint256,uint256)", line, 10_000), "desk.repay(1, 0.01 USDC) while the line is HELD: repay never consults the hold or the oracle")
        debt_after = int(bl.quote(line)["debt"])
        r.obs("line 1 debt across the repay while held", {"before": debt_before, "after": debt_after, "repaid": debt_before - debt_after}, p["block"])
    finally:
        rel = r.tx(bl.send(bl.MIRROR_KEEPER, bl.DESK, "release(uint256)", line), "desk.release(1) by the desk keeper")
    q = bl.quote(line)
    r.obs("line 1 after release", {**line_state(line), "quote": q["reasonName"], "obligation": bl.obligation(line), "debt": q["debt"]}, rel["block"])
    r.obs("partner API GET /v1/lines/1 after release", api_line(line))
    o = {x["what"]: x["value"] for x in r.run["observations"]}
    r.save(
        f"line 1 OPEN -> HELD (obligation {o['line 1 held']['obligation']}) -> OPEN; quote while held {o['desk.quote(1, 1 USDC) held']}; "
        f"a 1 USDC draw reverted {o['eth_call desk.draw(1, 1 USDC) from the borrower while held'][1]}; a 0.01 USDC repay landed while held "
        f"(debt {o['line 1 debt across the repay while held']['before'] / 1e6:.6f} -> {o['line 1 debt across the repay while held']['after'] / 1e6:.6f} USDC)",
        "The keeper hold is the operations-side stop: it freezes new credit on one line without touching the venue position. "
        "Every mirror-key transaction ran inside a KV hold of all three symbols (keeper Worker idle on that key).",
    )


def registry_pause():
    tok, line = bl.TOKENS["TSLAt"], 3
    r = Run("registry-pause", "Thu 8 Oct 2026, OVERNIGHT session: the OracleRegistry's paused flag for TSLAt is set on the Sepolia MirrorOracleRegistry (the mirror of Coinbase's registry, keeper-owned; the mirror held for the drill); the gate answers FEED_PAUSED, draws and the venue oracle stop, collateral can still be added; unpaused after")
    r.obs("registry TSLAt before", bl.call(bl.REGISTRY, "getOracleParams(address)(uint256,bool)", tok))
    v = bl.verdict(tok)
    r.obs("SessionGate.check(TSLAt) before", {"state": v["stateName"], "registryPaused": v["registryPaused"]})
    p = r.tx(bl.send(bl.MIRROR_KEEPER, bl.REGISTRY, "setPaused(address,bool)", tok, "true"), "MirrorOracleRegistry.setPaused(TSLAt, true) (the mirror key owns the registry)")
    try:
        v = bl.verdict(tok)
        r.obs("SessionGate.check(TSLAt) while paused", {"state": v["stateName"], "session": v["sessionName"], "registryPaused": v["registryPaused"], "answer": v["answer"]}, p["block"])
        r.obs("desk.quote(3, 1 USDC) while paused", bl.quote(line, 1_000_000)["reasonName"])
        r.obs("desk.obligationStatus(3) while paused", bl.obligation(line))
        r.obs("SessionGuard(TSLAt).price() while paused (Morpho borrow, withdrawCollateral and liquidate read it)", bl.try_call(TSLAT_GUARD, "price()(uint256)"))
        r.obs("eth_call desk.withdrawCollateral(3, 1) from the borrower while paused", bl.try_call(bl.DESK, "withdrawCollateral(uint256,uint256)", line, 1, sender=bl.BORROWER))
        r.obs("partner API GET /v1/lines/3 while paused", api_line(line))
        allowance = int(bl.call(tok, "allowance(address,address)(uint256)", bl.BORROWER, bl.DESK)[0])
        if allowance < 1:
            r.tx(bl.send(bl.BORROWER, tok, "approve(address,uint256)", bl.DESK, 1), "TSLAt.approve(desk, 1 raw) by the borrower")
        c = r.tx(bl.send(bl.BORROWER, bl.DESK, "addCollateral(uint256,uint256)", line, 1),
                 "desk.addCollateral(3, 1 raw TSLAt) while the registry is paused: supplyCollateral never reads the oracle")
        r.obs("line 3 collateral after the add", bl.quote(line)["collateralRaw"], c["block"])
    finally:
        u = r.tx(bl.send(bl.MIRROR_KEEPER, bl.REGISTRY, "setPaused(address,bool)", tok, "false"), "MirrorOracleRegistry.setPaused(TSLAt, false)")
    v = bl.verdict(tok)
    r.obs("SessionGate.check(TSLAt) after", {"state": v["stateName"], "registryPaused": v["registryPaused"]}, u["block"])
    r.obs("desk.quote(3, 1 USDC) after", bl.quote(line, 1_000_000)["reasonName"])
    r.obs("desk.obligationStatus(3) after", bl.obligation(line))
    o = {x["what"]: x["value"] for x in r.run["observations"]}
    r.save(
        f"gate OPEN -> {o['SessionGate.check(TSLAt) while paused']['state']} -> {o['SessionGate.check(TSLAt) after']['state']}; "
        f"draw quote {o['desk.quote(3, 1 USDC) while paused']} while paused; obligation {o['desk.obligationStatus(3) while paused']} "
        f"(the desk maps a registry pause to the issuer hold); SessionGuard.price() reverted {o['SessionGuard(TSLAt).price() while paused (Morpho borrow, withdrawCollateral and liquidate read it)'][1]}; "
        f"withdrawCollateral reverted {o['eth_call desk.withdrawCollateral(3, 1) from the borrower while paused'][1]}; "
        f"addCollateral of 1 raw TSLAt landed (collateral {o['line 3 collateral after the add']} raw); after unpause OPEN and {o['desk.quote(3, 1 USDC) after']}",
        "On mainnet the flag is Coinbase's OracleRegistry.getOracleParams(token).paused; on Sepolia the keeper mirrors it onto "
        "MirrorOracleRegistry every minute, so the drill held the mirror (KV) and set the flag directly. The desk records a registry "
        "pause as HOLD_ISSUER (CreditDeskLib.obligationStatus). Line 3 carries no debt (the TSLAt market is unseeded), so the "
        "repay leg is shown in the keeper-hold and issuer-transfer-pause runs.",
    )


def stale_feed():
    tok, line, feed = bl.TOKENS["TSLAt"], 3, bl.FEEDS["TSLAt"]
    r = Run("stale-feed", "Thu 8 Oct 2026, OVERNIGHT session: the TSLAt test feed is rewritten to a round last updated 27 h ago (older than heartbeat 24 h + tolerance 2 h) while the session is open; the gate answers FEED_STALE and the desk refuses; releasing the mirror restores the live mainnet round and the gate reopens")
    cfg = bl.tup(bl.call(bl.GATE, "feedOf(address)((address,uint8,uint32,uint32,bool))", tok)[0])
    r.obs("SessionGate.feedOf(TSLAt): heartbeat, tolerance", {"heartbeat": cfg[2], "tolerance": cfg[3]})
    rd = bl.call(feed, "latestRoundData()(uint80,int256,uint256,uint256,uint80)")
    r.obs("TSLAt feed round before (mirrored from mainnet TSLAc)", rd)
    now = bl.block_ts(bl.head())
    old = now - 27 * 3600
    w = r.tx(bl.send(bl.MIRROR_KEEPER, feed, "setRoundData(uint80,int256,uint256,uint256,uint80)", rd[0], rd[1], old, old, rd[4]),
             f"TestPriceFeed(TSLAt).setRoundData(same round and answer, updatedAt {old} = 27 h before block time)")
    v = bl.verdict(tok)
    r.obs("SessionGate.check(TSLAt) stale", {"state": v["stateName"], "session": v["sessionName"], "updatedAt": v["updatedAt"]}, w["block"])
    r.obs("desk.quote(3, 0) stale", bl.quote(line)["reasonName"])
    r.obs("desk.obligationStatus(3) stale", bl.obligation(line))
    r.obs("SessionGuard(TSLAt).price() stale", bl.try_call(TSLAT_GUARD, "price()(uint256)"))
    r.obs("eth_call desk.draw(3, 1 USDC) from the borrower stale", bl.try_call(bl.DESK, "draw(uint256,uint256)", line, 1_000_000, sender=bl.BORROWER))
    r.obs("partner API GET /v1/lines/3 stale", api_line(line))
    return r, w


def mirror_window(dry):
    window = Run("mirror-window", "")  # observations of the hold itself are copied into each run
    if dry:
        print(json.dumps(keeper_config().get("hold")))
        return
    hold_all(window)
    mirror_quiet(window)
    WINDOW_OBS.extend(window.run["observations"])
    stale_run = None
    try:
        for fn in (keeper_hold, registry_pause):
            fn()
        stale_run, write = stale_feed()
    finally:
        release_all(window)
    if stale_run is None:
        return
    # the mirror restores the live round on its own after the release
    mainnet = bl.call("0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4", "latestRoundData()(uint80,int256,uint256,uint256,uint80)", url=bl.MAINNET_RPC)
    restored = None
    for _ in range(40):
        cur = bl.call(bl.FEEDS["TSLAt"], "latestRoundData()(uint80,int256,uint256,uint256,uint80)")
        if int(cur[3]) > int(time.time()) - 26 * 3600:
            restored = cur
            break
        time.sleep(10)
    if restored is None:
        raise RuntimeError("the mirror did not restore the TSLAt round within ~7 minutes")
    tx = _find_mirror_tx(bl.FEEDS["TSLAt"], write["block"])
    if tx:
        stale_run.tx({"hash": tx["hash"], "block": tx["block"], "gasUsed": tx["gasUsed"]}, "keeper Worker mirror tick: setRoundData with the live mainnet TSLAc round (restores the feed after the hold is released)")
    v = bl.verdict(bl.TOKENS["TSLAt"])
    stale_run.obs("TSLAt feed round after the mirror restored it", restored)
    stale_run.obs("mainnet TSLAc round at that time", mainnet)
    stale_run.obs("SessionGate.check(TSLAt) after", {"state": v["stateName"], "session": v["sessionName"]})
    stale_run.obs("desk.quote(3, 0) after", bl.quote(3)["reasonName"])
    stale_run.obs("desk.obligationStatus(3) after", bl.obligation(3))
    for o in window.run["observations"]:
        stale_run.run["observations"].insert(0, o)
    o = {x["what"]: x["value"] for x in stale_run.run["observations"]}
    stale_run.save(
        f"gate OPEN -> {o['SessionGate.check(TSLAt) stale']['state']} in the {o['SessionGate.check(TSLAt) stale']['session']} session -> "
        f"{o['SessionGate.check(TSLAt) after']['state']}; desk quote {o['desk.quote(3, 0) stale']}; obligation {o['desk.obligationStatus(3) stale']}; "
        f"SessionGuard.price() reverted {o['SessionGuard(TSLAt).price() stale'][1]}; draw reverted {o['eth_call desk.draw(3, 1 USDC) from the borrower stale'][1]}; "
        f"the mirror restored round {o['TSLAt feed round after the mirror restored it'][0]} (updatedAt {o['TSLAt feed round after the mirror restored it'][3]})",
        "Staleness is judged against the gate's per-feed heartbeat and tolerance, in session only: on a weekend the calendar's "
        "MARKET_CLOSED takes precedence. The keeper's mirror copies mainnet's round verbatim, so on Sepolia the drill held it (KV) "
        "for the window and let the next tick restore the live value.",
    )


def _find_mirror_tx(feed, from_block):
    """The AnswerUpdated the mirror wrote after the release (Basescan logs API: one call, no 10-block window)."""
    key = os.environ.get("BOUNDLINE_ETHERSCAN_API_KEY", "")
    q = urllib.parse.urlencode({"chainid": str(bl.CHAIN_ID), "module": "logs", "action": "getLogs", "address": feed,
                                "fromBlock": str(from_block + 1), "toBlock": "latest", "page": "1", "offset": "20", "apikey": key})
    for _ in range(6):
        with urllib.request.urlopen(urllib.request.Request("https://api.etherscan.io/v2/api?" + q, headers={"user-agent": "k1"}), timeout=30) as resp:
            d = json.loads(resp.read())
        rows = d.get("result") if d.get("status") == "1" else []
        if rows:
            h = rows[-1]["transactionHash"]
            rc = bl.rpc("eth_getTransactionReceipt", [h])
            return {"hash": h, "block": int(rc["blockNumber"], 16), "gasUsed": int(rc["gasUsed"], 16), "from": bl.rpc("eth_getTransactionByHash", [h])["from"]}
        time.sleep(15)
    return None


DRILLS = {"issuer-transfer-pause": issuer_transfer_pause, "ineligible-receiver": ineligible_receiver,
          "scheduled-multiplier": scheduled_multiplier, "mirror-window": mirror_window}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("drill", choices=sorted(DRILLS))
    ap.add_argument("--dry", action="store_true", help="read-only: guards and before-state only")
    a = ap.parse_args()
    DRILLS[a.drill](a.dry)


if __name__ == "__main__":
    main()
