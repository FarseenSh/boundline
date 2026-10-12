// Assurance replay: the fork replay harness (scripts/replay) takes every real Aave and Morpho stock position
// through Friday close, a set of feed gaps and the Sunday reopen, raw venue against Boundline, and publishes the
// result to the SNAPSHOTS KV namespace under `assurance-latest`. The Observatory only serves and renders it.
export const KV_ASSURANCE = "assurance-latest";

export interface AssurancePositionResult {
  venue: "aave" | "morpho";
  address: string;
  market: string;
  collateralSymbol: string;
  debtUsdc: string;
  raw: { hfBefore: string; hfAtReopen: string; liquidatableSaturday: boolean; liquidatableAtReopen: boolean };
  boundline: { action: "pre-repay" | "pre-liquidate" | "none"; actionAt: "friday" | "saturday"; amountUsdc: string; hfAfter: string; liquidatableAtReopen: boolean };
}

export interface AssuranceScenario {
  id: string;
  gapBps: number;
  positions: AssurancePositionResult[];
}

export interface AssuranceRun {
  version: number;
  ranAt: number;
  chainId: number;
  forkBlock: number;
  forkBlockTime: number;
  scenarios: AssuranceScenario[];
  summary: { positions: number; scenarios: number; rawLiquidatable: number; boundlineLiquidatable: number; pass: boolean };
  evidenceHash: string;
  artifact: string;
}

export type AssuranceStatus = { status: "ok"; run: AssuranceRun } | { status: "no run yet" } | { status: "malformed"; detail: string };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Shape check on what the harness wrote; the page must never throw on a half-written key. */
export function parseAssurance(value: unknown): AssuranceStatus {
  if (value === null || value === undefined) return { status: "no run yet" };
  if (!isRecord(value)) return { status: "malformed", detail: "not an object" };
  if (typeof value["version"] !== "number") return { status: "malformed", detail: "version missing" };
  if (typeof value["ranAt"] !== "number") return { status: "malformed", detail: "ranAt missing" };
  if (!Array.isArray(value["scenarios"])) return { status: "malformed", detail: "scenarios missing" };
  const summary = value["summary"];
  if (!isRecord(summary) || typeof summary["pass"] !== "boolean") return { status: "malformed", detail: "summary missing" };
  for (const s of value["scenarios"] as unknown[]) {
    if (!isRecord(s) || typeof s["id"] !== "string" || !Array.isArray(s["positions"])) return { status: "malformed", detail: "scenario shape" };
  }
  return { status: "ok", run: value as unknown as AssuranceRun };
}

export async function readAssurance(kv: KVNamespace): Promise<AssuranceStatus> {
  try {
    return parseAssurance(await kv.get<unknown>(KV_ASSURANCE, "json"));
  } catch (err) {
    return { status: "malformed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Human form of a WAD or decimal health-factor string the harness wrote ("1680896609923236325" or "1.68"). */
export function fmtAssuranceHf(s: string): string {
  if (!/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n.toFixed(3) : s;
  }
  if (s.length > 15) return (Number(s.slice(0, s.length - 12)) / 1e6).toFixed(3);
  return Number(s).toFixed(3);
}
