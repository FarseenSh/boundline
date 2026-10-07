export type Venue = "morpho" | "aave";

/** What happened. The kinds share one shape; the flows that do not apply stay zero. */
export type EventKind =
  | "pre-liquidation" // Morpho pre-liquidation through the Protector: collateral seized and sold, debt repaid from proceeds
  | "protective-repay" // a repay funded from reserves or an advance (ProtectionVault, DeskProtectionVault, spend permission)
  | "liquidation" // the venue's own liquidation: collateral seized at the venue's incentive, debt repaid by the liquidator
  | "recovery" // Monday recovery: collateral withdrawn and sold to settle an advance
  | "settlement"; // an advance settled in USDC by the user or the partner

export interface CollateralFlows {
  /** Raw collateral units that left the position in this event (seized, withdrawn or recovered). */
  in: bigint;
  /** Sold on the DEX or taken by the liquidator against the repaid debt. */
  sold: bigint;
  /** Handed back to the borrower. */
  returned: bigint;
  /** Kept in kind as the incentive (the Protector's preLIF remainder, the liquidator's bonus). */
  retained: bigint;
  /** What is still on the position afterwards; decides whether remaining debt is bad debt. */
  remainingOnPosition: bigint;
}

export interface DebtFlows {
  before: bigint;
  after: bigint;
  /** Loan units repaid to the venue in this event. */
  repaid: bigint;
}

/** Where the money for the uses came from, in loan units. */
export interface Sources {
  /** Sale proceeds in loan units (the sold collateral at the price it fetched). */
  proceeds: bigint;
  /** The user's own reserve or spend permission. */
  fromUser: bigint;
  /** The partner's reserve. */
  fromPartner: bigint;
  /** A bounded Reserve advance, recorded as outstanding until settled. */
  fromAdvance: bigint;
  /** The liquidator's own funds (venue liquidation). */
  fromLiquidator: bigint;
}

/** Where the money went, in loan units. `repaid` lives in `debt`. */
export interface Fees {
  protocol: bigint;
  /** Incentive paid in loan units (0 when it was retained in kind). */
  incentive: bigint;
  /** Advance fee paid in this event. */
  advance: bigint;
  keeper: bigint;
}

export interface ReserveFlows {
  /** New advance principal recorded in this event (equals `sources.fromAdvance`). */
  advanced: bigint;
  /** Advance principal settled in this event. */
  settled: bigint;
  /** Outstanding advance principal for this user or line after the event. */
  outstandingBefore: bigint;
  outstandingAfter: bigint;
}

export interface ProtectionEvent {
  id: string;
  venue: Venue;
  kind: EventKind;
  /** Line id on a desk, or the user's address on a venue-direct position. */
  subject: string;
  /** Unix seconds. */
  at: number;
  collateral: CollateralFlows;
  debt: DebtFlows;
  sources: Sources;
  fees: Fees;
  reserve: ReserveFlows;
  /** Loan units returned to the borrower (sale proceeds beyond the repay and the fees). */
  borrowerRemainder: bigint;
  /** Free text: tx hash, decision hash, note. */
  reference?: string;
}

export const ZERO_COLLATERAL: CollateralFlows = { in: 0n, sold: 0n, returned: 0n, retained: 0n, remainingOnPosition: 0n };
export const ZERO_SOURCES: Sources = { proceeds: 0n, fromUser: 0n, fromPartner: 0n, fromAdvance: 0n, fromLiquidator: 0n };
export const ZERO_FEES: Fees = { protocol: 0n, incentive: 0n, advance: 0n, keeper: 0n };
export const ZERO_RESERVE: ReserveFlows = { advanced: 0n, settled: 0n, outstandingBefore: 0n, outstandingAfter: 0n };

export function sumSources(s: Sources): bigint {
  return s.proceeds + s.fromUser + s.fromPartner + s.fromAdvance + s.fromLiquidator;
}

export function sumFees(f: Fees): bigint {
  return f.protocol + f.incentive + f.advance + f.keeper;
}

/** Fills the flows that do not apply with zero so callers only write what happened. */
export function event(
  partial: Omit<ProtectionEvent, "collateral" | "debt" | "sources" | "fees" | "reserve" | "borrowerRemainder"> & {
    collateral?: Partial<CollateralFlows>;
    debt: DebtFlows;
    sources?: Partial<Sources>;
    fees?: Partial<Fees>;
    reserve?: Partial<ReserveFlows>;
    borrowerRemainder?: bigint;
  },
): ProtectionEvent {
  return {
    ...partial,
    collateral: { ...ZERO_COLLATERAL, ...partial.collateral },
    debt: partial.debt,
    sources: { ...ZERO_SOURCES, ...partial.sources },
    fees: { ...ZERO_FEES, ...partial.fees },
    reserve: { ...ZERO_RESERVE, ...partial.reserve },
    borrowerRemainder: partial.borrowerRemainder ?? 0n,
  };
}
