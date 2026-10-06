import type { ChainId } from "@boundline/chain";

export interface Env {
  DB: D1Database;
  /** Comma-separated public RPC lists (vars in `wrangler.jsonc`); the first answers, the rest are fallbacks. */
  BASE_RPC_URL: string;
  BASE_SEPOLIA_RPC_URL: string;
  /** Optional keyed RPCs (secrets); tried before the public lists. */
  BASE_RPC_URL_PRIVATE?: string;
  BASE_SEPOLIA_RPC_URL_PRIVATE?: string;
  /** The CreditDesk on Base Sepolia once deployed; empty or unset skips that source cleanly. */
  CREDIT_DESK_SEPOLIA?: string;
  /** "true" enables the phase-2 Base mainnet sources (feeds, OracleRegistry, B20 tokens, Morpho B20 markets, Aave spoke). */
  INDEX_MAINNET?: string;
  /** First block the mainnet registry, token, Morpho and Aave sources scan (default: the phase-2 cutoff in sources.ts). */
  MAINNET_START_BLOCK?: string;
  /** First block the mainnet feed source scans; deeper than the others so the weekend-gap history reaches back. */
  MAINNET_FEEDS_START_BLOCK?: string;
  /** Block ranges a single source may scan per tick (default 5 × 2,000 blocks). */
  MAX_RANGES_PER_TICK?: string;
  /** Block ranges every source together may scan per tick (default 8). */
  MAX_RANGES_TOTAL_PER_TICK?: string;
  /** Logs decoded per tick before no further range starts (default 200); the rest waits for the next tick. */
  MAX_LOGS_PER_TICK?: string;
  /** Secret shared with the Observatory, whose cron calls POST /__tick through a service binding (fallback for this Worker's own cron). */
  TICK_TOKEN?: string;
}

function joinUrls(...parts: (string | undefined)[]): string {
  return parts.filter((u): u is string => typeof u === "string" && u.trim().length > 0).join(",");
}

/** The RPC list for a chain: the keyed secret first when set, then the public list from the vars. */
export function rpcUrlFor(env: Env, chainId: ChainId): string {
  return chainId === 84532
    ? joinUrls(env.BASE_SEPOLIA_RPC_URL_PRIVATE, env.BASE_SEPOLIA_RPC_URL)
    : joinUrls(env.BASE_RPC_URL_PRIVATE, env.BASE_RPC_URL);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value ?? "");
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export function maxRangesPerTick(env: Env): number {
  return positiveInt(env.MAX_RANGES_PER_TICK, 5);
}

export function maxRangesTotalPerTick(env: Env): number {
  return positiveInt(env.MAX_RANGES_TOTAL_PER_TICK, 8);
}

export function maxLogsPerTick(env: Env): number {
  return positiveInt(env.MAX_LOGS_PER_TICK, 200);
}

/** A block number from a var, or undefined when unset or not a non-negative integer. */
export function blockFromEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}
