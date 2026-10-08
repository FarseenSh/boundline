"""The AAPLt MockSwapPool's TWAP and swap price, which the ShadowGuard reads while the feed is held (Base Sepolia).

  set -a; . ~/.boundline/base-sepolia.env; set +a
  python3 -I scripts/sepolia/twap.py show                       # mock vs mainnet, shadow LTVs while held
  python3 -I scripts/sepolia/twap.py mirror [--dry]             # copy the real Aerodrome AAPLc/USDC 1h TWAP from mainnet
  python3 -I scripts/sepolia/twap.py set --pct -8 [--dry]       # move it relative to the mainnet TWAP (or --price 309.50)
  python3 -I scripts/sepolia/twap.py ltv --who line1 --bps 5400 [--dry]   # put a position at a target shadow LTV while held

The mock is a `MockCLPool` (open setters `setAverageTick(window, tick)` and `setSlot0`) with the owner-only swap price
`setPrice36` (deployer). All three are set together and consistently: the TWAP tick over the ShadowGuard's own window
(3600 s), slot0 at the same tick, and price36 = the exact Uniswap quote at that tick, so the Protector sells at the
price the ShadowGuard reports before its haircut. Token order matches mainnet: token0 USDC (6 dec), token1 the stock
(8 dec), so a tick copies across unchanged. Prices are integer-exact (TickMath port, the ShadowGuard's arithmetic).
"""
import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bl  # noqa: E402

MAINNET_POOL = "0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0"  # Aerodrome Slipstream AAPLc/USDC
MAINNET_FEED = "0x787f13dEa48Db0897CbCDD985de77809D837F988"  # Chainlink AAPLc
WINDOW = 3600
HAIRCUT_BPS = 200
MIN_TICK, MAX_TICK = -887272, 887272


def sqrt_ratio_at_tick(tick: int) -> int:
    """Uniswap v3 TickMath.getSqrtRatioAtTick, integer-exact."""
    abs_tick = -tick if tick < 0 else tick
    if abs_tick > MAX_TICK:
        raise ValueError("tick out of range")
    ratio = 0xfffcb933bd6fad37aa2d162d1a594001 if abs_tick & 0x1 else 0x100000000000000000000000000000000
    for bit, mul in ((0x2, 0xfff97272373d413259a46990580e213a), (0x4, 0xfff2e50f5f656932ef12357cf3c7fdcc),
                     (0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0), (0x10, 0xffcb9843d60f6159c9db58835c926644),
                     (0x20, 0xff973b41fa98c081472e6896dfb254c0), (0x40, 0xff2ea16466c96a3843ec78b326b52861),
                     (0x80, 0xfe5dee046a99a2a811c461f1969c3053), (0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4),
                     (0x200, 0xf987a7253ac413176f2b074cf7815e54), (0x400, 0xf3392b0822b70005940c7a398e4b70f3),
                     (0x800, 0xe7159475a2c29b7443b29c7fa6e889d9), (0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825),
                     (0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5), (0x4000, 0x70d869a156d2a1b890bb3df62baf32f7),
                     (0x8000, 0x31be135f97d08fd981231505542fcfa6), (0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9),
                     (0x20000, 0x5d6af8dedb81196699c329225ee604), (0x40000, 0x2216e584f5fa1ea926041bedfe98),
                     (0x80000, 0x48a170391f7dc42444e8fa2)):
        if abs_tick & bit:
            ratio = (ratio * mul) >> 128
    if tick > 0:
        ratio = ((1 << 256) - 1) // ratio
    return (ratio >> 32) + (0 if ratio % (1 << 32) == 0 else 1)


def price36_at_tick(tick: int) -> int:
    """ShadowGuard._priceFromTick with the collateral as token1: raw USDC per raw stock, times 1e36."""
    s = sqrt_ratio_at_tick(tick)
    if s <= (1 << 128) - 1:
        return (1 << 192) * 10**36 // (s * s)
    ratio_x128 = s * s // (1 << 64)
    return (1 << 128) * 10**36 // ratio_x128


def usd(price36: int) -> float:
    return price36 / 1e34  # raw USDC (6) per raw stock (8): x 100 for USD per share


def avg_tick(cumulatives) -> int:
    delta = int(cumulatives[1]) - int(cumulatives[0])
    t = int(delta / WINDOW) if delta >= 0 else -((-delta) // WINDOW)  # Solidity truncation toward zero ...
    if delta < 0 and delta % WINDOW != 0:
        t = -((-delta) // WINDOW) - 1  # ... then floor toward -inf, as the ShadowGuard does
    return t


def tick_for_price(p_usd: float) -> int:
    """Smallest tick whose quote is at or below p_usd (the quote falls as the tick rises)."""
    t = math.ceil(-math.log(p_usd / 100.0) / math.log(1.0001))
    while usd(price36_at_tick(t)) > p_usd:
        t += 1
    while usd(price36_at_tick(t - 1)) <= p_usd:
        t -= 1
    return t


def mainnet_twap():
    cums = bl.call(MAINNET_POOL, "observe(uint32[])(int56[],uint160[])", f"[{WINDOW},0]", url=bl.MAINNET_RPC)[0]
    vals = [int(x.strip().split(" ")[0]) for x in cums.strip()[1:-1].split(",")]
    slot0 = bl.call(MAINNET_POOL, "slot0()(uint160,int24,uint16,uint16,uint16,bool)", url=bl.MAINNET_RPC)
    feed = bl.call(MAINNET_FEED, "latestRoundData()(uint80,int256,uint256,uint256,uint80)", url=bl.MAINNET_RPC)
    t = avg_tick(vals)
    return {"tick": t, "price36": price36_at_tick(t), "usd": usd(price36_at_tick(t)), "spotTick": int(slot0[1]),
            "feedUsd": int(feed[1]) / 1e8, "feedUpdatedAt": int(feed[3]),
            "dexVsFeedBps": round((usd(price36_at_tick(t)) / (int(feed[1]) / 1e8) - 1) * 10_000, 1)}


def mock_state():
    cums = bl.call(bl.POOL, "observe(uint32[])(int56[],uint160[])", f"[{WINDOW},0]")[0]
    vals = [int(x.strip().split(" ")[0]) for x in cums.strip()[1:-1].split(",")]
    t = avg_tick(vals)
    slot0 = bl.call(bl.POOL, "slot0()(uint160,int24,uint16,uint16,uint16,bool)")
    return {"tick": t, "twapUsd": usd(price36_at_tick(t)), "price36": int(bl.call(bl.POOL, "price36()(uint256)")[0]),
            "swapUsd": int(bl.call(bl.POOL, "price36()(uint256)")[0]) / 1e34, "slot0Tick": int(slot0[1]),
            "shadowGuardTwap36": int(bl.call(bl.SHADOW, "twapPrice36()(uint256)")[0]),
            "poolUsdc": bl.erc20(bl.USDC, bl.POOL) / 1e6}


def positions_at(twap_price36: int):
    """Shadow LTV of the two AAPLt positions the drill uses if the feed were held at this TWAP (haircut 200 bps)."""
    shadow = twap_price36 * (10_000 - HAIRCUT_BPS) // 10_000
    out = {}
    for name, who in (("drill (deployer, Protector band 58%-62.5%)", bl.DEPLOYER), ("line1 (borrower, vault grace 52%)", bl.BORROWER)):
        pos = bl.tup(bl.call(bl.MORPHO, "position(bytes32,address)((uint256,uint128,uint128))", bl.MARKETS["AAPLt"], who)[0])
        mkt = bl.tup(bl.call(bl.MORPHO, "market(bytes32)((uint128,uint128,uint128,uint128,uint128,uint128))", bl.MARKETS["AAPLt"])[0])
        shares, coll = int(pos[1]), int(pos[2])
        debt = -(-shares * (int(mkt[2]) + 1) // (int(mkt[3]) + 10**6)) if shares else 0  # Morpho toAssetsUp with virtual shares
        value = coll * shadow // 10**36
        out[name] = {"collateralRaw": coll, "debtRaw": debt, "shadowUsd": round(usd(shadow), 5),
                     "shadowLtvPct": round(debt * 100 / value, 4) if value else None}
    return out


def apply(tick: int, dry: bool, why: str):
    p36 = price36_at_tick(tick)
    sq = sqrt_ratio_at_tick(tick)
    plan = {"tick": tick, "price36": str(p36), "usd": round(usd(p36), 5), "sqrtPriceX96": str(sq), "why": why,
            "positionsWhileHeld": positions_at(p36)}
    if dry:
        return plan
    txs = []
    txs.append(bl.send(bl.DEPLOYER, bl.POOL, "setAverageTick(uint32,int24)", WINDOW, tick))
    txs.append(bl.send(bl.DEPLOYER, bl.POOL, "setSlot0(uint160,int24)", sq, tick))
    if int(bl.call(bl.POOL, "price36()(uint256)")[0]) != p36:
        txs.append(bl.send(bl.DEPLOYER, bl.POOL, "setPrice36(uint256)", p36))
    got = int(bl.call(bl.SHADOW, "twapPrice36()(uint256)")[0])
    if got != p36:
        raise RuntimeError(f"ShadowGuard.twapPrice36 {got} != computed {p36}")
    plan["txs"] = [{"hash": t["hash"], "block": t["block"], "call": t["call"]} for t in txs]
    plan["shadowGuardTwap36"] = str(got)
    return plan


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["show", "mirror", "set", "ltv"])
    ap.add_argument("--pct", type=float)
    ap.add_argument("--price", type=float)
    ap.add_argument("--who", choices=["drill", "line1"])
    ap.add_argument("--bps", type=int)
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    m = mainnet_twap()
    if a.cmd == "show":
        mock = mock_state()
        print(json.dumps({"mainnet": m, "mock": mock, "positionsIfHeldAtMockTwap": positions_at(price36_at_tick(mock["tick"])),
                          "positionsIfHeldAtMainnetTwap": positions_at(m["price36"])}, indent=2))
        return
    if a.cmd == "mirror":
        out = apply(m["tick"], a.dry, f"mirror of the mainnet AAPLc/USDC 1h TWAP (tick {m['tick']}, {m['usd']:.4f} USD; feed {m['feedUsd']}, DEX vs feed {m['dexVsFeedBps']} bps)")
    elif a.cmd == "set":
        if a.price is None and a.pct is None:
            sys.exit("set needs --price or --pct")
        target = a.price if a.price is not None else m["usd"] * (1 + a.pct / 100)
        out = apply(tick_for_price(target), a.dry, f"set to {target:.4f} USD ({'--price' if a.price is not None else f'{a.pct:+}% of the mainnet TWAP {m[chr(117)+chr(115)+chr(100)]:.4f}'})")
    else:
        if a.who is None or a.bps is None:
            sys.exit("ltv needs --who and --bps")
        who = bl.DEPLOYER if a.who == "drill" else bl.BORROWER
        pos = positions_at(m["price36"])
        key = [k for k in pos if k.startswith(a.who)][0]
        debt, coll = pos[key]["debtRaw"], pos[key]["collateralRaw"]
        shadow36 = debt * 10**36 * 10_000 // (coll * a.bps)            # the shadow price that gives the target LTV
        twap_usd = usd(shadow36 * 10_000 // (10_000 - HAIRCUT_BPS))
        out = apply(tick_for_price(twap_usd), a.dry, f"{a.who} ({who}) to shadow LTV {a.bps / 100:.2f}% while held: TWAP {twap_usd:.4f} USD")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
