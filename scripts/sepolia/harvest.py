"""The self-repaying leg, live on Base Sepolia: one DividendHarvester run on desk line 1 (9 Oct 2026).

The borrower opts line 1 into the harvester (Morpho.setAuthorization + enroll, mode HARVEST). The keeper's KV hold
stops the mirror for a few minutes (the mirror key also signs the feed writes), and the mirror key replays the multiplier
step NVDAc took on 1 Oct 2026 (Coinbase's "Cash Dividend", 1.0 -> 1.000537939576369481) on the AAPLt
MirrorOracleRegistry. The operator harvests in the open session: a Morpho flash loan repays through desk.repay, the
dividend collateral `raw x (m1 - m0) / m1` is withdrawn and sold on the AAPLt pool for exactly the repayment, the rest
is supplied back. Then the hold is released, the keeper mirrors mainnet's 1.0 back, and a second harvest call
re-bases on the step down without selling.

The Sepolia feed is not moved: on mainnet a dividend raises the total-return feed by the same step, so the borrower's
collateral value is unchanged and only the share count falls; here the feed stays mirrored and the run shows the
mechanism (amounts, repay-first ordering, the LTV check, the re-base), not a price effect.

  set -a; . ~/.boundline/base-sepolia.env; set +a
  python3 -I scripts/sepolia/harvest.py [--dry]
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import bl  # noqa: E402
import drills  # noqa: E402

HARVESTER = "0x5b1d1975929d764f41BAb9DA32C696ba137BD58E"
LINE = 1
TOKEN = bl.TOKENS["AAPLt"]
MARKET = bl.MARKETS["AAPLt"]
STEP = 1_000_537_939_576_369_481  # NVDAc's registry multiplier after its 1 Oct 2026 dividend (tx 0x7aef5d12…5ddcd)
HARVEST_MODE = 1
STANDINGS = ["NOT_ENROLLED", "GATE_CLOSED", "NO_CHANGE", "STEP_DOWN", "STEP_TOO_LARGE", "HEADROOM", "NO_DEBT", "TOO_SMALL",
             "NOT_AUTHORIZED", "READY"]
PREVIEW_T = "(uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)"
PREVIEW_FIELDS = ["standing", "baseMultiplier", "multiplier", "collateral", "debt", "price8", "dividendRaw", "dividendValue",
                  "repayAssets", "fullRepay"]
ENROLL_T = "(uint128,uint64,uint64,uint8,uint256)"
HARVESTED = "Harvested(uint256,address,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes32)"
HARVESTED_FIELDS = ["lineId", "baseMultiplier", "multiplier", "dividendRaw", "collateralSold", "repaid", "collateralReturned",
                    "price8", "decisionHash"]
REBASED = "Rebased(address,bytes32,uint256,uint256,uint8)"


def preview(block=None):
    v = bl.tup(bl.call(HARVESTER, f"preview(address,bytes32)({PREVIEW_T})", bl.BORROWER, MARKET, block=block)[0])
    p = dict(zip(PREVIEW_FIELDS, v))
    p["standingName"] = STANDINGS[int(p["standing"])]
    return p


def enrollment(block=None):
    v = bl.tup(bl.call(HARVESTER, f"enrollment(address,bytes32)({ENROLL_T})", bl.BORROWER, MARKET, block=block)[0])
    return dict(zip(["baseMultiplier", "enrolledAt", "lastHarvestAt", "mode", "lineId"], v))


def position(block=None):
    s, b, c = bl.call(bl.MORPHO, "position(bytes32,address)(uint256,uint128,uint128)", MARKET, bl.BORROWER, block=block)
    q = bl.quote(LINE, block=block)
    line = bl.tup(bl.call(bl.DESK, f"line(uint256)({drills.LINE_T})", LINE, block=block)[0])
    return {"collateralRaw": bl._clean(c), "borrowShares": bl._clean(b), "debt": q["debt"], "drawnPrincipal": line[8],
            "quoteReason": q["reasonName"], "collateralValue": q["collateralValue"]}


def registry(block=None):
    m, paused = bl.call(bl.REGISTRY, "getOracleParams(address)(uint256,bool)", TOKEN, block=block)
    return {"multiplier": bl._clean(m), "paused": paused}


def topic(sig):
    return bl._cast(["keccak", sig]).stdout.strip().lower()


def events(rec):
    """The harvester's Harvested and Rebased events in a receipt, decoded."""
    rc = bl.rpc("eth_getTransactionReceipt", [rec["hash"]])
    out = []
    for lg in rc["logs"]:
        if lg["address"].lower() != HARVESTER.lower():
            continue
        words = [int(lg["data"][2 + 64 * i: 2 + 64 * (i + 1)], 16) for i in range((len(lg["data"]) - 2) // 64)]
        if lg["topics"][0].lower() == topic(HARVESTED):
            row = dict(zip(HARVESTED_FIELDS, [str(w) for w in words]))
            row["decisionHash"] = "0x%064x" % words[-1]
            row["decision"] = str(int(lg["topics"][1], 16))
            out.append({"event": "Harvested", **row})
        elif lg["topics"][0].lower() == topic(REBASED):
            out.append({"event": "Rebased", "fromMultiplier": str(words[0]), "toMultiplier": str(words[1]),
                        "reason": STANDINGS[words[2]]})
    return out


def hold_mirror(run):
    """Hold every feed and registry (the mirror key signs the keeper's feed writes too, so nothing else may sign from it
    while the step is sent), then wait until its nonce is quiet."""
    drills.hold_all(run)
    drills.mirror_quiet(run)


def wait_mirrored_back(run, since_block):
    for _ in range(36):
        r = registry()
        if int(r["multiplier"]) == 10 ** 18:
            run.obs("AAPLt MirrorOracleRegistry after the release (the keeper mirrored mainnet AAPLc's 1.0 back)", r)
            m = drills._find_mirror_tx(bl.REGISTRY, since_block)  # Basescan logs API (eth_getLogs ranges 400 on the node)
            if m:
                run.run["txs"].append({"hash": m["hash"], "block": m["block"], "gasUsed": m["gasUsed"],
                                       "label": f"keeper Worker mirror ({m['from']}): MirrorOracleRegistry AAPLt multiplier back to mainnet's 1.0"})
            return
        time.sleep(10)
    raise RuntimeError("the registry was not mirrored back to 1.0 within 6 minutes")


def wait_for(what, pred, tries=30, every=10):
    for _ in range(tries):
        v = pred()
        if v:
            return v
        time.sleep(every)
    raise RuntimeError(f"timed out waiting for {what}")


def by_keeper():
    """The same step, but nobody calls harvest: the keeper Worker's harvest job (PROTECT_KEY, the harvester's keeper since
    9 Oct) sees READY within a tick and harvests; after the release it sees STEP_DOWN and re-bases."""
    run = drills.Run("dividend-harvest", "Fri 9 Oct 2026, OVERNIGHT session: the same replayed dividend step on line 1, with no "
                     "operator: the keeper Worker's harvest job finds the target READY and harvests it, then re-bases on the "
                     "step down after the release")
    run.run["evidence"] = ["scripts/sepolia/harvest.py --by-keeper", "apps/keeper/src/harvest-job.ts",
                           "https://boundline-keeper.papermind-ai.workers.dev/v1/harvest"]
    run.obs("harvester keeper (the keeper Worker's protection signer)", bl.call(HARVESTER, "keeper()(address)")[0])
    run.obs("line 1 before", position())
    e0 = run.obs("enrollment before", enrollment())
    p0 = run.obs("preview before", preview())
    if p0["standingName"] != "NO_CHANGE":
        raise RuntimeError(f"expected NO_CHANGE, got {p0['standingName']}")
    hold_mirror(run)
    try:
        st = run.tx(bl.send(bl.MIRROR_KEEPER, bl.REGISTRY, "setMultiplier(address,uint256)", TOKEN, STEP),
                    "MirrorOracleRegistry.setMultiplier(AAPLt, 1.000537939576369481) by the mirror key: the replayed step again")
        run.obs("preview after the step", preview(st["block"]), st["block"])
        done = wait_for("the keeper's harvest", lambda: (lambda e: e if e["lastHarvestAt"] != e0["lastHarvestAt"] else None)(enrollment()), tries=36)
        m = drills._find_mirror_tx(HARVESTER, st["block"])
        if not m:
            raise RuntimeError("no harvester log after the step")
        run.run["txs"].append({"hash": m["hash"], "block": m["block"], "gasUsed": m["gasUsed"],
                               "label": f"keeper Worker harvest job ({m['from']}): DividendHarvester.harvest(borrower, AAPLt market), unprompted"})
        run.obs("Harvested", events({"hash": m["hash"]}), m["block"])
        run.obs("line 1 after the keeper's harvest", position(m["block"]), m["block"])
        run.obs("enrollment after the keeper's harvest", done, m["block"])
    finally:
        rel_block = bl.head()
        drills.release_all(run)
    wait_mirrored_back(run, rel_block)
    back = wait_for("the keeper's re-base", lambda: (lambda e: e if int(e["baseMultiplier"]) == 10 ** 18 else None)(enrollment()), tries=36)
    m2 = drills._find_mirror_tx(HARVESTER, rel_block)
    if m2:
        run.run["txs"].append({"hash": m2["hash"], "block": m2["block"], "gasUsed": m2["gasUsed"],
                               "label": f"keeper Worker harvest job ({m2['from']}): harvest again on STEP_DOWN, a re-base without a sale"})
        run.obs("Rebased", events({"hash": m2["hash"]}), m2["block"])
    run.obs("enrollment at the end", back)
    run.obs("preview at the end", preview())
    o = {x["what"]: x["value"] for x in run.run["observations"]}
    h = (o.get("Harvested") or [{}])[0]
    run.save(
        f"no operator: within a tick of the step the keeper Worker harvested dividendRaw {h.get('dividendRaw')} raw AAPLt, sold "
        f"{h.get('collateralSold')} for {h.get('repaid')} raw USDC repaid through desk.repay ({h.get('collateralReturned')} returned); "
        f"line 1 debt {o['line 1 before']['debt']} -> {o['line 1 after the keeper\'s harvest']['debt']}; after the release it re-based "
        f"({[e.get('reason') for e in o.get('Rebased', [])]}) on its own",
        "Same replayed step as the operator run above (NVDAc's real 1 Oct step on the AAPLt registry mirror, the keeper's mirror held "
        "for the few minutes it took); the Sepolia feed was not moved. The harvest job reads the harvester's own preview each tick, "
        "simulates from its signer at latest and pending, and signs a plain transaction only in an OPEN session (the contract refuses "
        "otherwise); it yields the shared signer to the Protector and the vault.",
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="reads and eth_call guards only")
    ap.add_argument("--by-keeper", action="store_true", help="replay the step and let the keeper Worker harvest and re-base")
    a = ap.parse_args()
    if a.by_keeper:
        return by_keeper()

    run = drills.Run("dividend-harvest", "Fri 9 Oct 2026, OVERNIGHT session: desk line 1 opts into the DividendHarvester; "
                     "NVDAc's real 1 Oct dividend step (multiplier 1.0 -> 1.000537939576369481) is replayed on the AAPLt "
                     "registry mirror under a keeper hold; the operator harvests the dividend into the loan through a "
                     "Morpho flash loan and desk.repay; after the release the step down re-bases without a sale")
    run.run["evidence"] = ["scripts/sepolia/harvest.py", "contracts/src/harvest/DividendHarvester.sol",
                           "deployments/base-sepolia.json#harvest"]
    run.obs("harvester", {"address": HARVESTER, "owner": bl.call(HARVESTER, "owner()(address)")[0],
                          "keeper": bl.call(HARVESTER, "keeper()(address)")[0],
                          "maxStepBps": bl.call(HARVESTER, "maxStepBps()(uint16)")[0],
                          "maxSlippageBps": bl.call(HARVESTER, "maxSlippageBps()(uint16)")[0],
                          "route AAPLt": bl.call(HARVESTER, "routes(address)(address,bool)", TOKEN)})
    v = bl.verdict(TOKEN)
    run.obs("SessionGate.check(AAPLt)", {"state": v["stateName"], "session": v["sessionName"], "multiplier": v["multiplier"], "answer": v["answer"]})
    run.obs("AAPLt MirrorOracleRegistry before", registry())
    run.obs("line 1 before", position())
    run.obs("AAPLt pool USDC before", bl.erc20(bl.USDC, bl.POOL))

    authorized = bl.call(bl.MORPHO, "isAuthorized(address,address)(bool)", bl.BORROWER, HARVESTER)[0] == "true"
    enrolled = int(enrollment()["mode"]) != 0
    if a.dry:
        run.obs("preview (dry)", preview())
        run.obs("eth_call enroll(market, 1, HARVEST) from the borrower (dry)", bl.try_call(HARVESTER, "enroll(bytes32,uint256,uint8)", MARKET, LINE, HARVEST_MODE, sender=bl.BORROWER))
        print(json.dumps(run.run, indent=1))
        return

    if not authorized:
        run.tx(bl.send(bl.BORROWER, bl.MORPHO, "setAuthorization(address,bool)", HARVESTER, "true"),
               "Morpho.setAuthorization(harvester, true) by the borrower (the opt-in: lets it withdraw the dividend collateral)")
    if not enrolled:
        run.tx(bl.send(bl.BORROWER, HARVESTER, "enroll(bytes32,uint256,uint8)", MARKET, LINE, HARVEST_MODE),
               "DividendHarvester.enroll(AAPLt market, line 1, HARVEST) by the borrower: base multiplier = the registry's now")
    run.obs("enrollment", enrollment())
    p0 = run.obs("preview at the base multiplier", preview())
    if p0["standingName"] != "NO_CHANGE":
        raise RuntimeError(f"expected NO_CHANGE before the step, got {p0['standingName']}")

    hold_mirror(run)
    released = False
    try:
        st = run.tx(bl.send(bl.MIRROR_KEEPER, bl.REGISTRY, "setMultiplier(address,uint256)", TOKEN, STEP),
                    "MirrorOracleRegistry.setMultiplier(AAPLt, 1.000537939576369481) by the mirror key: NVDAc's 1 Oct dividend step, replayed")
        v = bl.verdict(TOKEN)
        run.obs("SessionGate.check(AAPLt) after the step", {"state": v["stateName"], "session": v["sessionName"], "multiplier": v["multiplier"]}, st["block"])
        p1 = run.obs("preview after the step", preview())
        if p1["standingName"] != "READY":
            raise RuntimeError(f"expected READY, got {p1['standingName']}")
        before = position()
        h = run.tx(bl.send(bl.DEPLOYER, HARVESTER, "harvest(address,bytes32,uint256)", bl.BORROWER, MARKET, int(time.time()) + 600),
                   "DividendHarvester.harvest(borrower, AAPLt market) by the operator: flash loan, desk.repay, withdraw the dividend collateral, sell it on the pool, supply the rest back")
        run.obs("Harvested", events(h), h["block"])
        after = run.obs("line 1 after the harvest", position(), h["block"])
        run.obs("LTV check (debt x collateral cross-multiplied, after <= before)",
                {"before": [before["debt"], before["collateralRaw"]], "after": [after["debt"], after["collateralRaw"]]})
        run.obs("AAPLt pool USDC after", bl.erc20(bl.USDC, bl.POOL), h["block"])
        run.obs("harvester balances after (USDC, AAPLt)", [bl.erc20(bl.USDC, HARVESTER), bl.erc20(TOKEN, HARVESTER)], h["block"])
        run.obs("enrollment after the harvest", enrollment(), h["block"])
        run.obs("preview after the harvest", preview())
    finally:
        rel_block = bl.head()
        drills.release_all(run)
        released = True
    if released:
        wait_mirrored_back(run, rel_block)
        p2 = run.obs("preview after the mirror restored 1.0", preview())
        if p2["standingName"] == "STEP_DOWN":
            r = run.tx(bl.send(bl.DEPLOYER, HARVESTER, "harvest(address,bytes32,uint256)", bl.BORROWER, MARKET, int(time.time()) + 600),
                       "DividendHarvester.harvest again: the multiplier fell (the replayed step was removed), so it re-bases and sells nothing")
            run.obs("Rebased", events(r), r["block"])
            run.obs("line 1 after the re-base", position(), r["block"])
        run.obs("enrollment at the end", enrollment())
    o = {x["what"]: x["value"] for x in run.run["observations"]}
    hv = (o.get("Harvested") or [{}])[0]
    run.save(
        f"multiplier 1.0 -> 1.000537939576369481 under the registry hold: dividendRaw {hv.get('dividendRaw')} raw AAPLt, "
        f"{hv.get('collateralSold')} sold on the pool for {hv.get('repaid')} raw USDC repaid through desk.repay, "
        f"{hv.get('collateralReturned')} returned to the position; line 1 debt {o['line 1 before']['debt']} -> {o['line 1 after the harvest']['debt']}, "
        f"collateral {o['line 1 before']['collateralRaw']} -> {o['line 1 after the harvest']['collateralRaw']}; after the release the "
        f"step down re-based ({[e.get('reason') for e in o.get('Rebased', [])]}) without a sale",
        "The Sepolia AAPLt feed was not moved: on mainnet a dividend raises Coinbase's total-return feed by the same step, so the "
        "collateral's value is unchanged and only the share count falls by the dividend. The multiplier step is the real one NVDAc "
        "took on 1 Oct 2026, replayed on the keeper-owned registry mirror while the keeper's mirror was held (KV) for the few minutes "
        "the step and the harvest took. The fork proof on the real NVDAc dividend and the real Aerodrome pool is in contracts/test/harvest/HarvestFork.t.sol.",
    )


if __name__ == "__main__":
    main()
