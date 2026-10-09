"""Friday 9 Oct 2026, before the 20:00 ET close: the runbook's Friday steps as one guarded command
(docs/runbooks/saturday-rescue-2026-10-10.md). Records the "before" state into the evidence file's `friday` section.

  set -a; . ~/.boundline/base-sepolia.env; set +a
  python3 -I scripts/sepolia/friday.py [--dry]

1. Mirror the real DEX onto the mock pool (twap.py mirror), but only when the mirrored TWAP keeps both positions out
   of action at the close: the drill position below 57.5% (band 58%) and line 1 below 51% (grace 52%). A mirror that
   would put a position into action is not applied (the rescues are recorded on Saturday, by hand); the previous mirror
   stays and the reason is recorded. The pool is topped up first when its headroom over the drill debt is under 0.03 USDC
   (a close-out it cannot pay would be a revert, which the keeper's pre-flight refuses and backs off from).
2. Keeper health: the mirror key and the protection signer funded, every pair in sync, no hold (vars or KV), the vault's
   and the harvester's keeper equal to the signer, both protection targets below band, line 1 below grace.
3. The Observatory names the close (`nextFeedTransition` = 1791590400, kind close).
Exits 1 when any check fails (the record is written either way).
"""
import argparse
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import bl  # noqa: E402
import twap  # noqa: E402

KEEPER = "https://boundline-keeper.papermind-ai.workers.dev"
OBSERVATORY = "https://boundline-observatory.papermind-ai.workers.dev"
EVIDENCE = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "evidence", "saturday-rescue-2026-10-10.json")
CLOSE = 1791590400
DRILL_MAX, LINE1_MAX = 57.5, 51.0
HEADROOM_MIN, TOP_UP = 30_000, 100_000  # raw USDC


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "boundline-friday"}), timeout=40) as r:
        return json.loads(r.read())


def ltvs(pos):
    d = next(v for k, v in pos.items() if k.startswith("drill"))
    l1 = next(v for k, v in pos.items() if k.startswith("line1"))
    return d, l1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="read and decide, send nothing, write nothing")
    a = ap.parse_args()
    rec = {"at": int(time.time()), "block": bl.head(), "checks": {}, "mirror": None, "topUp": None}
    fails = []

    m = twap.mainnet_twap()
    mock = twap.mock_state()
    at_mainnet = twap.positions_at(m["price36"])
    drill, line1 = ltvs(at_mainnet)
    rec["mainnetTwap"] = m
    rec["mockBefore"] = mock
    rec["positionsIfHeldAtMainnetTwap"] = at_mainnet

    headroom = bl.erc20(bl.USDC, bl.POOL) - drill["debtRaw"]
    if headroom < HEADROOM_MIN:
        if a.dry:
            rec["topUp"] = {"wouldSend": TOP_UP, "headroomRaw": headroom}
        else:
            t = bl.send(bl.DEPLOYER, bl.USDC, "transfer(address,uint256)", bl.POOL, TOP_UP)
            rec["topUp"] = {"tx": t["hash"], "block": t["block"], "amountRaw": TOP_UP, "headroomBeforeRaw": headroom}
            headroom += TOP_UP
    rec["checks"]["poolHeadroomRaw"] = headroom

    safe = drill["shadowLtvPct"] is not None and drill["shadowLtvPct"] < DRILL_MAX and line1["shadowLtvPct"] is not None and line1["shadowLtvPct"] < LINE1_MAX
    if not safe:
        rec["mirror"] = {"applied": False, "why": f"at the mainnet TWAP the drill would be {drill['shadowLtvPct']}% and line 1 {line1['shadowLtvPct']}% while held "
                         f"(limits {DRILL_MAX}% and {LINE1_MAX}%): the previous mirror stays so nothing acts unrecorded at the close"}
    elif abs(m["tick"] - mock["tick"]) == 0:
        rec["mirror"] = {"applied": False, "why": f"the mock already shows the mainnet TWAP tick {m['tick']}"}
    else:
        plan = twap.apply(m["tick"], a.dry, f"Friday mirror of the mainnet AAPLc/USDC 1h TWAP (tick {m['tick']}, {m['usd']:.4f} USD; feed {m['feedUsd']})")
        rec["mirror"] = {"applied": not a.dry, **plan}
    after = twap.mock_state()
    rec["mockAfter"] = after
    rec["positionsIfHeldAtMockTwap"] = twap.positions_at(twap.price36_at_tick(after["tick"]))
    d2, l2 = ltvs(rec["positionsIfHeldAtMockTwap"])
    if not (d2["shadowLtvPct"] < 58.0):
        fails.append(f"drill at {d2['shadowLtvPct']}% at the mock TWAP (band 58%)")
    if not (l2["shadowLtvPct"] < 52.0):
        fails.append(f"line 1 at {l2['shadowLtvPct']}% at the mock TWAP (grace 52%)")

    status, protect, vault, cfg, harvest = (get(f"{KEEPER}/v1/{p}") for p in ("status", "protect", "vault", "config", "harvest"))
    sessions = get(f"{OBSERVATORY}/v1/sessions")
    c = rec["checks"]
    c["mirrorKeyEth"] = status["keeper"]["balanceEth"]
    c["pairs"] = {p["symbol"]: [p["feed"]["plan"], p["registry"]["plan"]] for p in status["pairs"]}
    c["protectSignerEth"] = int(bl.rpc("eth_getBalance", [bl.PROTECT_SIGNER, "latest"]), 16) / 1e18
    c["hold"] = {"hold": cfg["hold"], "source": cfg["holdSource"]}
    c["protectTargets"] = [f"{t['borrower'][:8]}:{t['sizing']['standing'] if t.get('sizing') else t.get('error')}" for t in protect["targets"]]
    c["vault"] = {"keeperStatus": vault.get("keeperStatus"), "line1": [f"{t['lineId']}:{t['sizing']['standing']}:{t['shadowLtvPct']}%" for t in vault["targets"]]}
    c["harvest"] = {"keeperStatus": harvest.get("keeperStatus"), "standing": [t["preview"]["standing"] if t.get("preview") else t.get("error") for t in harvest.get("targets", [])]}
    c["nextFeedTransition"] = sessions.get("nextFeedTransition")
    if c["mirrorKeyEth"] < 0.005:
        fails.append(f"mirror key {c['mirrorKeyEth']} ETH < 0.005")
    if c["protectSignerEth"] < 0.003:
        fails.append(f"protection signer {c['protectSignerEth']} ETH < 0.003")
    if any(v != ["in-sync", "in-sync"] for v in c["pairs"].values()):
        fails.append(f"pairs not in sync: {c['pairs']}")
    if cfg["hold"]["feed"] or cfg["hold"]["registry"] or cfg["holdSource"] != "none":
        fails.append(f"a hold is on: {c['hold']}")
    if any(not s.endswith("BELOW_BAND") for s in c["protectTargets"]):
        fails.append(f"protection targets: {c['protectTargets']}")
    if c["vault"]["keeperStatus"] != "keeper" or any(":BELOW_GRACE:" not in s for s in c["vault"]["line1"]):
        fails.append(f"vault: {c['vault']}")
    if c["harvest"]["keeperStatus"] != "keeper":
        fails.append(f"harvest job: {c['harvest']}")
    nft = c["nextFeedTransition"] or {}
    if nft.get("at") != CLOSE or nft.get("kind") != "close":
        fails.append(f"Observatory nextFeedTransition {nft}")
    rec["fails"] = fails
    rec["ok"] = not fails

    print(json.dumps(rec, indent=2, default=str))
    if not a.dry:
        path = os.path.abspath(EVIDENCE)
        with open(path) as f:
            doc = json.load(f)
        doc["friday"] = rec
        with open(path + ".tmp", "w") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False, default=str)
            f.write("\n")
        os.replace(path + ".tmp", path)
        bl.log(f"  wrote {path}")
    sys.exit(0 if not fails else 1)


if __name__ == "__main__":
    main()
