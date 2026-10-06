// Everything that differs between deployments, read once from Vite's env. Mainnet is one line here plus
// the SDK's chain config; nothing else in the app knows the chain.
const env = import.meta.env as Record<string, string | undefined>;
const str = (k: string): string | undefined => {
  const v = env[k];
  return v && v.trim().length > 0 ? v.trim() : undefined;
};

export const ENV = {
  chainId: (Number(str("VITE_CHAIN_ID") ?? "84532") === 8453 ? 8453 : 84532) as 84532 | 8453,
  /** ERC-7677 paymaster URL (a server-side proxy to the CDP paymaster); unset → the user pays gas. */
  paymasterUrl: str("VITE_PAYMASTER_URL"),
  /** Builder Code registered at dashboard.base.org; unset → no ERC-8021 suffix. */
  builderCode: str("VITE_BUILDER_CODE"),
  /** Morpho pre-liquidation contract for protected mode; unset until Lane A's deploy lands. */
  preLiquidation: str("VITE_PRELIQUIDATION"),
  rpcUrl: str("VITE_RPC_URL"),
  /** The app Worker's proxy; the browser never holds the partner key. */
  apiBase: "/api",
  observatoryUrl: str("VITE_OBSERVATORY_URL") ?? "https://boundline-observatory.papermind-ai.workers.dev",
} as const;
