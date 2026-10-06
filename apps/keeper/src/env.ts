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
