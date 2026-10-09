// Recorded drill runs, bundled from docs/evidence/drills/*.json at build time so the API serves exactly what the
// repository documents. Add a file there (same shape) and import it here to publish a new run.
import badDebtProbe from "../../../docs/evidence/drills/bad-debt-probe.json" with { type: "json" };
import dividendHarvest from "../../../docs/evidence/drills/dividend-harvest.json" with { type: "json" };
import ineligibleReceiver from "../../../docs/evidence/drills/ineligible-receiver.json" with { type: "json" };
import issuerTransferPause from "../../../docs/evidence/drills/issuer-transfer-pause.json" with { type: "json" };
import keeperHold from "../../../docs/evidence/drills/keeper-hold.json" with { type: "json" };
import partialRepayment from "../../../docs/evidence/drills/partial-repayment.json" with { type: "json" };
import protection from "../../../docs/evidence/drills/protection.json" with { type: "json" };
import registryPause from "../../../docs/evidence/drills/registry-pause.json" with { type: "json" };
import scheduledMultiplier from "../../../docs/evidence/drills/scheduled-multiplier.json" with { type: "json" };
import staleFeed from "../../../docs/evidence/drills/stale-feed.json" with { type: "json" };
import validityTransactions from "../../../docs/evidence/drills/validity-transactions.json" with { type: "json" };
import venueHalt from "../../../docs/evidence/drills/venue-halt.json" with { type: "json" };
import weekendGap from "../../../docs/evidence/drills/weekend-gap.json" with { type: "json" };

export interface DrillTx {
  hash: string;
  label: string;
  block?: number;
}

export interface DrillRun {
  /** Unix seconds of the run's defining block (or of the reconstruction when there is no transaction). */
  ranAt: number;
  chainId: number;
  label: string;
  txs: DrillTx[];
  attempts?: { what: string; result: string }[];
  outcome: string;
  evidence: string[];
  notes?: string;
}

export interface DrillRunFile {
  drill: string;
  runs: DrillRun[];
}

export const DRILL_RUNS: readonly DrillRunFile[] = [
  weekendGap,
  staleFeed,
  registryPause,
  issuerTransferPause,
  scheduledMultiplier,
  ineligibleReceiver,
  venueHalt,
  keeperHold,
  partialRepayment,
  badDebtProbe,
  protection,
  validityTransactions,
  dividendHarvest,
] as unknown as DrillRunFile[];
