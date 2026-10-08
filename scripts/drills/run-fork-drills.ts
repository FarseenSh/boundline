// The fork drills driver: runs contracts/test/drills/*.t.sol (venue-halt, bad-debt-probe) under base-forge against a
// Base mainnet fork pinned at one block, parses their `DRILL {...}` log lines, reconciles every flow of the bad-debt
// probe with @boundline/ledger (the same five identities the ledger package tests), verifies the real 24 Sep 2026
// halt transactions on chain, and writes docs/evidence/drills/venue-halt.json and docs/evidence/drills/bad-debt-probe.json
// in the shape of the other drill files (drill, runs[] with ranAt, chainId, label, txs, attempts, outcome, evidence,
// notes) plus fork, assertions, values, ledger and a keccak256 evidence hash over the canonical run.
//
//   pnpm tsx scripts/drills/run-fork-drills.ts [--block N] [--only venue-halt|bad-debt-probe] [--forge-log path] [--out docs/evidence/drills]
//
// Needs BASE_RPC_URL (an archive endpoint) or BOUNDLINE_ALCHEMY_API_KEY, and base-forge at ~/.foundry/bin/base-forge
// (both drills move B20 tokens). The RPC URL never reaches the evidence or the logs. Exits 1 when a check fails or a
// ledger event does not reconcile.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { keccak256, stringToHex } from "viem";
import { event as ledgerEvent, reconcile } from "../../packages/ledger/src/index.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");

/** The real halt of the Aave V4 MAG7 spoke and its reversals (hub `SpokeConfig.halted`), Base mainnet. */
const PRECEDENT = [
  { hash: "0xa003f9e6842d520d8034a33a278cc6812af86a78eab4710241a417df57b45b1a", what: "go-live", payload: "0x6BDf957Ff2AE324fe23911f549aff9b5621b198E" },
  { hash: "0x86de199821582541271107b04751115aafeec608901a6260b0a27af52c0eed8f", what: "halt", payload: "0xbff63E3ad59a5F06716FD2EDd0E3C2a7123E3ac1" },
  { hash: "0x9d66188f9e6f1b9136cb35260c3665c12d82b30fb9bdd7ce52de1aed46205d30", what: "go-live", payload: "0x6BDf957Ff2AE324fe23911f549aff9b5621b198E" },
] as const;

const DRILL_FILES: Record<string, string> = { "venue-halt": "VenueHaltDrill.t.sol", "bad-debt-probe": "BadDebtProbeDrill.t.sol" };

interface Args {
  block: number | null;
  only: string | null;
  forgeLog: string | null;
  out: string;
}

function args(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const only = get("--only") ?? null;
  if (only && !DRILL_FILES[only]) throw new Error(`--only takes ${Object.keys(DRILL_FILES).join(" or ")}`);
  return { block: get("--block") ? Number(get("--block")) : null, only, forgeLog: get("--forge-log") ?? null, out: get("--out") ?? "docs/evidence/drills" };
}

function rpcUrl(): string {
  if (process.env.BASE_RPC_URL) return process.env.BASE_RPC_URL;
  const key = process.env.BOUNDLINE_ALCHEMY_API_KEY;
  if (!key) throw new Error("set BASE_RPC_URL or BOUNDLINE_ALCHEMY_API_KEY");
  return `https://base-mainnet.g.alchemy.com/v2/${key}`;
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------- parsing

interface Rec {
  drill: string;
  kind: "meta" | "check" | "attempt" | "value" | "ledger";
  scenario?: string;
  what?: string;
  name?: string;
  actual?: string | boolean;
  expected?: string | boolean;
  pass?: boolean;
  result?: string;
  value?: string;
  [k: string]: unknown;
}

export function parseForgeLog(log: string): Map<string, Rec[]> {
  const out = new Map<string, Rec[]>();
  for (const line of log.split("\n")) {
    const i = line.indexOf("DRILL {");
    if (i < 0) continue;
    const rec = JSON.parse(line.slice(i + "DRILL ".length)) as Rec;
    if (!out.has(rec.drill)) out.set(rec.drill, []);
    out.get(rec.drill)!.push(rec);
  }
  return out;
}

const usdc = (raw: string | bigint): string => (Number(BigInt(raw)) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const aapl = (raw: string | bigint): string => (Number(BigInt(raw)) / 1e8).toFixed(4);
const wad = (raw: string | bigint): string => (Number(BigInt(raw)) / 1e18).toFixed(4);

function lookup(recs: Rec[]) {
  const value = (scenario: string, name: string): string => {
    const r = recs.find((x) => x.kind === "value" && x.scenario === scenario && x.name === name);
    if (!r?.value) throw new Error(`missing value ${scenario} / ${name}`);
    return r.value;
  };
  const check = (scenario: string, what: string): string => {
    const r = recs.find((x) => x.kind === "check" && x.scenario === scenario && x.what === what);
    if (!r) throw new Error(`missing check ${scenario} / ${what}`);
    return String(r.actual);
  };
  return { value, check };
}

function assertions(recs: Rec[]) {
  return recs
    .filter((r) => r.kind === "check")
    .map((r) => ({ scenario: r.scenario!, what: r.what!, actual: r.actual!, expected: r.expected!, pass: r.pass === true }));
}

function attempts(recs: Rec[]) {
  return recs
    .filter((r) => r.kind === "check" && typeof r.actual === "string" && (r.actual === "ok" || /\(|^0x/.test(r.actual)) && /draw|repay|withdraw|liquidat|supply|borrow/i.test(r.what ?? ""))
    .map((r) => ({ what: `${r.scenario}: ${r.what}`, result: r.pass ? String(r.actual) : `${String(r.actual)} (expected ${String(r.expected)})` }));
}

function values(recs: Rec[]) {
  return recs.filter((r) => r.kind === "value").map((r) => ({ scenario: r.scenario!, name: r.name!, value: r.value! }));
}

// ---------------------------------------------------------------- venue-halt

async function venueHalt(recs: Rec[], url: string | null, meta: RunMeta) {
  const m = recs.find((r) => r.kind === "meta")!;
  const L = lookup(recs);
  const hub = "hub-halt (24 Sep payload)";
  const txs: { hash: string; label: string; block?: number }[] = [];
  for (const p of PRECEDENT) {
    let block: number | undefined;
    let label = `${p.what === "halt" ? "Halt" : "Go-live"} of the MAG7 spoke on the Aave V4 Equities Hub, Base mainnet: Safe 0x187A…77e9 → executor 0xA9D9…3d70.executeTransaction(payload ${p.payload}, "execute()", delegatecall) → HubConfigurator 0x2Cd4…778A.updateSpokeHalted(hub, asset, spoke, ${p.what === "halt"}) for assets 0-7`;
    if (url) {
      const r = await rpc<{ status: string; blockNumber: string } | null>(url, "eth_getTransactionReceipt", [p.hash]);
      if (!r || r.status !== "0x1") throw new Error(`precedent ${p.hash} is not a successful mainnet transaction`);
      block = Number(BigInt(r.blockNumber));
      const b = await rpc<{ timestamp: string }>(url, "eth_getBlockByNumber", [r.blockNumber, false]);
      label += ` (${new Date(Number(BigInt(b.timestamp)) * 1000).toISOString().replace(".000Z", "Z")})`;
    }
    txs.push({ hash: p.hash, label, ...(block ? { block } : {}) });
  }
  const a = assertions(recs);
  const pass = a.every((x) => x.pass);
  const outcome = [
    `Real switch (hub halt, the 24 Sep payload replayed as the Safe): the desk quotes ${L.check(hub, "desk quote reason for a 10 USDC draw")} with ${usdc(L.check(hub, "desk quote available (USDC units)"))} USDC available and records ${L.check(hub, "obligation status")}; the desk's draw (${L.check(hub, "desk draw of 10 USDC")}), the desk's repay (${L.check(hub, "desk repay of 1 USDC (anyone, any hour)")}) and the vault's protective repay (${L.check(hub, "protective repay of 20 USDC through the Giver")}) are refused by name before the venue is called; the venue itself refuses a repay (${L.check(hub, "repay of 1 USDC by the borrower at the venue")}), a withdrawal (${L.check(hub, "withdrawal of 0.01 AAPLc at the venue")}) and the liquidation of an under-water position (${L.check(hub, "liquidationCall covering 1% of the debt while the switch is on")}): nothing moves either way. The go-live payload restores draws, repays and liquidations.`,
    `AAPLc reserve frozen: desk ${L.check("aaplc-reserve-frozen", "desk quote reason for a 10 USDC draw")} / ${L.check("aaplc-reserve-frozen", "obligation status")}, draw ${L.check("aaplc-reserve-frozen", "desk draw of 10 USDC")}, protective repay ${usdc(L.check("aaplc-reserve-frozen", "protective repay through the Giver: repaid (USDC units)"))} USDC from the user's reserve, new AAPLc supply ${L.check("aaplc-reserve-frozen", "new AAPLc supply at the venue")}, a USDC borrow straight at the venue ${L.check("aaplc-reserve-frozen", "USDC borrow straight at the venue (Aave freezes per reserve)")}, liquidation ${L.check("aaplc-reserve-frozen", "liquidationCall covering 1% of the debt while the switch is on")}.`,
    `AAPLc reserve paused: desk ${L.check("aaplc-reserve-paused", "desk quote reason for a 10 USDC draw")} / ${L.check("aaplc-reserve-paused", "obligation status")}, protective repay ${L.check("aaplc-reserve-paused", "protective repay of 20 USDC through the Giver")}, withdrawal ${L.check("aaplc-reserve-paused", "withdrawal of 0.01 AAPLc at the venue")}, liquidation ${L.check("aaplc-reserve-paused", "liquidationCall covering 1% of the debt while the switch is on")}.`,
    `USDC reserve paused: desk ${L.check("usdc-reserve-paused", "desk quote reason for a 10 USDC draw")} / ${L.check("usdc-reserve-paused", "obligation status")}, the vault refuses the protective repay by name (${L.check("usdc-reserve-paused", "protective repay of 20 USDC through the Giver")}), the venue refuses a repay (${L.check("usdc-reserve-paused", "repay of 1 USDC by the borrower at the venue")}) and the liquidation (${L.check("usdc-reserve-paused", "liquidationCall covering 1% of the debt while the switch is on")}). Every switch reversed returns the line to OPEN.`,
    `${a.filter((x) => x.pass).length} of ${a.length} checks pass.`,
  ].join(" ");
  const run = {
    ranAt: Number(m.forkBlockTime),
    chainId: 8453,
    label: `Base mainnet fork at block ${m.forkBlock}: the real 24 Sep 2026 hub halt of the Aave V4 MAG7 spoke replayed through the Security Council Safe and its executor, then the AAPLc reserve frozen, the AAPLc reserve paused and the USDC reserve paused through the SpokeConfigurator, against the real borrower ${m.borrower} enrolled on an AaveDesk line with a ProtectionVault`,
    fork: {
      block: Number(m.forkBlock),
      blockTime: Number(m.forkBlockTime),
      drillTime: Number(m.drillTime),
      drillTimeNote: "the fork is warped to Fri 9 Oct 2026 10:30 ET (REGULAR) and the AAPLc feed's own last answer is re-stamped one minute earlier, so the gate is OPEN whenever the drill runs; Aave's price is unchanged",
      harness: "contracts/test/drills/VenueHaltDrill.t.sol under base-forge (FOUNDRY_BASE=true), driven by scripts/drills/run-fork-drills.ts",
      forgeVersion: meta.forgeVersion,
      executedAt: meta.executedAt,
    },
    precedent: {
      what: "Aave V4 Equities Hub, Base mainnet: SpokeConfig.halted set on the hub for every asset (0-7) of the MAG7 spoke 0x1790…7B8D, the treasury spoke 0x5f8d…b674 and the tokenization spoke 0x7081…efdc; Hub._validateAdd/_validateRemove/_validateDraw/_validateRestore all require !halted",
      safe: "0x187AAE17d4931310B3fc75743e7F16Bdc9eD77e9",
      executor: "0xA9D9923A1ADC1200771aaaA38CFeD6A5b8483d70",
      haltPayload: "0xbff63E3ad59a5F06716FD2EDd0E3C2a7123E3ac1",
      goLivePayload: "0x6BDf957Ff2AE324fe23911f549aff9b5621b198E",
      hubConfigurator: "0x2Cd40DFF9f2F74e8765dA148102b6668A5e9778A",
      spokeConfigurator: "0x0191B1Aa743c6B3C545119B5D56a0577D7f3a57F",
      accessManager: "0x4010C94698EDE9d895814502B6EB122D764a1Cc6",
      roles: "AccessManager roles read live: 200 (HubConfigurator.updateSpokeHalted) and 400 (SpokeConfigurator.updateFrozen/updatePaused) held by the executor; 101 (Hub.updateSpokeConfig) by the HubConfigurator; 301 (Spoke.updateReserveConfig) by the SpokeConfigurator",
    },
    borrower: {
      address: m.borrower,
      aaplcSuppliedRaw: m.aaplcSupplied,
      usdcDebtAfterHeadroomRepay: m.usdcDebt,
      healthFactorAfterHeadroomRepay: m.healthFactor,
      note: "the borrower's real position, repaid on the fork to 30% of its AAPLc value at Aave's price so a policy draw has headroom (as in the 6 Oct fork proof); AAPLc is about two thirds of its risk-weighted collateral, six other MAG7 stocks the rest",
    },
    txs,
    attempts: attempts(recs),
    assertions: a,
    values: values(recs),
    outcome,
    findings: [
      "Fixed on 8 Oct 2026, proven by this run: the AaveDesk (AaveDeskLib) and the ProtectionVault read the hub's SpokeConfig through AaveVenue (the spoke's getReserve(id) names the hub and the asset id; getSpokeConfig(assetId, spoke).active/.halted). A hub halt is the new reason VENUE_HALTED (appended last: the 20 reasons and 8 obligation statuses shared with the CreditDesk keep their order; the status is the existing HOLD_VENUE) with HOLD_VENUE; lending fails closed on a hub that cannot be read; a repay is refused only on a positive read, so a bad read never blocks protection. The first run of this drill (commit 464efe1, evidence hash 0x01a1269addcc4045fc8cfafccda9801fd8ac867ed137952a3393ecf3ca6ad4b3) recorded the blind spot it closes: during the halt the desk quoted NONE with 991.48 USDC available and recorded OPEN.",
      "A hub halt blocks repays as well as draws, so no protective repay can land while it lasts: protection has to act before the switch; it blocks liquidations too, so a halted position is frozen in both directions until the go-live payload. The vault's venueReason(reserveId) view lets the keeper see it and stop arming.",
      "Aave freezes per reserve: with only AAPLc frozen, Aave itself still lends USDC against it; the desk refuses (VENUE_FROZEN) because it never lends against a halted asset. A frozen reserve still repays and withdraws, so the vault's protect and recover go on.",
    ],
    evidence: ["contracts/test/drills/VenueHaltDrill.t.sol", "contracts/test/drills/DrillBase.sol", "scripts/drills/run-fork-drills.ts", "docs/evidence/drills/venue-halt.json"],
    notes: "Fork run, no transactions of its own: the three hashes are the real mainnet precedent (receipts checked by the runner). Scenario state is restored from one EVM snapshot between scenarios; liquidation checks stage an under-water position (borrow to health 1.10, AAPLc feed rewritten to 35% through the aggregator's transmission slot) before the switch is thrown.",
    pass,
  };
  return { drill: "venue-halt", runs: [{ ...run, evidenceHash: keccak256(stringToHex(canonical(run))) }] };
}

// ---------------------------------------------------------------- bad-debt-probe

function ledgerRows(recs: Rec[]) {
  return recs
    .filter((r) => r.kind === "ledger")
    .map((r) => {
      const big = (k: string) => BigInt(String(r[k]));
      const e = ledgerEvent({
        id: String(r.id),
        venue: "morpho",
        kind: r.eventKind as "liquidation" | "pre-liquidation",
        subject: String(r.subject),
        at: Number(r.at),
        reference: String(r.reference),
        collateral: { in: big("in"), sold: big("sold"), retained: big("retained"), remainingOnPosition: big("remainingOnPosition") },
        debt: { before: big("debtBefore"), after: big("debtAfter"), repaid: big("repaid") },
        sources: { proceeds: big("proceeds"), fromLiquidator: big("fromLiquidator") },
      });
      const rec = reconcile(e);
      const morphoBadDebt = big("morphoBadDebtAssets");
      // Morpho keeps debt in shares and rounds assets up on every read and on every repay, so `before = after + repaid`
      // can miss by one raw unit. Strict results stay as the ledger computed them; a miss of at most one unit on the
      // debt identity, and nowhere else, is reported as share rounding.
      const off = rec.equalities.filter((q) => !q.holds);
      const shareRounding = off.length > 0 && off.every((q) => q.id === "debt" && (q.residual === 1n || q.residual === -1n));
      return {
        scenario: String(r.scenario),
        id: e.id,
        kind: e.kind,
        subject: e.subject,
        at: e.at,
        flows: {
          collateralIn: e.collateral.in.toString(),
          sold: e.collateral.sold.toString(),
          retained: e.collateral.retained.toString(),
          remainingOnPosition: e.collateral.remainingOnPosition.toString(),
          debtBefore: e.debt.before.toString(),
          debtAfter: e.debt.after.toString(),
          repaid: e.debt.repaid.toString(),
          proceeds: e.sources.proceeds.toString(),
          fromLiquidator: e.sources.fromLiquidator.toString(),
        },
        reconciliation: {
          strict: rec.pass,
          pass: rec.pass || shareRounding,
          ...(shareRounding ? { note: `debt identity off by ${off[0]!.residual} raw unit (Morpho share rounding)` } : {}),
          badDebt: rec.badDebt.toString(),
          equalities: rec.equalities.map((q) => ({ id: q.id, left: q.left.toString(), right: q.right.toString(), residual: q.residual.toString(), holds: q.holds })),
        },
        ...(e.kind === "liquidation"
          ? {
              morphoBadDebtAssets: morphoBadDebt.toString(),
              ledgerMinusMorphoBadDebt: (rec.badDebt - morphoBadDebt).toString(),
              badDebtAgrees: rec.badDebt - morphoBadDebt >= -1n && rec.badDebt - morphoBadDebt <= 1n,
            }
          : {}),
      };
    });
}

function badDebtProbe(recs: Rec[], meta: RunMeta) {
  const m = recs.find((r) => r.kind === "meta")!;
  const L = lookup(recs);
  const ledger = ledgerRows(recs);
  const a = assertions(recs);
  const raw45 = "raw venue -45%";
  const raw15 = "raw venue -15%";
  const sg = "session-safe market, -45%";
  const p30 = "protected (30% deviation guard)";
  const p50 = "protected (50% deviation guard)";
  const liq = (s: string) => ledger.find((x) => x.scenario === s && x.kind === "liquidation");
  const ledgerPass = ledger.every((x) => x.reconciliation.pass && (x.kind !== "liquidation" || x.badDebtAgrees === true));
  const strictCount = ledger.filter((x) => x.reconciliation.strict).length;
  const roundingNotes = ledger.filter((x) => !x.reconciliation.strict).map((x) => `${x.scenario}: ${x.reconciliation.note ?? "does not reconcile"}`);
  const sumRepaid = (s: string) => ledger.filter((x) => x.scenario.startsWith(`${s} step`)).reduce((t, x) => t + BigInt(x.flows.repaid), 0n);
  const sumSold = (s: string) => ledger.filter((x) => x.scenario.startsWith(`${s} step`)).reduce((t, x) => t + BigInt(x.flows.sold), 0n);
  const outcome = [
    `Real borrower ${m.borrower} (${aapl(String(m.collateralRaw))} AAPLc on the Steakhouse AAPLc/USDC market), staged to venue LTV ${wad(String(m.venueLtvAtStage))} at Friday's close (debt ${usdc(String(m.debtAtStage))} USDC).`,
    `Reopen print -45% (venue LTV ${wad(L.value(raw45, "venue LTV at the reopen print (WAD)"))}): the raw venue liquidated all ${aapl(L.value(raw45, "collateral seized (raw AAPLc)"))} AAPLc, the liquidator repaid ${usdc(L.value(raw45, "debt repaid by the liquidator (USDC units)"))} USDC and kept ${usdc(L.value(raw45, "liquidation incentive, in kind (USDC units at the oracle price)"))} USDC of incentive in kind, and Morpho wrote off ${usdc(L.value(raw45, "bad debt written off by Morpho (USDC units)"))} USDC of bad debt against the suppliers (ledger bad debt ${usdc(liq(raw45)!.reconciliation.badDebt)}, residual vs Morpho ${liq(raw45)!.ledgerMinusMorphoBadDebt} units).`,
    `The same position on a SessionGuard market refused the Saturday liquidation (${L.check(sg, "Saturday liquidation")}) and the Saturday borrow, accepted a Saturday repay, and still wrote off ${usdc(L.value(sg, "bad debt written off by Morpho (USDC units)"))} USDC at the -45% reopen: a session-safe oracle refuses a held price, it does not prevent a gap.`,
    `Protected mode, default ShadowGuard (30% deviation guard): ${L.value(p30, "pre-liquidations on Saturday")} pre-liquidations as the DEX walked down (-4% to ${Number(L.value(p30, "last step acted on (bps)")) / 100}%; beyond -30% the guard stops pricing: NO_SHADOW_PRICE), ${aapl(sumSold(p30))} AAPLc sold for ${usdc(sumRepaid(p30))} USDC of debt; at the -45% reopen (LTV ${wad(L.value(p30, "venue LTV at the reopen print (WAD)"))}) the liquidation repaid every share, the borrower kept ${aapl(L.value(p30, "collateral left with the borrower (raw AAPLc)"))} AAPLc and the bad debt was ${usdc(L.value(p30, "bad debt written off by Morpho (USDC units)"))} USDC.`,
    `Guard at its 50% maximum: ${L.value(p50, "pre-liquidations on Saturday")} pre-liquidations to ${Number(L.value(p50, "last step acted on (bps)")) / 100}% and the position was healthy at the -45% reopen (LTV ${wad(L.value(p50, "venue LTV at the reopen print (WAD)"))}; liquidation ${L.check(p50, "liquidation at the reopen")}).`,
    `Reopen print -15%: the raw venue liquidated with every share repaid, ${aapl(L.value(raw15, "collateral left with the borrower (raw AAPLc)"))} AAPLc left to the borrower, no bad debt.`,
    `${ledger.length} ledger events: ${strictCount} close exactly, ${ledger.length - strictCount} within one raw unit of Morpho's share rounding${roundingNotes.length ? ` (${roundingNotes.join("; ")})` : ""}; the ledger's bad debt and Morpho's badDebtAssets agree within one unit on every liquidation; ${a.filter((x) => x.pass).length} of ${a.length} checks pass.`,
  ].join(" ");
  const run = {
    ranAt: Number(m.forkBlockTime),
    chainId: 8453,
    label: `Base mainnet fork at block ${m.forkBlock}: the largest real borrower of the Steakhouse AAPLc/USDC Morpho market taken through LLTV by a reopen print beyond the band and liquidated at the venue (bad debt), against the same position on a SessionGuard market and under protected mode`,
    fork: {
      block: Number(m.forkBlock),
      blockTime: Number(m.forkBlockTime),
      timestamps: { fridayClose: 1_791_590_400, saturday: 1_791_640_800, reopen: 1_791_763_200 },
      harness: "contracts/test/drills/BadDebtProbeDrill.t.sol under base-forge (FOUNDRY_BASE=true), driven by scripts/drills/run-fork-drills.ts",
      forgeVersion: meta.forgeVersion,
      executedAt: meta.executedAt,
    },
    position: {
      market: m.market,
      borrower: m.borrower,
      collateralRaw: m.collateralRaw,
      debtAtStage: m.debtAtStage,
      priceAtClose36: m.priceAtClose36,
      venueLtvAtStage: m.venueLtvAtStage,
      lltv: "0.625",
      liquidationIncentiveFactor: "1/(1 - 0.3 x (1 - 0.625)) = 1.12676 (Morpho)",
      preLiquidation: { preLltv: "0.58", preLCF: "1.0/1.0", preLIF: "1.01/1.02", contracts: { guard30: m.preLiquidation30, guard50: m.preLiquidation50 } },
    },
    txs: [] as { hash: string; label: string; block?: number }[],
    attempts: attempts(recs),
    assertions: a,
    values: values(recs),
    ledger: {
      method: "@boundline/ledger reconcile() over flows measured on the fork: collateral out of the position, into the liquidator or the pool, kept by the Protector; USDC paid by the liquidator or out of the pool; debt before and after from Morpho's expectedBorrowAssets. For a liquidation the debt left once the position holds no collateral is the ledger's bad debt, compared with Morpho's badDebtAssets. `strict` is the ledger's exact verdict; `pass` also accepts a miss of one raw unit on the debt identity alone, because Morpho keeps debt in shares and rounds assets up on reads and repays.",
      strictlyClosed: strictCount,
      events: ledger.length,
      pass: ledgerPass,
      entries: ledger,
    },
    outcome,
    evidence: ["contracts/test/drills/BadDebtProbeDrill.t.sol", "contracts/test/drills/DrillBase.sol", "scripts/drills/run-fork-drills.ts", "packages/ledger/src/reconcile.ts", "docs/evidence/drills/bad-debt-probe.json"],
    notes: "Fork run, no transactions. Prices move by rewriting the AAPLc aggregator's latest round in place (the replay's transmission-slot technique); the weekend DEX is a mock Slipstream pool at the stepped price (the real Aerodrome TWAP cannot move on a fork without trading through it). Morpho accrues interest inside liquidate before it writes bad debt off, so the supplier loss is measured against the interest-accrued totals (expectedMarketBalances). The SessionGuard leg is a clone account with the same collateral (moved from the Aerodrome pool) and debt on a new market with the same IRM and LLTV.",
    pass: a.every((x) => x.pass) && ledgerPass,
  };
  return { drill: "bad-debt-probe", runs: [{ ...run, evidenceHash: keccak256(stringToHex(canonical(run))) }] };
}

// ---------------------------------------------------------------- main

interface RunMeta {
  forgeVersion: string;
  executedAt: number;
}

async function main() {
  const a = args();
  const meta: RunMeta = { forgeVersion: "", executedAt: Math.floor(Date.now() / 1000) };
  let log: string;
  let url: string | null = null;
  if (a.forgeLog) {
    log = readFileSync(a.forgeLog, "utf8");
  } else {
    url = rpcUrl();
    const block = a.block ?? Number(BigInt(await rpc<string>(url, "eth_blockNumber", [])));
    const forge = `${homedir()}/.foundry/bin/base-forge`;
    meta.forgeVersion = spawnSync(forge, ["--version"], { encoding: "utf8" }).stdout.trim().split("\n")[0] ?? "";
    console.error(`fork drills: block ${block}, ${meta.forgeVersion}`);
    const matchPath = a.only ? `test/drills/${DRILL_FILES[a.only]}` : "test/drills/*";
    const run = spawnSync(forge, ["test", "--root", "contracts", "--match-path", matchPath, "-vv"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, BASE_RPC_URL: url, FOUNDRY_PROFILE: process.env.FOUNDRY_PROFILE ?? "lane-d", FOUNDRY_BASE: "true", DRILL_FORK_BLOCK: String(block) },
    });
    log = `${run.stdout}\n${run.stderr}`.split(url).join("<rpc>");
    const logPath = resolve(tmpdir(), "boundline-fork-drills.forge.log");
    writeFileSync(logPath, log);
    console.error(`fork drills: forge log in ${logPath}`);
    if (run.status !== 0) console.error(`base-forge exited ${run.status}`);
  }
  const byDrill = parseForgeLog(log);
  const wanted = a.only ? [a.only] : Object.keys(DRILL_FILES);
  for (const id of wanted) if (!byDrill.get(id)) throw new Error(`missing drill output for ${id}`);
  const out = resolve(ROOT, a.out);
  mkdirSync(out, { recursive: true });
  const docs = [];
  if (wanted.includes("venue-halt")) docs.push(await venueHalt(byDrill.get("venue-halt")!, url, meta));
  if (wanted.includes("bad-debt-probe")) docs.push(badDebtProbe(byDrill.get("bad-debt-probe")!, meta));
  let ok = true;
  for (const d of docs) {
    writeFileSync(resolve(out, `${d.drill}.json`), `${JSON.stringify(d, null, 2)}\n`);
    const r = d.runs[0]!;
    console.error(`${d.drill}: pass=${r.pass} checks=${r.assertions.length} hash ${r.evidenceHash}`);
    ok &&= r.pass;
  }
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
