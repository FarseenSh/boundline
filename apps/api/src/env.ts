/** Worker bindings and vars; see wrangler.jsonc. */
export interface Env {
  DB: D1Database;
  /** Comma-separated Base Sepolia RPC list (a var); the first answers, the rest are fallbacks. */
  BASE_SEPOLIA_RPC_URL: string;
  /** "84532" on Base Sepolia. */
  CHAIN_ID: string;
  /** CreditDesk address. Empty until the desk is deployed; routes that need it answer 503. */
  CREDIT_DESK: string;
  MORPHO: string;
  SESSION_GATE: string;
  /** Optional indexer base URL; `GET /v1/decisions/:hash` proxies to it when set, 501 otherwise. */
  INDEXER_URL?: string;
}
