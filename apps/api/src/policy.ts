// The partner policy as the console sees it: the desk's partner config and per-ticker policies read live, the diff
// of a proposed version against them, and the calls the partner admin signs to apply it. Self-custody throughout:
// the API prepares calldata and never signs.
import { encodeFunctionData, getAddress, isAddress, type Address, type Hex } from "viem";
import { creditDeskAbi } from "./abi/creditDesk.js";
import type { PartnerRecord } from "./db.js";
import type { DeskPartner, DeskReader, DeskTickerPolicy } from "./desk.js";
import { parseBaseUnits } from "./rounding.js";

export const WAD = 1_000_000_000_000_000_000n;

/** A market the desk serves, from the Worker's MARKETS var (deployments/base-sepolia.json). */
export interface MarketConfig {
  symbol: string;
  collateral: Address;
  marketId: Hex;
  /** Morpho pre-liquidation contract with a ShadowGuard oracle, when protected mode is live on this market. */
  preLiquidation?: Address;
  protector?: Address;
  /** The Protector's target LTV for sizing (preLltv, 0.58e18 on the AAPLt market). */
  targetLtvWad?: bigint;
}

/** Parses the MARKETS var: a JSON array of `{symbol, collateral, marketId, preLiquidation?, protector?, targetLtvWad?}`. */
export function parseMarkets(json: string | undefined): MarketConfig[] {
  if (!json || json.trim().length === 0) return [];
  const raw = JSON.parse(json) as unknown;
  if (!Array.isArray(raw)) throw new Error("MARKETS must be a JSON array");
  return raw.map((m, i) => {
    const r = m as Record<string, unknown>;
    if (typeof r.symbol !== "string" || typeof r.collateral !== "string" || !isAddress(r.collateral) || typeof r.marketId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r.marketId)) {
      throw new Error(`MARKETS[${i}] needs symbol, collateral (address) and marketId (bytes32)`);
    }
    const out: MarketConfig = { symbol: r.symbol, collateral: getAddress(r.collateral), marketId: r.marketId.toLowerCase() as Hex };
    if (typeof r.preLiquidation === "string" && isAddress(r.preLiquidation)) out.preLiquidation = getAddress(r.preLiquidation);
    if (typeof r.protector === "string" && isAddress(r.protector)) out.protector = getAddress(r.protector);
    if (typeof r.targetLtvWad === "string" && /^[0-9]+$/.test(r.targetLtvWad)) out.targetLtvWad = BigInt(r.targetLtvWad);
    return out;
  });
}

export interface TickerPolicyView {
  symbol: string;
  collateral: Address;
  marketId: Hex;
  allowed: boolean;
  maxLtvWad: string;
  minDraw: string;
  maxDraw: string;
  exposureCap: string;
  exposure: string;
  marketLltvWad: string | null;
}

export interface PolicyView {
  partnerId: Hex;
  name: string;
  policyVersion: number;
  partner: { admin: Address; signer: Address; eligibility: Address; active: boolean; exposureCap: string; exposure: string };
  tickers: TickerPolicyView[];
}

/** The live policy: the partner record from the desk and one row per configured market. */
export async function readPolicy(desk: DeskReader, partner: PartnerRecord, markets: readonly MarketConfig[]): Promise<PolicyView> {
  const p: DeskPartner = await desk.partner(partner.partnerId);
  const tickers = await Promise.all(
    markets.map(async (m) => {
      const [t, mk] = await Promise.all([desk.tickerPolicy(partner.partnerId, m.collateral), desk.market(m.marketId).catch(() => null)]);
      return tickerView(m, t, mk?.lltv ?? null);
    }),
  );
  return {
    partnerId: partner.partnerId,
    name: partner.name,
    policyVersion: p.policyVersion,
    partner: { admin: p.admin, signer: p.signer, eligibility: p.eligibility, active: p.active, exposureCap: p.exposureCap.toString(), exposure: p.exposure.toString() },
    tickers,
  };
}

function tickerView(m: MarketConfig, t: DeskTickerPolicy, lltv: bigint | null): TickerPolicyView {
  return {
    symbol: m.symbol,
    collateral: m.collateral,
    marketId: m.marketId,
    allowed: t.allowed,
    maxLtvWad: t.maxLtvWad.toString(),
    minDraw: t.minDraw.toString(),
    maxDraw: t.maxDraw.toString(),
    exposureCap: t.exposureCap.toString(),
    exposure: t.exposure.toString(),
    marketLltvWad: lltv === null ? null : lltv.toString(),
  };
}

// ---------------------------------------------------------------- proposed versions

export interface TickerInput {
  collateral: Address;
  allowed: boolean;
  maxLtvWad: bigint;
  minDraw: bigint;
  maxDraw: bigint;
  exposureCap: bigint;
}

export interface PartnerInput {
  signer: Address;
  eligibility: Address;
  exposureCap: bigint;
  active: boolean;
}

export interface VersionInput {
  note: string;
  tickers: TickerInput[];
  partner: PartnerInput | null;
}

export interface Change {
  scope: "ticker" | "partner";
  symbol?: string;
  collateral?: Address;
  field: string;
  before: string | boolean;
  after: string | boolean;
}

export interface PreparedCall {
  to: Address;
  data: Hex;
  description: string;
  function: "setTickerPolicy" | "setPartnerConfig";
}

const MAX_NOTE = 500;

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Validates a `POST /v1/policy/versions` body against the configured markets. Returns an error string or the parsed input. */
export function parseVersionInput(body: Record<string, unknown>, markets: readonly MarketConfig[]): VersionInput | { error: string } {
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) return { error: "note is required" };
  if (note.length > MAX_NOTE) return { error: `note must be at most ${MAX_NOTE} characters` };
  const tickers: TickerInput[] = [];
  if (body.tickers !== undefined) {
    if (!Array.isArray(body.tickers)) return { error: "tickers must be an array" };
    const seen = new Set<string>();
    for (const [i, raw] of body.tickers.entries()) {
      if (!isRecord(raw)) return { error: `tickers[${i}] must be an object` };
      if (typeof raw.collateral !== "string" || !isAddress(raw.collateral)) return { error: `tickers[${i}].collateral must be an address` };
      const collateral = getAddress(raw.collateral);
      if (!markets.some((m) => m.collateral.toLowerCase() === collateral.toLowerCase())) return { error: `tickers[${i}].collateral is not a market this desk serves` };
      if (seen.has(collateral.toLowerCase())) return { error: `tickers[${i}] repeats ${collateral}` };
      seen.add(collateral.toLowerCase());
      if (typeof raw.allowed !== "boolean") return { error: `tickers[${i}].allowed must be a boolean` };
      const maxLtvWad = parseBaseUnits(raw.maxLtvWad);
      if (maxLtvWad === null || maxLtvWad === 0n || maxLtvWad >= WAD) return { error: `tickers[${i}].maxLtvWad must be a wad strictly between 0 and 1e18` };
      const minDraw = parseBaseUnits(raw.minDraw ?? "0");
      const maxDraw = parseBaseUnits(raw.maxDraw ?? "0");
      const exposureCap = parseBaseUnits(raw.exposureCap ?? "0");
      if (minDraw === null || maxDraw === null || exposureCap === null) return { error: `tickers[${i}] amounts must be USDC base units as decimal strings` };
      if (maxDraw !== 0n && minDraw > maxDraw) return { error: `tickers[${i}].minDraw must not exceed maxDraw` };
      if (maxLtvWad > 2n ** 64n - 1n || [minDraw, maxDraw, exposureCap].some((x) => x > 2n ** 128n - 1n)) return { error: `tickers[${i}] value out of range` };
      tickers.push({ collateral, allowed: raw.allowed, maxLtvWad, minDraw, maxDraw, exposureCap });
    }
  }
  let partner: PartnerInput | null = null;
  if (body.partner !== undefined) {
    const raw = body.partner;
    if (!isRecord(raw)) return { error: "partner must be an object" };
    if (typeof raw.signer !== "string" || !isAddress(raw.signer)) return { error: "partner.signer must be an address (zero for open access)" };
    if (typeof raw.eligibility !== "string" || !isAddress(raw.eligibility)) return { error: "partner.eligibility must be an address (zero for none)" };
    const exposureCap = parseBaseUnits(raw.exposureCap ?? "0");
    if (exposureCap === null || exposureCap > 2n ** 128n - 1n) return { error: "partner.exposureCap must be USDC base units as a decimal string" };
    if (typeof raw.active !== "boolean") return { error: "partner.active must be a boolean" };
    partner = { signer: getAddress(raw.signer), eligibility: getAddress(raw.eligibility), exposureCap, active: raw.active };
  }
  if (tickers.length === 0 && !partner) return { error: "give tickers and/or partner to change" };
  return { note, tickers, partner };
}

/** Field-level diff of the input against the live policy and the calls that apply it (one per changed ticker, one for the partner config). */
export function diffPolicy(desk: Address, current: PolicyView, input: VersionInput): { changes: Change[]; calls: PreparedCall[] } {
  const changes: Change[] = [];
  const calls: PreparedCall[] = [];
  for (const t of input.tickers) {
    const cur = current.tickers.find((c) => c.collateral.toLowerCase() === t.collateral.toLowerCase());
    if (!cur) continue;
    const fields: [string, string | boolean, string | boolean][] = [
      ["allowed", cur.allowed, t.allowed],
      ["maxLtvWad", cur.maxLtvWad, t.maxLtvWad.toString()],
      ["minDraw", cur.minDraw, t.minDraw.toString()],
      ["maxDraw", cur.maxDraw, t.maxDraw.toString()],
      ["exposureCap", cur.exposureCap, t.exposureCap.toString()],
    ];
    const diffs = fields.filter(([, before, after]) => before !== after);
    if (diffs.length === 0) continue;
    for (const [field, before, after] of diffs) changes.push({ scope: "ticker", symbol: cur.symbol, collateral: cur.collateral, field, before, after });
    calls.push({
      to: desk,
      function: "setTickerPolicy",
      data: encodeFunctionData({
        abi: creditDeskAbi,
        functionName: "setTickerPolicy",
        args: [current.partnerId, t.collateral, t.allowed, t.maxLtvWad, t.minDraw, t.maxDraw, t.exposureCap],
      }),
      description: `setTickerPolicy(${cur.symbol}): ${diffs.map(([f, b, a]) => `${f} ${String(b)} → ${String(a)}`).join(", ")}`,
    });
  }
  if (input.partner) {
    const p = input.partner;
    const fields: [string, string | boolean, string | boolean][] = [
      ["signer", current.partner.signer.toLowerCase(), p.signer.toLowerCase()],
      ["eligibility", current.partner.eligibility.toLowerCase(), p.eligibility.toLowerCase()],
      ["exposureCap", current.partner.exposureCap, p.exposureCap.toString()],
      ["active", current.partner.active, p.active],
    ];
    const diffs = fields.filter(([, before, after]) => before !== after);
    if (diffs.length > 0) {
      for (const [field, before, after] of diffs) changes.push({ scope: "partner", field, before, after });
      calls.push({
        to: desk,
        function: "setPartnerConfig",
        data: encodeFunctionData({ abi: creditDeskAbi, functionName: "setPartnerConfig", args: [current.partnerId, p.signer, p.eligibility, p.exposureCap, p.active] }),
        description: `setPartnerConfig: ${diffs.map(([f, b, a]) => `${f} ${String(b)} → ${String(a)}`).join(", ")}`,
      });
    }
  }
  return { changes, calls };
}
