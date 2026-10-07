import { sumFees, sumSources, type ProtectionEvent } from "./event.js";

export type EqualityId = "sources-uses" | "advance" | "collateral" | "debt" | "bad-debt";

export interface Equality {
  id: EqualityId;
  /** Human statement of the identity. */
  statement: string;
  left: bigint;
  right: bigint;
  /** left − right; zero when the identity holds. */
  residual: bigint;
  holds: boolean;
}

export interface Reconciliation {
  eventId: string;
  equalities: Equality[];
  /** Loan units of the debt left after the event that nothing on the position backs any more. */
  badDebt: bigint;
  pass: boolean;
}

function eq(id: EqualityId, statement: string, left: bigint, right: bigint): Equality {
  return { id, statement, left, right, residual: left - right, holds: left === right };
}

/**
 * Checks the five identities of one event with exact arithmetic:
 *   1. sources = uses: proceeds + reserve funding + liquidator funds = repaid + fees + advance settled + borrower remainder
 *   2. advance conservation: outstandingBefore + advanced − settled = outstandingAfter (and advanced = fromAdvance)
 *   3. collateral conservation: collateral in = sold + returned + retained
 *   4. debt conservation: debt before = debt after + repaid
 *   5. bad debt is a subset of the remaining debt: badDebt = debtAfter when nothing is left on the position, else 0; 0 ≤ badDebt ≤ debtAfter
 */
export function reconcile(e: ProtectionEvent): Reconciliation {
  const uses = e.debt.repaid + sumFees(e.fees) + e.reserve.settled + e.borrowerRemainder;
  const e1 = eq("sources-uses", "proceeds + user + partner + advance + liquidator = repaid + fees + settled + borrower remainder", sumSources(e.sources), uses);
  const advanceLeft = e.reserve.outstandingBefore + e.reserve.advanced - e.reserve.settled;
  const e2a = eq("advance", "outstanding before + advanced − settled = outstanding after", advanceLeft, e.reserve.outstandingAfter);
  const e2 = e.reserve.advanced === e.sources.fromAdvance ? e2a : { ...e2a, holds: false, statement: `${e2a.statement}; advanced must equal the advance funding (${e.reserve.advanced} vs ${e.sources.fromAdvance})` };
  const e3 = eq("collateral", "collateral in = sold + returned + retained", e.collateral.in, e.collateral.sold + e.collateral.returned + e.collateral.retained);
  const e4 = eq("debt", "debt before = debt after + repaid", e.debt.before, e.debt.after + e.debt.repaid);
  const badDebt = e.collateral.remainingOnPosition === 0n ? e.debt.after : 0n;
  const subset = badDebt >= 0n && badDebt <= e.debt.after;
  const e5: Equality = { id: "bad-debt", statement: "bad debt = debt after when the position holds no collateral, otherwise 0; never more than the remaining debt", left: badDebt, right: e.debt.after, residual: e.debt.after - badDebt, holds: subset };
  const nonNegative = [e.collateral.in, e.collateral.sold, e.collateral.returned, e.collateral.retained, e.debt.before, e.debt.after, e.debt.repaid, sumSources(e.sources), sumFees(e.fees), e.reserve.advanced, e.reserve.settled, e.reserve.outstandingBefore, e.reserve.outstandingAfter, e.borrowerRemainder].every((v) => v >= 0n);
  const equalities = [e1, e2, e3, e4, e5];
  return { eventId: e.id, equalities, badDebt, pass: nonNegative && equalities.every((q) => q.holds) };
}

/** The residuals that do not close, keyed by identity, for logs and evidence. */
export function residuals(r: Reconciliation): Partial<Record<EqualityId, bigint>> {
  const out: Partial<Record<EqualityId, bigint>> = {};
  for (const q of r.equalities) if (!q.holds) out[q.id] = q.residual;
  return out;
}
