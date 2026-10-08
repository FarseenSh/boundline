"""Turn one Protector.protect transaction into a drill run: sizing before and after (archive eth_call at the
blocks around it), the decoded Protected / PreLiquidate / Morpho events, the feed slot the validity predicate
guarded, the gate's session. Prints the run as JSON; `--append` adds it to docs/evidence/drills/protection.json.

  python3 -I scripts/sepolia/record_protect.py <txHash> --label "..." [--append]
"""
import argparse
import json
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
import bl  # noqa: E402

SIZING = ("sizing(address,address,uint256)((uint8,uint256,uint256,uint256,uint256,uint256,bool,uint256,uint256,uint256,"
          "uint256,uint256,uint256,uint256,uint256,bool,uint256,uint256))")
SIZING_FIELDS = ["standing", "collateral", "borrowShares", "debtAssets", "shadowPrice36", "venuePrice36", "venueOracleLive",
                 "shadowLtvWad", "venueLtvWad", "preLifWad", "preLcfWad", "targetLtvWad", "maxSeizedAssets",
                 "maxRepaidShares", "maxRepaidAssets", "fullCloseAllowed", "fullCloseSeizedAssets", "fullCloseRepaidAssets"]
STANDING = ["NO_POSITION", "NO_SHADOW_PRICE", "BELOW_BAND", "IN_BAND", "ABOVE_LLTV"]
PROTECTED = "0xc4b3a4508e924fa5"  # Protected(uint256,address,address,uint256,uint256,uint256,uint256,uint256,bytes32)
PRELIQUIDATE = "0xd5b01f148b35d606"
MORPHO_REPAY = "0x52acb05cebbd3cd3"
MORPHO_WITHDRAW_COLLATERAL = "0xe80ebd7cc9223d73"


def sizing(borrower, block):
    s = dict(zip(SIZING_FIELDS, bl.tup(bl.call(bl.PROTECTOR, SIZING, bl.PRELIQ, borrower, 0, block=block)[0])))
    s["standing"] = STANDING[int(s["standing"])]
    return s


def pct(wad):
    return f"{int(wad) / 1e16:.4f}%"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tx")
    ap.add_argument("--label", default="")
    ap.add_argument("--append", action="store_true")
    a = ap.parse_args()

    r = bl.rpc("eth_getTransactionReceipt", [a.tx])
    tx = bl.rpc("eth_getTransactionByHash", [a.tx])
    block = int(r["blockNumber"], 16)
    ts = bl.block_ts(block)
    ev = {}
    for lg in r["logs"]:
        t0 = lg["topics"][0][:18]
        d = lg["data"][2:]
        w = [int(d[i:i + 64], 16) for i in range(0, len(d), 64)]
        if t0 == PROTECTED and lg["address"].lower() == bl.PROTECTOR.lower():
            ev["protected"] = {"decision": int(lg["topics"][1], 16), "borrower": "0x" + lg["topics"][3][-40:],
                               "seizedAssets": w[0], "repaidAssets": w[1], "collateralSold": w[2],
                               "venuePrice36": str(w[3]), "shadowPrice36": str(w[4]), "decisionHash": "0x%064x" % w[5]}
        elif t0 == PRELIQUIDATE:
            ev["preLiquidate"] = {"repaidAssets": w[0], "repaidShares": w[1], "seizedAssets": w[2]}
        elif t0 == MORPHO_REPAY:
            ev["morphoRepay"] = {"assets": w[0], "shares": w[1]}
        elif t0 == MORPHO_WITHDRAW_COLLATERAL:
            ev["morphoWithdrawCollateral"] = {"assets": w[1]}
    if "protected" not in ev:
        sys.exit("no Protected event in this transaction")
    borrower = ev["protected"]["borrower"]
    before, after = sizing(borrower, block - 1), sizing(borrower, block)
    slot_before = int(bl.rpc("eth_getStorageAt", [bl.FEEDS["AAPLt"], "0x5", hex(block - 1)]), 16)
    slot_at = int(bl.rpc("eth_getStorageAt", [bl.FEEDS["AAPLt"], "0x5", hex(block)]), 16)
    v = bl.verdict(bl.TOKENS["AAPLt"], block=block)
    p = ev["protected"]
    kept = p["seizedAssets"] - p["collateralSold"]
    action = "full close-out" if int(after["borrowShares"]) == 0 else "partial pre-liquidation"
    run = {
        "ranAt": ts,
        "chainId": bl.CHAIN_ID,
        "label": a.label or f"{action} by the keeper's protection job, {v['sessionName']} session",
        "txs": [{
            "hash": a.tx,
            "block": block,
            "label": (f"keeper Worker (signer {tx['from']}, nonce {int(tx['nonce'], 16)}): Protector.protect armed as a validity "
                      f"transaction (predicate: AAPLt feed slot 5 = {slot_before}, the round the decision was made on); "
                      f"Morpho Repay {ev.get('morphoRepay', {}).get('assets')} raw USDC + WithdrawCollateral "
                      f"{ev.get('morphoWithdrawCollateral', {}).get('assets')} raw AAPLt, {p['collateralSold']} raw AAPLt sold on the "
                      f"pool, PreLiquidate and Protected emitted; {int(r['gasUsed'], 16):,} gas"),
        }],
        "outcome": (f"{action}: shadow LTV {pct(before['shadowLtvWad'])} -> {pct(after['shadowLtvWad'])} "
                    f"({before['standing']} -> {after['standing']}); seized {p['seizedAssets']:,} raw AAPLt, repaid "
                    f"{p['repaidAssets'] / 1e6:.6f} USDC, sold {p['collateralSold']:,} raw, kept {kept:,} raw as the incentive; "
                    f"venue price {int(p['venuePrice36']) / 1e34:.5f} and shadow price {int(p['shadowPrice36']) / 1e34:.5f} USD; "
                    f"position after: {int(after['collateral']):,} raw AAPLt, {int(after['debtAssets']) / 1e6:.6f} USDC debt; "
                    f"decision #{p['decision']} {p['decisionHash']}; gate {v['stateName']} ({v['sessionName']})"),
        "evidence": ["deployments/base-sepolia.json#protection", "apps/keeper/src/protect-job.ts",
                     "scripts/sepolia/record_protect.py"],
        "sizingBefore": before,
        "sizingAfter": after,
        "events": ev,
        "predicate": {"feed": bl.FEEDS["AAPLt"], "slot": 5, "valueBefore": slot_before, "valueAtInclusion": slot_at,
                      "held": slot_before == slot_at},
        "gate": {"state": v["stateName"], "session": v["sessionName"], "answer": v["answer"], "updatedAt": v["updatedAt"]},
        "signer": {"address": tx["from"], "nonce": int(tx["nonce"], 16), "gasLimit": int(tx["gas"], 16),
                   "gasUsed": int(r["gasUsed"], 16), "maxPriorityFeePerGas": int(tx["maxPriorityFeePerGas"], 16)},
    }
    print(json.dumps(run, indent=2))
    if a.append:
        bl.append_run("protection", run)


if __name__ == "__main__":
    main()
