import { createPublicClient, fallback, http, type FallbackTransport, type HttpTransport, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { CHAIN_IDS, type ChainId } from "./addresses.js";

export interface BaseClientOptions {
  chainId: ChainId;
  /** One RPC URL, or several separated by commas: the first is tried first, the rest are fallbacks. */
  rpcUrl?: string;
  /** Multicall batch wait in ms; reads issued within the window share one eth_call. */
  batchWaitMs?: number;
  /** Cap on calls per multicall; the public RPC accepts large batches but keep it modest. */
  batchSize?: number;
}

export type BaseChain = typeof base | typeof baseSepolia;
export type BaseClient = PublicClient<HttpTransport | FallbackTransport<HttpTransport[]>, BaseChain>;

/** Public Base RPCs that answered Multicall3 and Aerodrome `observe` reads on 3 Oct 2026; `mainnet.base.org` rate-limits shared egress such as Cloudflare's, so it goes last. */
export const PUBLIC_RPC_URLS: Readonly<Record<ChainId, readonly string[]>> = {
  [CHAIN_IDS.base]: ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://mainnet.base.org"],
  [CHAIN_IDS.baseSepolia]: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
};

/** Splits a comma-separated RPC list, dropping blanks. */
export function splitRpcUrls(list: string | undefined): string[] {
  return (list ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

/** A viem public client for Base or Base Sepolia with multicall batching on and RPC fallback when several URLs are given. */
export function createBaseClient(opts: BaseClientOptions): BaseClient {
  const chain: BaseChain = opts.chainId === CHAIN_IDS.baseSepolia ? baseSepolia : base;
  const given = splitRpcUrls(opts.rpcUrl);
  const urls = given.length > 0 ? given : [...PUBLIC_RPC_URLS[opts.chainId]];
  const transports = urls.map((url) => http(url, { batch: false, retryCount: 1, timeout: 20_000 }));
  const transport = transports.length === 1 ? transports[0]! : fallback(transports, { rank: false, retryCount: 0 });
  return createPublicClient({
    chain,
    transport,
    batch: { multicall: { wait: opts.batchWaitMs ?? 16, batchSize: opts.batchSize ?? 1024 } },
  });
}
