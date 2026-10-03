import { createPublicClient, http, type HttpTransport, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { CHAIN_IDS, type ChainId } from "./addresses.js";

export interface BaseClientOptions {
  chainId: ChainId;
  rpcUrl?: string;
  /** Multicall batch wait in ms; reads issued within the window share one eth_call. */
  batchWaitMs?: number;
  /** Cap on calls per multicall; the public RPC accepts large batches but keep it modest. */
  batchSize?: number;
}

export type BaseChain = typeof base | typeof baseSepolia;
export type BaseClient = PublicClient<HttpTransport, BaseChain>;

/** A viem public client for Base or Base Sepolia with multicall batching on. */
export function createBaseClient(opts: BaseClientOptions): BaseClient {
  const chain: BaseChain = opts.chainId === CHAIN_IDS.baseSepolia ? baseSepolia : base;
  const url =
    opts.rpcUrl ?? (opts.chainId === CHAIN_IDS.baseSepolia ? "https://sepolia.base.org" : "https://mainnet.base.org");
  return createPublicClient({
    chain,
    transport: http(url, { batch: false, retryCount: 2, timeout: 20_000 }),
    batch: { multicall: { wait: opts.batchWaitMs ?? 16, batchSize: opts.batchSize ?? 1024 } },
  });
}
