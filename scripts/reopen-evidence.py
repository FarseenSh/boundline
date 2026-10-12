#!/usr/bin/env python3
"""Reconstruct a weekend freeze and reopen from the Chainlink round history on Base mainnet.

The Observatory's live capture missed the Sun 4 Oct 2026 reopen (the Workers Free plan killed its cron, see
docs/CONTEXT.md), but every round is onchain. For each Coinbase stock feed this walks the proxy's rounds
(binary search on `updatedAt`, which is monotonic within a phase) to find:

  * the held print: the last round at or before the Friday 20:00 ET close,
  * every round inside the closed window (expected: none),
  * the first print after the Sunday 20:00 ET reopen, its lag behind the boundary and its gap from the held print,

and, for the two tokens with an Aerodrome Slipstream pool, the DEX spot and 1h TWAP in the last block before the
reopen, which is the gap Boundline's shadow health saw while the venues still priced Friday's close.

Usage: BASE_RPC_URL=<archive rpc> python3 scripts/reopen-evidence.py --close 1790985600 --reopen 1791158400 \
           --out docs/evidence/reopen-2026-10-04.json
Only standard library. Never prints the RPC URL.
"""
import argparse
import json
import math
import os
import sys
import time
import urllib.request

FEEDS = [  # symbol, proxy, aerodrome pool (token0 USDC, token1 stock) or None — packages/chain/src/addresses.ts
    ("AAPLc", "0x787f13dEa48Db0897CbCDD985de77809D837F988", "0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0"),
    ("AMZNc", "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295", None),
    ("GOOGLc", "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2", None),
    ("METAc", "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D", None),
    ("MSFTc", "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c", None),
    ("MSTRc", "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a", None),
    ("NVDAc", "0x04689a41629776563E6822F76f2e57D148d28513", "0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9"),
    ("SNDKc", "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA", None),
    ("SPCXc", "0x6A634B235903C4ad6376892180d6fF8612e3Fa68", None),
    ("TSLAc", "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4", None),
]
SEL_LATEST = "0xfeaf968c"  # latestRoundData()
SEL_GET_ROUND = "0x9a6fc8f5"  # getRoundData(uint80)
SEL_SLOT0 = "0x3850c7bd"  # slot0()
SEL_OBSERVE = "0x883bdbfd"  # observe(uint32[])
TWO_255 = 1 << 255
TWO_256 = 1 << 256
Q96 = 1 << 96

RPC = os.environ.get("BASE_RPC_URL")
PACE_SECONDS = float(os.environ.get("RPC_PACE_SECONDS", "0.12"))
if not RPC:
    sys.exit("set BASE_RPC_URL (an archive RPC; the value is never printed)")
_id = 0


def rpc(method, params):
    global _id
    _id += 1
    body = json.dumps({"jsonrpc": "2.0", "id": _id, "method": method, "params": params}).encode()
    for attempt in range(8):
        try:
            time.sleep(PACE_SECONDS)  # stay under the archive provider's rate limit
            req = urllib.request.Request(RPC, data=body, headers={"content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                out = json.loads(r.read())
            if "error" in out:
                raise RuntimeError(out["error"].get("message", str(out["error"])))
            return out["result"]
        except RuntimeError:
            raise
        except urllib.error.HTTPError as e:  # 429 and friends: back off harder
            if attempt == 7:
                raise
            time.sleep(2.0 * (attempt + 1) if e.code == 429 else 0.5 * (attempt + 1))
        except Exception:  # transient transport trouble
            if attempt == 7:
                raise
            time.sleep(0.5 * (attempt + 1))


def call(to, data, block="latest"):
    return rpc("eth_call", [{"to": to, "data": data}, block])


def words(hexdata):
    h = hexdata[2:] if hexdata.startswith("0x") else hexdata
    return [int(h[i : i + 64], 16) for i in range(0, len(h) - len(h) % 64, 64)]


def int256(u):
    return u - TWO_256 if u >= TWO_255 else u


def round_data(feed, round_id):
    try:
        w = words(call(feed, SEL_GET_ROUND + f"{round_id:064x}"))
    except RuntimeError:
        return None  # "No data present"
    if len(w) < 5:
        return None
    return {"roundId": w[0], "answer": int256(w[1]), "startedAt": w[2], "updatedAt": w[3], "answeredInRound": w[4]}


def latest(feed):
    w = words(call(feed, SEL_LATEST))
    return {"roundId": w[0], "answer": int256(w[1]), "startedAt": w[2], "updatedAt": w[3], "answeredInRound": w[4]}


def first_round_at_or_after(feed, phase, lo_agg, hi_agg, t):
    """Smallest aggregator round id in [lo, hi] with updatedAt >= t, or None. Rounds are monotonic in updatedAt."""
    best = None
    while lo_agg <= hi_agg:
        mid = (lo_agg + hi_agg) // 2
        r = round_data(feed, (phase << 64) | mid)
        if r is None or r["updatedAt"] == 0:
            lo_agg = mid + 1  # below the retained history: move up
            continue
        if r["updatedAt"] >= t:
            best = r
            hi_agg = mid - 1
        else:
            lo_agg = mid + 1
    return best


def block_before(ts):
    """Highest block with timestamp < ts (binary search on block numbers)."""
    head = int(rpc("eth_blockNumber", []), 16)
    head_ts = int(rpc("eth_getBlockByNumber", [hex(head), False])["timestamp"], 16)
    lo = max(1, head - int((head_ts - ts) / 2) - 5000)
    hi = head
    while lo < hi:
        mid = (lo + hi + 1) // 2
        b_ts = int(rpc("eth_getBlockByNumber", [hex(mid), False])["timestamp"], 16)
        if b_ts < ts:
            lo = mid
        else:
            hi = mid - 1
    return lo


def pool_prices(pool, block):
    """DEX spot and 1h TWAP of the stock in USDC at `block` (token0 USDC 6 dec, token1 stock 8 dec)."""
    s = words(call(pool, SEL_SLOT0, hex(block)))
    sqrt_price = s[0]
    # price of token1 in token0 = 1 / (sqrtPrice/Q96)^2, then scale decimals (8 - 6)
    p1_in_0 = (Q96 / sqrt_price) ** 2 * 10 ** (8 - 6)
    window = 3600
    data = SEL_OBSERVE + f"{32:064x}" + f"{2:064x}" + f"{window:064x}" + f"{0:064x}"
    try:
        o = words(call(pool, data, hex(block)))
        # dynamic: offset, offset, len, c0, c1, ...
        n = o[2]
        c0, c1 = int256(o[3]), int256(o[4])
        avg_tick = (c1 - c0) // window if (c1 - c0) >= 0 else -((c0 - c1 + window - 1) // window)
        p_tick = 1.0001 ** avg_tick  # token1 per token0 in raw units
        twap = (1 / p_tick) * 10 ** (8 - 6)
    except Exception as e:  # pool without 1h history
        twap = None
    # slot0's int24 tick arrives ABI-padded: sign-extended to a full 256-bit word, so decode it as an int256.
    return {"spot": p1_in_0, "twap1h": twap, "tick": int256(s[1])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--close", type=int, required=True, help="unix seconds of the Friday 20:00 ET close")
    ap.add_argument("--reopen", type=int, required=True, help="unix seconds of the Sunday 20:00 ET reopen")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    result = {"chainId": 8453, "close": a.close, "reopen": a.reopen, "generatedAt": int(time.time()), "feeds": []}
    for symbol, feed, pool in FEEDS:
        lt = latest(feed)
        phase = lt["roundId"] >> 64
        hi = lt["roundId"] & ((1 << 64) - 1)
        lo = max(1, hi - 20000)
        first_after = first_round_at_or_after(feed, phase, lo, hi, a.reopen)
        first_in_window = first_round_at_or_after(feed, phase, lo, hi, a.close)
        # held print = round before first_in_window (or before first_after when nothing printed in the window)
        anchor = first_in_window or first_after
        held = round_data(feed, anchor["roundId"] - 1) if anchor else None
        in_window = []
        if first_in_window and first_in_window["updatedAt"] < a.reopen:
            r = first_in_window
            while r and r["updatedAt"] < a.reopen and len(in_window) < 50:
                in_window.append(r)
                r = round_data(feed, r["roundId"] + 1)
        row = {
            "symbol": symbol,
            "feed": feed,
            "phase": phase,
            "held": held,
            "roundsInsideClosedWindow": in_window,
            "firstAfterReopen": first_after,
        }
        if held and first_after:
            row["lagSeconds"] = first_after["updatedAt"] - a.reopen
            row["gapBps"] = (first_after["answer"] - held["answer"]) / held["answer"] * 1e4
            row["heldAgeAtReopenSeconds"] = a.reopen - held["updatedAt"]
        result["feeds"].append(row)
        print(f"{symbol:7s} held {held['answer']/1e8 if held else None} @ {held['updatedAt'] if held else None}  inWindow {len(in_window)}  first {first_after['answer']/1e8 if first_after else None} @ {first_after['updatedAt'] if first_after else None}  lag {row.get('lagSeconds')}s  gap {row.get('gapBps') and round(row['gapBps'],1)} bps", file=sys.stderr)

    b = block_before(a.reopen)
    result["blockBeforeReopen"] = b
    result["dex"] = {}
    for symbol, feed, pool in FEEDS:
        if not pool:
            continue
        p = pool_prices(pool, b)
        held = next(f["held"] for f in result["feeds"] if f["symbol"] == symbol)
        p["heldFeed"] = held["answer"] / 1e8 if held else None
        if held:
            p["spotVsHeldBps"] = (p["spot"] - p["heldFeed"]) / p["heldFeed"] * 1e4
            p["twapVsHeldBps"] = (p["twap1h"] - p["heldFeed"]) / p["heldFeed"] * 1e4 if p["twap1h"] else None
        result["dex"][symbol] = p
        print(f"DEX {symbol}: spot {p['spot']:.4f} twap1h {p['twap1h'] and round(p['twap1h'],4)} vs held {p['heldFeed']} → spot {p.get('spotVsHeldBps') and round(p['spotVsHeldBps'],1)} bps, twap {p.get('twapVsHeldBps') and round(p['twapVsHeldBps'],1)} bps (block {b})", file=sys.stderr)

    with open(a.out, "w") as f:
        json.dump(result, f, indent=2)
    print(f"wrote {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
