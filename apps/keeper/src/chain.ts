// Every network call the keeper makes, behind one interface so the tick and the status page are pure and
// testable with a fake.
import { aggregatorV3Abi, createBaseClient, oracleRegistryAbi, splitRpcUrls, PUBLIC_RPC_URLS, CHAIN_IDS, type BaseClient } from "@boundline/chain";
import { createWalletClient, fallback, http, type Abi, type Account, type Address, type Hex, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { mirrorOracleRegistryAbi, testPriceFeedAbi } from "./abis.js";
import { MAINNET_REGISTRY, SEPOLIA_REGISTRY, type MirrorPair } from "./config.js";
import type { RegistryParams, Round, RoundArgs } from "./plan.js";

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
  /** Null on timeout; the next tick's nonce check covers a transaction still in flight. */
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<Receipt | null>;
}

export interface ViemChainOptions {
  mainnetRpc: string;
  sepoliaRpc: string;
  keeperKey: Hex | null;
}

type Wallet = WalletClient<Transport, typeof baseSepolia, Account>;
type Multicallable = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };

function sepoliaUrls(list: string): string[] {
  const given = splitRpcUrls(list);
  return given.length > 0 ? given : [...PUBLIC_RPC_URLS[CHAIN_IDS.baseSepolia]];
}

function describe(err: unknown): string {
  if (err instanceof Error) return (err as Error & { shortMessage?: string }).shortMessage ?? err.message;
  return String(err);
}

async function readSide(
  client: BaseClient,
  chainId: number,
  pairs: readonly MirrorPair[],
  feedOf: (p: MirrorPair) => Address,
  tokenOf: (p: MirrorPair) => Address,
  registry: Address,
): Promise<SideReads> {
  const contracts: Multicallable[] = [];
  for (const p of pairs) {
    contracts.push(
      { address: feedOf(p), abi: aggregatorV3Abi, functionName: "latestRoundData" },
      { address: registry, abi: oracleRegistryAbi, functionName: "getOracleParams", args: [tokenOf(p)] },
    );
  }
  const [block, results] = await Promise.all([client.getBlockNumber(), client.multicall({ contracts, allowFailure: true })]);
  const rounds = new Map<string, ReadResult<Round>>();
  const reg = new Map<string, ReadResult<RegistryParams>>();
  pairs.forEach((p, i) => {
    const r = results[2 * i];
    const g = results[2 * i + 1];
    if (r?.status === "success") {
      const [roundId, answer, startedAt, updatedAt, answeredInRound] = r.result as readonly [bigint, bigint, bigint, bigint, bigint];
      rounds.set(p.symbol, { ok: true, value: { roundId, answer, startedAt, updatedAt, answeredInRound } });
    } else {
      rounds.set(p.symbol, { ok: false, error: r ? describe(r.error) : "no result" });
    }
    if (g?.status === "success") {
      const [multiplier, paused] = g.result as readonly [bigint, boolean];
      reg.set(p.symbol, { ok: true, value: { multiplier, paused } });
    } else {
      reg.set(p.symbol, { ok: false, error: g ? describe(g.error) : "no result" });
    }
  });
  return { chainId, block, rounds, registry: reg };
}

/** The real thing: viem public clients on both chains (RPC fallback lists) and a wallet client on Sepolia when a key is given. */
export function createViemMirrorChain(opts: ViemChainOptions): MirrorChain {
  const mainnet = createBaseClient({ chainId: CHAIN_IDS.base, rpcUrl: opts.mainnetRpc });
  const sepolia = createBaseClient({ chainId: CHAIN_IDS.baseSepolia, rpcUrl: opts.sepoliaRpc });
  const account = opts.keeperKey ? privateKeyToAccount(opts.keeperKey) : null;
  let wallet: Wallet | null = null;
  if (account) {
    const transports = sepoliaUrls(opts.sepoliaRpc).map((url) => http(url, { batch: false, retryCount: 1, timeout: 20_000 }));
    wallet = createWalletClient({
      account,
      chain: baseSepolia,
      transport: transports.length === 1 ? transports[0]! : fallback(transports, { rank: false, retryCount: 0 }),
    });
  }
  const keeper = account?.address ?? null;
  const requireWallet = (): Wallet => {
    if (!wallet) throw new Error("no KEEPER_KEY: the keeper is read-only");
    return wallet;
  };
  return {
    keeper,
    readMainnet: (pairs) => readSide(mainnet, CHAIN_IDS.base, pairs, (p) => p.mainnetFeed, (p) => p.mainnetToken, MAINNET_REGISTRY),
    readSepolia: (pairs) => readSide(sepolia, CHAIN_IDS.baseSepolia, pairs, (p) => p.sepoliaFeed, (p) => p.sepoliaToken, SEPOLIA_REGISTRY),
    async nonces() {
      if (!keeper) throw new Error("no keeper");
      const [latest, pending] = await Promise.all([
        sepolia.getTransactionCount({ address: keeper, blockTag: "latest" }),
        sepolia.getTransactionCount({ address: keeper, blockTag: "pending" }),
      ]);
      return { latest: BigInt(latest), pending: BigInt(pending) };
    },
    async balance() {
      if (!keeper) return 0n;
      return sepolia.getBalance({ address: keeper });
    },
    setRoundData(feed, args, nonce) {
      return requireWallet().writeContract({
        address: feed,
        abi: testPriceFeedAbi,
        functionName: "setRoundData",
        args: [args[0], args[1], args[2], args[3], args[4]],
        nonce: Number(nonce),
      });
    },
    setOracleParams(token, multiplier, paused, nonce) {
      return requireWallet().writeContract({
        address: SEPOLIA_REGISTRY,
        abi: mirrorOracleRegistryAbi,
        functionName: "setOracleParams",
        args: [token, multiplier, paused],
        nonce: Number(nonce),
      });
    },
    async waitForReceipt(hash, timeoutMs) {
      try {
        const r = await sepolia.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 1_000 });
        return { blockNumber: r.blockNumber, status: r.status, gasUsed: r.gasUsed };
      } catch {
        return null;
      }
    },
  };
}
