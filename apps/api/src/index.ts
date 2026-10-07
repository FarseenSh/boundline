import { CHAIN_IDS, createBaseClient, type ChainId } from "@boundline/chain";
import { getAddress, isAddress } from "viem";
import { createApp, type AppDeps } from "./app.js";
import { createD1Store } from "./db.js";
import { createDeskReader } from "./desk.js";
import type { Env } from "./env.js";
import { parseMarkets } from "./policy.js";
import { CAIP2, USDC_BY_NETWORK, createHttpFacilitator, usdcToAtomic } from "./x402.js";

export type { Env } from "./env.js";

/** x402 from the vars; null when `X402_ENABLED` is not "true". Misconfiguration throws at first request, loudly. */
export function x402From(env: Env): NonNullable<AppDeps["x402"]> | null {
  if (env.X402_ENABLED !== "true") return null;
  const network = (env.X402_NETWORK || "base-sepolia").trim();
  const caip2 = CAIP2[network];
  if (!caip2) throw new Error(`X402_NETWORK ${network} is not a network this API meters on`);
  if (!env.X402_PAY_TO || !isAddress(env.X402_PAY_TO)) throw new Error("X402_PAY_TO must be an address");
  const asset = env.X402_ASSET && isAddress(env.X402_ASSET) ? getAddress(env.X402_ASSET) : USDC_BY_NETWORK[network];
  if (!asset) throw new Error(`no USDC known on ${network}; set X402_ASSET`);
  const priceUsdc = (env.X402_PRICE_USDC || "0.01").trim();
  return {
    cfg: {
      payTo: getAddress(env.X402_PAY_TO),
      network,
      caip2,
      asset,
      assetName: "USDC",
      assetVersion: "2",
      amount: usdcToAtomic(priceUsdc),
      priceUsdc,
      maxTimeoutSeconds: 300,
      serviceName: "Boundline partner API",
      description: "Boundline: session-aware credit quotes and shadow health for tokenized stocks on Base",
    },
    facilitator: createHttpFacilitator(env.X402_FACILITATOR || "https://x402.org/facilitator"),
  };
}

function depsFrom(env: Env): AppDeps {
  const chainId = Number(env.CHAIN_ID || CHAIN_IDS.baseSepolia) as ChainId;
  const deskAddress = env.CREDIT_DESK && isAddress(env.CREDIT_DESK) ? getAddress(env.CREDIT_DESK) : null;
  const desk = deskAddress ? createDeskReader(createBaseClient({ chainId, rpcUrl: env.BASE_SEPOLIA_RPC_URL }), deskAddress, chainId) : null;
  return {
    store: createD1Store(env.DB),
    desk,
    chainId,
    now: () => Math.floor(Date.now() / 1000),
    uuid: () => crypto.randomUUID(),
    markets: parseMarkets(env.MARKETS),
    x402: x402From(env),
    ...(env.INDEXER_URL ? { indexerUrl: env.INDEXER_URL } : {}),
    // Worker-to-Worker fetches over workers.dev are refused (Cloudflare 1042); use the service binding when bound.
    ...(env.INDEXER ? { fetchImpl: env.INDEXER.fetch.bind(env.INDEXER) as typeof fetch } : {}),
  };
}

const apps = new WeakMap<Env, ReturnType<typeof createApp>>();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    let app = apps.get(env);
    if (!app) {
      app = createApp(depsFrom(env));
      apps.set(env, app);
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
