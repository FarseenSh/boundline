import { CHAIN_IDS, createBaseClient, type ChainId } from "@boundline/chain";
import { getAddress, isAddress } from "viem";
import { createApp, type AppDeps } from "./app.js";
import { createD1Store } from "./db.js";
import { createDeskReader } from "./desk.js";
import type { Env } from "./env.js";

export type { Env } from "./env.js";

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
