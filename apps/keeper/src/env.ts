export interface Env {
  /** Comma-separated Base mainnet RPC list (a var in `wrangler.jsonc`); the first answers, the rest are fallbacks. */
  BASE_RPC_URL: string;
  /** Comma-separated Base Sepolia RPC list (a var in `wrangler.jsonc`). */
  BASE_SEPOLIA_RPC_URL: string;
  /** Optional keyed RPCs (secrets), tried before the public lists. */
  BASE_RPC_URL_PRIVATE?: string;
  BASE_SEPOLIA_RPC_URL_PRIVATE?: string;
  /**
   * The keeper's private key, a secret (`wrangler secret put KEEPER_KEY`). Test-only Base Sepolia key that owns the
   * TestPriceFeeds and the MirrorOracleRegistry; never a mainnet key. Absent → the Worker only reads and reports.
   */
  KEEPER_KEY?: string;
  /** Transactions per tick (default 1; see config.ts MAX_TX_PER_TICK). */
  MAX_TX_PER_TICK?: string;
  /** Protection job (src/protect-job.ts): the Protector address; absent → the job is off. */
  PROTECTOR?: string;
  /** `preLiq:borrower:feed:slot,...` (src/protect.ts parseTargets). */
  PROTECT_TARGETS?: string;
  /** The protection signer's key, a secret of its own so a waiting validity transaction never blocks the mirror key. */
  PROTECT_KEY?: string;
  /** Sequencer endpoint for base_sendRawTransactionValidity (Base Sepolia: https://sepolia-sequencer.base.org). */
  BASE_SEPOLIA_SEQUENCER_URL?: string;
  /**
   * Comma-separated symbols whose Sepolia feed (or registry params) the mirror leaves alone, so a drill on the
   * simulators (a scheduled multiplier, a registry pause, a stale feed) is not reverted a minute later. Blank = none.
   */
  MIRROR_HOLD_FEED?: string;
  MIRROR_HOLD_REGISTRY?: string;
  /**
   * Runtime state (KV, binding KEEPER_STATE): key `hold` is the drill hold switch, JSON `{"feed": [...], "registry": [...]}`,
   * merged with the two MIRROR_HOLD_* vars so a drill can hold a symbol without a redeploy (README, "Drills by hand").
   * Absent binding or key → the vars alone.
   */
  KEEPER_STATE?: KVNamespace;
  /** Vault job (src/vault-job.ts): the DeskProtectionVault and the CreditDesk it repays through; absent → the job is off. */
  DESK_PROTECTION_VAULT?: string;
  CREDIT_DESK?: string;
  /** `lineId:graceLtvBps:targetLtvBps:shadowOracle:feed:slot,...` (src/vault.ts parseVaultTargets); blank → the job only answers /v1/vault. */
  VAULT_TARGETS?: string;
  /** Harvest job (src/harvest-job.ts): the DividendHarvester and its targets as <user>:<marketId>, comma-separated. */
  HARVESTER?: string;
  HARVEST_TARGETS?: string;
  /**
   * The partner API's event intake: an RPC binding to boundline-api, entrypoint `Events` (src/events.ts). Bound only
   * once the API serves it; absent → events are logged in the tick line and not sent.
   */
  API_EVENTS?: import("./events.js").EventsBinding;
}

function join(...parts: (string | undefined)[]): string {
  return parts.filter((u): u is string => typeof u === "string" && u.trim().length > 0).join(",");
}

/** Mainnet RPC list: the keyed secret first when set, then the public list. */
export function mainnetRpc(env: Env): string {
  return join(env.BASE_RPC_URL_PRIVATE, env.BASE_RPC_URL);
}

/** Sepolia RPC list, same rule. */
export function sepoliaRpc(env: Env): string {
  return join(env.BASE_SEPOLIA_RPC_URL_PRIVATE, env.BASE_SEPOLIA_RPC_URL);
}

/** A usable `0x`-prefixed 32-byte key, or null when the secret is absent or malformed. */
export function keeperKey(env: Env): `0x${string}` | null {
  return asKey(env.KEEPER_KEY);
}

export function protectKey(env: Env): `0x${string}` | null {
  return asKey(env.PROTECT_KEY);
}

function asKey(value: string | undefined): `0x${string}` | null {
  const k = value?.trim();
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) return null;
  return k as `0x${string}`;
}

export function sequencerUrl(env: Env): string {
  return env.BASE_SEPOLIA_SEQUENCER_URL?.trim() || "https://sepolia-sequencer.base.org";
}

/** The held symbols from the two MIRROR_HOLD_* vars (trimmed, blank entries dropped). */
export function mirrorHold(env: Pick<Env, "MIRROR_HOLD_FEED" | "MIRROR_HOLD_REGISTRY">): { feed: Set<string>; registry: Set<string> } {
  const list = (v: string | undefined) => new Set((v ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0));
  return { feed: list(env.MIRROR_HOLD_FEED), registry: list(env.MIRROR_HOLD_REGISTRY) };
}

/** The KV key of the runtime hold switch. */
export const HOLD_KEY = "hold";

export interface HoldView {
  feed: Set<string>;
  registry: Set<string>;
  /** Where the held symbols came from. */
  source: "none" | "vars" | "kv" | "vars+kv";
  /** Why the KV value was ignored, when it was (a bad value means no KV hold, never a crash). */
  kvError?: string;
}

/** Parses the KV `hold` value, `{"feed": [...], "registry": [...]}`; null, blank or malformed → nothing held (with the reason). */
export function parseKvHold(raw: string | null): { feed: Set<string>; registry: Set<string>; error?: string } {
  const none = (error?: string) => ({ feed: new Set<string>(), registry: new Set<string>(), ...(error ? { error } : {}) });
  if (raw === null || raw.trim() === "") return none();
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return none("hold: not JSON");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return none("hold: not an object");
  const list = (x: unknown): Set<string> =>
    new Set(Array.isArray(x) ? x.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter((s) => s.length > 0) : []);
  const o = v as { feed?: unknown; registry?: unknown };
  return { feed: list(o.feed), registry: list(o.registry) };
}

/** The vars' hold united with the KV hold. */
export function mergeHold(vars: { feed: Set<string>; registry: Set<string> }, kv: { feed: Set<string>; registry: Set<string>; error?: string }): HoldView {
  const fromVars = vars.feed.size + vars.registry.size > 0;
  const fromKv = kv.feed.size + kv.registry.size > 0;
  const source: HoldView["source"] = fromVars && fromKv ? "vars+kv" : fromVars ? "vars" : fromKv ? "kv" : "none";
  return {
    feed: new Set([...vars.feed, ...kv.feed]),
    registry: new Set([...vars.registry, ...kv.registry]),
    source,
    ...(kv.error ? { kvError: kv.error } : {}),
  };
}

/** One KV read per tick; a missing binding, a failed read or a bad value falls back to the vars alone. */
export async function readHold(env: Pick<Env, "MIRROR_HOLD_FEED" | "MIRROR_HOLD_REGISTRY" | "KEEPER_STATE">): Promise<HoldView> {
  const vars = mirrorHold(env);
  if (!env.KEEPER_STATE) return mergeHold(vars, parseKvHold(null));
  let raw: string | null = null;
  try {
    raw = await env.KEEPER_STATE.get(HOLD_KEY);
  } catch (err) {
    return mergeHold(vars, { feed: new Set(), registry: new Set(), error: `hold: KV read failed: ${err instanceof Error ? err.message : String(err)}` });
  }
  return mergeHold(vars, parseKvHold(raw));
}
