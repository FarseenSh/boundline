// Validity-transaction prototype (Cobalt): submit a signed transaction that Base includes only while a storage
// slot matches a predicate, with a block-number expiry. This is the keeper's Saturday / first-block-after-reopen
// mechanism from plan M13, exercised on Base Sepolia against the Boundline TestPriceFeed:
//
//   op "="  on the feed's updatedAt slot  → "only while the feed still shows this round" (the Saturday repay)
//   op "!=" on the same slot              → "only once the feed has printed a new round" (the first-block repay)
//
// Usage (never prints the key):
//   KEY=$BOUNDLINE_TESTNET_VALIDITY_KEY pnpm --filter @boundline/keeper exec tsx scripts/validity-tx.ts \
//     --rpc https://sepolia.base.org --sequencer https://sepolia-sequencer.base.org \
//     --feed 0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a --slot 5 --op '!=' \
//     --desk 0x39aBaDc0aAa12D1F7e259b89536Aa1848997399a --line 1 --amount 100000 --expires-in 3000 [--wait 120]
//   ... --watch 0x<hash>   polls a receipt for an earlier submission.
//   ... --loop 50 --deadline 5400   re-arm: the sequencer only accepts a block bound about 32 blocks ahead
//                                   (measured 6 Oct 2026: "maximum permitted block" = head + 32), so a transaction
//                                   that must wait for a state change is re-submitted with a fresh bound every
//                                   --loop seconds until it lands or --deadline seconds pass. Same nonce, same
//                                   signed bytes, same hash: only the predicate window moves.
import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const need = (k: string): string => {
  const v = args.get(k);
  if (!v) throw new Error(`missing --${k}`);
  return v;
};

const rpcUrl = need("rpc");
const sequencerUrl = args.get("sequencer") ?? rpcUrl;
let id = 0;
async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const text = await res.text();
  let body: { result?: unknown; error?: { code: number; message: string } };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // Public RPCs answer rate limits and outages with an HTML page; surface it as an RPC error, not a crash.
    throw new Error(`${method}: HTTP ${res.status} non-JSON answer from ${new URL(url).host}: ${text.slice(0, 60).replace(/\s+/g, " ")}`);
  }
  if (body.error) throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
  return body.result;
}
const hex = (n: bigint | number): Hex => `0x${BigInt(n).toString(16)}`;

async function watch(hash: Hex, seconds: number): Promise<void> {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const r = (await rpc(rpcUrl, "eth_getTransactionReceipt", [hash])) as { blockNumber: Hex; status: Hex; gasUsed: Hex } | null;
    if (r) {
      console.log(JSON.stringify({ hash, included: true, block: Number(r.blockNumber), status: r.status === "0x1" ? "success" : "reverted", gasUsed: Number(r.gasUsed) }));
      return;
    }
    if (Date.now() > until) {
      console.log(JSON.stringify({ hash, included: false, note: "not included yet: the predicate is not satisfied, or the bound expired" }));
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main(): Promise<void> {
  if (args.has("watch")) return watch(args.get("watch") as Hex, Number(args.get("wait") ?? 60));
  const key = process.env.KEY as Hex | undefined;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("set KEY in the environment");
  const account = privateKeyToAccount(key);
  const feed = need("feed") as Address;
  const slot = hex(BigInt(need("slot")));
  const op = need("op");
  const desk = need("desk") as Address;
  const line = BigInt(need("line"));
  const amount = BigInt(need("amount"));
  const expiresIn = BigInt(args.get("expires-in") ?? "3000");

  const chainId = Number(await rpc(rpcUrl, "eth_chainId", []));
  const head = BigInt((await rpc(rpcUrl, "eth_blockNumber", [])) as Hex);
  const current = (await rpc(rpcUrl, "eth_getStorageAt", [feed, slot, "latest"])) as Hex;
  const value = (args.get("value") ?? current) as Hex;
  const nonce = Number(await rpc(rpcUrl, "eth_getTransactionCount", [account.address, "pending"]));
  const gasPrice = BigInt((await rpc(rpcUrl, "eth_gasPrice", [])) as Hex);
  const maxPriorityFeePerGas = 1_000_000n;
  const maxFeePerGas = (gasPrice * 3n > 20_000_000n ? gasPrice * 3n : 20_000_000n) + maxPriorityFeePerGas;

  const data = encodeFunctionData({
    abi: [{ type: "function", name: "repay", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }] }],
    functionName: "repay",
    args: [line, amount],
  });
  const raw = await account.signTransaction({ chainId, type: "eip1559", nonce, to: desk, data, value: 0n, gas: 250_000n, maxFeePerGas, maxPriorityFeePerGas });
  const validity = [
    { type: "storage", params: { address: feed, slot, op, value } },
    { type: "block_number", params: { op: "<=", value: hex(head + expiresIn) } },
  ];
  console.log(JSON.stringify({ from: account.address, nonce, to: desk, action: `repay(${line}, ${amount})`, predicate: { feed, slot, op, value, currentSlotValue: current, satisfiedNow: op === "=" ? current === value : current !== value }, expiresAtBlock: Number(head + expiresIn), head: Number(head), sequencer: sequencerUrl }, null, 2));
  const submit = async (bound: bigint): Promise<Hex> => {
    const v = [validity[0], { type: "block_number", params: { op: "<=", value: hex(bound) } }];
    return (await rpc(sequencerUrl, "base_sendRawTransactionValidity", [raw, { validity: v }])) as Hex;
  };
  // A restart while the previous arming is still alive answers "already known": the transaction is armed under its
  // old bound, so carry on with the same hash (keccak of the signed bytes) and re-arm from the loop.
  let hash: Hex;
  try {
    hash = await submit(head + expiresIn);
    console.log(JSON.stringify({ accepted: true, hash, at: new Date().toISOString() }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already known/i.test(msg)) throw err;
    hash = keccak256(raw);
    console.log(JSON.stringify({ accepted: true, alreadyKnown: true, hash, at: new Date().toISOString() }));
  }
  if (args.has("loop")) {
    const every = Number(args.get("loop")) * 1000;
    const deadline = Date.now() + Number(args.get("deadline") ?? "5400") * 1000;
    let submissions = 1;
    for (;;) {
      // One failed read (rate limit, outage) must not end the watch: log it and try again next cycle.
      try {
        const r = (await rpc(rpcUrl, "eth_getTransactionReceipt", [hash])) as { blockNumber: Hex; status: Hex; gasUsed: Hex } | null;
        if (r) {
          const slotNow = (await rpc(rpcUrl, "eth_getStorageAt", [feed, slot, r.blockNumber])) as Hex;
          console.log(JSON.stringify({ hash, included: true, block: Number(r.blockNumber), status: r.status === "0x1" ? "success" : "reverted", gasUsed: Number(r.gasUsed), slotValueInThatBlock: slotNow, submissions, at: new Date().toISOString() }));
          return;
        }
      } catch (err) {
        console.log(JSON.stringify({ readFailed: true, error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() }));
      }
      if (Date.now() > deadline) {
        console.log(JSON.stringify({ hash, included: false, submissions, note: "deadline passed" }));
        return;
      }
      await new Promise((r) => setTimeout(r, every));
      try {
        const h = BigInt((await rpc(rpcUrl, "eth_blockNumber", [])) as Hex);
        const cur = (await rpc(rpcUrl, "eth_getStorageAt", [feed, slot, "latest"])) as Hex;
        hash = await submit(h + expiresIn);
        submissions += 1;
        console.log(JSON.stringify({ rearmed: true, submissions, head: Number(h), bound: Number(h + expiresIn), slotNow: cur, satisfiedNow: op === "=" ? cur === value : cur !== value, at: new Date().toISOString() }));
      } catch (err) {
        console.log(JSON.stringify({ rearmFailed: true, error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() }));
      }
    }
  }
  if (args.has("wait")) await watch(hash, Number(args.get("wait")));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
