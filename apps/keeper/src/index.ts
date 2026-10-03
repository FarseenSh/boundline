import { Hono } from "hono";
import { createViemMirrorChain, type MirrorChain } from "./chain.js";
import { CHAINS, KEEPER_ADDRESS, MAINNET_REGISTRY, PAIRS, RECEIPT_TIMEOUT_MS, SEPOLIA_REGISTRY } from "./config.js";
import { keeperKey, mainnetRpc, sepoliaRpc, type Env } from "./env.js";
import { collectStatus } from "./status.js";
import { runTick } from "./tick.js";

export type { Env } from "./env.js";

function chainFor(env: Env): MirrorChain {
  return createViemMirrorChain({ mainnetRpc: mainnetRpc(env), sepoliaRpc: sepoliaRpc(env), keeperKey: keeperKey(env) });
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "boundline-keeper" }));

app.get("/", async (c) => c.json(await collectStatus(chainFor(c.env), PAIRS, nowSeconds())));
app.get("/v1/status", async (c) => c.json(await collectStatus(chainFor(c.env), PAIRS, nowSeconds())));

app.get("/v1/config", (c) =>
  c.json({
    service: "boundline-keeper",
    jobs: ["sepolia-feed-mirror", "sepolia-registry-mirror"],
    cron: "* * * * *",
    receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
    keeperAddress: KEEPER_ADDRESS,
    chains: {
      mainnet: { chainId: CHAINS.mainnet, registry: MAINNET_REGISTRY, rpc: mainnetRpc(c.env).split(",").map(redact) },
      sepolia: { chainId: CHAINS.sepolia, registry: SEPOLIA_REGISTRY, rpc: sepoliaRpc(c.env).split(",").map(redact) },
    },
    pairs: PAIRS,
  }),
);

/** Keyed RPC URLs carry the key in the path; show only the host. */
function redact(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

/** One mirror tick, logged as one JSON line; never throws (the cron must not crashloop). */
export async function tick(env: Env): Promise<void> {
  try {
    const report = await runTick(chainFor(env), PAIRS);
    const line = {
      tick: report.at,
      ms: report.durationMs,
      skipped: report.skipped,
      planned: report.planned,
      sent: report.sent,
      nonces: report.nonces,
      txs: report.txs.map((t) => `${t.symbol}/${t.kind}#${t.nonce}:${t.hash ?? "-"}:${typeof t.receipt === "string" ? t.receipt : (t.receipt?.status ?? t.error ?? "?")}`),
      plans: report.symbols.map((s) => `${s.symbol} feed=${s.feed.plan}(${s.feed.reason}) reg=${s.registry.plan}(${s.registry.reason})`),
      errors: report.errors,
    };
    console.log(JSON.stringify(line));
  } catch (err) {
    console.error("tick failed", err instanceof Error ? err.message : err);
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env));
  },
} satisfies ExportedHandler<Env>;
