import { Hono } from "hono";
import { getMirrorChain, type MirrorChain } from "./chain.js";
import { CHAINS, KEEPER_ADDRESS, MAINNET_REGISTRY, MAX_TX_PER_TICK, PAIRS, SEPOLIA_REGISTRY } from "./config.js";
import { keeperKey, mainnetRpc, protectKey, sepoliaRpc, sequencerUrl, type Env } from "./env.js";
import { parseTargets } from "./protect.js";
import { liveProtectRpc, protectAccount, runProtect, type ProtectReport } from "./protect-job.js";
import { collectStatus } from "./status.js";
import { runTick } from "./tick.js";
import type { Address } from "viem";

export type { Env } from "./env.js";

/** Memoised per isolate: clients and the signing account are built once (CPU budget, see chain.ts). */
function chainFor(env: Env): MirrorChain {
  return getMirrorChain({ mainnetRpc: mainnetRpc(env), sepoliaRpc: sepoliaRpc(env), keeperKey: keeperKey(env) });
}

/** The var MAX_TX_PER_TICK when it is a whole number (0 means plan only), else the default. */
export function maxTxPerTick(env: Pick<Env, "MAX_TX_PER_TICK">): number {
  const raw = env.MAX_TX_PER_TICK?.trim();
  if (!raw) return MAX_TX_PER_TICK;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : MAX_TX_PER_TICK;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "boundline-keeper" }));

app.get("/", async (c) => c.json(await collectStatus(chainFor(c.env), PAIRS, nowSeconds())));
app.get("/v1/status", async (c) => c.json(await collectStatus(chainFor(c.env), PAIRS, nowSeconds())));

/** Live view of the protection job: every target's sizing and decision, nothing signed. */
app.get("/v1/protect", async (c) => {
  const deps = protectDeps(c.env);
  if (!deps) return c.json({ enabled: false, note: "set PROTECTOR and PROTECT_TARGETS to turn the protection job on" });
  const report = await runProtect({ ...deps, account: null });
  // Sizing carries bigints: serialise them as decimal strings (JSON.stringify would throw and answer 500).
  return c.body(jsonWithBigints({ enabled: true, protector: deps.protector, ...report, signer: protectAccount(protectKey(c.env))?.address ?? null }), 200, { "content-type": "application/json" });
});

app.get("/v1/config", (c) =>
  c.json({
    service: "boundline-keeper",
    jobs: ["sepolia-feed-mirror", "sepolia-registry-mirror"],
    cron: "* * * * *",
    maxTxPerTick: maxTxPerTick(c.env),
    keeperAddress: KEEPER_ADDRESS,
    chains: {
      mainnet: { chainId: CHAINS.mainnet, registry: MAINNET_REGISTRY, rpc: mainnetRpc(c.env).split(",").map(redact) },
      sepolia: { chainId: CHAINS.sepolia, registry: SEPOLIA_REGISTRY, rpc: sepoliaRpc(c.env).split(",").map(redact) },
    },
    pairs: PAIRS,
    protection: { protector: c.env.PROTECTOR ?? null, targets: parseTargetsSafe(c.env.PROTECT_TARGETS).length, sequencer: redact(sequencerUrl(c.env)) },
  }),
);

/** JSON with every bigint as a decimal string. */
export function jsonWithBigints(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

function parseTargetsSafe(list: string | undefined) {
  try {
    return parseTargets(list);
  } catch {
    return [];
  }
}

function protectDeps(env: Env) {
  const protector = env.PROTECTOR?.trim();
  if (!protector || !/^0x[0-9a-fA-F]{40}$/.test(protector)) return null;
  const targets = parseTargetsSafe(env.PROTECT_TARGETS);
  if (targets.length === 0) return null;
  return { rpc: liveProtectRpc(sepoliaRpc(env), sequencerUrl(env)), protector: protector as Address, targets, account: protectAccount(protectKey(env)), chainId: CHAINS.sepolia };
}

/** The protection job: reads every target, arms at most one action. Logged as one JSON line; never throws. */
export async function protectTick(env: Env): Promise<ProtectReport | null> {
  const deps = protectDeps(env);
  if (!deps) return null;
  try {
    const r = await runProtect(deps);
    console.log(
      JSON.stringify({
        protect: r.at,
        ms: r.ms,
        skipped: r.skipped,
        targets: r.targets.map((t) => `${t.borrower.slice(0, 8)}:${t.sizing?.standing ?? "?"}:${t.decision?.action ?? t.error ?? "-"}`),
        armed: r.armed,
        errors: r.errors,
      }),
    );
    return r;
  } catch (err) {
    console.error("protect tick failed", err instanceof Error ? err.message : err);
    return null;
  }
}

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
    const report = await runTick(chainFor(env), PAIRS, { maxTxPerTick: maxTxPerTick(env) });
    const line = {
      tick: report.at,
      ms: report.durationMs,
      skipped: report.skipped,
      planned: report.planned,
      sent: report.sent,
      deferred: report.deferred,
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
    // Protection first (its action matters more than a feed mirror), then the mirror; each signs at most once.
    ctx.waitUntil(protectTick(env).then(() => tick(env)));
  },
} satisfies ExportedHandler<Env>;
