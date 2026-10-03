// Every onchain read the Observatory makes lives here, behind one interface, so the rest of the
// app is pure and testable with a stub reader.
import {
  B20_TOKENS,
  MAINNET,
  aggregatorV3Abi,
  b20AssetAbi,
  clPoolAbi,
  createBaseClient,
  oracleRegistryAbi,
  type B20Token,
} from "@boundline/chain";
import type { Address } from "viem";

export const TWAP_WINDOW_SECONDS = 3600;

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

type Multicallable = Parameters<ReturnType<typeof createBaseClient>["multicall"]>[0]["contracts"][number];

/** Reader against a Base RPC: one multicall for every token and pool, plus one block header. */
export function createViemReader(rpcUrl: string): ChainReader {
  const client = createBaseClient({ chainId: 8453, rpcUrl });
  return {
    async read(tokens = B20_TOKENS) {
      const tokenCalls: Multicallable[] = [];
      for (const t of tokens) {
        tokenCalls.push(
          { address: t.feed, abi: aggregatorV3Abi, functionName: "latestRoundData" },
          { address: t.feed, abi: aggregatorV3Abi, functionName: "decimals" },
          { address: MAINNET.oracleRegistry, abi: oracleRegistryAbi, functionName: "getOracleParams", args: [t.address] },
          { address: t.address, abi: b20AssetAbi, functionName: "isPaused", args: [0] },
          { address: t.address, abi: b20AssetAbi, functionName: "pausedFeatures" },
          { address: t.address, abi: b20AssetAbi, functionName: "uiMultiplier" },
          { address: t.address, abi: b20AssetAbi, functionName: "newUIMultiplier" },
          { address: t.address, abi: b20AssetAbi, functionName: "effectiveAt" },
        );
      }
      const pooled = tokens.filter((t) => t.aerodromePool !== undefined);
      const poolCalls: Multicallable[] = [];
      for (const t of pooled) {
        const pool = t.aerodromePool as Address;
        poolCalls.push(
          { address: pool, abi: clPoolAbi, functionName: "slot0" },
          { address: pool, abi: clPoolAbi, functionName: "liquidity" },
          { address: pool, abi: clPoolAbi, functionName: "observe", args: [[TWAP_WINDOW_SECONDS, 0]] },
        );
      }
      const [block, results] = await Promise.all([
        client.getBlock({ blockTag: "latest", includeTransactions: false }),
        client.multicall({ contracts: [...tokenCalls, ...poolCalls], allowFailure: true }),
      ]);

      const TOKEN_STRIDE = 8;
      const out: TokenRead[] = tokens.map((t, i) => {
        const r = results.slice(i * TOKEN_STRIDE, (i + 1) * TOKEN_STRIDE);
        const errors: string[] = [];
        const take = <T>(idx: number, name: string, fallback: T): T => {
          const x = r[idx];
          if (x && x.status === "success") return x.result as T;
          errors.push(name);
          return fallback;
        };
        const round = take<readonly [bigint, bigint, bigint, bigint, bigint]>(0, "latestRoundData", [0n, 0n, 0n, 0n, 0n]);
        const params = take<readonly [bigint, boolean]>(2, "getOracleParams", [10n ** 18n, false]);
        return {
          symbol: t.symbol,
          address: t.address,
          feed: t.feed,
          feedRoundId: round[0],
          feedAnswer: round[1],
          feedUpdatedAt: round[3],
          feedDecimals: take<number>(1, "decimals", 8),
          registryMultiplier: params[0],
          registryPaused: params[1],
          transferPaused: take<boolean>(3, "isPaused", false),
          pausedFeatures: [...take<readonly number[]>(4, "pausedFeatures", [])],
          uiMultiplier: take<bigint>(5, "uiMultiplier", 10n ** 18n),
          newUIMultiplier: take<bigint>(6, "newUIMultiplier", 10n ** 18n),
          effectiveAt: take<bigint>(7, "effectiveAt", 0n),
          errors,
        };
      });

      const base = tokens.length * TOKEN_STRIDE;
      const pools: PoolRead[] = pooled.map((t, i) => {
        const r = results.slice(base + i * 3, base + (i + 1) * 3);
        const slot0 = r[0]?.status === "success" ? (r[0].result as readonly [bigint, number, number, number, number, boolean]) : null;
        const liquidity = r[1]?.status === "success" ? (r[1].result as bigint) : 0n;
        const obs = r[2]?.status === "success" ? (r[2].result as readonly [readonly bigint[], readonly bigint[]]) : null;
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

      return {
        chainId: 8453,
        blockNumber: block.number,
        blockTimestamp: Number(block.timestamp),
        tokens: out,
        pools,
      };
    },
  };
}
