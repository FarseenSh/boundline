// Seize watch panel (plan M9): the indexer answers who can seize the ten Coinbase stocks, under which exemption policy,
// and whether the venue pools are exempt (its GET /v1/seize-watch: a full-history baseline, indexed events since, live
// reads). The Observatory refreshes it through the service binding on minute 3 of every 30 and keeps it in KV, so the
// page never waits on the indexer and the free tier's 1,000 KV writes a day are not spent (48 a day here).

export const KV_SEIZE = "seize-watch";
/** Kept a little over two refresh periods, so one missed refresh does not empty the panel. */
export const SEIZE_TTL_SECONDS = 2 * 3600;

/** Minute 3 of every 30: never shares a tick with the positions (0 mod 5), Aave (1 mod 5) or gaps (2 mod 10) jobs. */
export function seizeDue(epochSeconds: number): boolean {
  return Math.floor(epochSeconds / 60) % 30 === 3;
}

export interface SeizeVenue {
  name: string;
  address: string;
  exempt: boolean | null;
}

export interface SeizeToken {
  symbol: string;
  token: string;
  verdict: "NO_SEIZE_ROLE" | "SEIZE_ROLE_HELD" | "SEIZE_ROLE_REVOKED" | "SEIZED_BEFORE" | string;
  seizeRole: { grantsAllTime: number; holders: string[] };
  seizeExemptPolicy: { live: number | null; updates: { old: number; new: number; block: number; time: number; tx: string }[] };
  seizeReceiverPolicy: { live: number | null };
  seized: number;
  venues: SeizeVenue[] | null;
}

export interface SeizeWatchBody {
  chainId: number;
  asOf: number;
  live: { block: number | null; error: string | null };
  coverage: { baseline: { from: number; to: number; toTime: number; governanceLogs: number; method: string }; tokenEvents: { to: number; toTime: number } | null };
  summary: { seizeRoleHolders: number; seizeRoleGrantsAllTime: number; seizedAllTime: number; exemptionPolicies: number[]; venuesNotExempt: { symbol: string; venue: string; address: string }[]; statement: string };
  policyChanges: { policyId: number; event: string; accounts: string[]; block: number; time: number; tx: string }[];
  tokens: SeizeToken[];
}

/** A minimal shape check before the body is cached or rendered (the indexer is another deployment). */
export function isSeizeWatchBody(x: unknown): x is SeizeWatchBody {
  const b = x as Partial<SeizeWatchBody> | null;
  return Boolean(b && typeof b === "object" && Array.isArray(b.tokens) && b.summary && typeof b.summary.statement === "string" && b.live && b.coverage);
}
