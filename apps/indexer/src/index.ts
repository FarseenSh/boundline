import type { ChainId } from "@boundline/chain";
import { createApp } from "./app.js";
import { maxLogsPerTick, maxRangesPerTick, maxRangesTotalPerTick, rootHashesPerTick, rpcUrlFor, type Env } from "./env.js";
import { rawLogClient } from "./ingest.js";
import { rawChainReader } from "./reconcile.js";
import { rawRpc, splitUrls, type RawRpc } from "./rpc.js";
import { SEPOLIA, SEPOLIA_STACK, mainnetSources, sepoliaSources, type Source } from "./sources.js";
import { D1Store } from "./store-d1.js";
import type { Store } from "./store.js";
import { ROOT_HASHES_PER_TICK, runTick, type TickDeps } from "./tick.js";

export type { Env } from "./env.js";

/** Every source this deployment follows: Sepolia always, mainnet behind INDEX_MAINNET. */
export function activeSources(env: Env): Source[] {
  return [...sepoliaSources(env), ...(env.INDEX_MAINNET === "true" ? mainnetSources(env) : [])];
}

/** One raw RPC client per URL list for the isolate's life: request-driven reads (seize watch) memoise on it. */
const rpcClients = new Map<string, RawRpc>();
function rpcFor(env: Env, chainId: number): RawRpc {
  const urls = rpcUrlFor(env, chainId as ChainId);
  let client = rpcClients.get(urls);
  if (!client) {
    client = rawRpc(splitUrls(urls));
    rpcClients.set(urls, client);
  }
  return client;
}

const app = createApp({ store: (env) => new D1Store(env.DB), sources: activeSources, rpc: rpcFor });

/** The tick's dependencies for a deployment; exported so scripts/bench-tick.ts measures exactly what the Worker runs. */
export function tickDeps(env: Env, store: Store, now: () => number = () => Math.floor(Date.now() / 1000)): TickDeps {
  return {
    store,
    // Raw JSON-RPC, not viem, on the cron path: see src/rpc.ts (the Free plan's 10 ms of CPU per invocation).
    clientFor: (chainId: ChainId) => rawLogClient(rawRpc(splitUrls(rpcUrlFor(env, chainId)))),
    readerFor: (chainId: ChainId) => rawChainReader(rawRpc(splitUrls(rpcUrlFor(env, chainId)))),
    now,
  };
}

export async function tick(env: Env): Promise<boolean> {
  const summary = await runTick(
    tickDeps(env, new D1Store(env.DB)),
    {
      sources: activeSources(env),
      markets: [{ chainId: SEPOLIA, morpho: SEPOLIA_STACK.morpho, marketId: SEPOLIA_STACK.market.id }],
      maxRanges: maxRangesPerTick(env),
      maxRangesTotal: maxRangesTotalPerTick(env),
      maxLogs: maxLogsPerTick(env),
      rootHashesPerTick: rootHashesPerTick(env, ROOT_HASHES_PER_TICK),
    },
  );
  if (summary.errors.length > 0) console.error(`tick errors: ${summary.errors.join(" | ")}`);
  return summary.ran;
}

/** Fallback trigger: another Worker's cron calls this through a service binding with the shared TICK_TOKEN. */
app.post("/__tick", async (c) => {
  const token = c.env.TICK_TOKEN;
  const auth = c.req.header("authorization") ?? "";
  if (!token || auth !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
  const started = Date.now();
  const ran = await tick(c.env);
  return c.json({ ok: true, ran, ms: Date.now() - started });
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env).catch((err) => console.error("tick failed", err instanceof Error ? err.message : err)));
  },
} satisfies ExportedHandler<Env>;
