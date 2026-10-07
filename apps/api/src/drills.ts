// The drills registry (plan M6 and M8): every drill the stack is built to pass, with its steps, and the runs that
// have actually been executed so far. Definitions live here; run records are JSON files under docs/evidence/drills
// bundled at build time (drill-runs.ts), so the console and the evidence export show the same hashes the docs do.
import { DRILL_RUNS, type DrillRun } from "./drill-runs.js";

export interface DrillStep {
  n: number;
  title: string;
  detail: string;
}

export interface DrillDefinition {
  id: string;
  title: string;
  description: string;
  /** Where the drill runs: the Morpho desk, the Aave desk, the oracle stack, or the issuer's B20 controls. */
  venue: "morpho" | "aave" | "oracle" | "issuer" | "cobalt" | "both";
  steps: DrillStep[];
}

export interface Drill extends DrillDefinition {
  runs: DrillRun[];
}

const step = (n: number, title: string, detail: string): DrillStep => ({ n, title, detail });

export const DRILL_DEFINITIONS: readonly DrillDefinition[] = [
  {
    id: "weekend-gap",
    title: "Weekend gap",
    description:
      "The Chainlink feed holds Friday's close from 20:00 ET until Sunday 20:00 ET while the DEX keeps trading. Session-safe markets refuse to price the held value; the reopen prints a gap against it.",
    venue: "both",
    steps: [
      step(1, "Stage a position before the Friday close", "A self-custody line with collateral and debt, just above the grace line, before Fri 20:00 ET."),
      step(2, "Weekend session: refusals and allowances", "borrow, withdrawCollateral and liquidate revert MarketClosed(WEEKEND); repay and supplyCollateral pass (they never read the oracle)."),
      step(3, "Saturday: shadow price", "The ShadowGuard prices the position at the 1h DEX TWAP less the haircut; the keeper acts only inside the band."),
      step(4, "Reopen capture", "The Observatory records the first rounds after Sun 20:00 ET: lag, gap in bps, DEX versus held feed."),
      step(5, "Evidence", "Round history, block numbers, decision hashes and the capture summary with hashes."),
    ],
  },
  {
    id: "stale-feed",
    title: "Stale feed",
    description: "A feed older than heartbeat plus tolerance (24 h + 2 h) is refused as FEED_STALE even inside a session.",
    venue: "oracle",
    steps: [
      step(1, "Let the feed age past the gate's limit", "On Sepolia the mirrored TestPriceFeed keeps mainnet's updatedAt; an in-session gap past 26 h makes it stale."),
      step(2, "Quote and draw", "The desk's quote answers FEED_STALE; draw and withdrawCollateral revert Refused(FEED_STALE)."),
      step(3, "Recovery", "The next fresh round clears the hold; the obligation status returns from HOLD_FEED to OPEN."),
    ],
  },
  {
    id: "registry-pause",
    title: "Registry pause",
    description: "The OracleRegistry's paused flag for a token makes the gate answer FEED_PAUSED; draws hold, repays continue.",
    venue: "oracle",
    steps: [
      step(1, "Pause the token on the registry", "On Sepolia the keeper-owned MirrorOracleRegistry sets paused = true (the mirror is suspended for the drill)."),
      step(2, "Observe the hold", "quote: FEED_PAUSED; obligation status HOLD_FEED; the Observatory shows the pause."),
      step(3, "Unpause", "paused = false; the line returns to OPEN."),
    ],
  },
  {
    id: "issuer-transfer-pause",
    title: "Issuer transfer pause",
    description: "A B20 issuer pausing transfers (isPaused(TRANSFER)) makes the gate answer TRANSFER_PAUSED: nothing can move the collateral, so nothing is lent against it.",
    venue: "issuer",
    steps: [
      step(1, "Pause transfers on the test stock", "The issuer role pauses the TRANSFER feature on the Sepolia B20 asset."),
      step(2, "Observe", "quote: TRANSFER_PAUSED; obligation status HOLD_TRANSFER; addCollateral and withdrawCollateral revert at the token."),
      step(3, "Unpause", "The hold lifts with the feature."),
    ],
  },
  {
    id: "scheduled-multiplier",
    title: "Scheduled multiplier",
    description: "A scheduled lower UI multiplier (a split or a corporate action) within seven days haircuts capacity ahead of its effectiveAt.",
    venue: "cobalt",
    steps: [
      step(1, "Schedule a 2-for-1 on the test stock", "setOracleParams with the new multiplier and an effectiveAt a few days out."),
      step(2, "Quote", "corporateActionHaircut = true; capacity reflects the lower multiplier before it takes effect."),
      step(3, "Effective", "After effectiveAt the registry value is the new one; the haircut flag clears."),
    ],
  },
  {
    id: "ineligible-receiver",
    title: "Ineligible receiver",
    description: "Cobalt's composite receiver policy (partner allowlist INTERSECT issuer blocklist) refuses a receiver that is not admitted; the desk preflights isAuthorized on both legs.",
    venue: "cobalt",
    steps: [
      step(1, "A receiver outside the allowlist", "An address not on the holders allowlist tries to receive the test stock."),
      step(2, "Refusal", "The transfer reverts at the token; the desk's quote answers NOT_ELIGIBLE before any call is sent."),
      step(3, "Admission", "updateAllowlist admits the address; the same transfer passes."),
    ],
  },
  {
    id: "venue-halt",
    title: "Venue halt",
    description: "A venue-level pause or freeze (Aave's halt of 24 Sep 2026 is the precedent) surfaces as VENUE_PAUSED or VENUE_FROZEN on the Aave desk; repays through the Giver keep working where the venue allows them.",
    venue: "aave",
    steps: [
      step(1, "Freeze the reserve on a fork", "Reserve frozen or paused on the MAG7 spoke."),
      step(2, "Observe", "AaveDesk quote: VENUE_PAUSED / VENUE_FROZEN; draws refused; the obligation status HOLD_VENUE."),
      step(3, "Recovery", "The hold lifts with the venue."),
    ],
  },
  {
    id: "partial-repayment",
    title: "Partial repayment",
    description: "A repay below the debt reduces drawnPrincipal, partner exposure and ticker exposure by exactly the principal repaid; anyone may repay.",
    venue: "morpho",
    steps: [
      step(1, "Draw in session", "The line owner draws; Decision DRAW with the price and session."),
      step(2, "Repay part of it", "The owner or a third party repays; Repaid(lineId, amount, full=false), Decision REPAY."),
      step(3, "Reconcile", "Desk, Morpho position and the indexer agree on the remaining debt."),
    ],
  },
  {
    id: "bad-debt-probe",
    title: "Bad-debt probe",
    description: "A position taken through LLTV on a fork, liquidated at the venue, reconciled by the ledger: bad debt is a subset of remaining debt and the five-way conservation holds.",
    venue: "morpho",
    steps: [
      step(1, "Gap the price past LLTV on a fork", "Rewrite the feed by more than the band allows."),
      step(2, "Venue liquidation", "Morpho's liquidate at the held price; the ledger records proceeds, fees, remainder."),
      step(3, "Reconcile", "proceeds = debt reduction + fees + remainder; bad debt classified."),
    ],
  },
  {
    id: "protection",
    title: "Protection (shadow pre-liquidation)",
    description: "An opted-in position inside the band (preLltv < shadow LTV ≤ LLTV) is pre-liquidated partially at the ShadowGuard price by the keeper's validity transaction; the Protector sells the seized collateral inside the callback and repays from the proceeds.",
    venue: "morpho",
    steps: [
      step(1, "Opt in", "Morpho.setAuthorization(preLiquidation, true) by the borrower."),
      step(2, "Enter the band", "Shadow LTV above preLltv (58%) and at or below LLTV (62.5%)."),
      step(3, "Keeper arms the action", "Protector.sizing picks the partial; protect() is signed and submitted as a validity transaction with a held-feed predicate."),
      step(4, "Execution", "PreLiquidate: seized collateral sold on the pool, repaid from proceeds, incentive kept for the Reserve."),
      step(5, "After", "Shadow LTV at preLltv; standing BELOW_BAND; Protected event with a decision hash."),
    ],
  },
  {
    id: "validity-transactions",
    title: "Validity transactions (Cobalt)",
    description: "base_sendRawTransactionValidity with storage predicates on the feed's round slot and a block-number bound: Base itself holds the keeper's action until the state matches.",
    venue: "cobalt",
    steps: [
      step(1, "Sign the action", "repay or protect, signed offline with its own key."),
      step(2, "Submit with predicates", "storage(feed, slot) = held (Saturday action) or != held (first block after the print), block_number <= head + 30."),
      step(3, "Re-arm", "The sequencer accepts a bound at most 32 blocks ahead; the keeper re-submits every tick while the predicate is pending."),
      step(4, "Inclusion", "The transaction lands only in a block where the predicate holds; recorded with the slot value in that block."),
    ],
  },
];

const runsByDrill = new Map<string, DrillRun[]>(DRILL_RUNS.map((file) => [file.drill, file.runs]));

export function listDrills(): Drill[] {
  return DRILL_DEFINITIONS.map((d) => ({ ...d, runs: runsByDrill.get(d.id) ?? [] }));
}

export function getDrill(id: string): Drill | null {
  const d = DRILL_DEFINITIONS.find((x) => x.id === id);
  return d ? { ...d, runs: runsByDrill.get(d.id) ?? [] } : null;
}
