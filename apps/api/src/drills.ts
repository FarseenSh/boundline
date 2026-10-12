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
    description: "A feed older than heartbeat plus tolerance (24 h + 2 h) is refused as FEED_STALE even inside a session: the gate fails closed, the desk refuses draws and the obligation holds as HOLD_FEED until a fresh round prints.",
    venue: "oracle",
    steps: [
      step(1, "Age the feed past the gate's limit", "With the keeper's mirror held for the symbol, TestPriceFeed.setRoundData re-stamps the live round 27 h old while the session is open (the mirror otherwise copies mainnet's rounds verbatim)."),
      step(2, "Refusals", "The gate answers FEED_STALE; SessionGuard.price() reverts FeedStale(token, updatedAt, maxAge); the desk's quote answers FEED_STALE and a draw reverts Refused(FEED_STALE); obligationStatus is HOLD_FEED."),
      step(3, "Recovery", "Releasing the hold lets the keeper mirror the live mainnet round again; the gate reopens and the obligation returns to OPEN."),
    ],
  },
  {
    id: "registry-pause",
    title: "Registry pause",
    description: "The Coinbase OracleRegistry's paused flag for a token makes the gate answer FEED_PAUSED: draws, withdrawals and the venue oracle stop, the obligation holds as HOLD_ISSUER (the desk maps a registry pause to the issuer hold), and collateral can still be added.",
    venue: "oracle",
    steps: [
      step(1, "Pause the token on the registry", "On Sepolia the keeper-owned MirrorOracleRegistry (the mirror of Coinbase's registry) sets paused = true, with the mirror held for the drill."),
      step(2, "Observe the hold", "The gate and the quote answer FEED_PAUSED; SessionGuard.price() reverts FeedPaused(token); withdrawCollateral reverts Refused(FEED_PAUSED); obligationStatus is HOLD_ISSUER; addCollateral still lands (supplyCollateral never reads the oracle)."),
      step(3, "Unpause", "paused = false: the gate is OPEN again and the quote NONE."),
    ],
  },
  {
    id: "issuer-transfer-pause",
    title: "Issuer transfer pause",
    description: "A B20 issuer pausing transfers (isPaused(TRANSFER)) makes the gate answer TRANSFER_PAUSED: nothing can move the collateral, so nothing is lent against it, and the obligation holds as HOLD_TRANSFER.",
    venue: "issuer",
    steps: [
      step(1, "Pause transfers on the test stock", "The issuer (PAUSE_ROLE) calls pause([TRANSFER]) on the Sepolia B20 asset."),
      step(2, "Observe", "The gate and the line's quote answer TRANSFER_PAUSED; obligationStatus is HOLD_TRANSFER; withdrawCollateral is refused by the desk (Refused(TRANSFER_PAUSED)); addCollateral and a plain transfer revert at the token (ContractPaused)."),
      step(3, "Unpause", "unpause([TRANSFER]) by the issuer (UNPAUSE_ROLE): the gate reopens, the quote is NONE and the obligation OPEN."),
    ],
  },
  {
    id: "scheduled-multiplier",
    title: "Scheduled multiplier",
    description: "A scheduled LOWER UI multiplier (a split or another corporate action, announced on the B20 asset under ERC-8056) within seven days haircuts collateral value and capacity by next/current ahead of its effectiveAt; a higher one (a dividend reinvestment) is never haircut. A haircut cuts capacity; it is not a hold.",
    venue: "cobalt",
    steps: [
      step(1, "Schedule a 2-for-1 on the test stock", "The issuer (OPERATOR_ROLE) calls announce([updateUIMultiplier(0.5e18, effectiveAt)], …) on the B20 asset with effectiveAt three days out (Cobalt, ERC-8056)."),
      step(2, "Quote", "corporateActionHaircut = true; the line's collateral value and capacity halve at the same price (live: capacity 592.39 → 296.20 USDC); the gate and the obligation stay OPEN."),
      step(3, "Cancel or take effect", "announce([cancelUIMultiplierUpdate()]) clears the haircut (capacity back to 592.39 USDC); had it taken effect, the new multiplier would simply be the current one and the flag would clear."),
    ],
  },
  {
    id: "ineligible-receiver",
    title: "Ineligible receiver",
    description: "Cobalt's composite receiver policy (issuer blocklist INTERSECT holders allowlist) refuses a receiver that is not admitted. The desk preflights the B20 policy on both legs and refuses with PolicyForbids before Morpho is called, where Morpho alone would only say \"transfer reverted\". This partner has no eligibility hook, so the refusal is the token's policy, not NOT_ELIGIBLE.",
    venue: "cobalt",
    steps: [
      step(1, "A receiver outside the allowlist", "A fresh address, or a line owner whose admission the issuer withdraws with updateAllowlist(holders allowlist, false, [owner])."),
      step(2, "Refusal", "A transfer to it reverts at the token with PolicyForbids(TRANSFER_RECEIVER_POLICY, policyId); for the line owner the desk's withdrawCollateral refuses with PolicyForbids(TRANSFER_RECEIVER_POLICY, owner) before Morpho is called."),
      step(3, "Admission", "updateAllowlist(holders allowlist, true, [address]) admits it and the same transfer passes; the drill restores the book as it was."),
    ],
  },
  {
    id: "venue-halt",
    title: "Venue halt",
    description: "Aave's real halt switch, replayed: on 24 Sep 2026 the Aave V4 Equities Hub halted the MAG7 spoke (SpokeConfig.halted on the hub for all eight assets) through the Security Council Safe, its executor and a payload calling HubConfigurator.updateSpokeHalted. Replayed on a Base mainnet fork with the exact payloads against a real borrower on an AaveDesk line with a ProtectionVault, followed by the spoke's own reserve freeze and pause.",
    venue: "aave",
    steps: [
      step(1, "Stage a real position on a fork", "Base mainnet fork at a pinned block; the real borrower 0xC9Bc…ca66 enrolled on an AaveDesk line with a ProtectionVault reserve; baseline: gate OPEN, quote NONE, a 10 USDC draw through the Taker passes."),
      step(2, "Replay the 24 Sep hub halt", "As the Security Council Safe 0x187A…77e9: executor 0xA9D9…3d70.executeTransaction(halt payload 0xbff6…3ac1, execute(), delegatecall) → HubConfigurator.updateSpokeHalted(hub, asset, spoke, true) for assets 0-7, exactly as the real halt transaction 0x86de1998…ed8f."),
      step(3, "Observe the halt", "The desk answers VENUE_HALTED (reason 25, appended after the shared reasons) with obligation HOLD_VENUE and 0 available; the desk's draws, the desk's repays and the vault's protective repay are refused by name (Refused(25)) before the venue is called, while the venue's own repay, withdrawal and liquidation revert SpokeHalted(): nothing moves either way. (Fixed 8 Oct: the drill's first run recorded the desk quoting NONE and OPEN during the halt; the desk and the vault now read the hub's SpokeConfig.)"),
      step(4, "Go live again", "The go-live payload 0x6BDf…198E (the real transactions 0xa003f9e6…b45b1a and 0x9d66188f…5d30) reopens everything: draws, repays and liquidations."),
      step(5, "Reserve freeze and pause", "Through the SpokeConfigurator: AAPLc frozen → VENUE_FROZEN / HOLD_VENUE, the desk refuses the draw while Aave itself would still lend, the protective repay from the user's reserve passes; AAPLc paused → VENUE_PAUSED, the protective repay passes, withdrawal and liquidation revert ReservePaused(); USDC paused → VENUE_PAUSED, the vault refuses the protective repay by name (Refused(20)) and the venue refuses repay and liquidation (ReservePaused()). Every switch reversed returns the line to OPEN."),
    ],
  },
  {
    id: "keeper-hold",
    title: "Keeper hold",
    description: "The desk's keeper holds one line; quote and draw answer LINE_HELD and obligationStatus is HOLD_KEEPER; a repay still lands; release restores OPEN.",
    venue: "morpho",
    steps: [
      step(1, "Hold the line", "desk.hold(lineId, reason) by the desk's keeper: the line goes OPEN → HELD with the reason recorded and a HOLD decision hash."),
      step(2, "Refusals and allowances", "quote answers LINE_HELD; a draw reverts Refused(LINE_HELD); obligationStatus is HOLD_KEEPER; a repay by anyone still lands and reduces the debt (repay never consults the hold or the oracle)."),
      step(3, "Release", "desk.release(lineId) by the keeper: HELD → OPEN with a RELEASE decision; quotes and draws resume."),
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
    description: "The largest real borrower of a Base mainnet Morpho B20 market taken through LLTV by a reopen print beyond the band, on a fork: the raw venue liquidates and writes off bad debt; the same position on a SessionGuard market refuses the Saturday liquidation but still takes the gap at the reopen; under protected mode the Protector sells down at the ShadowGuard price on Saturday and no bad debt is left. The ledger reconciles every event.",
    venue: "morpho",
    steps: [
      step(1, "Stage the position at Friday's close", "Fork at a pinned block; the real borrower is staged to a venue LTV of 0.56 at the close; the feed's own transmission slot is rewritten for the reopen print."),
      step(2, "Raw venue", "A Saturday liquidation at the held price fails (the position is healthy at it); at a −45% reopen print Morpho liquidates all the collateral and writes off bad debt against the suppliers; at −15% every share is repaid."),
      step(3, "Session-safe market", "The same position on a SessionGuard market: Saturday liquidation and borrow revert MarketClosed, a repay passes, and the −45% reopen still writes off bad debt: a session-safe oracle refuses a held price, it does not prevent a gap."),
      step(4, "Protected mode", "As the DEX walks down on Saturday the Protector pre-liquidates at the ShadowGuard price (fresh feed in session, TWAP less 200 bps while held) until the deviation guard stops pricing; at the reopen the liquidation repays every share and no bad debt is left (with the guard at its maximum the position is still healthy at the reopen)."),
      step(5, "Reconcile", "@boundline/ledger over every event: proceeds = debt reduction + fees + remainder; the ledger's bad debt agrees with Morpho's badDebtAssets within one raw unit of share rounding."),
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
    id: "reserve-ladder",
    title: "Protective repay down the funding ladder",
    description:
      "Where a sale cannot run, the DeskProtectionVault repays a desk line at any hour from the user's reserve, then the partner's reserve, then a bounded advance from the Boundline Reserve (ERC-4626); the advance is settled in the next open session with its fee, which the Reserve harvests into its share price. The desk's repay never reads the oracle, so the ladder works while the feed is held.",
    venue: "morpho",
    steps: [
      step(1, "Reserves in place", "The user deposits into their own reserve in the DeskProtectionVault; the Reserve allocates advance liquidity to the vault (a sink under its utilisation cap)."),
      step(2, "Over grace", "The line's shadow LTV crosses the keeper's grace line (52%); the vault job sizes the repay that returns it to the target (45%) and previews the ladder."),
      step(3, "Repay down the ladder", "DeskProtectionVault.protect(lineId, amount), armed by the keeper as a validity transaction with a held-feed predicate: user reserve, then partner reserve, then an advance (fee 1%, cap per line), paid through desk.repay; Protected with a decision hash."),
      step(4, "Settle in session", "repayAdvance(lineId, principal + fee) by anyone once the session is open; AdvanceSettled with a decision hash."),
      step(5, "Harvest", "BoundlineReserve.harvest(vault): the fee moves into the Reserve and its share price rises."),
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
  {
    id: "dividend-harvest",
    title: "Dividend harvest (self-repaying leg)",
    description: "A cash dividend on a Coinbase tokenized stock arrives as a registry multiplier step; the DividendHarvester sweeps the dividend-equivalent collateral raw × (m1 − m0) / m1 into the loan in an open session, so the borrower keeps their share count and the debt falls. Splits, falls and HEADROOM mode re-base without selling.",
    venue: "morpho",
    steps: [
      step(1, "Opt in", "Morpho.setAuthorization(harvester, true) and enroll(market, line, HARVEST) by the borrower: the base multiplier m0 is the registry's value now."),
      step(2, "The multiplier steps", "On Sepolia the keeper-owned MirrorOracleRegistry replays NVDAc's real 1 Oct 2026 step (1.0 → 1.000537939576369481), with the mirror held for the run."),
      step(3, "Harvest", "harvest() by the keeper Worker's harvest job within a tick of the step (or by the operator): a Morpho flash loan repays through desk.repay first, the dividend collateral is withdrawn and sold on the stock's pool above a 1% floor under the gate's price, the rest is supplied back; LTV may not rise; Harvested with a decision hash."),
      step(4, "Re-base on a fall", "The mirror restores mainnet's multiplier; the next harvest re-bases m0 on the step down and sells nothing (Rebased STEP_DOWN)."),
    ],
  },
];

const runsByDrill = new Map<string, DrillRun[]>(DRILL_RUNS.map((file) => [file.drill, file.runs]));

/**
 * A run field longer than this (as JSON) is summarised in the list view: the fork drills carry tens of kilobytes of
 * assertions, values and ledger entries (bad-debt-probe 54 KB, venue-halt 19 KB). GET /v1/drills/:id and the
 * evidence export keep every run whole.
 */
export const LIST_FIELD_LIMIT = 4_096;
const CORE_FIELDS = new Set(["ranAt", "chainId", "label", "txs", "attempts", "outcome", "evidence", "notes"]);

function summarise(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const graded = value.filter((x) => x !== null && typeof x === "object" && "pass" in (x as object));
    return { trimmed: true, count: value.length, ...(graded.length ? { passed: graded.filter((x) => (x as { pass?: unknown }).pass === true).length } : {}) };
  }
  if (value !== null && typeof value === "object") {
    const small = Object.entries(value as Record<string, unknown>).filter(([, v]) => v === null || ["boolean", "number"].includes(typeof v) || (typeof v === "string" && v.length <= 200));
    return { trimmed: true, keys: Object.keys(value as object), ...Object.fromEntries(small) };
  }
  return { trimmed: true };
}

/** The run as the list view shows it: core fields and small extras as they are, large extras summarised. */
export function summariseRun(run: DrillRun, drillId: string): DrillRun {
  const out: Record<string, unknown> = {};
  const trimmed: string[] = [];
  for (const [k, v] of Object.entries(run as unknown as Record<string, unknown>)) {
    if (CORE_FIELDS.has(k) || JSON.stringify(v).length <= LIST_FIELD_LIMIT) out[k] = v;
    else {
      out[k] = summarise(v);
      trimmed.push(k);
    }
  }
  if (trimmed.length) out.trimmedFields = { fields: trimmed, full: `/v1/drills/${drillId}` };
  return out as unknown as DrillRun;
}

/** Every drill with its runs; `full: false` (the list view) summarises the large fields of fork runs. */
export function listDrills(opts: { full?: boolean } = {}): Drill[] {
  return DRILL_DEFINITIONS.map((d) => {
    const runs = runsByDrill.get(d.id) ?? [];
    return { ...d, runs: opts.full ? runs : runs.map((r) => summariseRun(r, d.id)) };
  });
}

export function getDrill(id: string): Drill | null {
  const d = DRILL_DEFINITIONS.find((x) => x.id === id);
  return d ? { ...d, runs: runsByDrill.get(d.id) ?? [] } : null;
}
