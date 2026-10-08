"""Saturday staging (8 Oct 2026): shape desk line 1 (the borrower's AAPLt line) for the 10 Oct vault drill.

A fourth AAPLt line for the same borrower is impossible: `openLine` reverts `LineExists` for the same partner, user and
market, and a second partner would share the borrower's single Morpho position on the market. So line 1 itself is shaped:
collateral down to ~0.02 AAPLt (withdraw, in session), debt up to ~48% LTV (draw, in session), and a 0.4 USDC user
reserve in the DeskProtectionVault so Saturday's protective repay takes the user reserve first and then a Reserve advance.

Idempotent: reads the live line first and only does the steps still missing. Writes the staging record as JSON to stdout.

  set -a; . ~/.boundline/base-sepolia.env; set +a
  python3 -I scripts/sepolia/stage_line1.py [--collateral 2000000] [--ltv-bps 4800] [--reserve 400000]
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bl  # noqa: E402

LINE = 1


def snapshot(tag):
    q = bl.quote(LINE)
    pos = bl.tup(bl.call(bl.MORPHO, "position(bytes32,address)((uint256,uint128,uint128))", bl.MARKETS["AAPLt"], bl.BORROWER)[0])
    s = {
        "at": tag,
        "block": bl.head(),
        "session": q["sessionName"],
        "price8": int(q["price8"]),
        "collateralRaw": int(q["collateralRaw"]),
        "debtRaw": int(q["debt"]),
        "maxDebtRaw": int(q["maxDebt"]),
        "availableRaw": int(q["available"]),
        "ltvBps": round(int(q["debt"]) * 10_000 / int(q["collateralValue"]), 2) if int(q["collateralValue"]) else None,
        "borrowShares": int(pos[1]),
        "obligation": bl.obligation(LINE),
        "userReserveRaw": int(bl.call(bl.VAULT, "userBalance(address)(uint256)", bl.BORROWER)[0]),
        "borrowerUsdcRaw": bl.erc20(bl.USDC, bl.BORROWER),
        "borrowerAaplRaw": bl.erc20(bl.TOKENS["AAPLt"], bl.BORROWER),
    }
    bl.log(f"[{tag}] {s}")
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--collateral", type=int, default=2_000_000, help="raw AAPLt to leave on line 1 (8 decimals)")
    ap.add_argument("--ltv-bps", type=int, default=4800)
    ap.add_argument("--reserve", type=int, default=400_000, help="raw USDC for the borrower's vault reserve")
    a = ap.parse_args()
    rec = {"line": LINE, "borrower": bl.BORROWER, "txs": [], "snapshots": [snapshot("before")]}
    q = bl.quote(LINE)
    if q["reasonName"] != "NONE":
        sys.exit(f"desk refuses line {LINE} now: {q['reasonName']} ({q['sessionName']})")

    # 1. withdraw collateral down to the target (session-gated; the policy LTV must hold afterwards)
    coll = int(q["collateralRaw"])
    if coll > a.collateral:
        amt = coll - a.collateral
        ok, out = bl.try_call(bl.DESK, "withdrawCollateral(uint256,uint256)", LINE, amt, sender=bl.BORROWER)
        if not ok:
            sys.exit(f"withdrawCollateral guard refused: {out}")
        t = bl.send(bl.BORROWER, bl.DESK, "withdrawCollateral(uint256,uint256)", LINE, amt)
        t["label"] = f"desk.withdrawCollateral(1, {amt:,} raw AAPLt): line 1 collateral {coll:,} -> {a.collateral:,} raw, in the {q['sessionName']} session (gate OPEN)"
        rec["txs"].append(t)
        rec["snapshots"].append(snapshot("after-withdraw"))

    # 2. draw to the target LTV (rounded down to the cent; min draw 1 USDC)
    q = bl.quote(LINE)
    value = int(q["collateralValue"])
    want = value * a.ltv_bps // 10_000 - int(q["debt"])
    want = want // 10_000 * 10_000
    if want >= 1_000_000:
        ok, out = bl.try_call(bl.DESK, "draw(uint256,uint256)", LINE, want, sender=bl.BORROWER)
        if not ok:
            sys.exit(f"draw guard refused: {out}")
        qq = bl.quote(LINE, want)
        if qq["reasonName"] != "NONE":
            sys.exit(f"desk quote refuses the draw: {qq['reasonName']}")
        t = bl.send(bl.BORROWER, bl.DESK, "draw(uint256,uint256)", LINE, want)
        t["label"] = f"desk.draw(1, {want / 1e6:.2f} USDC) at price {int(q['price8']) / 1e8:.5f}, {q['sessionName']} session: line 1 to ~{a.ltv_bps / 100:.0f}% LTV"
        rec["txs"].append(t)
        rec["snapshots"].append(snapshot("after-draw"))
    else:
        bl.log(f"draw skipped: {want} raw is below the 1 USDC minimum (already at target)")

    # 3. the borrower's protection reserve in the DeskProtectionVault (ladder step one)
    have = int(bl.call(bl.VAULT, "userBalance(address)(uint256)", bl.BORROWER)[0])
    if have < a.reserve:
        need = a.reserve - have
        allowance = int(bl.call(bl.USDC, "allowance(address,address)(uint256)", bl.BORROWER, bl.VAULT)[0])
        if allowance < need:
            t = bl.send(bl.BORROWER, bl.USDC, "approve(address,uint256)", bl.VAULT, need)
            t["label"] = f"USDC.approve(DeskProtectionVault, {need / 1e6:.6f})"
            rec["txs"].append(t)
        ok, out = bl.try_call(bl.VAULT, "deposit(uint256)", need, sender=bl.BORROWER)
        if not ok:
            sys.exit(f"deposit guard refused: {out}")
        t = bl.send(bl.BORROWER, bl.VAULT, "deposit(uint256)", need)
        t["label"] = f"DeskProtectionVault.deposit({need / 1e6:.6f} USDC): the borrower's own protection reserve, step one of the ladder"
        rec["txs"].append(t)
        rec["snapshots"].append(snapshot("after-deposit"))
    print(json.dumps(rec, indent=2))


if __name__ == "__main__":
    main()
