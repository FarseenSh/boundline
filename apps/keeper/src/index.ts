import { Hono } from "hono";
import { PatternRouter } from "hono/router/pattern-router";
import { getMirrorChain, type MirrorChain } from "./chain.js";
import { CHAINS, KEEPER_ADDRESS, MAINNET_REGISTRY, MAX_TX_PER_TICK, PAIRS, SEPOLIA_REGISTRY } from "./config.js";
import { HOLD_KEY, keeperKey, mainnetRpc, protectKey, readHold, sepoliaRpc, sequencerUrl, type Env, type HoldView } from "./env.js";
import { STATE_KEY, apiTick, borrowerKey, decodeExecutions, emitEvents, executionReads, lineKey, parseState, transitions, type Execution, type KeeperEvent, type KeeperState } from "./events.js";
import { BACKOFF_BLOCKS, encodeProtect, parseTargets } from "./protect.js";
import { liveProtectRpc, protectAccount, runProtect, simulate, type ProtectReport } from "./protect-job.js";
import { collectStatus } from "./status.js";
import { runTick } from "./tick.js";
import { encodeVaultProtect, parseVaultTargets, pct, usdc, type VaultTarget } from "./vault.js";
import { runVault, simulateBatch, type VaultReport } from "./vault-job.js";
import { harvestGate, parseHarvestTargets, runHarvest, type HarvestReport, type HarvestTarget, type ProtectionView } from "./harvest-job.js";
import { warmUp } from "./warm.js";
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
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// PatternRouter, not Hono's default SmartRouter: the default compiles a regular expression over every route on the
// first request of a cold isolate (24-26 ms CPU measured in apps/api, 8 Oct 2026); PatternRouter's first match costs
// 0.2-0.3 ms, which the Free plan's 10 ms CPU per invocation can afford.
export const app = new Hono<{ Bindings: Env }>({ router: new PatternRouter() });

app.get("/health", (c) => c.json({ ok: true, service: "boundline-keeper" }));

app.get("/", async (c) => c.json(await collectStatus(chainFor(c.env), PAIRS, nowSeconds(), await readHold(c.env))));
app.get("/v1/status", async (c) => c.json(await collectStatus(chainFor(c.env), PAIRS, nowSeconds(), await readHold(c.env))));

/** Live view of the protection job: every target's sizing and decision, nothing signed. */
app.get("/v1/protect", async (c) => {
  const deps = protectDeps(c.env);
  if (!deps) return c.json({ enabled: false, note: "set PROTECTOR and PROTECT_TARGETS to turn the protection job on" });
  // Dry run with the signer: decide, simulate the exact action from the signer (would-revert shows here), never sign.
  const state = await readState(c.env);
  const report = await runProtect({ ...deps, ...stateLookupsProtect(state), dryRun: true });
  // ?simulate=close: the pre-flight on a hypothetical full close-out of every target, now, from the signer (eth_call only).
  let whatIf: unknown = undefined;
  const signer = protectAccount(protectKey(c.env))?.address ?? null;
  if (c.req.query("simulate") === "close" && signer) {
    const deadline = BigInt(nowSeconds() + 15 * 60);
    whatIf = await Promise.all(
      report.targets.map(async (t) => {
        if (!t.sizing || t.sizing.borrowShares === 0n) return { borrower: t.borrower, skipped: "no position" };
        const sim = await simulate(deps.rpc, signer, deps.protector, encodeProtect(t.preLiq, t.borrower, 0n, t.sizing.borrowShares, 0n, deadline));
        return { borrower: t.borrower, action: "close", repaidShares: t.sizing.borrowShares, ...sim };
      }),
    );
  }
  // Sizing carries bigints: serialise them as decimal strings (JSON.stringify would throw and answer 500).
  return c.body(jsonWithBigints({ enabled: true, protector: deps.protector, ...report, signer, ...(whatIf ? { whatIf } : {}) }), 200, { "content-type": "application/json" });
});

/** Live view of the vault job: every line's shadow LTV, the repay it would make and how the ladder funds it; nothing signed. */
app.get("/v1/vault", async (c) => {
  const cfg = vaultConfig(c.env);
  if (!cfg.vault || !cfg.desk) return c.json({ enabled: false, note: "set DESK_PROTECTION_VAULT and CREDIT_DESK to turn the vault job on" });
  const state = await readState(c.env);
  const report = await runVault({ ...liveVaultDeps(c.env, cfg), ...stateLookupsVault(state), dryRun: true });
  // ?simulate=<raw USDC>: the pre-flight on a hypothetical protect(lineId, amount), now, from the signer (eth_call only).
  const amountQ = c.req.query("simulate");
  let whatIf: unknown = undefined;
  if (amountQ && /^\d{1,20}$/.test(amountQ) && report.signer) {
    const amount = BigInt(amountQ);
    const deps = liveVaultDeps(c.env, cfg);
    whatIf = await Promise.all(cfg.targets.map(async (t) => ({ lineId: t.lineId.toString(), amount, ...(await simulateBatch(deps.rpc, report.signer!, cfg.vault!, encodeVaultProtect(t.lineId, amount))) })));
  }
  const keeperStatus = report.signer === null ? "no-key" : report.keeperIsSigner === true ? "keeper" : report.keeperIsSigner === false ? "not-keeper" : "unknown";
  return c.body(
    jsonWithBigints({
      enabled: true,
      desk: cfg.desk,
      keeperStatus,
      ...(cfg.error ? { targetsError: cfg.error } : {}),
      ...report,
      targets: report.targets.map((t) => ({ ...t, shadowLtvPct: pct(t.sizing?.shadowLtvWad ?? null), venueLtvPct: pct(t.sizing?.venueLtvWad ?? null), amountUsdc: t.sizing ? usdc(t.sizing.amount) : null })),
      state: state ? { grace: state.grace, armed: state.armed, backoff: state.backoff } : null,
      ...(whatIf ? { whatIf } : {}),
      events: c.env.API_EVENTS ? "bound" : "unbound (logged only)",
    }),
    200,
    { "content-type": "application/json" },
  );
});

/** Live view of the harvest job: every enrolled target's preview and what the job would send; nothing signed. */
app.get("/v1/harvest", async (c) => {
  const cfg = harvestConfig(c.env);
  if (!cfg.harvester) return c.json({ enabled: false, note: "set HARVESTER and HARVEST_TARGETS to turn the harvest job on" });
  const report = await runHarvest({ ...liveHarvestDeps(c.env, cfg), dryRun: true });
  const keeperStatus = report.signer === null ? "no-key" : report.keeperIsSigner === true ? "keeper" : report.keeperIsSigner === false ? "not-keeper" : "unknown";
  return c.body(jsonWithBigints({ enabled: true, keeperStatus, ...(cfg.error ? { targetsError: cfg.error } : {}), ...report }), 200, { "content-type": "application/json" });
});

/**
 * Proves the API_EVENTS binding end to end without side effects: it sends an event of a type the API does not accept,
 * so the API validates and refuses it (nothing is stored, nothing is delivered) and its refusal comes back here.
 */
app.get("/v1/events/probe", async (c) => {
  if (!c.env.API_EVENTS) return c.json({ bound: false, note: "no API_EVENTS binding: events are logged only" });
  try {
    const answer = await c.env.API_EVENTS.ingest({ type: "probe" } as unknown as KeeperEvent);
    return c.json({ bound: true, answer, note: "an invalid event on purpose: the API validated and refused it; nothing was stored or delivered" });
  } catch (err) {
    return c.json({ bound: true, error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

app.get("/v1/config", async (c) => {
  const hold = await readHold(c.env);
  const vault = vaultConfig(c.env);
  const protection = { protector: c.env.PROTECTOR ?? null, targets: parseTargetsSafe(c.env.PROTECT_TARGETS).length, sequencer: redact(sequencerUrl(c.env)) };
  const vaultJob = {
    vault: vault.vault,
    desk: vault.desk,
    targets: vault.targets.map((t) => ({ lineId: t.lineId.toString(), graceLtvBps: t.graceLtvBps, targetLtvBps: t.targetLtvBps, shadowOracle: t.shadowOracle, feed: t.feed, feedSlot: Number(t.feedSlot) })),
    ...(vault.error ? { targetsError: vault.error } : {}),
    signer: "PROTECT_KEY (shared with the protection job: one signature per tick, the Protector first)",
  };
  return c.json({
    service: "boundline-keeper",
    jobs: [
      { name: "sepolia-feed-mirror", signer: "KEEPER_KEY", what: "copy each mainnet Coinbase feed round onto its Sepolia TestPriceFeed" },
      { name: "sepolia-registry-mirror", signer: "KEEPER_KEY", what: "copy the mainnet OracleRegistry params onto the MirrorOracleRegistry" },
      { name: "protection", signer: "PROTECT_KEY", what: "shadow pre-liquidation through the Protector, armed as a validity transaction", config: protection },
      { name: "vault", signer: "PROTECT_KEY", what: "any-hour protective repay of desk lines through the DeskProtectionVault ladder, armed as a validity transaction", config: vaultJob },
      {
        name: "harvest",
        signer: "PROTECT_KEY",
        what: "the self-repaying leg: each dividend (a registry multiplier step) swept into the enrolled loan through the DividendHarvester in an open session; a fall or a split-sized step re-bases",
        config: { harvester: harvestConfig(c.env).harvester, targets: harvestConfig(c.env).targets, signer: "PROTECT_KEY (third after the Protector and the vault; one signature per tick)" },
      },
      { name: "events", what: "grace, grace.cleared and protect events to the partner API", binding: "API_EVENTS", bound: c.env.API_EVENTS !== undefined },
    ],
    cron: "* * * * *",
    preflight: {
      simulate: "eth_call of the exact calldata from the signer at latest (must succeed) and pending (must not revert) before any signature",
      onRevert: "decision would-revert with the decoded error (src/reverts.ts); nothing signed, no event",
      backoffBlocks: BACKOFF_BLOCKS,
      rearm: "every re-arm re-signs (new hash) with tip and fee cap +25% per 30-block window since the episode began",
    },
    warmUp,
    maxTxPerTick: maxTxPerTick(c.env),
    hold: { feed: [...hold.feed], registry: [...hold.registry] },
    holdSource: hold.source,
    ...(hold.kvError ? { holdKvError: hold.kvError } : {}),
    holdSwitch: { kvBinding: "KEEPER_STATE", bound: c.env.KEEPER_STATE !== undefined, key: HOLD_KEY },
    keeperAddress: KEEPER_ADDRESS,
    chains: {
      mainnet: { chainId: CHAINS.mainnet, registry: MAINNET_REGISTRY, rpc: mainnetRpc(c.env).split(",").map(redact) },
      sepolia: { chainId: CHAINS.sepolia, registry: SEPOLIA_REGISTRY, rpc: sepoliaRpc(c.env).split(",").map(redact) },
    },
    pairs: PAIRS,
    protection,
    vault: vaultJob,
  });
});

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
  if (!protector || !ADDRESS.test(protector)) return null;
  const targets = parseTargetsSafe(env.PROTECT_TARGETS);
  if (targets.length === 0) return null;
  return { rpc: liveProtectRpc(sepoliaRpc(env), sequencerUrl(env)), protector: protector as Address, targets, account: protectAccount(protectKey(env)), chainId: CHAINS.sepolia };
}

/** The event and backoff state (KV `state`); null without the binding or when it cannot be read. */
async function readState(env: Env): Promise<KeeperState | null> {
  if (!env.KEEPER_STATE) return null;
  try {
    return parseState(await env.KEEPER_STATE.get(STATE_KEY));
  } catch {
    return null;
  }
}

function stateLookupsProtect(state: KeeperState | null) {
  return {
    episodeHead: (b: Address) => {
      const a = state?.armed[borrowerKey(b)];
      return a ? BigInt(a.head) : null;
    },
    backoff: (b: Address) => state?.backoff[borrowerKey(b)] ?? null,
  };
}

function stateLookupsVault(state: KeeperState | null) {
  return {
    episodeHead: (lineId: string) => {
      const a = state?.armed[lineKey(lineId)];
      return a ? BigInt(a.head) : null;
    },
    backoff: (lineId: string) => state?.backoff[lineKey(lineId)] ?? null,
  };
}

export interface VaultConfig {
  vault: Address | null;
  desk: Address | null;
  targets: VaultTarget[];
  error?: string;
}

export function vaultConfig(env: Pick<Env, "DESK_PROTECTION_VAULT" | "CREDIT_DESK" | "VAULT_TARGETS">): VaultConfig {
  const vault = env.DESK_PROTECTION_VAULT?.trim();
  const desk = env.CREDIT_DESK?.trim();
  const cfg: VaultConfig = { vault: vault && ADDRESS.test(vault) ? (vault as Address) : null, desk: desk && ADDRESS.test(desk) ? (desk as Address) : null, targets: [] };
  try {
    cfg.targets = parseVaultTargets(env.VAULT_TARGETS);
  } catch (err) {
    cfg.error = err instanceof Error ? err.message : String(err);
  }
  return cfg;
}

function liveVaultDeps(env: Env, cfg: VaultConfig) {
  return { rpc: liveProtectRpc(sepoliaRpc(env), sequencerUrl(env)), vault: cfg.vault!, desk: cfg.desk!, targets: cfg.targets, account: protectAccount(protectKey(env)), chainId: CHAINS.sepolia };
}

/** The protection job: reads every target, arms at most one action. Logged as one JSON line; never throws. */
export async function protectTick(env: Env, state: KeeperState | null = null): Promise<ProtectReport | null> {
  const deps = protectDeps(env);
  if (!deps) return null;
  try {
    const r = await runProtect({ ...deps, ...stateLookupsProtect(state) });
    console.log(
      JSON.stringify({
        protect: r.at,
        ms: r.ms,
        skipped: r.skipped,
        targets: r.targets.map((t) => `${t.borrower.slice(0, 8)}:${t.sizing?.standing ?? "?"}:${t.decision ? (t.decision.action === "none" && "error" in t.decision ? `${t.decision.reason}(${t.decision.error})` : t.decision.action) : (t.error ?? "-")}`),
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

/** The vault job: one batch, at most one signature (only when the Protector does not want the signer). Never throws. */
export async function vaultTick(env: Env, cfg: VaultConfig, signerBusy: boolean, state: KeeperState | null = null): Promise<VaultReport | null> {
  if (!cfg.vault || !cfg.desk || cfg.targets.length === 0) return null;
  try {
    const r = await runVault({ ...liveVaultDeps(env, cfg), ...stateLookupsVault(state), signerBusy });
    console.log(
      jsonWithBigints({
        vault: r.at,
        ms: r.ms,
        skipped: r.skipped,
        keeperIsSigner: r.keeperIsSigner,
        targets: r.targets.map((t) => `${t.lineId}:${t.sizing?.standing ?? "?"}:${pct(t.sizing?.shadowLtvWad ?? null)}%:${t.decision?.action === "protect" ? `protect ${usdc(t.decision.amount)}` : t.decision && "error" in t.decision ? `${t.decision.reason}(${t.decision.error})` : (t.decision?.reason ?? t.error ?? "-")}`),
        armed: r.armed,
        errors: r.errors,
      }),
    );
    return r;
  } catch (err) {
    console.error("vault tick failed", err instanceof Error ? err.message : err);
    return null;
  }
}

export interface HarvestConfig {
  harvester: Address | null;
  targets: HarvestTarget[];
  error?: string;
}

export function harvestConfig(env: Pick<Env, "HARVESTER" | "HARVEST_TARGETS">): HarvestConfig {
  const h = env.HARVESTER?.trim();
  const cfg: HarvestConfig = { harvester: h && ADDRESS.test(h) ? (h as Address) : null, targets: [] };
  try {
    cfg.targets = parseHarvestTargets(env.HARVEST_TARGETS);
  } catch (err) {
    cfg.error = err instanceof Error ? err.message : String(err);
  }
  return cfg;
}

function liveHarvestDeps(env: Env, cfg: HarvestConfig) {
  return { rpc: liveProtectRpc(sepoliaRpc(env), sequencerUrl(env)), harvester: cfg.harvester!, targets: cfg.targets, account: protectAccount(protectKey(env)), chainId: CHAINS.sepolia };
}

/** What the protection jobs read this tick, for the harvest job's gate (no extra reads). */
export function protectionView(protect: ProtectReport | null, vault: VaultReport | null, signerBusy: boolean): ProtectionView {
  const vaultWanted = vault?.armed != null || (vault?.targets.some((t) => t.decision?.action === "protect") ?? false);
  const closedQuote = vault?.targets.some((t) => t.quote !== null && (t.quote.reason === "MARKET_CLOSED" || t.quote.session === "WEEKEND" || t.quote.session === "HOLIDAY")) ?? false;
  const heldFeed = protect?.targets.some((t) => t.sizing !== null && t.sizing !== undefined && t.sizing.venueOracleLive === false) ?? false;
  return { signerWanted: signerBusy || vaultWanted, marketClosed: closedQuote || heldFeed };
}

/** The harvest job: one batch, at most one plain transaction; nothing at all while it could not act (harvestGate). Never throws. */
export async function harvestTick(env: Env, view: ProtectionView): Promise<HarvestReport | null> {
  const cfg = harvestConfig(env);
  if (!cfg.harvester || cfg.targets.length === 0) return null;
  const gate = harvestGate(view);
  if (gate) {
    console.log(JSON.stringify({ harvest: nowSeconds(), skipped: gate, reads: 0 }));
    return null;
  }
  try {
    const r = await runHarvest({ ...liveHarvestDeps(env, cfg) });
    console.log(
      jsonWithBigints({
        harvest: r.at,
        ms: r.ms,
        skipped: r.skipped,
        keeperIsSigner: r.keeperIsSigner,
        targets: r.targets.map((t) => `${t.user.slice(0, 8)}:${t.preview?.standing ?? t.error ?? "?"}:${t.decision?.action ?? "-"}`),
        sent: r.sent,
        errors: r.errors,
      }),
    );
    return r;
  } catch (err) {
    console.error("harvest tick failed", err instanceof Error ? err.message : err);
    return null;
  }
}

/** After both protection jobs: look for executions, move the state, send the events. One KV write at most. Never throws. */
export async function eventsTick(env: Env, state: KeeperState, protect: ProtectReport | null, vault: VaultReport | null, cfg: VaultConfig): Promise<void> {
  try {
    const protector = env.PROTECTOR?.trim();
    const reads = executionReads(state, cfg.vault, protector && ADDRESS.test(protector) ? (protector as Address) : null);
    let executions: Execution[] = [];
    if (reads.length > 0) {
      try {
        const outcomes = await liveProtectRpc(sepoliaRpc(env), sequencerUrl(env)).batch(reads.map((r) => r.call));
        executions = decodeExecutions(reads, outcomes, state);
      } catch (err) {
        console.error("execution check failed", err instanceof Error ? err.message : err);
      }
    }
    const head = vault?.head ?? protect?.head ?? null;
    const { next, events, changed } = transitions(state, { chainId: CHAINS.sepolia, now: nowSeconds(), vault, protect, executions, head });
    if (changed && env.KEEPER_STATE) await env.KEEPER_STATE.put(STATE_KEY, JSON.stringify(next));
    if (events.length === 0 && !changed) return;
    const sent = await emitEvents(env.API_EVENTS, events);
    console.log(JSON.stringify({ events: events.map((e) => `${e.type}:${e.lineId ?? e.borrower ?? "-"}:${String(e.data.phase ?? e.data.standing ?? "")}`), sent, stateChanged: changed, grace: Object.keys(next.grace), armed: Object.keys(next.armed) }));
  } catch (err) {
    console.error("events tick failed", err instanceof Error ? err.message : err);
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
export async function tick(env: Env, hold: HoldView): Promise<void> {
  try {
    const report = await runTick(chainFor(env), PAIRS, { maxTxPerTick: maxTxPerTick(env), hold });
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
      hold: hold.source === "none" ? null : { feed: [...hold.feed], registry: [...hold.registry], source: hold.source },
      errors: hold.kvError ? [...report.errors, hold.kvError] : report.errors,
    };
    console.log(JSON.stringify(line));
  } catch (err) {
    console.error("tick failed", err instanceof Error ? err.message : err);
  }
}

/**
 * One cron run. Protection first (its action matters more than a feed mirror): the Protector job, then the vault job
 * (which yields the shared signer whenever the Protector wanted it), then the harvest job (which yields it to either),
 * then the events, then the mirror. The hold switch and the event state are one KV read each.
 */
export async function runCron(env: Env): Promise<void> {
  const cfg = vaultConfig(env);
  const watching = protectDeps(env) !== null || cfg.targets.length > 0;
  // The state first: both jobs need it (re-arm fee steps, backoffs) before they decide.
  const [hold, state] = await Promise.all([readHold(env), watching ? readState(env) : Promise.resolve(null)]);
  const protect = await protectTick(env, state);
  // The Protector keeps the shared signer whenever it wanted to act (a simulated revert or a backoff is not wanting).
  const signerBusy = protect?.targets.some((t) => t.decision !== null && t.decision.action !== "none") ?? false;
  const vault = await vaultTick(env, cfg, signerBusy, state);
  // The harvest job takes the signer only when neither protection job wanted it and the market is open (a dividend
  // can wait a minute); otherwise it reads nothing.
  await harvestTick(env, protectionView(protect, vault, signerBusy));
  if (state) await eventsTick(env, state, protect, vault, cfg);
  await tick(env, hold);
  // Last, so it can never delay a protection or a mirror write: the API's webhook tick (its own cron does not fire).
  console.log(JSON.stringify({ apiTick: await apiTick(env.API_EVENTS) }));
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
} satisfies ExportedHandler<Env>;
