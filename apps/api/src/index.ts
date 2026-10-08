import { CHAIN_IDS, createBaseClient, type ChainId } from "@boundline/chain";
import { WorkerEntrypoint } from "cloudflare:workers";
import { getAddress, isAddress, type Address } from "viem";
import { createApp, makeIndexerGet, makeWebhookRuntime, type AppDeps } from "./app.js";
import { createD1Store } from "./db.js";
import { createDeskReader } from "./desk.js";
import type { Env } from "./env.js";
import { parseMarkets } from "./policy.js";
import { decodeLineHead, encodeLine, rpcCall } from "./route.js";
import { routeSignerFrom } from "./route-signer.js";
import { POLL_SOURCES, createD1WebhookStore, ingestKeeperEvent, pollSource, retryDue, type KeeperEvent, type PollResult } from "./webhooks.js";
import { CAIP2, USDC_BY_NETWORK, createHttpFacilitator, usdcToAtomic } from "./x402.js";

export type { Env } from "./env.js";
export type { KeeperEvent } from "./webhooks.js";

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
      description: "Boundline: session-aware credit quotes, route plans and shadow health for tokenized stocks on Base",
    },
    facilitator: createHttpFacilitator(env.X402_FACILITATOR || "https://x402.org/facilitator"),
  };
}

function list(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function addressOrNull(v: string | undefined): Address | null {
  return v && isAddress(v) ? getAddress(v) : null;
}

/** RPC reads and webhook deliveries go out on the global fetch: external services, never Worker bindings. */
const globalFetch: typeof fetch = (input, init) => fetch(input, init);

export const DEFAULT_PUBLIC_HOST = "boundline-api.papermind-ai.workers.dev";

/**
 * The app's dependencies from the env. `forCron` leaves out what only HTTP routes use (the viem desk reader, route
 * reads and the signer, x402): a scheduled tick is strictly capped at 10 ms of CPU and pays for nothing it does not use.
 */
export function depsFrom(env: Env, opts: { forCron?: boolean } = {}): AppDeps {
  const chainId = Number(env.CHAIN_ID || CHAIN_IDS.baseSepolia) as ChainId;
  const deskAddress = addressOrNull(env.CREDIT_DESK);
  const desk = deskAddress && !opts.forCron ? createDeskReader(createBaseClient({ chainId, rpcUrl: env.BASE_SEPOLIA_RPC_URL }), deskAddress, chainId) : null;
  const markets = parseMarkets(env.MARKETS);
  const sepoliaRpcs = list(env.BASE_SEPOLIA_RPC_URL);
  const gate = addressOrNull(env.SESSION_GATE);
  const morpho = addressOrNull(env.MORPHO);
  const observatory = env.OBSERVATORY;
  return {
    store: createD1Store(env.DB),
    desk,
    chainId,
    now: () => Math.floor(Date.now() / 1000),
    uuid: () => crypto.randomUUID(),
    markets,
    x402: opts.forCron ? null : x402From(env),
    ...(env.INDEXER_URL ? { indexerUrl: env.INDEXER_URL } : {}),
    // Worker-to-Worker fetches over workers.dev are refused (Cloudflare 1042); use the service binding when bound.
    ...(env.INDEXER ? { fetchImpl: env.INDEXER.fetch.bind(env.INDEXER) as typeof fetch } : {}),
    route: opts.forCron ? { sepolia: null, mainnet: null } : {
      sepolia: deskAddress && gate && morpho ? { rpcs: sepoliaRpcs, fetchImpl: globalFetch, desk: deskAddress, gate, morpho, markets, vault: addressOrNull(env.DESK_PROTECTION_VAULT) } : null,
      mainnet: observatory
        ? {
            observatory: async (path: string) => {
              const res = await observatory.fetch(`https://observatory${path}`, { signal: AbortSignal.timeout(15_000) });
              if (!res.ok) throw new Error(`observatory${path} answered ${res.status}`);
              return res.json();
            },
            rpcs: list(env.BASE_RPC_URL),
            fetchImpl: globalFetch,
          }
        : null,
    },
    routeSigner: opts.forCron ? null : routeSignerFrom(env.ROUTE_SIGNER_KEY),
    webhookStore: createD1WebhookStore(env.DB),
    selfHosts: [env.PUBLIC_HOST?.trim() || DEFAULT_PUBLIC_HOST],
    deliveryFetch: globalFetch,
    ...(deskAddress
      ? {
          readLine: async (lineId: bigint) => {
            try {
              return decodeLineHead(await rpcCall(sepoliaRpcs, deskAddress, encodeLine(lineId), globalFetch));
            } catch {
              return null;
            }
          },
        }
      : {}),
  };
}

const runtimes = new WeakMap<Env, { deps: AppDeps; app: ReturnType<typeof createApp> }>();

function runtimeFor(env: Env): { deps: AppDeps; app: ReturnType<typeof createApp> } {
  let r = runtimes.get(env);
  if (!r) {
    const deps = depsFrom(env);
    r = { deps, app: createApp(deps) };
    runtimes.set(env, r);
  }
  return r;
}

const cronDeps = new WeakMap<Env, AppDeps>();

/**
 * The cron, one small tick a minute (a scheduled invocation is killed at 10 ms of CPU on the Free plan): poll ONE
 * indexer source (they alternate by minute) for at most a few new events, then send at most two due deliveries.
 * The Hono app is built only when a delivery is addressed to this API itself (the echo receiver).
 */
export async function runCron(env: Env, ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const started = Date.now();
  let deps = cronDeps.get(env);
  if (!deps) {
    deps = depsFrom(env, { forCron: true });
    cronDeps.set(env, deps);
  }
  const d = deps;
  let app: ReturnType<typeof createApp> | null = null;
  const rt = makeWebhookRuntime(d, async (req) => (app ??= createApp(d)).fetch(req, env, ctx), (p) => ctx.waitUntil(p));
  if (!rt) return { cron: "skipped", reason: "webhooks are not configured" };
  const source = POLL_SOURCES[Math.floor(d.now() / 60) % POLL_SOURCES.length] as string;
  let poll: PollResult;
  try {
    poll = await pollSource(rt, source, d.chainId, makeIndexerGet(d));
  } catch (err) {
    poll = { source, status: "error", fetched: 0, ingested: 0, deliveries: 0, cursor: null, detail: err instanceof Error ? err.message : String(err) };
  }
  const polls: PollResult[] = [poll];
  let retries: Awaited<ReturnType<typeof retryDue>> | { error: string };
  try {
    retries = await retryDue(rt, 2);
  } catch (err) {
    retries = { error: err instanceof Error ? err.message : String(err) };
  }
  const line = {
    cron: d.now(),
    ms: Date.now() - started,
    polls: polls.map((p) => `${p.source}:${p.status} fetched=${p.fetched} ingested=${p.ingested} deliveries=${p.deliveries} cursor=${p.cursor ?? "-"}${p.detail ? ` (${p.detail})` : ""}`),
    retries,
  };
  console.log(JSON.stringify(line));
  return line;
}

/**
 * The keeper's way in: `env.API_EVENTS.ingest(evt)` over a service binding to this entrypoint. RPC entrypoints are
 * reachable only through bindings, so no shared secret is needed. Validated, deduplicated, logged for the partner
 * the line belongs to and delivered to its webhooks after the call returns.
 */
export class Events extends WorkerEntrypoint<Env> {
  async ingest(evt: KeeperEvent): Promise<{ accepted: boolean; id: string; deliveries: number; duplicate?: boolean; error?: string }> {
    const env = this.env;
    const ctx = this.ctx;
    const { deps, app } = runtimeFor(env);
    const rt = makeWebhookRuntime(deps, async (req) => app.fetch(req, env, ctx), (p) => ctx.waitUntil(p));
    if (!rt) return { accepted: false, id: "", deliveries: 0, error: "webhooks are not configured" };
    try {
      return await ingestKeeperEvent(rt, evt);
    } catch (err) {
      console.error("events.ingest failed", err instanceof Error ? err.message : err);
      return { accepted: false, id: "", deliveries: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * One webhook tick (the same bounded work as this Worker's own cron) for a caller whose cron is known to fire: on
   * this account new cron triggers have been slow or silent before (the indexer's for 40 minutes on 3 Oct), so the
   * keeper calls `env.API_EVENTS.tick()` once a minute. Idempotent: two ticks in the same minute only find duplicates.
   */
  async tick(): Promise<Record<string, unknown>> {
    try {
      return await runCron(this.env, this.ctx);
    } catch (err) {
      return { cron: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return runtimeFor(env).app.fetch(request, env, ctx);
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(
      runCron(env, ctx).catch((err: unknown) => {
        console.error("cron failed", err instanceof Error ? err.message : err);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
