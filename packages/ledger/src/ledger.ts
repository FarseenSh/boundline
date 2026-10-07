import { sumFees, type EventKind, type ProtectionEvent, type Venue } from "./event.js";
import { reconcile, type Reconciliation } from "./reconcile.js";

export interface Totals {
  events: number;
  byKind: Partial<Record<EventKind, number>>;
  collateralIn: bigint;
  collateralSold: bigint;
  collateralReturned: bigint;
  collateralRetained: bigint;
  proceeds: bigint;
  repaid: bigint;
  fromUser: bigint;
  fromPartner: bigint;
  fromLiquidator: bigint;
  fees: bigint;
  advanced: bigint;
  settled: bigint;
  /** Σ advanced − Σ settled: must equal the sum of the latest outstanding per subject. */
  outstanding: bigint;
  borrowerRemainder: bigint;
  badDebt: bigint;
}

export interface SubjectState {
  subject: string;
  venue: Venue;
  events: number;
  outstanding: bigint;
  /** Debt after the latest event for this subject. */
  debtAfter: bigint;
  collateralRemaining: bigint;
  badDebt: bigint;
  lastAt: number;
}

export interface Ledger {
  events: ProtectionEvent[];
  reconciliations: Reconciliation[];
  totals: Totals;
  subjects: Map<string, SubjectState>;
}

export class LedgerError extends Error {
  constructor(message: string, readonly reconciliation?: Reconciliation) {
    super(message);
    this.name = "LedgerError";
  }
}

function emptyTotals(): Totals {
  return { events: 0, byKind: {}, collateralIn: 0n, collateralSold: 0n, collateralReturned: 0n, collateralRetained: 0n, proceeds: 0n, repaid: 0n, fromUser: 0n, fromPartner: 0n, fromLiquidator: 0n, fees: 0n, advanced: 0n, settled: 0n, outstanding: 0n, borrowerRemainder: 0n, badDebt: 0n };
}

export function createLedger(): Ledger {
  return { events: [], reconciliations: [], totals: emptyTotals(), subjects: new Map() };
}

/**
 * Appends an event after reconciling it. Refuses an event that does not close, one whose
 * `outstandingBefore` disagrees with the subject's running outstanding, or one whose debt before
 * disagrees with the subject's last debt after (when the subject has history and `strictChain` is on).
 */
export function record(ledger: Ledger, e: ProtectionEvent, opts: { strictChain?: boolean } = {}): Reconciliation {
  const r = reconcile(e);
  if (!r.pass) throw new LedgerError(`event ${e.id} does not reconcile: ${r.equalities.filter((q) => !q.holds).map((q) => `${q.id} residual ${q.residual}`).join(", ")}`, r);
  const key = `${e.venue}:${e.subject}`;
  const prev = ledger.subjects.get(key);
  const running = prev?.outstanding ?? 0n; // a subject starts with nothing advanced
  if (running !== e.reserve.outstandingBefore) {
    throw new LedgerError(`event ${e.id}: outstandingBefore ${e.reserve.outstandingBefore} but the ledger has ${running} outstanding for ${key}`, r);
  }
  if (prev && opts.strictChain && prev.debtAfter !== e.debt.before) {
    throw new LedgerError(`event ${e.id}: debt before ${e.debt.before} but the ledger's last debt after for ${key} is ${prev.debtAfter} (interest or outside repays must be booked as their own events)`, r);
  }
  ledger.events.push(e);
  ledger.reconciliations.push(r);
  const t = ledger.totals;
  t.events += 1;
  t.byKind[e.kind] = (t.byKind[e.kind] ?? 0) + 1;
  t.collateralIn += e.collateral.in;
  t.collateralSold += e.collateral.sold;
  t.collateralReturned += e.collateral.returned;
  t.collateralRetained += e.collateral.retained;
  t.proceeds += e.sources.proceeds;
  t.repaid += e.debt.repaid;
  t.fromUser += e.sources.fromUser;
  t.fromPartner += e.sources.fromPartner;
  t.fromLiquidator += e.sources.fromLiquidator;
  t.fees += sumFees(e.fees);
  t.advanced += e.reserve.advanced;
  t.settled += e.reserve.settled;
  t.outstanding = t.advanced - t.settled;
  t.borrowerRemainder += e.borrowerRemainder;
  t.badDebt = t.badDebt - (prev?.badDebt ?? 0n) + r.badDebt;
  ledger.subjects.set(key, { subject: e.subject, venue: e.venue, events: (prev?.events ?? 0) + 1, outstanding: e.reserve.outstandingAfter, debtAfter: e.debt.after, collateralRemaining: e.collateral.remainingOnPosition, badDebt: r.badDebt, lastAt: e.at });
  return r;
}

export interface LedgerCheck {
  pass: boolean;
  /** Σ advanced = Σ settled + Σ outstanding per subject. */
  advanceConservation: { advanced: bigint; settled: bigint; outstandingBySubject: bigint; holds: boolean };
  /** Σ sources = Σ uses over the whole ledger. */
  flowConservation: { sources: bigint; uses: bigint; holds: boolean };
  /** Σ collateral in = Σ sold + returned + retained. */
  collateralConservation: { in: bigint; out: bigint; holds: boolean };
  /** Bad debt never exceeds the remaining debt of the subjects that carry it. */
  badDebtSubset: { badDebt: bigint; remainingDebt: bigint; holds: boolean };
  eventsPassing: number;
}

/** The ledger-wide identities, recomputed from the events rather than the running totals. */
export function check(ledger: Ledger): LedgerCheck {
  let advanced = 0n;
  let settled = 0n;
  let sources = 0n;
  let uses = 0n;
  let cin = 0n;
  let cout = 0n;
  for (const e of ledger.events) {
    advanced += e.reserve.advanced;
    settled += e.reserve.settled;
    sources += e.sources.proceeds + e.sources.fromUser + e.sources.fromPartner + e.sources.fromAdvance + e.sources.fromLiquidator;
    uses += e.debt.repaid + sumFees(e.fees) + e.reserve.settled + e.borrowerRemainder;
    cin += e.collateral.in;
    cout += e.collateral.sold + e.collateral.returned + e.collateral.retained;
  }
  let outstandingBySubject = 0n;
  let badDebt = 0n;
  let remainingDebt = 0n;
  for (const s of ledger.subjects.values()) {
    outstandingBySubject += s.outstanding;
    badDebt += s.badDebt;
    remainingDebt += s.debtAfter;
  }
  const advanceConservation = { advanced, settled, outstandingBySubject, holds: advanced === settled + outstandingBySubject };
  const flowConservation = { sources, uses, holds: sources === uses };
  const collateralConservation = { in: cin, out: cout, holds: cin === cout };
  const badDebtSubset = { badDebt, remainingDebt, holds: badDebt >= 0n && badDebt <= remainingDebt };
  const eventsPassing = ledger.reconciliations.filter((r) => r.pass).length;
  return { pass: advanceConservation.holds && flowConservation.holds && collateralConservation.holds && badDebtSubset.holds && eventsPassing === ledger.events.length, advanceConservation, flowConservation, collateralConservation, badDebtSubset, eventsPassing };
}

/** JSON-safe view (bigints as decimal strings) for evidence files. */
export function toJSON(ledger: Ledger): unknown {
  return JSON.parse(JSON.stringify({ events: ledger.events, reconciliations: ledger.reconciliations, totals: ledger.totals, subjects: [...ledger.subjects.values()], check: check(ledger) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
