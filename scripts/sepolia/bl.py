"""Shared helpers for the Base Sepolia drill and staging scripts (stdlib only).

Reads go through Alchemy when BOUNDLINE_ALCHEMY_API_KEY is set (public endpoints answer 429 under load), writes
through `cast send` with a key taken from the environment by NAME: a key value is never printed or logged.
Load the keys first: `set -a; . ~/.boundline/base-sepolia.env; set +a`. Base Sepolia only (chain 84532).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.request

CHAIN_ID = 84532
_AK = os.environ.get("BOUNDLINE_ALCHEMY_API_KEY", "")
RPC = f"https://base-sepolia.g.alchemy.com/v2/{_AK}" if _AK else "https://sepolia.base.org"
MAINNET_RPC = f"https://base-mainnet.g.alchemy.com/v2/{_AK}" if _AK else "https://mainnet.base.org"
EXPLORER = "https://sepolia.basescan.org/tx/"

# The book (deployments/base-sepolia.json).
DESK = "0x39aBaDc0aAa12D1F7e259b89536Aa1848997399a"
GATE = "0x92f59437d4ef5CDcEAe2CcDE89B03A7B4B1Ae427"
MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"
USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
REGISTRY = "0xc78A796710be93774310ff8Cf467EaABCeAb4655"
POLICY_REGISTRY = "0x8453000000000000000000000000000000000002"
VAULT = "0x87f600279F021ca859b9903DE884d3A7A169f38c"
RESERVE = "0x7AcE5c9ca94d5B67feC97348Ff41778D092a6B6E"
PROTECTOR = "0x5c546946c909718040dd686f63df6cb5e4df442c"
PRELIQ = "0xdcae709341aab652144e8afcb47479fe49e133a1"
SHADOW = "0x7a53b459be6e5e9a12324cc3417bb027daf73f65"
POOL = "0x5069f3753961efcaea8c7f6ec49a182e2c40081b"
TOKENS = {
    "AAPLt": "0xB2000000000000000000000E063E65377cA34141",
    "NVDAt": "0xB200000000000000000000AEd76Eae58870E2ae6",
    "TSLAt": "0xb200000000000000000000Af3FB2181a8772F804",
}
FEEDS = {
    "AAPLt": "0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a",
    "NVDAt": "0x097dCec820dCF11b5e8d0fA698b86714f96dB0e2",
    "TSLAt": "0x5CB94874E3a54F36Bc8DD9c85405ea300e5b43a1",
}
MARKETS = {
    "AAPLt": "0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047",
    "NVDAt": "0x7cb7fcc828a7296f8ea18256e0f5763a5588cfe22df9c943088021c762e58cc9",
    "TSLAt": "0xb0e8d25d1c9b822cc718c89666b887698922a7b49fdb00dbdecd70dd4ed9e2f1",
}
DEPLOYER = "0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E"
BORROWER = "0xB789aD318945B37566E2549F65526Cc269a482Fc"
MIRROR_KEEPER = "0x28A50Eb7C2Db2B04638D3b226c724A1Cfe999894"
PROTECT_SIGNER = "0x40668755c993A551dB05E844fF9150A0C00a0373"

KEYS = {  # address -> env var holding its key (never read here, only passed to cast by name)
    DEPLOYER.lower(): "BOUNDLINE_TESTNET_DEPLOYER_KEY",
    BORROWER.lower(): "BOUNDLINE_TESTNET_BORROWER_KEY",
    MIRROR_KEEPER.lower(): "BOUNDLINE_TESTNET_KEEPER_KEY",
}

QUOTE_T = "(uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)"
QUOTE_FIELDS = ["reason", "session", "price8", "collateralRaw", "collateralValue", "debt", "maxDebt", "available",
                "effectiveMaxLtvWad", "corporateActionHaircut"]
VERDICT_T = "(uint8,uint8,int256,uint256,uint256,bool,bool)"
VERDICT_FIELDS = ["state", "session", "answer", "updatedAt", "multiplier", "registryPaused", "transferPaused"]
REASONS = ["NONE", "DESK_PAUSED", "LINE_NOT_OPEN", "LINE_HELD", "PARTNER_INACTIVE", "MARKET_DISABLED", "MARKET_CLOSED",
           "FEED_PAUSED", "TRANSFER_PAUSED", "FEED_STALE", "FEED_INVALID", "UNKNOWN_TOKEN", "TICKER_NOT_ALLOWED",
           "NOT_ELIGIBLE", "BELOW_MIN_DRAW", "ABOVE_MAX_DRAW", "PARTNER_CAP", "TICKER_CAP", "INSUFFICIENT_CAPACITY",
           "NOT_AUTHORIZED_ON_VENUE"]
SESSIONS = ["UNKNOWN", "PRE", "REGULAR", "POST", "OVERNIGHT", "WEEKEND", "HOLIDAY"]
GATE_STATES = ["OPEN", "MARKET_CLOSED", "FEED_PAUSED", "TRANSFER_PAUSED", "FEED_STALE", "FEED_INVALID", "UNKNOWN_TOKEN"]
OBLIGATION = ["NONE", "OPEN", "HOLD_SESSION", "HOLD_FEED", "HOLD_ISSUER", "HOLD_TRANSFER", "HOLD_KEEPER", "CLOSED"]


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def rpc(method, params, url=None, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url or RPC, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                         headers={"content-type": "application/json", "user-agent": "boundline-k1"})
            with urllib.request.urlopen(req, timeout=30) as r:
                out = json.loads(r.read())
            if "error" in out:
                return {"__error__": out["error"]}
            return out["result"]
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"{method}: {last}")


def _cast(args, check=True):
    p = subprocess.run(["cast", *args], capture_output=True, text=True)
    if check and p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).strip()[-800:])
    return p


def _clean(line):
    """Scalars lose cast's ' [1e18]' annotation; tuple and array lines are kept whole for `tup`."""
    line = line.strip()
    return line if line.startswith(("(", "[")) else line.split(" [")[0].strip()


def call(to, sig, *args, block=None, url=None):
    """`cast call` decoded output lines; raises with the revert text on failure."""
    a = ["call", "--rpc-url", url or RPC]
    if block is not None:
        a += ["--block", str(block)]
    p = _cast([*a, to, sig, *[str(x) for x in args]])
    return [_clean(ln) for ln in p.stdout.strip().splitlines()]


def try_call(to, sig, *args, sender=None, block=None):
    """eth_call that never raises: (ok, decoded lines | revert text)."""
    a = ["call", "--rpc-url", RPC]
    if sender:
        a += ["--from", sender]
    if block is not None:
        a += ["--block", str(block)]
    p = _cast([*a, to, sig, *[str(x) for x in args]], check=False)
    if p.returncode == 0:
        return True, [_clean(ln) for ln in p.stdout.strip().splitlines()]
    msg = (p.stderr or p.stdout).strip()
    return False, decode_revert(msg)


SCOPES = {  # keccak256 of the B20 policy scope names, as they appear in PolicyForbids
    "0x8a4b3fa2d8b921852bc0089c6ef0958aa6961897be36fd731330fe2cd23f8363": "TRANSFER_RECEIVER_POLICY",
    "0xb81736c875ab819dd97f59f2a6542cfb731ad52b4ae15a6f24df2fb02b0327f5": "TRANSFER_SENDER_POLICY",
}
with open(os.path.join(os.path.dirname(__file__), "errors.json")) as _f:
    ERRORS = json.load(_f)  # selector -> signature of the custom errors the drills expect (cast sig)


def decode_revert(msg):
    m = re.search(r"data: \"?(0x[0-9a-fA-F]+)", msg) or re.search(r"(0x[0-9a-fA-F]{8,})", msg)
    if m:
        data = m.group(1)
        sig = ERRORS.get(data[:10].lower())
        if sig:
            p = _cast(["decode-error", "--sig", sig, data], check=False)
            args = " ".join(p.stdout.split()) if p.returncode == 0 else data[10:]
            args = re.sub(r"\s*\[[^\]]*\]", "", args)  # cast's scientific-notation annotations
            for h, scope in SCOPES.items():
                args = args.replace(h, scope)
            args = ", ".join(args.split())
            name = sig.split("(")[0]
            if name == "Refused" and args.isdigit() and int(args) < len(REASONS):
                return f"Refused({args} = {REASONS[int(args)]})"
            return f"{name}({args})"
        p = _cast(["decode-error", data], check=False)
        if p.returncode == 0 and p.stdout.strip():
            return f"{data[:10]} {p.stdout.strip()}"
        return data[:202]
    return msg.splitlines()[-1][:300] if msg else "revert"


def tup(line):
    """Parse a cast tuple line '(a, b, c)' into strings, stripping cast's [1e18] annotations."""
    s = line.strip()
    if s.startswith("(") and s.endswith(")"):
        s = s[1:-1]
    parts, depth, cur = [], 0, ""
    for ch in s:
        if ch in "([":
            depth += 1
        if ch in ")]":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        parts.append(cur.strip())
    return [re.sub(r"\s*\[[^\]]*\]$", "", x).strip() for x in parts]


def quote(line_id, amount=0, block=None):
    v = tup(call(DESK, f"quote(uint256,uint256)({QUOTE_T})", line_id, amount, block=block)[0])
    q = dict(zip(QUOTE_FIELDS, v))
    q["reasonName"] = REASONS[int(q["reason"])]
    q["sessionName"] = SESSIONS[int(q["session"])]
    return q


def verdict(token, block=None):
    v = tup(call(GATE, f"check(address)({VERDICT_T})", token, block=block)[0])
    d = dict(zip(VERDICT_FIELDS, v))
    d["stateName"] = GATE_STATES[int(d["state"])]
    d["sessionName"] = SESSIONS[int(d["session"])]
    return d


def obligation(line_id, block=None):
    return OBLIGATION[int(call(DESK, "obligationStatus(uint256)(uint8)", line_id, block=block)[0])]


def erc20(token, who, block=None):
    return int(call(token, "balanceOf(address)(uint256)", who, block=block)[0])


def head():
    return int(rpc("eth_blockNumber", []), 16)


def block_ts(n):
    return int(rpc("eth_getBlockByNumber", [hex(n), False])["timestamp"], 16)


def send(sender, to, sig, *args, gas=None, tries=5, guard=True):
    """Sign with the key of `sender` (by env var name), wait for the receipt, return a compact record.
    An eth_call from `sender` with the same calldata runs first and stops the send on a revert (guard=True).
    Retries the nonce races sepolia's load-balanced nodes produce; raises on a reverted receipt."""
    var = KEYS[sender.lower()]
    if not os.environ.get(var):
        raise RuntimeError(f"{var} not loaded")
    if guard:
        ok, out = try_call(to, sig, *args, sender=sender)
        if not ok:
            raise RuntimeError(f"eth_call guard refused {sig}: {out}")
    last = None
    for i in range(tries):
        a = ["send", "--rpc-url", RPC, "--private-key", os.environ[var], "--json", "--confirmations", "1"]
        if gas:
            a += ["--gas-limit", str(gas)]
        p = subprocess.run(["cast", *a, to, sig, *[str(x) for x in args]], capture_output=True, text=True)
        if p.returncode == 0:
            r = json.loads(p.stdout)
            rec = {"hash": r["transactionHash"], "block": int(r["blockNumber"], 16), "status": int(r["status"], 16),
                   "gasUsed": int(r["gasUsed"], 16), "from": sender, "to": to, "call": sig}
            if rec["status"] != 1:
                raise RuntimeError(f"reverted on chain: {rec}")
            log(f"  sent {sig.split('(')[0]} -> {rec['hash']} block {rec['block']}")
            time.sleep(2)  # let the load-balanced nodes catch up before the next read
            return rec
        msg = (p.stderr or p.stdout)
        last = msg.strip()[-400:]
        if re.search(r"nonce too low|replacement transaction underpriced|already known|timeout|429|Too Many", msg, re.I):
            log(f"  retry {i + 1}: {last.splitlines()[-1] if last else ''}")
            time.sleep(4 + 3 * i)
            continue
        raise RuntimeError(f"send {sig} failed: {decode_revert(msg)}")
    raise RuntimeError(f"send {sig} failed after retries: {last}")


def append_run(drill_id, run, path=None):
    """Append a run to docs/evidence/drills/<id>.json (created when missing)."""
    path = path or os.path.join(os.path.dirname(__file__), "..", "..", "docs", "evidence", "drills", f"{drill_id}.json")
    path = os.path.abspath(path)
    data = {"drill": drill_id, "runs": []}
    if os.path.exists(path):
        with open(path) as f:
            data = json.load(f)
    data["runs"].append(run)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)
    log(f"  wrote {path}")
    return path
