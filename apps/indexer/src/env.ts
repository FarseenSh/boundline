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
  /** "true" enables the mainnet sources (phase 2; nothing is registered yet). */
  INDEX_MAINNET?: string;
  /** Block ranges a single source may scan per tick (default 5 × 2,000 blocks). */
  MAX_RANGES_PER_TICK?: string;
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

export function maxRangesPerTick(env: Env): number {
  const n = Number(env.MAX_RANGES_PER_TICK ?? "5");
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 5;
}
