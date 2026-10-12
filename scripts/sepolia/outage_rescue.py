"""The feed-outage rescue on Base Sepolia (Mon 12 Oct 2026): the Saturday rescue's two actions, run in session under a
staged frozen feed, step by step, every step recorded in docs/evidence/feed-outage-rescue-2026-10-12.json.

Why in session: the 9-11 Oct weekend passed without the two recorded rescues (docs/evidence/saturday-rescue-2026-10-10.md).
The ShadowGuard treats FEED_STALE exactly like MARKET_CLOSED (`heldFeed` in ShadowGuard.shadowPrice), so a feed that
stops printing in an open session takes the same protection path as a weekend: the venue oracle (SessionGuard) refuses
to price, the shadow price is the pool TWAP less 200 bps, the keeper may close out on the Protector and repay down the
vault's ladder, each armed as a validity transaction on the feed's updatedAt slot. The staging is the 8 Oct stale-feed
drill's: the keeper's mirror of AAPLt is held (KV), and the AAPLt test feed is rewritten to the same round and answer
with an updatedAt 27 h old (heartbeat 24 h + tolerance 2 h). Nothing here claims a weekend.

  set -a; . ~/.boundline/base-sepolia.env; set +a
  python3 -I scripts/sepolia/outage_rescue.py show             # read-only: every number the steps depend on
  python3 -I scripts/sepolia/outage_rescue.py pre              # read-only checks, writes the "before" section
  python3 -I scripts/sepolia/outage_rescue.py stale            # hold the mirror, write the stale round, narrow the hold to AAPLt
  python3 -I scripts/sepolia/outage_rescue.py step1            # TWAP so the drill position is at 58.80%: the keeper closes it out
  python3 -I scripts/sepolia/outage_rescue.py step2            # TWAP so line 1 is at 54.00%: the keeper's vault job repays it
  python3 -I scripts/sepolia/outage_rescue.py restore          # TWAP mirrored from mainnet, the hold released, the feed restored
  python3 -I scripts/sepolia/outage_rescue.py settle           # in session: the borrower settles the advance, the Reserve harvests
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import bl  # noqa: E402
import drills  # noqa: E402  (KV hold switch, keeper config, mirror quiet, mirror-tx lookup)
import record_protect  # noqa: E402
import twap  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
EVIDENCE = os.path.join(REPO, "docs", "evidence", "feed-outage-rescue-2026-10-12.json")
KEEPER_API = "https://boundline-keeper.papermind-ai.workers.dev"
LOGS_RPC = "https://sepolia.base.org"  # 500-block eth_getLogs windows (Alchemy's free tier allows 10)
MARKET = bl.MARKETS["AAPLt"]
AAPLT, FEED = bl.TOKENS["AAPLt"], bl.FEEDS["AAPLt"]
GUARD = "0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854"  # SessionGuard AAPLt (the market oracle)
STALE_AGE = 27 * 3600
MP_T = "(address,address,address,address,uint256)"
ADV_T = "(uint128,uint128,uint128,uint128,uint64,uint64)"


class Obs:
    """Shim for drills.hold_all/release_all/mirror_quiet, which report through run.obs()."""

    def __init__(self):
        self.rows = []

    def obs(self, what, value, block=None):
        self.rows.append({"what": what, "value": value, "block": block if block is not None else bl.head()})
        bl.log(f"  obs: {what} = {value}")


def topic(sig):
    return subprocess.run(["cast", "keccak", sig], capture_output=True, text=True, check=True).stdout.strip()


def load():
    if os.path.exists(EVIDENCE):
        with open(EVIDENCE) as f:
            return json.load(f)
    return {"title": "Feed-outage rescue on Base Sepolia, Mon 12 Oct 2026 (the Saturday rescue's two actions under a staged frozen feed)",
            "script": "scripts/sepolia/outage_rescue.py", "runbook": "docs/runbooks/saturday-rescue-2026-10-10.md",
            "why": __doc__.split("\n\n")[1].replace("\n", " "), "steps": {}}


def save(step, data):
    d = load()
    d["steps"][step] = data
    tmp = EVIDENCE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, EVIDENCE)
    bl.log(f"  wrote {EVIDENCE} [{step}]")


def keeper(path):
    req = urllib.request.Request(KEEPER_API + path, headers={"user-agent": "boundline-outage-rescue"})
    for i in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
            if body:
                return json.loads(body)
        except Exception as e:  # noqa: BLE001
            bl.log(f"  keeper {path}: {e}")
        time.sleep(3 + 2 * i)  # a fresh isolate can answer an empty body once
    return None


def market_params():
    return bl.tup(bl.call(bl.MORPHO, f"idToMarketParams(bytes32)({MP_T})", MARKET)[0])


def position(who, block=None):
    pos = bl.tup(bl.call(bl.MORPHO, "position(bytes32,address)((uint256,uint128,uint128))", MARKET, who, block=block)[0])
    mkt = bl.tup(bl.call(bl.MORPHO, "market(bytes32)((uint128,uint128,uint128,uint128,uint128,uint128))", MARKET, block=block)[0])
    shares, coll = int(pos[1]), int(pos[2])
    debt = -(-shares * (int(mkt[2]) + 1) // (int(mkt[3]) + 10**6)) if shares else 0
    return {"borrowShares": shares, "collateralRaw": coll, "debtRaw": debt}


def shadow(block=None):
    ok, out = bl.try_call(bl.SHADOW, "shadowPrice()(uint256,uint8,(uint8,uint8,int256,uint256,uint256,bool,bool))", block=block)
    if not ok:
        return {"reverted": out}
    v = bl.tup(out[2])
    return {"price36": out[0], "usd": int(out[0]) / 1e34, "source": ["FEED", "TWAP"][int(out[1])] if int(out[1]) < 2 else out[1],
            "gate": bl.GATE_STATES[int(v[0])], "session": bl.SESSIONS[int(v[1])]}


def vault_state(block=None):
    adv = bl.tup(bl.call(bl.VAULT, f"advanceOf(uint256)({ADV_T})", 1, block=block)[0])
    return {"userBalance": int(bl.call(bl.VAULT, "userBalance(address)(uint256)", bl.BORROWER, block=block)[0]),
            "advanceLiquidity": int(bl.call(bl.VAULT, "advanceLiquidity()(uint256)", block=block)[0]),
            "advance": {"outstanding": int(adv[0]), "feeOutstanding": int(adv[1]), "totalAdvanced": int(adv[2]), "totalSettled": int(adv[3])},
            "feesCollected": int(bl.call(bl.VAULT, "feesCollected()(uint256)", block=block)[0]),
            "vaultUsdc": bl.erc20(bl.USDC, bl.VAULT, block)}


def snapshot(label):
    """Every number the steps depend on, at one block."""
    blk = bl.head()
    v = bl.verdict(AAPLT, block=blk)
    rd = bl.call(FEED, "latestRoundData()(uint80,int256,uint256,uint256,uint80)", block=blk)
    q = bl.quote(1, block=blk)
    s = {
        "label": label, "block": blk, "blockTime": bl.block_ts(blk),
        "gate": {"state": v["stateName"], "session": v["sessionName"], "answer": v["answer"], "updatedAt": v["updatedAt"]},
        "feed": {"roundId": rd[0], "answer": rd[1], "updatedAt": rd[3], "slot5": int(bl.rpc("eth_getStorageAt", [FEED, "0x5", hex(blk)]), 16)},
        "shadow": shadow(blk),
        "venueOracle": (lambda r: {"ok": r[0], "value" if r[0] else "revert": r[1]})(bl.try_call(GUARD, "price()(uint256)", block=blk)),
        "mock": twap.mock_state(),
        "drill": {**position(bl.DEPLOYER, blk), "sizing": record_protect.sizing(bl.DEPLOYER, blk)},
        "line1": {**position(bl.BORROWER, blk), "quote": q["reasonName"], "obligation": bl.obligation(1, block=blk),
                  "sizing": record_protect.sizing(bl.BORROWER, blk)},
        "vault": vault_state(blk),
        "reserve": {"totalAssets": int(bl.call(bl.RESERVE, "totalAssets()(uint256)", block=blk)[0]),
                    "totalSupply": int(bl.call(bl.RESERVE, "totalSupply()(uint256)", block=blk)[0]),
                    "idleUsdc": bl.erc20(bl.USDC, bl.RESERVE, blk)},
        "poolUsdc": bl.erc20(bl.USDC, bl.POOL, blk),
        "balancesEth": {k: int(bl.rpc("eth_getBalance", [a, hex(blk)]), 16) / 1e18 for k, a in
                        (("protectSigner", bl.PROTECT_SIGNER), ("mirrorKey", bl.MIRROR_KEEPER), ("deployer", bl.DEPLOYER), ("borrower", bl.BORROWER))},
    }
    for k in ("drill", "line1"):
        sz = s[k]["sizing"]
        s[k]["shadowLtvPct"] = round(int(sz["shadowLtvWad"]) / 1e16, 4)
        s[k]["standing"] = sz["standing"]
    return s


def brief(s):
    return {"block": s["block"], "gate": f"{s['gate']['state']} ({s['gate']['session']})", "shadow": f"{s['shadow'].get('source')} {s['shadow'].get('usd')}",
            "drill": f"{s['drill']['standing']} {s['drill']['shadowLtvPct']}% debt {s['drill']['debtRaw']}",
            "line1": f"{s['line1']['standing']} {s['line1']['shadowLtvPct']}% debt {s['line1']['debtRaw']} {s['line1']['obligation']}",
            "vault": s["vault"], "poolUsdc": s["poolUsdc"], "mockTick": s["mock"]["tick"]}


def keeper_views():
    p, v, c = keeper("/v1/protect"), keeper("/v1/vault"), keeper("/v1/config")
    out = {"hold": (c or {}).get("hold"), "holdSource": (c or {}).get("holdSource")}
    if p:
        out["protect"] = {"armed": p.get("armed"), "skipped": p.get("skipped"), "errors": p.get("errors"),
                          "targets": [{"borrower": t["borrower"], "standing": t["sizing"]["standing"], "venueOracleLive": t["sizing"]["venueOracleLive"],
                                       "decision": t.get("decision")} for t in p.get("targets", [])]}
    if v:
        out["vault"] = {"armed": v.get("armed"), "skipped": v.get("skipped"), "errors": v.get("errors"), "state": v.get("state"),
                        "targets": [{"lineId": t["lineId"], "standing": t["sizing"]["standing"], "shadowLtvPct": t.get("shadowLtvPct"),
                                     "amountUsdc": t.get("amountUsdc"), "ladder": t.get("ladder"), "decision": t.get("decision")} for t in v.get("targets", [])]}
    return out


def logs(address, topic0, from_block):
    head = bl.head()
    out, start = [], from_block
    while start <= head:
        end = min(start + 499, head)
        r = bl.rpc("eth_getLogs", [{"address": address, "topics": [topic0], "fromBlock": hex(start), "toBlock": hex(end)}], url=LOGS_RPC)
        if isinstance(r, dict) and "__error__" in r:
            raise RuntimeError(f"eth_getLogs: {r['__error__']}")
        out += r
        start = end + 1
    return out


def wait_for(what, check, timeout=600, every=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        got = check()
        if got:
            bl.log(f"  {what}: done after {int(time.time() - t0)} s")
            return got
        time.sleep(every)
    raise RuntimeError(f"{what}: not seen within {timeout} s (state: {json.dumps(brief(snapshot('timeout')))})")


def tx_record(h):
    r = bl.rpc("eth_getTransactionReceipt", [h])
    t = bl.rpc("eth_getTransactionByHash", [h])
    return {"hash": h, "block": int(r["blockNumber"], 16), "status": int(r["status"], 16), "from": t["from"], "to": t["to"],
            "nonce": int(t["nonce"], 16), "gasUsed": int(r["gasUsed"], 16)}


# ---------------------------------------------------------------------------------------------------- steps

def cmd_show(_a):
    s = snapshot("show")
    print(json.dumps({"snapshot": s, "keeper": keeper_views()}, indent=2))


def cmd_pre(_a):
    s = snapshot("before")
    k = keeper_views()
    fails = []
    if s["gate"]["state"] != "OPEN":
        fails.append(f"gate {s['gate']['state']}")
    if s["drill"]["standing"] != "BELOW_BAND" or s["line1"]["standing"] != "BELOW_BAND":
        fails.append("a target is not BELOW_BAND")
    if s["poolUsdc"] < s["drill"]["debtRaw"] + 30_000:
        fails.append(f"pool {s['poolUsdc']} < drill debt {s['drill']['debtRaw']} + 0.03")
    if s["balancesEth"]["protectSigner"] < 0.003:
        fails.append("protect signer under 0.003 ETH")
    if s["vault"]["userBalance"] < 400_000 or s["vault"]["advanceLiquidity"] < 200_000:
        fails.append("vault ladder short")
    if (k.get("hold") or {}).get("feed"):
        fails.append(f"a hold is already on: {k.get('hold')}")
    save("before", {"snapshot": s, "keeper": k, "fails": fails})
    print(json.dumps({"brief": brief(s), "keeper": k, "fails": fails}, indent=2))
    if fails:
        sys.exit(1)


def cmd_stale(a):
    w = Obs()
    if not a.dry:
        drills.hold_all(w)  # every symbol, feed and registry: the Worker signs nothing from the mirror key
        drills.mirror_quiet(w)
    rd = bl.call(FEED, "latestRoundData()(uint80,int256,uint256,uint256,uint80)")
    now = bl.block_ts(bl.head())
    old = now - STALE_AGE
    plan = {"round": rd, "staleUpdatedAt": old, "ageAtWrite": STALE_AGE}
    if a.dry:
        print(json.dumps(plan, indent=2))
        return
    try:
        tx = bl.send(bl.MIRROR_KEEPER, FEED, "setRoundData(uint80,int256,uint256,uint256,uint80)", rd[0], rd[1], old, old, rd[4])
    except Exception:
        drills.release_all(w)
        raise
    after = snapshot("stale")
    if after["gate"]["state"] != "FEED_STALE" or after["shadow"].get("source") != "TWAP":
        bl.log("  the gate did not go FEED_STALE / the shadow price is not the TWAP: releasing the hold")
        drills.release_all(w)
        save("stale", {"plan": plan, "tx": tx, "after": after, "aborted": True})
        sys.exit(1)
    # Narrow the hold to AAPLt so the Worker keeps mirroring NVDAt and TSLAt; the mirror key is not used again here.
    drills.kv(["put", "hold", json.dumps({"feed": ["AAPLt"], "registry": ["AAPLt"]})])
    narrowed = wait_for("hold narrowed to AAPLt", lambda: (lambda c: c if c and c.get("hold", {}).get("feed") == ["AAPLt"] else None)(drills.keeper_config()), 150, 6)
    w.obs("keeper /v1/config hold narrowed to AAPLt", {"hold": narrowed.get("hold"), "holdSource": narrowed.get("holdSource")})
    morpho_liq = bl.try_call(bl.MORPHO, "liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)",
                             "(" + ",".join(market_params()) + ")", bl.BORROWER, 1, 0, "0x", sender=bl.DEPLOYER)
    save("stale", {"plan": plan, "tx": {**tx, "label": f"TestPriceFeed(AAPLt).setRoundData(round {rd[0]}, answer {rd[1]}, updatedAt {old} = 27 h before block time) by the mirror key, inside a KV hold"},
                   "holdObservations": w.rows, "after": after, "rawLiquidateWhileStale": {"ok": morpho_liq[0], "result": morpho_liq[1]},
                   "keeper": keeper_views()})
    print(json.dumps({"tx": tx["hash"], "after": brief(after), "rawLiquidate": morpho_liq}, indent=2))


def cmd_step1(a):
    before = snapshot("step1 before")
    if before["gate"]["state"] != "FEED_STALE":
        sys.exit(f"gate is {before['gate']['state']}, run `stale` first")
    from_block = before["block"]
    plan = twap.apply(twap.tick_for_price(twap_for(bl.DEPLOYER, 5880)), a.dry, "drill (deployer) to shadow LTV 58.80% while the feed is held (stale)")
    if a.dry:
        print(json.dumps(plan, indent=2))
        return
    moved = snapshot("step1 TWAP moved")
    protected = topic("Protected(uint256,address,address,uint256,uint256,uint256,uint256,uint256,bytes32)")

    def landed():
        if position(bl.DEPLOYER)["borrowShares"] != 0:
            return None
        rows = [lg for lg in logs(bl.PROTECTOR, protected, from_block) if lg["topics"][3][-40:].lower() == bl.DEPLOYER[2:].lower()]
        return rows[-1] if rows else None

    lg = wait_for("keeper close-out of the drill position", landed, 900)
    h = lg["transactionHash"]
    run = json.loads(subprocess.run([sys.executable, "-I", os.path.join(os.path.dirname(__file__), "record_protect.py"), h, "--label",
                                     "Mon 12 Oct 2026, REGULAR session, AAPLt feed held stale by the operator (the Saturday rescue's step 1, run in "
                                     "session): the keeper closed out the drill position at the TWAP shadow price as a validity transaction"],
                                    capture_output=True, text=True, check=True).stdout)
    after = snapshot("step1 after")
    liq = bl.try_call(bl.MORPHO, "liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)",
                      "(" + ",".join(market_params()) + ")", bl.BORROWER, 1, 0, "0x", sender=bl.DEPLOYER)
    save("step1", {"twap": plan, "moved": moved, "protectTx": tx_record(h), "run": run, "after": after,
                   "rawLiquidateSameMoment": {"call": "Morpho.liquidate(AAPLt market, borrower 0xB789..82Fc, seizedAssets 1, 0, 0x) from the deployer (eth_call)",
                                              "ok": liq[0], "result": liq[1]}, "keeper": keeper_views()})
    print(json.dumps({"protectTx": h, "outcome": run["outcome"], "rawLiquidate": liq, "after": brief(after)}, indent=2))


def twap_for(who, bps):
    pos = position(who)
    shadow36 = pos["debtRaw"] * 10**36 * 10_000 // (pos["collateralRaw"] * bps)
    return twap.usd(shadow36 * 10_000 // (10_000 - twap.HAIRCUT_BPS))


def cmd_step2(a):
    before = snapshot("step2 before")
    if before["gate"]["state"] != "FEED_STALE":
        sys.exit(f"gate is {before['gate']['state']}")
    if before["drill"]["borrowShares"] != 0 and not a.force:
        sys.exit("step 1 has not landed (the drill position still has debt); --force to override")
    from_block = before["block"]
    plan = twap.apply(twap.tick_for_price(twap_for(bl.BORROWER, 5400)), a.dry, "line 1 (borrower) to shadow LTV 54.00% while the feed is held (stale)")
    if a.dry:
        print(json.dumps({"plan": plan, "previewProtect(1, 0.6 USDC)": bl.call(bl.VAULT, "previewProtect(uint256,uint256)((uint256,uint256,uint256,uint256))", 1, 600_000)}, indent=2))
        return
    moved = snapshot("step2 TWAP moved")
    vt = topic("Protected(uint256,address,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,bytes32)")

    def landed():
        rows = logs(bl.VAULT, vt, from_block)
        return rows[-1] if rows else None

    lg = wait_for("keeper vault repay on line 1", landed, 900)
    h = lg["transactionHash"]
    d = lg["data"][2:]
    w = [int(d[i:i + 64], 16) for i in range(0, len(d), 64)]
    ev = {"lineId": int(lg["topics"][1], 16), "user": "0x" + lg["topics"][2][-40:], "partnerId": lg["topics"][3],
          "repaid": w[0], "fromUser": w[1], "fromPartner": w[2], "fromAdvance": w[3], "debtBefore": w[4], "debtAfter": w[5],
          "decisionHash": "0x%064x" % w[6]}
    rc = bl.rpc("eth_getTransactionReceipt", [h])
    blk = int(rc["blockNumber"], 16)
    slot_before = int(bl.rpc("eth_getStorageAt", [FEED, "0x5", hex(blk - 1)]), 16)
    slot_at = int(bl.rpc("eth_getStorageAt", [FEED, "0x5", hex(blk)]), 16)
    desk_logs = [lg2 for lg2 in rc["logs"] if lg2["address"].lower() == bl.DESK.lower()]
    after = snapshot("step2 after")
    save("step2", {"twap": plan, "moved": moved, "vaultTx": tx_record(h), "vaultProtected": ev,
                   "predicate": {"feed": FEED, "slot": 5, "valueBefore": slot_before, "valueAtInclusion": slot_at, "held": slot_before == slot_at},
                   "deskLogsInTx": len(desk_logs), "after": after, "keeper": keeper_views()})
    print(json.dumps({"vaultTx": h, "event": ev, "after": brief(after)}, indent=2))


def cmd_restore(a):
    plan = twap.apply(twap.mainnet_twap()["tick"], a.dry, "restore: mirror of the mainnet AAPLc/USDC 1h TWAP")
    if a.dry:
        print(json.dumps(plan, indent=2))
        return
    w = Obs()
    start = bl.head()
    drills.release_all(w)

    def restored():
        rd = bl.call(FEED, "latestRoundData()(uint80,int256,uint256,uint256,uint80)")
        return rd if int(rd[3]) > int(time.time()) - 26 * 3600 else None

    rd = wait_for("the Worker's mirror restores the AAPLt round", restored, 600)
    mtx = drills._find_mirror_tx(FEED, start)
    after = snapshot("restored")
    save("restore", {"twap": plan, "holdObservations": w.rows, "restoredRound": rd, "mirrorTx": mtx, "after": after, "keeper": keeper_views()})
    print(json.dumps({"mirrorTx": mtx, "after": brief(after)}, indent=2))


def cmd_settle(a):
    before = snapshot("settle before")
    if before["gate"]["state"] != "OPEN":
        sys.exit(f"gate is {before['gate']['state']}: settle in an open session")
    adv = before["vault"]["advance"]
    amount = adv["outstanding"] + adv["feeOutstanding"]
    if amount == 0:
        sys.exit("no advance outstanding on line 1")
    if a.dry:
        print(json.dumps({"repayAdvance": amount, "advance": adv}, indent=2))
        return
    txs = [bl.send(bl.BORROWER, bl.USDC, "approve(address,uint256)", bl.VAULT, amount),
           bl.send(bl.BORROWER, bl.VAULT, "repayAdvance(uint256,uint256)", 1, amount)]
    mid = snapshot("settled")
    txs.append(bl.send(bl.DEPLOYER, bl.RESERVE, "harvest(address)", bl.VAULT))
    after = snapshot("harvested")
    shares, assets = after["reserve"]["totalSupply"], after["reserve"]["totalAssets"]
    save("settle", {"amount": amount, "txs": txs, "afterSettle": mid, "after": after,
                    "reserveSharePrice": assets / shares if shares else None})
    print(json.dumps({"txs": [t["hash"] for t in txs], "vault": after["vault"], "reserve": after["reserve"]}, indent=2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["show", "pre", "stale", "step1", "step2", "restore", "settle"])
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    {"show": cmd_show, "pre": cmd_pre, "stale": cmd_stale, "step1": cmd_step1, "step2": cmd_step2, "restore": cmd_restore, "settle": cmd_settle}[a.cmd](a)


if __name__ == "__main__":
    main()
