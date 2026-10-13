// The replay harness driver. Runs contracts/test/fork/ReplayFork.t.sol under base-forge against a Base
// mainnet fork, parses its REPLAY_* log lines, and writes the assurance evidence (JSON with a keccak256
// hash over the canonical document, plus a readable Markdown table). Optionally uploads the JSON to the
// Observatory's KV namespace as `assurance-latest`, where /v1/assurance serves it.
//
//   pnpm tsx scripts/replay/run.ts [--date YYYY-MM-DD] [--block N] [--kv] [--out docs/evidence/assurance]
//                                  [--candidates-from docs/evidence/assurance/<date>.json]
//
// The Aave candidates come from the indexer's live borrower list unless --candidates-from names an earlier
// evidence file: with its --block, that replays the same positions (the indexer's list grows over time).
//
// Needs BASE_RPC_URL (an archive endpoint; the free Alchemy tier works) or BOUNDLINE_ALCHEMY_API_KEY, and
// base-forge at ~/.foundry/bin/base-forge (B20 transfers happen in every sale and liquidation). The RPC
// URL never reaches the evidence or the logs.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { keccak256, stringToHex } from "viem";

const ROOT = resolve(import.meta.dirname, "..", "..");
const MARKET_ID = "0xae1a30486234bf7e7ac166c7c03d9bc5f2cd8a39be2c48e73c665ac7148c3c28";
const AAVE_MARKET = "Aave V4 MAG7 spoke 0x17905Db0e4A3514467539956c084180616AE7B8D, reserve 0 (AAPLc) against reserve 7 (USDC)";
const INDEXER = process.env.REPLAY_INDEXER_URL ?? "https://boundline-indexer.papermind-ai.workers.dev";
const KV_NAMESPACE = "aa7d8b27e629463da60008acfeccc30d";

interface Args {
  date: string;
  block: number | null;
  kv: boolean;
  out: string;
  forgeLog: string | null;
  candidatesFrom: string | null;
}

function args(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const today = new Date().toISOString().slice(0, 10);
  return {
    date: get("--date") ?? today,
    block: get("--block") ? Number(get("--block")) : null,
    kv: a.includes("--kv"),
    out: get("--out") ?? "docs/evidence/assurance",
    forgeLog: get("--forge-log") ?? null,
    candidatesFrom: get("--candidates-from") ?? null,
  };
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

async function candidates(): Promise<string[]> {
  const res = await fetch(`${INDEXER}/v1/venues/aave/borrowers?limit=200`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`indexer ${res.status}`);
  const body = (await res.json()) as { borrowers: { address: string }[] };
  return body.borrowers.map((b) => b.address);
}

/** The candidate list an earlier evidence file recorded, so a run at its fork block replays the same positions. */
function candidatesFrom(path: string): string[] {
  const doc = JSON.parse(readFileSync(path, "utf8")) as { candidates?: { address: string }[] };
  if (!doc.candidates?.length) throw new Error(`${path} lists no candidates`);
  return doc.candidates.map((c) => c.address);
}

interface Meta {
  forkBlock: string;
  forkBlockTime: string;
  heldAnswer: number;
  heldRound: string;
  feedSlot: string;
  feedSlotByLayout: string;
  positions: string;
  timestamps: { fridayClose: number; saturday: number; reopen: number };
}

interface Candidate {
  address: string;
  debtUsdc: string;
  aaplcRaw: string;
  hf: string;
  eligible: boolean;
}

interface RawRow {
  venue: "morpho" | "aave";
  address: string;
  label: string;
  staged: boolean;
  gapBps: number;
  gappedAnswer: number;
  collateralRaw: string;
  debtUsdc: string;
  hfReal: string;
  note: string;
  raw: { hfBefore: string; hfAtReopen: string; liquidatableSaturday: boolean; liquidatableAtReopen: boolean; liquidationExecuted: boolean; hfSaturdayHeld: string };
  boundline: { action: string; actionAt: string; amountUsdc: string; hfAfter: string; liquidatableAtReopen: boolean; liquidationExecuted: boolean; hfAfterSaturday: string; standing: string; shadowPrice36: string };
}

interface Parsed {
  meta: Meta;
  candidates: Candidate[];
  rows: RawRow[];
  done: { rows: number; boundlineFailures: number } | null;
}

function parseForgeLog(log: string): Parsed {
  let meta: Meta | null = null;
  const cands: Candidate[] = [];
  const rows: RawRow[] = [];
  let done: Parsed["done"] = null;
  for (const line of log.split("\n")) {
    const t = line.trim();
    const take = (tag: string): unknown => JSON.parse(t.slice(tag.length));
    if (t.startsWith("REPLAY_META ")) meta = take("REPLAY_META ") as Meta;
    else if (t.startsWith("REPLAY_CANDIDATE ")) cands.push(take("REPLAY_CANDIDATE ") as Candidate);
    else if (t.startsWith("REPLAY_ROW ")) rows.push(take("REPLAY_ROW ") as RawRow);
    else if (t.startsWith("REPLAY_DONE ")) done = take("REPLAY_DONE ") as Parsed["done"];
  }
  if (!meta) throw new Error("no REPLAY_META line in the forge output");
  return { meta, candidates: cands, rows, done };
}

/** Deterministic JSON: object keys sorted, no whitespace. The hash is taken over this form. */
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

function wad(s: string): string {
  const v = BigInt(s);
  if (v === (1n << 256n) - 1n) return "∞";
  const whole = v / 10n ** 18n;
  const frac = ((v % 10n ** 18n) / 10n ** 14n).toString().padStart(4, "0");
  return `${whole}.${frac}`;
}

function usdc(s: string): string {
  const v = BigInt(s);
  return `${(Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function price8(n: number): string {
  return (n / 1e8).toFixed(2);
}

function buildEvidence(p: Parsed, date: string, out: string, runFacts: { ranAt: number; forgeVersion: string; candidatesSource: string }) {
  const gaps = [...new Set(p.rows.map((r) => r.gapBps))].sort((a, b) => b - a);
  const scenarios = gaps.map((gap) => ({
    id: `gap-${Math.abs(gap) / 100}`,
    gapBps: gap,
    positions: p.rows
      .filter((r) => r.gapBps === gap)
      .map((r) => ({
        venue: r.venue,
        address: r.address,
        market: r.venue === "morpho" ? MARKET_ID : AAVE_MARKET,
        collateralSymbol: "AAPLc",
        debtUsdc: r.debtUsdc,
        label: r.label,
        staged: r.staged,
        stagingNote: r.note,
        collateralRaw: r.collateralRaw,
        hfAtForkBlock: r.hfReal,
        heldAnswer: p.meta.heldAnswer,
        gappedAnswer: r.gappedAnswer,
        raw: {
          hfBefore: r.raw.hfBefore,
          hfSaturdayHeld: r.raw.hfSaturdayHeld,
          hfAtReopen: r.raw.hfAtReopen,
          liquidatableSaturday: r.raw.liquidatableSaturday,
          liquidatableAtReopen: r.raw.liquidatableAtReopen,
          liquidationExecuted: r.raw.liquidationExecuted,
        },
        boundline: {
          action: r.boundline.action,
          actionAt: r.boundline.actionAt,
          amountUsdc: r.boundline.amountUsdc,
          standing: r.boundline.standing,
          shadowPrice36: r.boundline.shadowPrice36,
          hfAfterSaturday: r.boundline.hfAfterSaturday,
          hfAfter: r.boundline.hfAfter,
          liquidatableAtReopen: r.boundline.liquidatableAtReopen,
          liquidationExecuted: r.boundline.liquidationExecuted,
        },
      })),
  }));
  const all = scenarios.flatMap((s) => s.positions);
  const rawLiquidatable = all.filter((r) => r.raw.liquidatableAtReopen).length;
  const boundlineLiquidatable = all.filter((r) => r.boundline.liquidatableAtReopen).length;
  const doc: Record<string, unknown> = {
    version: 1,
    ranAt: runFacts.ranAt,
    chainId: 8453,
    forkBlock: Number(p.meta.forkBlock),
    forkBlockTime: Number(p.meta.forkBlockTime),
    scenarios,
    summary: {
      positions: new Set(all.map((r) => `${r.venue}:${r.address}:${r.staged}`)).size,
      scenarios: scenarios.length,
      rawLiquidatable,
      boundlineLiquidatable,
      rawLiquidationsExecuted: all.filter((r) => r.raw.liquidationExecuted).length,
      boundlineLiquidationsExecuted: all.filter((r) => r.boundline.liquidationExecuted).length,
      pass: boundlineLiquidatable === 0 && all.every((r) => !r.boundline.liquidationExecuted) && (p.done?.boundlineFailures ?? 1) === 0,
    },
    method: {
      harness: "contracts/test/fork/ReplayFork.t.sol under base-forge (FOUNDRY_BASE=true), driven by scripts/replay/run.ts",
      forge: runFacts.forgeVersion,
      feed: "Coinbase AAPL / USD proxy 0x787f13dEa48Db0897CbCDD985de77809D837F988, aggregator 0xc37B6F754e90D4Cca1f533F5a08f7d532b3d0d9D (AccessControlledOCR2Aggregator 1.0.0)",
      feedSlot: p.meta.feedSlot,
      feedSlotByLayout: p.meta.feedSlotByLayout,
      heldRound: p.meta.heldRound,
      heldAnswer: p.meta.heldAnswer,
      slotDiscovery: "vm.record + vm.accesses on latestRoundData() (the recorded storage reads of the aggregator), cross-checked against keccak256(abi.encode(roundId, 12)) for the s_transmissions mapping; both must agree or the run aborts",
      priceForcing: "vm.store on that slot: int192 answer | uint32 observationsTimestamp | uint32 transmissionTimestamp (anvil_setStorageAt's equivalent); the proxy, the Morpho oracle (MorphoChainlinkOracleV2 on the proxy) and the Aave spoke oracle all read it",
      time: "vm.warp to Fri 20:00 ET (Friday's last print rewritten with the held answer), Sat 10:00 ET, and Sun 20:00 ET + 12 s where the gapped answer is written with a fresh timestamp",
      weekendDex: "a MockSwapPool (Slipstream-shaped) set to the gapped price: the ShadowGuard's TWAP source and the Protector's sale venue; the real Aerodrome pool's TWAP cannot be moved on a fork without trading through it",
      boundline: "Morpho: Protector partial pre-liquidation at the shadow price when the position is in the band (preLltv 0.58 to LLTV 0.625), the Reserve's repay rung when it is past the band; Aave: ProtectionVault repay through the Giver, funded by a Reserve advance, sized to health 1.02 at the gapped price",
      rawVenue: "no action; at the reopen a funded liquidator calls Morpho.liquidate (0.01 AAPLc) or Spoke.liquidationCall (1% of the debt) and the row records whether the venue let it through",
      optIns: "Morpho users: Morpho.setAuthorization(preLiquidation); Aave users: Spoke.setUserPositionManager(Giver), both impersonated on the fork as the one-time opt-in they would sign",
      timestamps: p.meta.timestamps,
      candidatesSource: runFacts.candidatesSource,
    },
    candidates: p.candidates,
    artifact: `${out}/${date}.json`,
  };
  doc.evidenceHash = keccak256(stringToHex(canonical(doc)));
  return doc as typeof doc & { evidenceHash: string; summary: { pass: boolean; rawLiquidatable: number; boundlineLiquidatable: number; positions: number; scenarios: number } };
}

function markdown(doc: ReturnType<typeof buildEvidence>, date: string): string {
  const s = doc.summary;
  const scenarios = doc.scenarios as { id: string; gapBps: number; positions: Record<string, any>[] }[];
  const lines: string[] = [];
  lines.push(`# Assurance replay, ${date}`, "");
  lines.push(`Base mainnet fork at block ${doc.forkBlock} (${new Date(Number(doc.forkBlockTime) * 1000).toISOString()}), run at ${new Date(doc.ranAt * 1000).toISOString()}.`);
  lines.push(`Held AAPL answer ${price8((doc.method as any).heldAnswer)} (round ${(doc.method as any).heldRound}); feed slot \`${(doc.method as any).feedSlot}\`.`);
  lines.push(`Evidence hash \`${doc.evidenceHash}\` over the canonical JSON of \`${doc.artifact}\` without the hash field.`, "");
  lines.push(`**Summary:** ${s.positions} positions x ${s.scenarios} gaps. Raw venue liquidatable at the reopen: ${s.rawLiquidatable}. Boundline liquidatable at the reopen: ${s.boundlineLiquidatable}. ${s.pass ? "PASS" : "FAIL"}.`, "");
  lines.push("Health is the venue's own number (Aave `healthFactor`; for Morpho, collateral x price x LLTV / debt on the same scale), 1.0000 is the liquidation line. \"Sat held\" is the venue's view on Saturday at the frozen feed; \"reopen\" is the first block after Sunday 20:00 ET with the gap printed.", "");
  for (const sc of scenarios) {
    lines.push(`## ${sc.id}: feed prints ${sc.gapBps / 100}% at the reopen`, "");
    lines.push("| Position | Debt USDC | Health Fri close | Sat held | Raw at reopen | Raw liquidation | Boundline Saturday action | Boundline at reopen | Liquidation on protected path |");
    lines.push("|---|---:|---:|---:|---:|---|---|---:|---|");
    for (const r of sc.positions) {
      const action = r.boundline.action === "none" ? `none (${r.boundline.standing})` : `${r.boundline.action} ${usdc(r.boundline.amountUsdc)} USDC (${r.boundline.standing})`;
      lines.push(
        `| ${r.label}${r.staged ? " (staged)" : ""} \`${r.address.slice(0, 6)}…${r.address.slice(-4)}\` | ${usdc(r.debtUsdc)} | ${wad(r.raw.hfBefore)} | ${wad(r.raw.hfSaturdayHeld)} | ${wad(r.raw.hfAtReopen)}${r.raw.liquidatableAtReopen ? " liquidatable" : ""} | ${r.raw.liquidationExecuted ? "went through" : "refused"} | ${action} | ${wad(r.boundline.hfAfter)}${r.boundline.liquidatableAtReopen ? " liquidatable" : ""} | ${r.boundline.liquidationExecuted ? "went through" : "refused"} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Candidates considered (Aave MAG7 borrowers from the indexer)", "");
  lines.push("| Address | USDC debt | AAPLc raw | Health | Eligible |", "|---|---:|---:|---:|---|");
  for (const c of doc.candidates as Candidate[]) lines.push(`| \`${c.address}\` | ${usdc(c.debtUsdc)} | ${c.aaplcRaw} | ${wad(c.hf)} | ${c.eligible ? "yes" : "no"} |`);
  lines.push("", "## Method", "");
  for (const [k, v] of Object.entries(doc.method as Record<string, unknown>)) lines.push(`- **${k}**: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  lines.push("", "Staged rows are the real position brought to the band's edge at Friday's close (a borrow on the fork) so the contrast shows; unstaged rows are the position exactly as it stood at the fork block.", "");
  return lines.join("\n");
}

async function main() {
  const a = args();
  const ranAt = Math.floor(Date.now() / 1000);
  let log: string;
  let forgeVersion = "";
  let candidatesSource = `${INDEXER}/v1/venues/aave/borrowers`;
  if (a.forgeLog) {
    log = (await import("node:fs")).readFileSync(a.forgeLog, "utf8");
    candidatesSource = `replayed from ${a.forgeLog}`;
  } else {
    const url = rpcUrl();
    const cands = a.candidatesFrom ? candidatesFrom(a.candidatesFrom) : await candidates();
    if (a.candidatesFrom) candidatesSource = `the candidates of ${a.candidatesFrom}`;
    const block = a.block ?? Number(BigInt(await rpc<string>(url, "eth_blockNumber", [])));
    const forge = `${homedir()}/.foundry/bin/base-forge`;
    forgeVersion = spawnSync(forge, ["--version"], { encoding: "utf8" }).stdout.trim().split("\n")[0] ?? "";
    console.error(`replay: fork block ${block}, ${cands.length} Aave candidates, base-forge ${forgeVersion}`);
    const run = spawnSync(forge, ["test", "--root", "contracts", "--match-path", "test/fork/ReplayFork.t.sol", "-vv"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env,
        BASE_RPC_URL: url,
        FOUNDRY_PROFILE: process.env.FOUNDRY_PROFILE ?? "lane-b",
        FOUNDRY_BASE: "true",
        REPLAY_FORK_BLOCK: String(block),
        REPLAY_AAVE_CANDIDATES: cands.join(","),
      },
    });
    log = `${run.stdout}\n${run.stderr}`;
    const scrubbed = log.split(url).join("<rpc>");
    mkdirSync(resolve(ROOT, a.out), { recursive: true });
    writeFileSync(resolve(ROOT, a.out, `${a.date}.forge.log`), scrubbed);
    if (run.status !== 0) console.error(`base-forge exited ${run.status}; the log is in ${a.out}/${a.date}.forge.log`);
  }
  const parsed = parseForgeLog(log);
  const doc = buildEvidence(parsed, a.date, a.out, { ranAt, forgeVersion, candidatesSource });
  mkdirSync(resolve(ROOT, a.out), { recursive: true });
  const jsonPath = resolve(ROOT, a.out, `${a.date}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(doc, null, 2)}\n`);
  writeFileSync(resolve(ROOT, a.out, `${a.date}.md`), `${markdown(doc, a.date)}\n`);
  console.error(`replay: ${parsed.rows.length} rows, raw liquidatable ${doc.summary.rawLiquidatable}, Boundline liquidatable ${doc.summary.boundlineLiquidatable}, pass=${doc.summary.pass}, hash ${doc.evidenceHash}`);
  if (a.kv) {
    const put = spawnSync("pnpm", ["exec", "wrangler", "kv", "key", "put", "--namespace-id", KV_NAMESPACE, "--remote", "assurance-latest", "--path", jsonPath], { cwd: resolve(ROOT, "apps/observatory"), encoding: "utf8" });
    console.error(put.stdout.trim());
    if (put.status !== 0) {
      console.error(put.stderr.trim());
      process.exitCode = 1;
    }
  }
  if (!doc.summary.pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
