export interface Env {
  SNAPSHOTS: KVNamespace;
  DB: D1Database;
  /** Optional: the R2 export bucket is not bound in `wrangler.jsonc` (no r2 scope on the deploy login). Skip exports when absent. */
  EXPORTS?: R2Bucket;
  /** Comma-separated public RPC list (a var in `wrangler.jsonc`); the first answers, the rest are fallbacks. */
  BASE_RPC_URL: string;
  /** Optional keyed RPC (a secret: `wrangler secret put BASE_RPC_URL_PRIVATE`); tried before the public list. */
  BASE_RPC_URL_PRIVATE?: string;
  /** Optional service binding to the indexer Worker; the cron calls its POST /__tick with INDEXER_TICK_TOKEN. */
  INDEXER?: Fetcher;
  INDEXER_TICK_TOKEN?: string;
}

/** The RPC list every read uses: the keyed secret first when set, then the public list. */
export function rpcUrl(env: Env): string {
  return [env.BASE_RPC_URL_PRIVATE, env.BASE_RPC_URL].filter((u): u is string => typeof u === "string" && u.trim().length > 0).join(",");
}
