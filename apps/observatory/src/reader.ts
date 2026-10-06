// Every onchain read the Observatory makes lives here, behind one interface, so the rest of the
// app is pure and testable with a stub reader.
//
// One `eth_call` to Multicall3 per snapshot: the block number and timestamp (Multicall3's own helpers,
// so they describe the very block the reads ran on), eight reads per token and three per Aerodrome
// pool. The calldata is built once per token list at module scope and the response is decoded word by
// word (encoding.ts), which keeps a tick far inside the Workers Free plan's 10 ms CPU budget; viem's
// generic multicall cost 17 ms warm and about 90 ms cold on 6 Oct 2026.
import { B20_TOKENS, CHAIN_IDS, MAINNET, PUBLIC_RPC_URLS, createBaseClient, splitRpcUrls, type B20Token, type BaseClient } from "@boundline/chain";
import type { Address, Hex } from "viem";
import {
  MULTICALL3,
  SELECTOR,
  callData,
  decodeAggregate3,
  decodeBool,
  decodeLatestRoundData,
  decodeObserve,
  decodeOracleParams,
  decodeSlot0,
  decodeUint,
  decodeUint8Array,
  encodeAggregate3,
  observeCallData,
  wordAddress,
  wordUint,
  type Call,
  type CallResult,
} from "./encoding.js";
import { ethCaller, type EthCall, type RpcOptions } from "./rpc.js";

export const TWAP_WINDOW_SECONDS = 3600;
/** The two Multicall3 helpers at the front of every aggregate: getBlockNumber, getCurrentBlockTimestamp. */
export const HEAD_CALLS = 2;
export const TOKEN_STRIDE = 8;
export const POOL_STRIDE = 3;

export interface TokenRead {
  symbol: string;
  address: Address;
  feed: Address;
  feedAnswer: bigint;
  feedUpdatedAt: bigint;
  feedRoundId: bigint;
  feedDecimals: number;
  registryMultiplier: bigint;
  registryPaused: boolean;
  transferPaused: boolean;
  pausedFeatures: number[];
  uiMultiplier: bigint;
  newUIMultiplier: bigint;
  effectiveAt: bigint;
  /** Calls that failed in the multicall, by name; the row is still produced. */
  errors: string[];
}

export interface PoolRead {
  symbol: string;
  pool: Address;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  /** [atWindowAgo, now] tick cumulatives, null when the pool has no 1h history. */
  tickCumulatives: [bigint, bigint] | null;
  twapWindow: number;
}

export interface ChainReads {
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: number;
  tokens: TokenRead[];
  pools: PoolRead[];
}

export interface ChainReader {
  read(tokens?: readonly B20Token[]): Promise<ChainReads>;
}

export interface ReadPlan {
  tokens: readonly B20Token[];
  pooled: readonly B20Token[];
  calls: readonly Call[];
  /** aggregate3 calldata for `calls`. */
  data: Hex;
}

const plans = new WeakMap<readonly B20Token[], ReadPlan>();

/** The aggregate for a token list, built once per list. */
export function planReads(tokens: readonly B20Token[] = B20_TOKENS): ReadPlan {
  const hit = plans.get(tokens);
  if (hit) return hit;
  const calls: Call[] = [
    { target: MULTICALL3, callData: SELECTOR.getBlockNumber },
    { target: MULTICALL3, callData: SELECTOR.getCurrentBlockTimestamp },
  ];
  for (const t of tokens) {
    calls.push(
      { target: t.feed, callData: SELECTOR.latestRoundData },
      { target: t.feed, callData: SELECTOR.decimals },
      { target: MAINNET.oracleRegistry, callData: callData(SELECTOR.getOracleParams, wordAddress(t.address)) },
      { target: t.address, callData: callData(SELECTOR.isPaused, wordUint(0)) },
      { target: t.address, callData: SELECTOR.pausedFeatures },
      { target: t.address, callData: SELECTOR.uiMultiplier },
      { target: t.address, callData: SELECTOR.newUIMultiplier },
      { target: t.address, callData: SELECTOR.effectiveAt },
    );
  }
  const pooled = tokens.filter((t) => t.aerodromePool !== undefined);
  for (const t of pooled) {
    const pool = t.aerodromePool as Address;
    calls.push(
      { target: pool, callData: SELECTOR.slot0 },
      { target: pool, callData: SELECTOR.liquidity },
      { target: pool, callData: observeCallData([TWAP_WINDOW_SECONDS, 0]) },
    );
  }
  const plan: ReadPlan = { tokens, pooled, calls, data: encodeAggregate3(calls) };
  plans.set(tokens, plan);
  return plan;
}

/** Built when the module is evaluated (the Worker's startup budget), never inside a tick. */
export const DEFAULT_PLAN: ReadPlan = planReads(B20_TOKENS);

function attempt<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Shapes aggregate3 results into ChainReads. Pure; the decoder test drives it with a recorded response. */
export function shapeReads(plan: ReadPlan, results: readonly CallResult[]): ChainReads {
  if (results.length !== plan.calls.length) throw new Error(`aggregate3 returned ${results.length} results for ${plan.calls.length} calls`);
  const head = (i: number, name: string): bigint => {
    const r = results[i];
    if (!r?.success) throw new Error(`${name} failed inside the aggregate`);
    return decodeUint(r.data);
  };
  const blockNumber = head(0, "getBlockNumber");
  const blockTimestamp = Number(head(1, "getCurrentBlockTimestamp"));

  const tokens: TokenRead[] = plan.tokens.map((t, i) => {
    const base = HEAD_CALLS + i * TOKEN_STRIDE;
    const errors: string[] = [];
    const take = <T>(offset: number, name: string, decode: (data: string) => T, fallback: T): T => {
      const r = results[base + offset];
      if (!r || !r.success) {
        errors.push(name);
        return fallback;
      }
      const value = attempt(() => decode(r.data));
      if (value === null) {
        errors.push(name);
        return fallback;
      }
      return value;
    };
    const round = take(0, "latestRoundData", decodeLatestRoundData, [0n, 0n, 0n, 0n, 0n] as const);
    const params = take(2, "getOracleParams", decodeOracleParams, [10n ** 18n, false] as const);
    return {
      symbol: t.symbol,
      address: t.address,
      feed: t.feed,
      feedRoundId: round[0],
      feedAnswer: round[1],
      feedUpdatedAt: round[3],
      feedDecimals: take(1, "decimals", (d) => Number(decodeUint(d)), 8),
      registryMultiplier: params[0],
      registryPaused: params[1],
      transferPaused: take(3, "isPaused", decodeBool, false),
      pausedFeatures: take(4, "pausedFeatures", decodeUint8Array, []),
      uiMultiplier: take(5, "uiMultiplier", decodeUint, 10n ** 18n),
      newUIMultiplier: take(6, "newUIMultiplier", decodeUint, 10n ** 18n),
      effectiveAt: take(7, "effectiveAt", decodeUint, 0n),
      errors,
    };
  });

  const poolBase = HEAD_CALLS + plan.tokens.length * TOKEN_STRIDE;
  const pools: PoolRead[] = plan.pooled.map((t, i) => {
    const base = poolBase + i * POOL_STRIDE;
    const s = results[base];
    const l = results[base + 1];
    const o = results[base + 2];
    const slot0 = s?.success ? attempt(() => decodeSlot0(s.data)) : null;
    const liquidity = (l?.success ? attempt(() => decodeUint(l.data)) : null) ?? 0n;
    const obs = o?.success ? attempt(() => decodeObserve(o.data)) : null;
    const cum = obs && obs[0].length === 2 ? ([obs[0][0] as bigint, obs[0][1] as bigint] as [bigint, bigint]) : null;
    return {
      symbol: t.symbol,
      pool: t.aerodromePool as Address,
      sqrtPriceX96: slot0 ? slot0[0] : 0n,
      tick: slot0 ? slot0[1] : 0,
      liquidity,
      tickCumulatives: cum,
      twapWindow: TWAP_WINDOW_SECONDS,
    };
  });

  return { chainId: 8453, blockNumber, blockTimestamp, tokens, pools };
}

const clients = new Map<string, BaseClient>();

/** One viem client per RPC list, reused across invocations of a warm isolate (building one costs about a millisecond). */
export function clientFor(rpcUrl: string, chainId: 8453 | 84532 = 8453): BaseClient {
  const key = `${chainId}:${rpcUrl}`;
  const hit = clients.get(key);
  if (hit) return hit;
  const client = createBaseClient({ chainId, rpcUrl });
  clients.set(key, client);
  return client;
}

/** The comma-separated RPC list as URLs, or the public mainnet list when empty. */
export function rpcUrlsOf(rpcUrl: string): string[] {
  const given = splitRpcUrls(rpcUrl);
  return given.length > 0 ? given : [...PUBLIC_RPC_URLS[CHAIN_IDS.base]];
}

/** One `eth_call` to Multicall3, decoded. */
export async function callAggregate3(call: EthCall, data: Hex): Promise<CallResult[]> {
  return decodeAggregate3(await call(MULTICALL3, data));
}

/** Reader against a Base RPC list: one aggregate for every token and pool, block header included, over raw JSON-RPC. */
export function createRpcReader(rpcUrl: string, opts: RpcOptions = {}): ChainReader {
  const call = ethCaller(rpcUrlsOf(rpcUrl), opts);
  return {
    async read(tokens = B20_TOKENS) {
      const plan = planReads(tokens);
      return shapeReads(plan, await callAggregate3(call, plan.data));
    },
  };
}
