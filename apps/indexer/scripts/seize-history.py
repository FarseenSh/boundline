"""Seize watch baseline (8 Oct 2026): full-history governance scan of the ten priced Coinbase stocks on Base mainnet
(RoleGranted, RoleRevoked, PolicyUpdated, Seized) from just before their creation (block 49,145,000; the stocks were
created in blocks 49,145,181-49,145,336) to the head, over eth_getLogs in 1,000-block windows, then live reads at the
head: policyId(SEIZE_EXEMPT_POLICY), policyId(SEIZE_RECEIVER_POLICY) and hasRole(SEIZE_ROLE, a) for every account that
ever held any role. Writes JSON; src/seize-baseline.ts summarises the 8 Oct run. Stdlib only; reads the Alchemy key from
BOUNDLINE_ALCHEMY_API_KEY and never prints it.

    set -a; . ~/.boundline/base-sepolia.env; set +a; python3 -I apps/indexer/scripts/seize-history.py out.json
"""
import json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

AK = os.environ.get("BOUNDLINE_ALCHEMY_API_KEY", "")
LOG_RPCS = ["https://gateway.tenderly.co/public/base", "https://base.gateway.tenderly.co"]
CALL_RPC = f"https://base-mainnet.g.alchemy.com/v2/{AK}"
TOKENS = {
    "AAPLc": "0xb200000000000000000000C2e324d24d7eEcd1fb", "AMZNc": "0xb200000000000000000000d9192b6B456483C2E8",
    "GOOGLc": "0xb2000000000000000000002D0BA3164cc74f58B7", "METAc": "0xb2000000000000000000008bC8786B856E61707C",
    "MSFTc": "0xB200000000000000000000Ab99cFa739E253872B", "MSTRc": "0xb2000000000000000000004884b426556b92883d",
    "NVDAc": "0xb20000000000000000000078ee7ce2fE4908108C", "SNDKc": "0xb200000000000000000000397293Cb8cda9a10c5",
    "SPCXc": "0xb2000000000000000000007b9fcbd005511aCBd5", "TSLAc": "0xb2000000000000000000001e800a7f5189430cD0",
}
BY_ADDR = {v.lower(): k for k, v in TOKENS.items()}
T = {
    "0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d": "RoleGranted",
    "0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b": "RoleRevoked",
    "0x8b4790f7ff717fc8f60f07ae099e47ef318dc04b37ae98056b50a22b79056626": "PolicyUpdated",
    "0xa9aec5d8b86e2fa2fd6ac3af62f2622e3dfdab1967d4cbbb56a5df7d74cb887c": "Seized",
}
SEIZE_ROLE = "0x3469b8b0d89e9604f8510ed143f74a8336d22955d4f83e23bf53d9414e27f432"
ROLES = {"0x" + "00" * 32: "DEFAULT_ADMIN_ROLE", SEIZE_ROLE: "SEIZE_ROLE"}
SCOPES = {
    "0xedb5da348cfb67af08746d3afd1be81034b50d5c8576f31aff688f39dfd540ed": "SEIZE_EXEMPT_POLICY",
    "0xbf15b19caf5c77422c038bc25f26b8b815c3a14f6d04c6616076b81bcfe07b3d": "SEIZE_RECEIVER_POLICY",
}


def post(url, method, params, timeout=40):
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"content-type": "application/json", "user-agent": "boundline-seize-scan"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read())
    if "error" in out:
        raise RuntimeError(out["error"])
    return out["result"]


def window(frm, to):
    params = [{"address": list(TOKENS.values()), "fromBlock": hex(frm), "toBlock": hex(to), "topics": [list(T.keys())]}]
    for attempt in range(6):
        url = LOG_RPCS[attempt % len(LOG_RPCS)]
        try:
            return post(url, "eth_getLogs", params)
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"window {frm}-{to}: {last}")


def main(out_path):
    start = 49_145_000
    head = int(post(CALL_RPC, "eth_blockNumber", []), 16)
    windows = [(b, min(b + 999, head)) for b in range(start, head + 1, 1000)]
    t0 = time.time()
    logs = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for i, res in enumerate(ex.map(lambda w: window(*w), windows)):
            logs.extend(res)
            if i % 400 == 0:
                print(f"  {i}/{len(windows)} windows, {len(logs)} logs, {time.time() - t0:.0f}s", flush=True)
    print(f"scanned {len(windows)} windows ({start}..{head}) in {time.time() - t0:.0f}s: {len(logs)} logs")
    tokens = {s: {"token": a, "roles": {}, "seizeRoleEvents": [], "seizePolicyUpdates": [], "otherPolicyUpdates": 0, "seized": [], "accounts": set()} for s, a in TOKENS.items()}
    for lg in sorted(logs, key=lambda x: (int(x["blockNumber"], 16), int(x["logIndex"], 16))):
        sym = BY_ADDR.get(lg["address"].lower())
        if not sym:
            continue
        rec = tokens[sym]
        name = T[lg["topics"][0]]
        blk = int(lg["blockNumber"], 16)
        if name in ("RoleGranted", "RoleRevoked"):
            role = lg["topics"][1]
            acct = "0x" + lg["topics"][2][-40:]
            rec["accounts"].add(acct)
            rn = ROLES.get(role, role[:10] + "…")
            rec["roles"][rn] = rec["roles"].get(rn, 0) + 1
            if role == SEIZE_ROLE:
                rec["seizeRoleEvents"].append({"event": name, "account": acct, "block": blk, "tx": lg["transactionHash"]})
        elif name == "PolicyUpdated":
            scope = lg["topics"][1]
            d = lg["data"][2:]
            if scope in SCOPES:
                rec["seizePolicyUpdates"].append({"scope": SCOPES[scope], "old": int(d[0:64], 16), "new": int(d[64:128], 16), "block": blk, "tx": lg["transactionHash"]})
            else:
                rec["otherPolicyUpdates"] += 1
        elif name == "Seized":
            rec["seized"].append({"block": blk, "tx": lg["transactionHash"]})
    for sym, rec in tokens.items():
        tok = rec["token"]
        rec["livePolicyIds"] = {nm: int(post(CALL_RPC, "eth_call", [{"to": tok, "data": "0xdb3de624" + sc[2:]}, hex(head)]), 16) for sc, nm in SCOPES.items()}
        rec["liveSeizeRoleHolders"] = [a for a in sorted(rec["accounts"]) if int(post(CALL_RPC, "eth_call", [{"to": tok, "data": "0x91d14854" + SEIZE_ROLE[2:] + a[2:].rjust(64, "0")}, hex(head)]), 16) == 1]
        rec["accounts"] = sorted(rec["accounts"])
        print(sym, "roles", rec["roles"], "seizeRoleEvents", len(rec["seizeRoleEvents"]), "seizePolicyUpdates", rec["seizePolicyUpdates"], "seized", len(rec["seized"]), "live", rec["livePolicyIds"], "liveSeizeHolders", rec["liveSeizeRoleHolders"], "accounts", len(rec["accounts"]))
    json.dump({"scannedFrom": start, "scannedTo": head, "windows": len(windows), "logs": len(logs), "tokens": tokens}, open(out_path, "w"), indent=1)


if __name__ == "__main__":
    main(sys.argv[1])
