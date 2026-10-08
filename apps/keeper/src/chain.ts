// Every network call the keeper makes, behind one interface so the tick and the status page are pure and
// testable with a fake.
//
// Budget: the Workers Free plan allows 10 ms of CPU per invocation. This adapter therefore avoids viem's generic
// ABI machinery (see src/raw.ts for the measurements) and, since 8 Oct 2026, viem's transport too: reads go through
// the raw client in src/rpc.ts, one JSON-RPC batch per side. Only viem's local-account signer remains; its one-time
// cost (noble-curves' base-point tables, about 18 ms) is paid at module evaluation, which has its own startup budget,
// and the account is memoised per isolate.
import { splitRpcUrls, CHAIN_IDS } from "@boundline/chain";
import type { Address, Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { GAS_LIMIT, MIN_MAX_FEE_WEI, PRIORITY_FEE_WEI, MAINNET_REGISTRY, SEPOLIA_REGISTRY, type MirrorPair } from "./config.js";
import type { RegistryParams, Round, RoundArgs } from "./plan.js";
import {
  MULTICALL3,
  decodeAggregate3,
  decodeLatestRoundData,
  decodeOracleParams,
  describeRevert,
  encodeAggregate3,
  encodeGetOracleParams,
  encodeLatestRoundData,
  encodeSetOracleParams,
  encodeSetRoundData,
  hexToBigInt,
  type Call3,
} from "./raw.js";
import { rpcFor, type RpcClient } from "./rpc.js";

export type ReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SideReads {
  chainId: number;
  block: bigint;
  /** By pair symbol (the Sepolia test stock symbol on both sides). */
  rounds: Map<string, ReadResult<Round>>;
  registry: Map<string, ReadResult<RegistryParams>>;
}

export interface Receipt {
  blockNumber: bigint;
  status: "success" | "reverted";
  gasUsed: bigint;
}

export interface MirrorChain {
  /** The keeper's address, null when the Worker has no key (read-only mode). */
  readonly keeper: Address | null;
  readMainnet(pairs: readonly MirrorPair[]): Promise<SideReads>;
  readSepolia(pairs: readonly MirrorPair[]): Promise<SideReads>;
  /** Keeper nonces on Sepolia. */
  nonces(): Promise<{ latest: bigint; pending: bigint }>;
  /** Keeper ETH balance on Sepolia, wei. */
  balance(): Promise<bigint>;
  setRoundData(feed: Address, args: RoundArgs, nonce: bigint): Promise<Hex>;
  setOracleParams(token: Address, multiplier: bigint, paused: boolean, nonce: bigint): Promise<Hex>;
  /** Null when the receipt is not there yet; a tick never waits for it, the status tooling may. */
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<Receipt | null>;
}

export interface ViemChainOptions {
  mainnetRpc: string;
  sepoliaRpc: string;
  keeperKey: Hex | null;
}

// ---------------------------------------------------------------------------------------------- warm-up

/** Not a secret: the scalar 1. Deriving its account at module load builds noble's tables once per isolate. */
const WARMUP_KEY: Hex = "0x0000000000000000000000000000000000000000000000000000000000000001";
const warmAccount = privateKeyToAccount(WARMUP_KEY);
void warmAccount
  .signTransaction({
    chainId: CHAIN_IDS.baseSepolia,
    type: "eip1559",
    nonce: 0,
    to: "0x0000000000000000000000000000000000000000",
    value: 0n,
    gas: 21_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    data: "0x",
  })
  .catch(() => undefined);

// ---------------------------------------------------------------------------------------------- memo

let cachedAccount: { key: Hex; account: PrivateKeyAccount } | null = null;
function accountFor(key: Hex): PrivateKeyAccount {
  if (cachedAccount && cachedAccount.key === key) return cachedAccount.account;
  const account = privateKeyToAccount(key);
  cachedAccount = { key, account };
  return account;
}

let cachedChain: { opts: ViemChainOptions; chain: MirrorChain } | null = null;

/** The memoised adapter for a Worker: one per isolate as long as the RPC lists and the key do not change. */
export function getMirrorChain(opts: ViemChainOptions): MirrorChain {
  const c = cachedChain;
  if (c && c.opts.mainnetRpc === opts.mainnetRpc && c.opts.sepoliaRpc === opts.sepoliaRpc && c.opts.keeperKey === opts.keeperKey) return c.chain;
  const chain = createViemMirrorChain(opts);
  cachedChain = { opts, chain };
  return chain;
}

// ---------------------------------------------------------------------------------------------- reads

function describe(err: unknown): string {
  if (err instanceof Error) return (err as Error & { shortMessage?: string }).shortMessage ?? err.message;
  return String(err);
}

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

async function readSide(
  client: RpcClient,
  chainId: number,
  pairs: readonly MirrorPair[],
  feedOf: (p: MirrorPair) => Address,
  tokenOf: (p: MirrorPair) => Address,
  registry: Address,
): Promise<SideReads> {
  const calls: Call3[] = [];
  for (const p of pairs) {
    calls.push({ target: feedOf(p), allowFailure: true, callData: encodeLatestRoundData() });
    calls.push({ target: registry, allowFailure: true, callData: encodeGetOracleParams(tokenOf(p)) });
  }
  // One HTTP request: the head and the multicall as a JSON-RPC batch.
  const [blockO, callO] = await client.batch([
    { method: "eth_blockNumber", params: [] },
    { method: "eth_call", params: [{ to: MULTICALL3, data: encodeAggregate3(calls) }, "latest"] },
  ]);
  if (!blockO?.ok) throw new Error(`eth_blockNumber: ${blockO?.ok === false ? blockO.error : "missing"}`);
  if (!callO?.ok) throw new Error(`eth_call: ${callO?.ok === false ? callO.error : "missing"}`);
  const blockHex = blockO.result as Hex;
  const results = decodeAggregate3(callO.result as Hex);
  const rounds = new Map<string, ReadResult<Round>>();
  const reg = new Map<string, ReadResult<RegistryParams>>();
  pairs.forEach((p, i) => {
    const r = results[2 * i];
    const g = results[2 * i + 1];
    try {
      if (!r) throw new Error("no result");
      if (!r.success) throw new Error(describeRevert(r.returnData));
      rounds.set(p.symbol, { ok: true, value: decodeLatestRoundData(r.returnData) });
    } catch (err) {
      rounds.set(p.symbol, { ok: false, error: describe(err) });
    }
    try {
      if (!g) throw new Error("no result");
      if (!g.success) throw new Error(describeRevert(g.returnData));
      reg.set(p.symbol, { ok: true, value: decodeOracleParams(g.returnData) });
    } catch (err) {
      reg.set(p.symbol, { ok: false, error: describe(err) });
    }
  });
  return { chainId, block: hexToBigInt(blockHex), rounds, registry: reg };
}

// ---------------------------------------------------------------------------------------------- the adapter

/** The real thing: raw JSON-RPC clients on both chains (RPC fallback lists), raw calls, a local signer on Sepolia when a key is given. */
export function createViemMirrorChain(opts: ViemChainOptions, clients?: { mainnet: RpcClient; sepolia: RpcClient }): MirrorChain {
  const mainnetClient = clients?.mainnet ?? rpcFor(splitRpcUrls(opts.mainnetRpc).join(","));
  const sepoliaClient = clients?.sepolia ?? rpcFor(splitRpcUrls(opts.sepoliaRpc).join(","));
  const sepolia: Rpc = (method, params) => sepoliaClient.call(method, params);
  const account = opts.keeperKey ? accountFor(opts.keeperKey) : null;
  const keeper = account?.address ?? null;

  async function fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const gasPrice = hexToBigInt((await sepolia("eth_gasPrice", [])) as Hex);
    const maxFeePerGas = (gasPrice * 3n > MIN_MAX_FEE_WEI ? gasPrice * 3n : MIN_MAX_FEE_WEI) + PRIORITY_FEE_WEI;
    return { maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE_WEI };
  }

  async function send(to: Address, data: Hex, nonce: bigint): Promise<Hex> {
    if (!account) throw new Error("no KEEPER_KEY: the keeper is read-only");
    const { maxFeePerGas, maxPriorityFeePerGas } = await fees();
    const signed = await account.signTransaction({
      chainId: CHAIN_IDS.baseSepolia,
      type: "eip1559",
      nonce: Number(nonce),
      to,
      value: 0n,
      gas: GAS_LIMIT,
      maxFeePerGas,
      maxPriorityFeePerGas,
      data,
    });
    return (await sepolia("eth_sendRawTransaction", [signed])) as Hex;
  }

  return {
    keeper,
    readMainnet: (pairs) => readSide(mainnetClient, CHAIN_IDS.base, pairs, (p) => p.mainnetFeed, (p) => p.mainnetToken, MAINNET_REGISTRY),
    readSepolia: (pairs) => readSide(sepoliaClient, CHAIN_IDS.baseSepolia, pairs, (p) => p.sepoliaFeed, (p) => p.sepoliaToken, SEPOLIA_REGISTRY),
    async nonces() {
      if (!keeper) throw new Error("no keeper");
      const [latestO, pendingO] = await sepoliaClient.batch([
        { method: "eth_getTransactionCount", params: [keeper, "latest"] },
        { method: "eth_getTransactionCount", params: [keeper, "pending"] },
      ]);
      if (!latestO?.ok || !pendingO?.ok) throw new Error(`nonces: ${latestO?.ok === false ? latestO.error : ""} ${pendingO?.ok === false ? pendingO.error : ""}`.trim());
      return { latest: hexToBigInt(latestO.result as Hex), pending: hexToBigInt(pendingO.result as Hex) };
    },
    async balance() {
      if (!keeper) return 0n;
      return hexToBigInt((await sepolia("eth_getBalance", [keeper, "latest"])) as Hex);
    },
    setRoundData: (feed, args, nonce) => send(feed, encodeSetRoundData(args), nonce),
    setOracleParams: (token, multiplier, paused, nonce) => send(SEPOLIA_REGISTRY, encodeSetOracleParams(token, multiplier, paused), nonce),
    async waitForReceipt(hash, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const r = (await sepolia("eth_getTransactionReceipt", [hash])) as { blockNumber: Hex; status: Hex; gasUsed: Hex } | null;
        if (r) return { blockNumber: hexToBigInt(r.blockNumber), status: hexToBigInt(r.status) === 1n ? "success" : "reverted", gasUsed: hexToBigInt(r.gasUsed) };
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    },
  };
}
