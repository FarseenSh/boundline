"""What a DeployMainnet broadcast costs at today's Base mainnet fees. Stdlib only.

    python3 -I DeployMainnet.cost.py <broadcast run-latest.json> <rpc that holds the receipts> <Base mainnet rpc>

Gas is read from the receipts (a rehearsal on a base-anvil fork, or the real run). L2 execution is priced at the
highest base fee of the last 20 mainnet blocks plus their median priority fee (eth_feeHistory); the L1 data fee is
the GasPriceOracle predeploy's getL1FeeUpperBound(calldata + 68 bytes) per transaction, an upper bound; the dollar
figure uses Chainlink's ETH/USD feed on Base."""
import json, sys, urllib.request

GPO = "0x420000000000000000000000000000000000000F"
GET_L1_FEE_UPPER_BOUND = "0xf1c7a58b"
CHAINLINK_ETH_USD = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70"


def rpc(url, method, params):
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"content-type": "application/json", "user-agent": "boundline-deploy"})
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.loads(r.read())
    if "error" in out:
        raise RuntimeError(out["error"])
    return out["result"]


def main():
    path, receipts_rpc, mainnet = sys.argv[1], sys.argv[2], sys.argv[3]
    run = json.load(open(path))
    by_hash = {r["transactionHash"]: r for r in run.get("receipts", [])}
    total_gas, sizes, failed = 0, [], 0
    for t in run["transactions"]:
        r = by_hash.get(t["hash"]) or rpc(receipts_rpc, "eth_getTransactionReceipt", [t["hash"]])
        failed += r["status"] != "0x1"
        total_gas += int(r["gasUsed"], 16)
        data = t["transaction"].get("input") or t["transaction"].get("data") or "0x"
        sizes.append((len(data) - 2) // 2)
    print(f"transactions {len(sizes)} (failed {failed}), gas used {total_gas:,}, calldata {sum(sizes):,} bytes")
    fh = rpc(mainnet, "eth_feeHistory", ["0x14", "latest", [50]])
    base = max(int(x, 16) for x in fh["baseFeePerGas"])
    tips = sorted(int(x[0], 16) for x in fh["reward"])
    tip = tips[len(tips) // 2]
    l2 = total_gas * (base + tip)
    l1 = 0
    for n in sizes:
        l1 += int(rpc(mainnet, "eth_call", [{"to": GPO, "data": GET_L1_FEE_UPPER_BOUND + hex(n + 68)[2:].rjust(64, "0")}, "latest"]), 16)
    usd = int(rpc(mainnet, "eth_call", [{"to": CHAINLINK_ETH_USD, "data": "0xfeaf968c"}, "latest"])[2 + 64:2 + 128], 16) / 1e8
    total = l2 + l1
    print(f"mainnet base fee {base / 1e9:.6f} gwei (max of 20 blocks), priority {tip / 1e9:.6f} gwei (median)")
    print(f"L2 execution {l2 / 1e18:.8f} ETH, L1 data (upper bound) {l1 / 1e18:.8f} ETH")
    print(f"TOTAL {total / 1e18:.8f} ETH = ${total / 1e18 * usd:.2f} at ETH ${usd:,.2f}")


if __name__ == "__main__":
    main()
