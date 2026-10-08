// Everything that differs between deployments, read once from Vite's env.
const env = import.meta.env as Record<string, string | undefined>;
const str = (k: string): string | undefined => {
  const v = env[k];
  return v && v.trim().length > 0 ? v.trim() : undefined;
};

export const ENV = {
  chainId: (Number(str("VITE_CHAIN_ID") ?? "84532") === 8453 ? 8453 : 84532) as 84532 | 8453,
  /** The console Worker's proxy: adds the partner key server-side unless the partner pasted their own. */
  apiBase: "/api",
  /** Fixtures instead of the network (`VITE_CONSOLE_MOCK=1` at build time). */
  mock: str("VITE_CONSOLE_MOCK") === "1",
  observatoryUrl: str("VITE_OBSERVATORY_URL") ?? "https://boundline-observatory.papermind-ai.workers.dev",
  appUrl: str("VITE_APP_URL") ?? "https://boundline-app.papermind-ai.workers.dev",
  /** The partner API's public origin: webhook URLs must be reachable from it, and the echo receiver lives on it. */
  apiPublicUrl: str("VITE_API_PUBLIC_URL") ?? "https://boundline-api.papermind-ai.workers.dev",
} as const;
