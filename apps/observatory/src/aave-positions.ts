// Real positions on the Aave V4 MAG7 spoke: who borrows (the indexer's Borrow-event scan), what they
// owe, and their health at the venue's price versus the 24/7 DEX TWAP of the stock collateral.
//
// Every read is hand-encoded and hand-decoded (encoding.ts) and batched through one Multicall3 call per
// tick, for the same reason as the snapshot reader: the Workers Free plan's 10 ms CPU budget. The health
// model reproduces the spoke's own figure (checked live on 7 Oct 2026 against borrower 0x84c4…d980:
// Σ collateral value × collateral factor / debt value = 1.6809, the spoke's healthFactor), so the shadow
// health is the same formula with the DEX TWAP in place of the held feed for every reserve that has a pool.
import { AAVE_MAG7_RESERVES, B20_BY_SYMBOL, MAINNET, answerToNumber, price36ToHuman } from "@boundline/chain";
import type { Address } from "viem";
import { MULTICALL3, addressAt, boolAt, callData, decodeAggregate3, encodeAggregate3, uintAt, wordAddress, wordUint, type Call, type CallResult } from "./encoding.js";
import type { EthCall } from "./rpc.js";
import type { Snapshot } from "./snapshot.js";

export const AAVE_CHAIN_ID = 8453;
export const AAVE_SPOKE: Address = MAINNET.aaveMag7Spoke;
/** USDC, the spoke's only borrowable reserve. */
export const USDC_RESERVE_ID = AAVE_MAG7_RESERVES.USDC;
/** Borrowers read per tick; the scan rotates through the known list so one tick stays bounded. */
export const AAVE_BATCH_PER_TICK = 25;
/** Flag a position for protection below this shadow health (the venue would liquidate at 1.0 once the feed prints). */
export const AAVE_PROTECTION_HF = 1.05;
/** Reserve metadata (decimals, collateral factors, oracle) changes rarely: cached in KV this long. */
export const AAVE_META_TTL_SECONDS = 3600;
export const KV_AAVE_META = "aave-reserve-meta";

/** `cast sig` of each spoke and oracle signature; checked against viem in test/aave-positions.test.ts. */
export const AAVE_SELECTOR = {
  getUserAccountData: "0xbf92857c", // getUserAccountData(address)
  getUserTotalDebt: "0x9b7172a6", // getUserTotalDebt(uint256,address)
  getUserSuppliedAssets: "0xf1568a89", // getUserSuppliedAssets(uint256,address)
  getReserve: "0x77778db3", // getReserve(uint256)
  getReserveConfig: "0x008754a2", // getReserveConfig(uint256)
  getDynamicReserveConfig: "0xec17bb00", // getDynamicReserveConfig(uint256,uint32)
  oracle: "0x38013f02", // ORACLE()
  getReservePrice: "0xd45c35ff", // getReservePrice(uint256)
} as const;

const RESERVE_IDS: readonly number[] = Object.values(AAVE_MAG7_RESERVES);
const SYMBOL_BY_ID: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(AAVE_MAG7_RESERVES).map(([s, id]) => [id, s]));
const STOCK_RESERVE_IDS: readonly number[] = RESERVE_IDS.filter((id) => id !== USDC_RESERVE_ID);
const MAX_UINT256 = (1n << 256n) - 1n;

export interface AaveReserveMeta {
  reserveId: number;
  symbol: string;
  underlying: Address;
  decimals: number;
  /** Basis points, from `getDynamicReserveConfig(id, dynamicConfigKey)`. 0 for USDC (borrow-only). */
  collateralFactorBps: number;
  paused: boolean;
  frozen: boolean;
  borrowable: boolean;
}

export interface AaveMeta {
  readAt: number;
  oracle: Address;
  reserves: AaveReserveMeta[];
}

export interface AaveBorrowerRecord {
  chainId: number;
  address: Address;
  firstSeenBlock: number;
  lastSeenBlock: number;
  reserveIds: number[];
  source: "indexer";
  updatedAt: number;
}

export interface AaveCollateralLeg {
  reserveId: number;
  symbol: string;
  /** Raw supplied units (8 decimals for the stocks). */
  raw: string;
  amount: number;
  collateralFactor: number;
  /** USD per share as the spoke's oracle answers (held while closed). */
  venuePrice: number;
  /** USD per share from the 1h DEX TWAP; null when the token has no pool (the venue price stands in). */
  shadowPrice: number | null;
  venueValueUsd: number;
  shadowValueUsd: number;
}

export interface AavePositionRow {
  chainId: number;
  venue: "aave";
  spoke: Address;
  address: Address;
  takenAt: number;
  blockNumber: number;
  /** Raw USDC debt on reserve 7 (6 decimals). */
  debtUsdc: string;
  debtValueUsd: number;
  collateralValueUsd: number;
  shadowCollateralValueUsd: number;
  /** Share of the collateral-factor-weighted value that has a 24/7 DEX price (0..1). */
  shadowCoverage: number;
  collateral: AaveCollateralLeg[];
  /** The spoke's own healthFactor (WAD → number), null without debt. */
  venueHf: number | null;
  /** Σ value × collateral factor / debt value at the venue's prices: the spoke's formula, recomputed. */
  modelHf: number | null;
  /** The same formula with the DEX TWAP for every reserve that has a pool. */
  shadowHf: number | null;
  protectionCase: boolean;
  riskPremiumBps: number;
  avgCollateralFactor: number;
}

function attempt<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function ok(r: CallResult | undefined): string | null {
  return r && r.success && r.data.length >= 64 ? r.data : null;
}

// ---------------------------------------------------------------- reserve metadata (two round trips, cached)

/** First round trip: every reserve's static record and the spoke's oracle. */
export function planReserveRecords(): Call[] {
  return [...RESERVE_IDS.map((id): Call => ({ target: AAVE_SPOKE, callData: callData(AAVE_SELECTOR.getReserve, wordUint(id)) })), { target: AAVE_SPOKE, callData: AAVE_SELECTOR.oracle }];
}

export interface ReserveRecord {
  reserveId: number;
  underlying: Address;
  decimals: number;
  dynamicConfigKey: number;
}

/** `getReserve(id)` → (underlying, hub, assetId, decimals, collateralRisk, flags, dynamicConfigKey). */
export function decodeReserveRecords(results: readonly CallResult[]): { records: ReserveRecord[]; oracle: Address | null } {
  const records: ReserveRecord[] = [];
  RESERVE_IDS.forEach((id, i) => {
    const d = ok(results[i]);
    if (!d) return;
    const r = attempt(() => ({ reserveId: id, underlying: addressAt(d, 0), decimals: Number(uintAt(d, 3)), dynamicConfigKey: Number(uintAt(d, 6)) }));
    if (r) records.push(r);
  });
  const o = ok(results[RESERVE_IDS.length]);
  return { records, oracle: o ? attempt(() => addressAt(o, 0)) : null };
}

/** Second round trip: collateral factors (keyed by each reserve's dynamic config key) and flags. */
export function planReserveConfigs(records: readonly ReserveRecord[]): Call[] {
  return records.flatMap((r): Call[] => [
    { target: AAVE_SPOKE, callData: callData(AAVE_SELECTOR.getDynamicReserveConfig, wordUint(r.reserveId), wordUint(r.dynamicConfigKey)) },
    { target: AAVE_SPOKE, callData: callData(AAVE_SELECTOR.getReserveConfig, wordUint(r.reserveId)) },
  ]);
}

export function decodeReserveConfigs(records: readonly ReserveRecord[], results: readonly CallResult[]): AaveReserveMeta[] {
  return records.map((r, i) => {
    const dyn = ok(results[i * 2]);
    const cfg = ok(results[i * 2 + 1]);
    return {
      reserveId: r.reserveId,
      symbol: SYMBOL_BY_ID[r.reserveId] ?? `reserve-${r.reserveId}`,
      underlying: r.underlying,
      decimals: r.decimals,
      collateralFactorBps: dyn ? Number(attempt(() => uintAt(dyn, 0)) ?? 0n) : 0,
      paused: cfg ? (attempt(() => boolAt(cfg, 1)) ?? false) : false,
      frozen: cfg ? (attempt(() => boolAt(cfg, 2)) ?? false) : false,
      borrowable: cfg ? (attempt(() => boolAt(cfg, 3)) ?? false) : false,
    };
  });
}

/** Reads the reserve metadata in two aggregate3 calls. */
export async function readAaveMeta(call: EthCall, now: number): Promise<AaveMeta> {
  const first = decodeAggregate3(await call(MULTICALL3, encodeAggregate3(planReserveRecords())));
  const { records, oracle } = decodeReserveRecords(first);
  if (!oracle || records.length === 0) throw new Error("aave spoke: reserve records unreadable");
  const second = decodeAggregate3(await call(MULTICALL3, encodeAggregate3(planReserveConfigs(records))));
  return { readAt: now, oracle, reserves: decodeReserveConfigs(records, second) };
}

/** KV-cached metadata; a read failure falls back to the stale copy when there is one. */
export async function cachedAaveMeta(kv: KVNamespace, call: EthCall, now: number, ttl = AAVE_META_TTL_SECONDS): Promise<AaveMeta> {
  const hit = await kv.get<AaveMeta>(KV_AAVE_META, "json");
  if (hit && now - hit.readAt < ttl) return hit;
  try {
    const fresh = await readAaveMeta(call, now);
    await kv.put(KV_AAVE_META, JSON.stringify(fresh), { expirationTtl: Math.max(60, ttl * 4) });
    return fresh;
  } catch (err) {
    if (hit) return hit;
    throw err;
  }
}

// ---------------------------------------------------------------- positions (one round trip per batch)

/** Calls per borrower: account data, USDC debt, one supplied-assets read per stock reserve. */
export const USER_STRIDE = 2 + STOCK_RESERVE_IDS.length;

/** Prices for every reserve first, then USER_STRIDE calls per borrower. */
export function planPositions(meta: AaveMeta, borrowers: readonly Address[]): Call[] {
  const calls: Call[] = RESERVE_IDS.map((id) => ({ target: meta.oracle, callData: callData(AAVE_SELECTOR.getReservePrice, wordUint(id)) }));
  for (const b of borrowers) {
    calls.push(
      { target: AAVE_SPOKE, callData: callData(AAVE_SELECTOR.getUserAccountData, wordAddress(b)) },
      { target: AAVE_SPOKE, callData: callData(AAVE_SELECTOR.getUserTotalDebt, wordUint(USDC_RESERVE_ID), wordAddress(b)) },
      ...STOCK_RESERVE_IDS.map((id): Call => ({ target: AAVE_SPOKE, callData: callData(AAVE_SELECTOR.getUserSuppliedAssets, wordUint(id), wordAddress(b)) })),
    );
  }
  return calls;
}

export interface AccountData {
  riskPremiumBps: number;
  avgCollateralFactor: number;
  /** WAD healthFactor; null when the spoke answers type(uint256).max (no debt). */
  healthFactor: bigint | null;
  totalCollateralValue: bigint;
  totalDebtValueRay: bigint;
  activeCollateralCount: number;
  borrowCount: number;
}

/** `getUserAccountData(user)` → the seven-word UserAccountData struct. */
export function decodeAccountData(data: string): AccountData {
  const hf = uintAt(data, 2);
  return {
    riskPremiumBps: Number(uintAt(data, 0)),
    avgCollateralFactor: Number(uintAt(data, 1)) / 1e18,
    healthFactor: hf === MAX_UINT256 ? null : hf,
    totalCollateralValue: uintAt(data, 3),
    totalDebtValueRay: uintAt(data, 4),
    activeCollateralCount: Number(uintAt(data, 5)),
    borrowCount: Number(uintAt(data, 6)),
  };
}

export interface ShapeInput {
  address: Address;
  account: AccountData;
  debtUsdc: bigint;
  /** reserveId → raw supplied assets. */
  supplied: ReadonlyMap<number, bigint>;
  /** reserveId → oracle price (8 decimals). */
  prices: ReadonlyMap<number, bigint>;
  /** B20 symbol → 1h TWAP in USD, for the reserves whose token has a DEX pool. */
  shadowUsdBySymbol: ReadonlyMap<string, number>;
  meta: AaveMeta;
  blockNumber: number;
  takenAt: number;
}

/** Health at the venue's prices and at the DEX TWAP, the spoke's own formula on both. Null when the row is empty. */
export function shapeAavePosition(i: ShapeInput): AavePositionRow | null {
  const usdcPrice = i.prices.get(USDC_RESERVE_ID);
  const usdc = i.meta.reserves.find((r) => r.reserveId === USDC_RESERVE_ID);
  const debtValueUsd = usdcPrice === undefined ? Number(i.debtUsdc) / 1e6 : (Number(i.debtUsdc) / 10 ** (usdc?.decimals ?? 6)) * answerToNumber(usdcPrice, 8);
  const legs: AaveCollateralLeg[] = [];
  for (const r of i.meta.reserves) {
    if (r.reserveId === USDC_RESERVE_ID) continue;
    const raw = i.supplied.get(r.reserveId) ?? 0n;
    if (raw === 0n) continue;
    const px = i.prices.get(r.reserveId);
    const venuePrice = px === undefined ? 0 : answerToNumber(px, 8);
    const amount = Number(raw) / 10 ** r.decimals;
    const shadowPrice = i.shadowUsdBySymbol.get(r.symbol) ?? null;
    legs.push({
      reserveId: r.reserveId,
      symbol: r.symbol,
      raw: raw.toString(),
      amount,
      collateralFactor: r.collateralFactorBps / 10_000,
      venuePrice,
      shadowPrice,
      venueValueUsd: amount * venuePrice,
      shadowValueUsd: amount * (shadowPrice ?? venuePrice),
    });
  }
  if (legs.length === 0 && i.debtUsdc === 0n) return null;
  const weightedVenue = legs.reduce((s, l) => s + l.venueValueUsd * l.collateralFactor, 0);
  const weightedShadow = legs.reduce((s, l) => s + l.shadowValueUsd * l.collateralFactor, 0);
  const covered = legs.reduce((s, l) => s + (l.shadowPrice === null ? 0 : l.venueValueUsd * l.collateralFactor), 0);
  const hasDebt = i.debtUsdc > 0n && debtValueUsd > 0;
  const modelHf = hasDebt ? weightedVenue / debtValueUsd : null;
  const shadowHf = hasDebt ? weightedShadow / debtValueUsd : null;
  const venueHf = i.account.healthFactor === null ? null : Number(i.account.healthFactor) / 1e18;
  return {
    chainId: AAVE_CHAIN_ID,
    venue: "aave",
    spoke: AAVE_SPOKE,
    address: i.address,
    takenAt: i.takenAt,
    blockNumber: i.blockNumber,
    debtUsdc: i.debtUsdc.toString(),
    debtValueUsd,
    collateralValueUsd: legs.reduce((s, l) => s + l.venueValueUsd, 0),
    shadowCollateralValueUsd: legs.reduce((s, l) => s + l.shadowValueUsd, 0),
    shadowCoverage: weightedVenue > 0 ? covered / weightedVenue : 0,
    collateral: legs,
    venueHf,
    modelHf,
    shadowHf,
    protectionCase: hasDebt && shadowHf !== null && shadowHf < AAVE_PROTECTION_HF,
    riskPremiumBps: i.account.riskPremiumBps,
    avgCollateralFactor: i.account.avgCollateralFactor,
  };
}

/** The 1h TWAP in USD per B20 symbol, from the snapshot the tick already took. */
export function shadowUsdFromSnapshot(snapshot: Pick<Snapshot, "tokens">): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of snapshot.tokens) {
    if (!t.dexTwapPrice36) continue;
    const token = B20_BY_SYMBOL[t.symbol];
    out.set(t.symbol, price36ToHuman(BigInt(t.dexTwapPrice36), token?.decimals ?? 8, 6));
  }
  return out;
}

/** Decodes one batch's aggregate3 results into rows; borrowers whose reads failed or whose position is empty are skipped. */
export function decodePositions(meta: AaveMeta, borrowers: readonly Address[], results: readonly CallResult[], shadowUsdBySymbol: ReadonlyMap<string, number>, blockNumber: number, takenAt: number): AavePositionRow[] {
  const prices = new Map<number, bigint>();
  RESERVE_IDS.forEach((id, i) => {
    const d = ok(results[i]);
    const p = d ? attempt(() => uintAt(d, 0)) : null;
    if (p !== null) prices.set(id, p);
  });
  const rows: AavePositionRow[] = [];
  borrowers.forEach((b, k) => {
    const base = RESERVE_IDS.length + k * USER_STRIDE;
    const acct = ok(results[base]);
    const debt = ok(results[base + 1]);
    const account = acct ? attempt(() => decodeAccountData(acct)) : null;
    const debtUsdc = debt ? attempt(() => uintAt(debt, 0)) : null;
    if (!account || debtUsdc === null) return;
    const supplied = new Map<number, bigint>();
    STOCK_RESERVE_IDS.forEach((id, j) => {
      const d = ok(results[base + 2 + j]);
      const v = d ? attempt(() => uintAt(d, 0)) : null;
      if (v !== null) supplied.set(id, v);
    });
    const row = shapeAavePosition({ address: b, account, debtUsdc, supplied, prices, shadowUsdBySymbol, meta, blockNumber, takenAt });
    if (row) rows.push(row);
  });
  return rows;
}

/** One aggregate3 call for a batch of borrowers. */
export async function readAavePositions(call: EthCall, meta: AaveMeta, borrowers: readonly Address[], shadowUsdBySymbol: ReadonlyMap<string, number>, blockNumber: number, takenAt: number): Promise<AavePositionRow[]> {
  if (borrowers.length === 0) return [];
  const results = decodeAggregate3(await call(MULTICALL3, encodeAggregate3(planPositions(meta, borrowers))));
  return decodePositions(meta, borrowers, results, shadowUsdBySymbol, blockNumber, takenAt);
}

// ---------------------------------------------------------------- borrowers from the indexer

interface IndexerBorrower {
  address: string;
  firstBlock: number;
  lastBlock: number;
  reserveIds?: string[];
}

/** Parses the indexer's `/v1/venues/aave/borrowers` body into records; malformed entries are dropped. */
export function parseIndexerBorrowers(body: { borrowers?: IndexerBorrower[] }, now: number): AaveBorrowerRecord[] {
  const out: AaveBorrowerRecord[] = [];
  for (const b of body.borrowers ?? []) {
    if (typeof b.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(b.address)) continue;
    out.push({
      chainId: AAVE_CHAIN_ID,
      address: b.address.toLowerCase() as Address,
      firstSeenBlock: Number(b.firstBlock) || 0,
      lastSeenBlock: Number(b.lastBlock) || 0,
      reserveIds: (b.reserveIds ?? []).map((r) => Number(r)).filter((n) => Number.isInteger(n)),
      source: "indexer",
      updatedAt: now,
    });
  }
  return out;
}

/** The slice of the known borrowers this tick reads, wrapping around; `offset` is where the last tick stopped. */
export function rotate<T>(all: readonly T[], offset: number, batch = AAVE_BATCH_PER_TICK): { picked: T[]; nextOffset: number } {
  if (all.length === 0) return { picked: [], nextOffset: 0 };
  const start = ((offset % all.length) + all.length) % all.length;
  const picked: T[] = [];
  for (let k = 0; k < Math.min(batch, all.length); k += 1) picked.push(all[(start + k) % all.length] as T);
  return { picked, nextOffset: all.length <= batch ? 0 : (start + batch) % all.length };
}
