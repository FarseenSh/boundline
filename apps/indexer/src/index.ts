import { createBaseClient, type ChainId } from "@boundline/chain";
import { createApp } from "./app.js";
import { maxRangesPerTick, rpcUrlFor, type Env } from "./env.js";
import { viemLogClient } from "./ingest.js";
import { viemChainReader } from "./reconcile.js";
import { SEPOLIA, SEPOLIA_STACK, mainnetSources, sepoliaSources } from "./sources.js";
import { D1Store } from "./store-d1.js";
import { runTick } from "./tick.js";

export type { Env } from "./env.js";

const app = createApp({ store: (env) => new D1Store(env.DB) });

export async function tick(env: Env): Promise<void> {
  const sources = [...sepoliaSources(env), ...(env.INDEX_MAINNET === "true" ? mainnetSources() : [])];
  const summary = await runTick(
    {
      store: new D1Store(env.DB),
      clientFor: (chainId: ChainId) => viemLogClient(createBaseClient({ chainId, rpcUrl: rpcUrlFor(env, chainId) })),
      readerFor: (chainId: ChainId) => viemChainReader(createBaseClient({ chainId, rpcUrl: rpcUrlFor(env, chainId) })),
      now: () => Math.floor(Date.now() / 1000),
    },
    {
      sources,
      markets: [{ chainId: SEPOLIA, morpho: SEPOLIA_STACK.morpho, marketId: SEPOLIA_STACK.market.id }],
      maxRanges: maxRangesPerTick(env),
    },
  );
  if (summary.errors.length > 0) console.error(`tick errors: ${summary.errors.join(" | ")}`);
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env).catch((err) => console.error("tick failed", err instanceof Error ? err.message : err)));
  },
} satisfies ExportedHandler<Env>;
