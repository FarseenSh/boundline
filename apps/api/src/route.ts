// POST /v1/route (plan M11): where a draw should go and why, as a deterministic plan a partner stores on the obligation.
//
// Base Sepolia (the API's own chain): the session-safe markets the desk serves, read live in ONE Multicall3 call (Morpho
// `market` and `idToMarketParams`, the SessionGate's verdict for the collateral, the partner's ticker policy and partner
// record on the desk, the block number) plus one `borrowRateView` on the market's IRM. Base mainnet: the Observatory's
// token snapshot and Morpho B20 markets with the IRM rates (`@boundline/router/candidates`, the same builder the agent
// uses). Every ABI word is encoded and decoded by hand (`@boundline/router/raw`): viem's generic decoders cost tens of
// milliseconds cold, and the Workers Free plan allows 10 ms of CPU per invocation. The plan hash and the EIP-712 digest
// are hand-rolled too (keccak over canonical bytes), checked against viem's `hashTypedData` in the tests.
import { canonicalRoutePlan, route, routePlanTypedData, ROUTE_PLAN_TYPES, type GateState, type PartnerPolicy, type RoutePlan, type RoutePlanTypedData, type SaturdayMode, type VenueCandidate } from "@boundline/router";
import { buildCandidates, readRates, type ObservatoryMarket, type ObservatoryToken, type RateRead } from "@boundline/router/candidates";
import { MULTICALL3, addressFromWord, addressWord, bytes32Word, decodeMarket, decodeMarketParams, decodeUint, encodeBorrowRateView, encodeIdToMarketParams, encodeMarket, multicall, word, wordAt, type Call3, type Call3Result } from "@boundline/router/raw";
import { keccak256, stringToHex, type Address, type Hex } from "viem";
import type { MarketConfig, SaturdayModePolicy } from "./policy.js";
import { saturdayFractionBps } from "./policy.js";

export const CHAIN_SEPOLIA = 84532;
export const CHAIN_MAINNET = 8453;
const STOCK_DECIMALS = 8;
const USDC_DECIMALS = 6;
const WAD = 10n ** 18n;
const ZERO: Address = "0x0000000000000000000000000000000000000000";
/** Without a partner policy: 50 % (the live `boundline-app` policy on the desk), a 1 USDC minimum, no caps. */
export const DEFAULT_MAX_LTV_BPS = 5_000;
export const DEFAULT_MIN_DRAW = 1_000_000n;
/** A capacity probe when the request names no amount: the router caps it at capacity and says CAPACITY_LIMITED. */
const CAPACITY_PROBE = (1n << 127n) - 1n;
const UNCAPPED = 10n ** 30n;
/** Route plans are valid this long; a draw after that needs a new plan. */
export const PLAN_VALID_SECONDS = 120;

/** Selectors (`cast sig`) of the reads that are not Morpho's. */
export const SELECTOR = {
  /** SessionGate.check(address) → Verdict (7 static words) */
  check: "0xc23697a8",
  /** CreditDesk.tickerPolicy(bytes32,address) → TickerPolicy (6 static words) */
  tickerPolicy: "0xac1b3140",
  /** CreditDesk.partner(bytes32) → Partner (7 static words) */
  partner: "0xfa2ca900",
  /** CreditDesk.line(uint256) → Line (9 static words) */
  line: "0x3c7d9255",
  /** Multicall3.getBlockNumber() */
  getBlockNumber: "0x42cbb15c",
} as const;

/** IPriceGate.GateState in declaration order, mapped to the router's names (UNKNOWN_TOKEN → UNKNOWN). */
export const GATE_STATES: readonly GateState[] = ["OPEN", "MARKET_CLOSED", "FEED_PAUSED", "TRANSFER_PAUSED", "FEED_STALE", "FEED_INVALID", "UNKNOWN"];
export const SESSIONS = ["UNKNOWN", "PRE", "REGULAR", "POST", "OVERNIGHT", "WEEKEND", "HOLIDAY"] as const;

// ---------------------------------------------------------------- request

export interface RouteInput {
  chainId: number;
  borrower: Address;
  symbol: string;
  /** Collateral in 8-decimal base units. */
  collateralAmount: bigint;
  /** USDC base units; null asks for the capacity. */
  amount: bigint | null;
  preferProtection: boolean;
  /** The caller's wish; Saturday mode applies only when the partner policy enables it. */
  saturdayMode: boolean | null;
  lineId: string | null;
  /** A partner id (bytes32) a keyless caller may name to route under that partner's public on-chain policy. */
  partnerId: Hex | null;
  maxLtvBps: number | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** "0.02" → 2_000_000n at 8 decimals; null for anything that is not a non-negative decimal with at most `decimals` places. */
export function parseDecimalUnits(value: unknown, decimals: number): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = typeof value === "number" ? String(value) : value.trim();
  const m = /^(\d{1,30})(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  return BigInt(m[1] as string) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Validates a POST /v1/route body (shape in the lane contract); `toPartnerId` normalises a partner name or id. */
export function parseRouteInput(body: Record<string, unknown>, toPartnerId: (v: unknown) => Hex | null): RouteInput | { error: string } {
  const chainId = body.chainId === undefined ? CHAIN_SEPOLIA : Number(body.chainId);
  if (chainId !== CHAIN_SEPOLIA && chainId !== CHAIN_MAINNET) return { error: "chainId must be 84532 (Base Sepolia, the desk) or 8453 (Base mainnet, read-only venues)" };
  let borrower: Address = ZERO;
  if (body.borrower !== undefined) {
    if (typeof body.borrower !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.borrower)) return { error: "borrower must be an address" };
    borrower = body.borrower as Address;
  }
  if (!Array.isArray(body.collateral) || body.collateral.length === 0) return { error: "collateral must be a non-empty array of {symbol, amount}" };
  if (body.collateral.length > 1) return { error: "one collateral per route plan: route each stock on its own (a line holds one collateral)" };
  const c = body.collateral[0];
  if (!isRecord(c) || typeof c.symbol !== "string" || !/^[A-Za-z0-9]{2,12}$/.test(c.symbol)) return { error: "collateral[0].symbol must be a stock symbol (AAPLt, AAPLc, …)" };
  const collateralAmount = parseDecimalUnits(c.amount, STOCK_DECIMALS);
  if (collateralAmount === null || collateralAmount === 0n) return { error: "collateral[0].amount must be a positive decimal string in shares (at most 8 decimals), e.g. \"0.02\"" };
  let amount: bigint | null = null;
  if (body.amountUsdc !== undefined && body.amountUsdc !== null) {
    amount = parseDecimalUnits(body.amountUsdc, USDC_DECIMALS);
    if (amount === null || amount === 0n) return { error: "amountUsdc must be a positive decimal string in USDC (at most 6 decimals), e.g. \"3.00\"; omit it to ask for the capacity" };
  }
  if (body.preferProtection !== undefined && typeof body.preferProtection !== "boolean") return { error: "preferProtection must be a boolean" };
  if (body.saturdayMode !== undefined && typeof body.saturdayMode !== "boolean") return { error: "saturdayMode must be a boolean" };
  let lineId: string | null = null;
  if (body.lineId !== undefined && body.lineId !== null) {
    const raw = typeof body.lineId === "number" ? String(body.lineId) : body.lineId;
    if (typeof raw !== "string" || !/^[1-9][0-9]{0,30}$/.test(raw)) return { error: "lineId must be a positive integer as a decimal string" };
    lineId = raw;
  }
  let partnerId: Hex | null = null;
  if (body.partnerId !== undefined) {
    partnerId = toPartnerId(body.partnerId);
    if (!partnerId) return { error: "partnerId must be bytes32 hex or a string of at most 32 bytes" };
  }
  let maxLtvBps: number | null = null;
  if (body.maxLtvBps !== undefined) {
    const v = body.maxLtvBps;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v >= 9_000) return { error: "maxLtvBps must be an integer in (0, 9000)" };
    maxLtvBps = v;
  }
  return {
    chainId,
    borrower,
    symbol: c.symbol,
    collateralAmount,
    amount,
    preferProtection: body.preferProtection === undefined ? true : (body.preferProtection as boolean),
    saturdayMode: body.saturdayMode === undefined ? null : (body.saturdayMode as boolean),
    lineId,
    partnerId,
    maxLtvBps,
  };
}

// ---------------------------------------------------------------- reads (Base Sepolia, hand-rolled)

export interface Verdict {
  state: GateState;
  session: (typeof SESSIONS)[number];
  answer: bigint;
  updatedAt: bigint;
  multiplier: bigint;
  registryPaused: boolean;
  transferPaused: boolean;
}

export interface TickerPolicyWords {
  allowed: boolean;
  maxLtvWad: bigint;
  minDraw: bigint;
  maxDraw: bigint;
  exposureCap: bigint;
  exposure: bigint;
}

export interface PartnerWords {
  admin: Address;
  active: boolean;
  policyVersion: number;
  exposureCap: bigint;
  exposure: bigint;
}

const TWO_255 = 1n << 255n;
const TWO_256 = 1n << 256n;

function words(data: Hex, n: number, what: string): bigint[] {
  const d = data.startsWith("0x") ? data.slice(2) : data;
  const out: bigint[] = [];
  for (let i = 0; i < n; i += 1) {
    const w = wordAt(d, i);
    if (w === null) throw new Error(`${what}: expected ${n} words`);
    out.push(w);
  }
  return out;
}

export function encodeCheck(token: Address): Hex {
  return `${SELECTOR.check}${addressWord(token)}` as Hex;
}
export function encodeTickerPolicy(partnerId: Hex, collateral: Address): Hex {
  return `${SELECTOR.tickerPolicy}${bytes32Word(partnerId)}${addressWord(collateral)}` as Hex;
}
export function encodePartner(partnerId: Hex): Hex {
  return `${SELECTOR.partner}${bytes32Word(partnerId)}` as Hex;
}
export function encodeLine(lineId: bigint): Hex {
  return `${SELECTOR.line}${word(lineId)}` as Hex;
}

export function decodeVerdict(data: Hex): Verdict {
  const [state, session, answer, updatedAt, multiplier, registryPaused, transferPaused] = words(data, 7, "check");
  return {
    state: GATE_STATES[Number(state)] ?? "UNKNOWN",
    session: SESSIONS[Number(session)] ?? "UNKNOWN",
    answer: (answer as bigint) >= TWO_255 ? (answer as bigint) - TWO_256 : (answer as bigint),
    updatedAt: updatedAt as bigint,
    multiplier: multiplier as bigint,
    registryPaused: registryPaused !== 0n,
    transferPaused: transferPaused !== 0n,
  };
}

export function decodeTickerPolicy(data: Hex): TickerPolicyWords {
  const [allowed, maxLtvWad, minDraw, maxDraw, exposureCap, exposure] = words(data, 6, "tickerPolicy") as [bigint, bigint, bigint, bigint, bigint, bigint];
  return { allowed: allowed !== 0n, maxLtvWad, minDraw, maxDraw, exposureCap, exposure };
}

export function decodePartner(data: Hex): PartnerWords {
  const [admin, , , active, policyVersion, exposureCap, exposure] = words(data, 7, "partner") as [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  return { admin: addressFromWord(admin) as Address, active: active !== 0n, policyVersion: Number(policyVersion), exposureCap, exposure };
}

/** The first three words of `line(uint256)`: partner, user, market. */
export function decodeLineHead(data: Hex): { partnerId: Hex; user: Address; marketId: Hex } {
  const [partnerId, user, marketId] = words(data, 3, "line") as [bigint, bigint, bigint];
  return { partnerId: `0x${partnerId.toString(16).padStart(64, "0")}` as Hex, user: addressFromWord(user) as Address, marketId: `0x${marketId.toString(16).padStart(64, "0")}` as Hex };
}

export interface SepoliaReadDeps {
  rpcs: readonly string[];
  fetchImpl: typeof fetch;
  desk: Address;
  gate: Address;
  morpho: Address;
}

export interface SepoliaRead {
  blockNumber: bigint | null;
  verdict: Verdict | null;
  ticker: TickerPolicyWords | null;
  partner: PartnerWords | null;
  liquidity: bigint | null;
  lltvWad: bigint | null;
  rateWad: bigint | null;
  notes: string[];
}

function ok(r: Call3Result | undefined): r is Call3Result {
  return Boolean(r && r.success && r.returnData.length > 2);
}

/** One multicall for the market, the gate and the partner's policy; one more call for the IRM's rate. */
export async function readSepoliaMarket(deps: SepoliaReadDeps, market: MarketConfig, partnerId: Hex | null): Promise<SepoliaRead> {
  const notes: string[] = [];
  const calls: Call3[] = [
    { target: MULTICALL3, allowFailure: true, callData: SELECTOR.getBlockNumber as Hex },
    { target: deps.morpho, allowFailure: true, callData: encodeMarket(market.marketId) },
    { target: deps.morpho, allowFailure: true, callData: encodeIdToMarketParams(market.marketId) },
    { target: deps.gate, allowFailure: true, callData: encodeCheck(market.collateral) },
  ];
  if (partnerId) {
    calls.push({ target: deps.desk, allowFailure: true, callData: encodeTickerPolicy(partnerId, market.collateral) });
    calls.push({ target: deps.desk, allowFailure: true, callData: encodePartner(partnerId) });
  }
  const r = await multicall(deps.rpcs, calls, deps.fetchImpl);
  const out: SepoliaRead = { blockNumber: null, verdict: null, ticker: null, partner: null, liquidity: null, lltvWad: null, rateWad: null, notes };
  if (ok(r[0])) out.blockNumber = decodeUint(r[0].returnData);
  let m: ReturnType<typeof decodeMarket> | null = null;
  let p: ReturnType<typeof decodeMarketParams> | null = null;
  try {
    if (ok(r[1])) m = decodeMarket(r[1].returnData);
    if (ok(r[2])) p = decodeMarketParams(r[2].returnData);
  } catch (err) {
    notes.push(`${market.symbol}: market read failed (${err instanceof Error ? err.message : String(err)})`);
  }
  if (m) out.liquidity = m.totalSupplyAssets > m.totalBorrowAssets ? m.totalSupplyAssets - m.totalBorrowAssets : 0n;
  if (p) out.lltvWad = p.lltv;
  if (!m || !p) notes.push(`${market.symbol}: Morpho market read failed (liquidity unknown → 0)`);
  if (ok(r[3])) out.verdict = decodeVerdict(r[3].returnData);
  else notes.push(`${market.symbol}: SessionGate.check failed (gate UNKNOWN, fails closed)`);
  if (partnerId) {
    if (ok(r[4])) out.ticker = decodeTickerPolicy(r[4].returnData);
    else notes.push(`${market.symbol}: the desk's ticker policy read failed`);
    if (ok(r[5])) out.partner = decodePartner(r[5].returnData);
    else notes.push("the desk's partner read failed");
  }
  if (m && p) {
    try {
      const res = await rpcCall(deps.rpcs, p.irm, encodeBorrowRateView(p, m), deps.fetchImpl);
      out.rateWad = decodeUint(res) * 31_536_000n;
    } catch (err) {
      notes.push(`${market.symbol}: IRM rate read failed (${err instanceof Error ? err.message : String(err)}); rate 0`);
    }
  }
  return out;
}

/** One eth_call through an ordered RPC list (the first endpoint that answers wins). */
export async function rpcCall(rpcs: readonly string[], to: string, data: Hex, fetchImpl: typeof fetch): Promise<Hex> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] });
  let last = "no rpc";
  for (const url of rpcs) {
    try {
      const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(8_000) });
      const json = (await res.json()) as { result?: Hex; error?: { message?: string } };
      if (json.error || !json.result) {
        last = json.error?.message ?? "empty result";
        continue;
      }
      return json.result;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`eth_call failed on every rpc: ${last}`);
}

// ---------------------------------------------------------------- candidates and policy

export interface ResolvedRoute {
  candidates: VenueCandidate[];
  policy: PartnerPolicy;
  policySource: string;
  /** The desk's partner policy version (Sepolia, partner known), else null. */
  deskPolicyVersion: number | null;
  blockNumber: bigint | null;
  notes: string[];
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Policy max LTV: the partner's ticker policy (or the default), never above a stricter per-request bound. */
function clampLtv(policyWad: bigint, requestBps: number | null): bigint {
  return requestBps === null ? policyWad : minBig(policyWad, BigInt(requestBps) * 10n ** 14n);
}

export function defaultPolicy(maxLtvBps: number | null): PartnerPolicy {
  return { allowed: true, maxLtvWad: BigInt(maxLtvBps ?? DEFAULT_MAX_LTV_BPS) * 10n ** 14n, minDraw: DEFAULT_MIN_DRAW, maxDraw: 0n, exposureHeadroom: UNCAPPED };
}

export interface SepoliaRouteDeps extends SepoliaReadDeps {
  markets: readonly MarketConfig[];
  /** The DeskProtectionVault: any desk line can be repaid at any hour from its ladder. */
  vault: Address | null;
}

/** Candidates on Base Sepolia: the desk's market for the symbol, priced by the SessionGate, under the partner's on-chain policy. */
export async function sepoliaRoute(deps: SepoliaRouteDeps, input: RouteInput, partnerId: Hex | null): Promise<ResolvedRoute> {
  const market = deps.markets.find((m) => m.symbol.toLowerCase() === input.symbol.toLowerCase());
  if (!market) {
    return { candidates: [], policy: defaultPolicy(input.maxLtvBps), policySource: "none", deskPolicyVersion: null, blockNumber: null, notes: [`${input.symbol} is not a market the desk serves on Base Sepolia (${deps.markets.map((m) => m.symbol).join(", ")})`] };
  }
  const read = await readSepoliaMarket(deps, market, partnerId);
  const notes = [...read.notes];
  let policy = defaultPolicy(input.maxLtvBps);
  let policySource = `default: ${(Number(policy.maxLtvWad) / 1e16).toFixed(2)}% max LTV, 1 USDC minimum, no caps (no partner named)`;
  let deskPolicyVersion: number | null = null;
  if (partnerId) {
    if (read.ticker && read.partner) {
      const t = read.ticker;
      const partnerHeadroom = read.partner.exposureCap === 0n ? UNCAPPED : read.partner.exposureCap > read.partner.exposure ? read.partner.exposureCap - read.partner.exposure : 0n;
      const tickerHeadroom = t.exposureCap === 0n ? UNCAPPED : t.exposureCap > t.exposure ? t.exposureCap - t.exposure : 0n;
      const registered = read.partner.admin !== ZERO;
      policy = { allowed: t.allowed && read.partner.active && registered, maxLtvWad: clampLtv(t.maxLtvWad, input.maxLtvBps), minDraw: t.minDraw, maxDraw: t.maxDraw, exposureHeadroom: minBig(partnerHeadroom, tickerHeadroom) };
      deskPolicyVersion = read.partner.policyVersion;
      policySource = `the desk's ${market.symbol} ticker policy for partner ${partnerId} (desk policy version ${read.partner.policyVersion}); headroom = min(partner, ticker) exposure caps`;
      if (!registered) notes.push("the partner is not registered on the desk: nothing is allowed");
      else if (!read.partner.active) notes.push("the partner is inactive on the desk: nothing is allowed");
    } else {
      policy = { ...defaultPolicy(input.maxLtvBps), allowed: false };
      policySource = "unknown: the desk's partner policy could not be read (fails closed)";
    }
  }
  const v = read.verdict;
  const protection: VenueCandidate["protection"] = market.preLiquidation ? "pre-liquidation" : deps.vault ? "vault" : "none";
  const candidate: VenueCandidate = {
    venue: "morpho",
    chainId: CHAIN_SEPOLIA,
    marketId: market.marketId,
    collateral: market.symbol,
    collateralDecimals: STOCK_DECIMALS,
    loanDecimals: USDC_DECIMALS,
    borrowRateWad: read.rateWad ?? 0n,
    lltvWad: read.lltvWad ?? 0n,
    availableLiquidity: read.liquidity ?? 0n,
    protection,
    gate: v?.state ?? "UNKNOWN",
    feedPrice8: v && v.answer > 0n ? v.answer : null,
    // A SessionGuard market never draws while the feed is held: no TWAP, no Saturday mode here.
    twapPrice8: null,
    pricesAroundTheClock: false,
  };
  if (v) notes.push(`${market.symbol}: SessionGate ${v.state}, session ${v.session}, feed ${Number(v.answer) / 1e8} updated at ${v.updatedAt}`);
  if (protection === "pre-liquidation") notes.push(`${market.symbol}: protected mode live (Morpho pre-liquidation ${market.preLiquidation} with the ShadowGuard oracle, Boundline's Protector) and the DeskProtectionVault's any-hour repay`);
  else if (protection === "vault") notes.push(`${market.symbol}: the DeskProtectionVault repays a desk line at any hour from its ladder (user reserve, partner reserve, bounded Reserve advance)`);
  return { candidates: [candidate], policy, policySource, deskPolicyVersion, blockNumber: read.blockNumber, notes };
}

export interface MainnetRouteDeps {
  observatory: (path: string) => Promise<unknown>;
  rpcs: readonly string[];
  fetchImpl: typeof fetch;
}

/** Candidates on Base mainnet: the B20 Morpho markets the Observatory lists, IRM rates read live, a default policy. */
export async function mainnetRoute(deps: MainnetRouteDeps, input: RouteInput): Promise<ResolvedRoute> {
  const [tokensRes, marketsRes] = await Promise.all([deps.observatory("/v1/tokens"), deps.observatory("/v1/venues/morpho/markets")]);
  const tokens = ((tokensRes as { tokens?: ObservatoryToken[] }).tokens ?? []) as ObservatoryToken[];
  const mainnetMarkets = ((marketsRes as { markets?: ObservatoryMarket[] }).markets ?? []) as ObservatoryMarket[];
  const ids = mainnetMarkets.filter((m) => m.collateral.symbol === input.symbol).map((m) => m.id);
  let rates: RateRead[];
  const notes: string[] = [];
  try {
    rates = await readRates(deps.rpcs, ids, deps.fetchImpl);
  } catch (err) {
    notes.push(`IRM rates unavailable: ${err instanceof Error ? err.message : String(err)}`);
    rates = ids.map((id) => ({ id, borrowRateWad: 0n, availableLiquidity: 0n, lltvWad: 0n, collateralToken: "", error: "rate read failed" }));
  }
  const built = buildCandidates(input.symbol, { tokens, mainnetMarkets, mainnetRates: rates, sepoliaRates: [] });
  const policy = defaultPolicy(input.maxLtvBps ?? 5_500);
  const candidates = built.candidates.filter((c) => c.chainId === CHAIN_MAINNET);
  const protectedCount = candidates.filter((c) => c.protection === "pre-liquidation").length;
  return {
    candidates,
    policy,
    policySource: `default: ${(Number(policy.maxLtvWad) / 1e16).toFixed(2)}% max LTV (mainnet routes use a default policy, not the mainnet desk's; maxLtvBps tightens it)`,
    deskPolicyVersion: null,
    blockNumber: null,
    notes: [
      ...notes,
      ...built.notes,
      protectedCount > 0
        ? `Base mainnet: ${protectedCount} of ${candidates.length} markets carry a Boundline pre-liquidation (protected mode, opted into with Morpho.setAuthorization); the rest show protection none`
        : "Base mainnet: no Boundline pre-liquidation on these markets, so they show protection none",
    ],
  };
}

// ---------------------------------------------------------------- the plan, its hash and its EIP-712 digest

/** Saturday mode as the router takes it: only when the partner policy enables it and the caller did not opt out. */
export function effectiveSaturday(policy: SaturdayModePolicy | null, wish: boolean | null): { mode: SaturdayMode | null; applied: boolean; note: string | null } {
  if (!policy || !policy.enabled) {
    return { mode: null, applied: false, note: wish ? "Saturday mode is off in the partner policy (POST /v1/policy/versions with saturdayMode to enable it)" : null };
  }
  if (wish === false) return { mode: null, applied: false, note: "Saturday mode is enabled in the policy; this request opted out" };
  return { mode: { enabled: true, haircutBps: policy.haircutBps, capacityFractionBps: saturdayFractionBps(policy) }, applied: true, note: null };
}

export interface PlannedRoute {
  plan: RoutePlan;
  planJson: string;
  planHash: Hex;
  typedData: RoutePlanTypedData | null;
  digest: Hex | null;
}

/** Runs the router; `now` in unix seconds. */
export function makePlan(input: RouteInput, resolved: ResolvedRoute, saturday: SaturdayMode | null, chainId: number, verifyingContract: Address, now: number): PlannedRoute {
  const plan = route(
    {
      user: input.borrower,
      collateral: input.symbol,
      collateralAmount: input.collateralAmount,
      collateralDecimals: STOCK_DECIMALS,
      amount: input.amount ?? CAPACITY_PROBE,
      policy: resolved.policy,
      preferProtection: input.preferProtection,
      now,
      validForSeconds: PLAN_VALID_SECONDS,
      ...(saturday ? { saturdayMode: saturday } : {}),
    },
    resolved.candidates,
  );
  const planJson = canonicalRoutePlan(plan);
  const planHash = keccak256(stringToHex(planJson));
  const typedData = plan.chosen ? routePlanTypedData(plan, chainId, verifyingContract) : null;
  return { plan, planJson, planHash, typedData, digest: typedData ? routePlanDigest(typedData) : null };
}

const ENC = new TextEncoder();
const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const keccakText = (text: string): string => keccak256(`0x${hexOf(ENC.encode(text))}`).slice(2);
const keccakHex = (hex: string): string => keccak256(`0x${hex}`).slice(2);

/** `RoutePlan(address user,string collateral,…)`, the type string the EIP-712 type hash is taken over. */
export const ROUTE_PLAN_TYPE_STRING = `RoutePlan(${ROUTE_PLAN_TYPES.RoutePlan.map((f) => `${f.type} ${f.name}`).join(",")})`;
const ROUTE_PLAN_TYPEHASH = keccakText(ROUTE_PLAN_TYPE_STRING);
const DOMAIN_TYPEHASH = keccakText("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

/** The EIP-712 digest of a route plan, by hand: keccak256(0x1901 ‖ domainSeparator ‖ structHash). */
export function routePlanDigest(td: RoutePlanTypedData): Hex {
  const d = td.domain;
  const domainSeparator = keccakHex(DOMAIN_TYPEHASH + keccakText(d.name) + keccakText(d.version) + word(d.chainId) + addressWord(d.verifyingContract));
  const m = td.message;
  const fields = ROUTE_PLAN_TYPES.RoutePlan.map((f) => {
    const v = m[f.name as keyof typeof m];
    if (f.type === "string") return keccakText(String(v));
    if (f.type === "address") return addressWord(String(v));
    return word(v as bigint);
  });
  const structHash = keccakHex(ROUTE_PLAN_TYPEHASH + fields.join(""));
  return keccak256(`0x1901${domainSeparator}${structHash}`);
}

const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/** JSON-safe typed data for a wallet's eth_signTypedData_v4 (bigints as decimal strings, the domain type spelled out). */
export function typedDataJson(td: RoutePlanTypedData): Record<string, unknown> {
  return {
    domain: td.domain,
    types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...td.types },
    primaryType: td.primaryType,
    message: Object.fromEntries(Object.entries(td.message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
  };
}
