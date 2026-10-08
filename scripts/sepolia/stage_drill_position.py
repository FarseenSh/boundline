"""Saturday staging (8 Oct 2026): pre-position the deployer's opted-in drill position (directly on Morpho, outside the desk).

Why: `Protector.sizing` does not look at the sale pool's USDC and the keeper does not simulate before arming, so an
IN_BAND position whose close-out the MockSwapPool cannot pay would be armed every minute and revert every time. Two facts
on 8 Oct made that the default outcome at the Fri 20:00 ET close: the pool held 1.805321 USDC against a debt of 1.805454
(pool and debt both started at 2 USDC and fall together on each pre-liquidation; the gap is accrued interest), and the 200
bps weekend haircut alone moves the position from 57.2% to 58.3% shadow LTV at the real DEX TWAP, inside the 58% band.

A repay of `--amount` raw USDC by the deployer on its own position (Morpho.repay never reads the oracle) leaves the pool able
to pay a full close-out and keeps the position below the band at the close unless the DEX trades ~2.7% under the held feed.
Saturday's drill then moves the mock TWAP deliberately (scripts/sepolia/twap.py ltv --who drill ...).

  set -a; . ~/.boundline/base-sepolia.env; set +a
  python3 -I scripts/sepolia/stage_drill_position.py [--amount 60000] [--dry]
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bl  # noqa: E402

MP_T = "(address,address,address,address,uint256)"


def state(tag):
    pos = bl.tup(bl.call(bl.MORPHO, "position(bytes32,address)((uint256,uint128,uint128))", bl.MARKETS["AAPLt"], bl.DEPLOYER)[0])
    s = bl.tup(bl.call(bl.PROTECTOR, "sizing(address,address,uint256)((uint8,uint256,uint256,uint256,uint256,uint256,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,uint256,uint256))",
                       bl.PRELIQ, bl.DEPLOYER, 0)[0])
    out = {"at": tag, "block": bl.head(), "borrowShares": int(pos[1]), "collateralRaw": int(pos[2]), "debtRaw": int(s[3]),
           "standing": ["NO_POSITION", "NO_SHADOW_PRICE", "BELOW_BAND", "IN_BAND", "ABOVE_LLTV"][int(s[0])],
           "shadowLtvPct": int(s[7]) / 1e16, "poolUsdcRaw": bl.erc20(bl.USDC, bl.POOL), "deployerUsdcRaw": bl.erc20(bl.USDC, bl.DEPLOYER)}
    out["poolHeadroomRaw"] = out["poolUsdcRaw"] - out["debtRaw"]
    bl.log(f"[{tag}] {out}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--amount", type=int, default=60_000)
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    rec = {"position": "deployer drill position on the AAPLt/USDC market (opted into the AAPLt pre-liquidation)", "txs": [], "states": [state("before")]}
    mp = bl.call(bl.MORPHO, "idToMarketParams(bytes32)(address,address,address,address,uint256)", bl.MARKETS["AAPLt"])
    mp_arg = f"({','.join(mp)})"
    if a.dry:
        print(json.dumps(rec, indent=2))
        return
    allowance = int(bl.call(bl.USDC, "allowance(address,address)(uint256)", bl.DEPLOYER, bl.MORPHO)[0])
    if allowance < a.amount:
        t = bl.send(bl.DEPLOYER, bl.USDC, "approve(address,uint256)", bl.MORPHO, a.amount)
        t["label"] = f"USDC.approve(Morpho, {a.amount / 1e6:.6f}) by the deployer"
        rec["txs"].append(t)
    t = bl.send(bl.DEPLOYER, bl.MORPHO, f"repay({MP_T},uint256,uint256,address,bytes)", mp_arg, a.amount, 0, bl.DEPLOYER, "0x")
    t["label"] = f"Morpho.repay(AAPLt/USDC, {a.amount / 1e6:.6f} USDC, onBehalf = deployer): pre-positions the drill position for the weekend"
    rec["txs"].append(t)
    rec["states"].append(state("after"))
    print(json.dumps(rec, indent=2))


if __name__ == "__main__":
    main()
