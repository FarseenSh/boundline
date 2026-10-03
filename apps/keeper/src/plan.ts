// Pure mirror decisions: no network, fully unit-tested.

export interface Round {
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
}

export interface RegistryParams {
  multiplier: bigint;
  paused: boolean;
}

/** `setRoundData` arguments in ABI order. */
export type RoundArgs = readonly [bigint, bigint, bigint, bigint, bigint];

export const ROUND_FIELDS = ["roundId", "answer", "startedAt", "updatedAt", "answeredInRound"] as const;
export type RoundField = (typeof ROUND_FIELDS)[number];

export type FeedPlan =
  | { action: "skip"; reason: "in-sync" | "mainnet-empty" }
  | { action: "setRoundData"; reason: "sepolia-unknown" | "differs"; args: RoundArgs; changed: readonly RoundField[] };

export type RegistryPlan =
  | { action: "skip"; reason: "in-sync" }
  | { action: "setOracleParams"; reason: "sepolia-unknown" | "differs"; args: readonly [bigint, boolean] };

export function roundDiff(a: Round, b: Round): RoundField[] {
  return ROUND_FIELDS.filter((f) => a[f] !== b[f]);
}

export function toRoundArgs(r: Round): RoundArgs {
  return [r.roundId, r.answer, r.startedAt, r.updatedAt, r.answeredInRound];
}

/**
 * Mirror the whole mainnet round onto the Sepolia TestPriceFeed. Faithful by design: a stale or paused
 * mainnet round is copied as is, so the Sepolia gate shows what the mainnet gate would. Only an all-zero
 * mainnet round (a decode glitch, never a real Chainlink round) is refused.
 */
export function planFeedMirror(mainnet: Round, sepolia: Round | null): FeedPlan {
  if (mainnet.updatedAt === 0n && mainnet.answer === 0n) return { action: "skip", reason: "mainnet-empty" };
  if (sepolia === null) {
    return { action: "setRoundData", reason: "sepolia-unknown", args: toRoundArgs(mainnet), changed: [...ROUND_FIELDS] };
  }
  const changed = roundDiff(mainnet, sepolia);
  if (changed.length === 0) return { action: "skip", reason: "in-sync" };
  return { action: "setRoundData", reason: "differs", args: toRoundArgs(mainnet), changed };
}

/** Mirror the mainnet OracleRegistry params (multiplier, paused) onto the Sepolia MirrorOracleRegistry. */
export function planRegistryMirror(mainnet: RegistryParams, sepolia: RegistryParams | null): RegistryPlan {
  const args = [mainnet.multiplier, mainnet.paused] as const;
  if (sepolia === null) return { action: "setOracleParams", reason: "sepolia-unknown", args };
  if (mainnet.multiplier === sepolia.multiplier && mainnet.paused === sepolia.paused) return { action: "skip", reason: "in-sync" };
  return { action: "setOracleParams", reason: "differs", args };
}

/**
 * Send only when nothing from the keeper is still in the mempool: a pending nonce above the latest one means a
 * previous tick's transactions are in flight, and resending the same updates would only burn gas.
 */
export function shouldSend(latestNonce: bigint, pendingNonce: bigint): boolean {
  return pendingNonce <= latestNonce;
}

/** Seconds the Sepolia feed trails mainnet's `updatedAt`; 0 when in sync, null when Sepolia is unknown. */
export function lagSeconds(mainnet: Round, sepolia: Round | null): number | null {
  if (sepolia === null) return null;
  if (roundDiff(mainnet, sepolia).length === 0) return 0;
  const lag = mainnet.updatedAt - sepolia.updatedAt;
  return lag > 0n ? Number(lag) : 0;
}
