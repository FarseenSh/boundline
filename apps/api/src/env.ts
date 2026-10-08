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
  /** Service binding to the indexer Worker; the decisions proxy uses it when present. */
  INDEXER?: Fetcher;
  /** JSON array of the desk's markets: `{symbol, collateral, marketId, preLiquidation?, protector?, targetLtvWad?}`. */
  MARKETS?: string;
  /** x402 metering of the public routes: "true" to meter requests that carry no partner key. */
  X402_ENABLED?: string;
  /** Address that receives the metered payments. */
  X402_PAY_TO?: string;
  /** Facilitator base URL (https://x402.org/facilitator on Sepolia). */
  X402_FACILITATOR?: string;
  /** v1 network name ("base-sepolia"); mapped to CAIP-2 for v2 clients. */
  X402_NETWORK?: string;
  /** Price per metered call in USDC ("0.01"). */
  X402_PRICE_USDC?: string;
  /** Optional override of the EIP-3009 asset (defaults to USDC of the network). */
  X402_ASSET?: string;
  /** Service binding to the Observatory: Base mainnet tokens and Morpho markets for `POST /v1/route` on chain 8453. */
  OBSERVATORY?: Fetcher;
  /** Comma-separated Base mainnet RPC list (IRM rates for mainnet routes). */
  BASE_RPC_URL?: string;
  /** The DeskProtectionVault: desk lines it can repay at any hour are routed with protection `vault`. */
  DESK_PROTECTION_VAULT?: string;
  /** The host this API answers on; webhook deliveries to it are dispatched to the app itself (error 1042 otherwise). */
  PUBLIC_HOST?: string;
  /** Secret: signs EIP-712 route plans (typed data only, never a transaction). Absent → plans are unsigned. */
  ROUTE_SIGNER_KEY?: string;
}
