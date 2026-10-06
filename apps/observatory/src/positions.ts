// Real positions on the B20 Morpho markets: who borrowed (Borrow events, seeded from Morpho's API),
// what they owe, and their health at the venue's price versus the 24/7 DEX TWAP.
import { MAINNET, TOPICS, price36ToHuman } from "@boundline/chain";
import type { Address, Hex } from "viem";
import { MULTICALL3, SELECTOR, callData, decodeAggregate3, decodeMarket, decodePosition, decodeUint, encodeAggregate3, wordAddress, wordBytes32, type Call } from "./encoding.js";
import { MORPHO_GRAPHQL, type MarketRow } from "./morpho.js";
import type { EthCall, GetLogs } from "./rpc.js";

/** Blocks per getLogs call: publicnode serves 5,000 at the head; `mainnet.base.org` 2,000. */
export const SCAN_SPAN = 2000;
export const SCAN_CALLS_PER_TICK = 2;
/** publicnode answers "archive requests require a token" for ranges older than about 8,000 blocks. */
export const SCAN_ARCHIVE_DEPTH = 7000;
export const POSITIONS_EVERY_SECONDS = 600;
export const CHAIN_ID = 8453;
const ORACLE_SCALE = 10n ** 36n;
const VIRTUAL_SHARES = 1_000_000n;
const VIRTUAL_ASSETS = 1n;

export interface Borrower {
  chainId: number;
  marketId: Hex;
  address: Address;
  firstSeenBlock: number;
  source: "logs" | "api";
}

export interface PositionRow {
  chainId: number;
  marketId: Hex;
  address: Address;
  takenAt: number;
  blockNumber: number;
  collateralSymbol: string;
  lltv: number;
  collateral: string;
  borrowShares: string;
  debtAssets: string;
  venuePrice: number | null;
  shadowPrice: number | null;
  venueHf: number | null;
  shadowHf: number | null;
  protectionCase: boolean;
}

export interface ScanPlan {
  from: number;
  to: number;
  /** Set when the cursor fell behind the archive cutoff and the scan jumped forward (a gap the API seed covers). */
  skippedFrom: number | null;
}

/** Morpho SharesMathLib.toAssetsUp: shares -> assets with the virtual offsets, rounded up. */
export function toAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  if (shares === 0n) return 0n;
  const num = shares * (totalAssets + VIRTUAL_ASSETS);
  const den = totalShares + VIRTUAL_SHARES;
  return (num + den - 1n) / den;
}

/** Which blocks to scan this tick, or null when the cursor is already at the head. */
export function planScan(cursor: number | null, head: number, span = SCAN_SPAN, calls = SCAN_CALLS_PER_TICK, archiveDepth = SCAN_ARCHIVE_DEPTH): ScanPlan | null {
  const to = head - 1;
  let from = cursor === null ? head - span : cursor + 1;
  let skippedFrom: number | null = null;
  const floor = head - archiveDepth;
  if (from < floor) {
    skippedFrom = from;
    from = floor;
  }
  if (from > to) return null;
  return { from, to: Math.min(to, from + span * calls - 1), skippedFrom };
}

/** Splits a plan into getLogs-sized chunks. */
export function chunks(plan: ScanPlan, span = SCAN_SPAN): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (let f = plan.from; f <= plan.to; f += span) out.push({ from: f, to: Math.min(plan.to, f + span - 1) });
  return out;
}

interface ApiPosition {
  user: { address: string };
  market: { marketId: string };
  state: { borrowShares: string; collateral: string } | null;
}

export function parsePositionsDiscovery(body: { data?: { marketPositions?: { items?: ApiPosition[] } } }, marketIds: ReadonlySet<string>, block: number): Borrower[] {
  const items = body.data?.marketPositions?.items ?? [];
  const out: Borrower[] = [];
  for (const p of items) {
    const id = p.market.marketId.toLowerCase();
    if (!marketIds.has(id)) continue;
    if (!p.state || BigInt(p.state.borrowShares) === 0n) continue;
    out.push({ chainId: CHAIN_ID, marketId: id as Hex, address: p.user.address as Address, firstSeenBlock: block, source: "api" });
  }
  return out;
}

const POSITIONS_QUERY = `query B20Positions($ids: [String!]) {
  marketPositions(first: 500, where: { chainId_in: [8453], marketUniqueKey_in: $ids, borrowShares_gte: 1 }) {
    items { user { address } market { marketId } state { borrowShares collateral } }
  }
}`;

/** Current borrowers from Morpho's API: the seed, because public RPCs refuse deep getLogs ranges. */
export async function fetchApiBorrowers(fetchImpl: typeof fetch, marketIds: readonly Hex[], block: number): Promise<Borrower[]> {
  const res = await fetchImpl(MORPHO_GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: POSITIONS_QUERY, variables: { ids: marketIds } }),
  });
  if (!res.ok) throw new Error(`morpho api ${res.status}`);
  return parsePositionsDiscovery((await res.json()) as Parameters<typeof parsePositionsDiscovery>[0], new Set(marketIds.map((m) => m.toLowerCase())), block);
}

/** The two RPC reads the positions job makes, both over raw JSON-RPC (rpc.ts) so the job stays CPU-light. */
export interface PositionsRpc {
  call: EthCall;
  getLogs: GetLogs;
}

/** Morpho `Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)`. */
export const BORROW_TOPIC: Hex = TOPICS.morphoBorrow;

/** Borrow events on the given markets between two blocks, in getLogs-sized chunks; `id` and `onBehalf` come straight from the topics. */
export async function scanBorrowLogs(getLogs: GetLogs, marketIds: readonly Hex[], plan: ScanPlan): Promise<Borrower[]> {
  const out = new Map<string, Borrower>();
  for (const c of chunks(plan)) {
    const logs = await getLogs({ address: MAINNET.morpho, topics: [BORROW_TOPIC, [...marketIds]], fromBlock: c.from, toBlock: c.to });
    for (const l of logs) {
      const id = l.topics[1]?.toLowerCase();
      const onBehalfTopic = l.topics[2];
      if (!id || !onBehalfTopic || onBehalfTopic.length !== 66) continue;
      const onBehalf = `0x${onBehalfTopic.slice(26)}` as Address;
      const key = `${id}:${onBehalf}`;
      if (!out.has(key)) out.set(key, { chainId: CHAIN_ID, marketId: id as Hex, address: onBehalf, firstSeenBlock: l.blockNumber ? Number(BigInt(l.blockNumber)) : c.from, source: "logs" });
    }
  }
  return [...out.values()];
}

export interface PositionInput {
  chainId: number;
  marketId: Hex;
  address: Address;
  collateralSymbol: string;
  lltv: number;
  collateral: bigint;
  borrowShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  venuePrice36: bigint | null;
  shadowPrice36: bigint | null;
  blockNumber: number;
  takenAt: number;
}

/** Collateral value in loan units (USDC base units) at a 36-scale price. */
function collateralValue(collateral: bigint, price36: bigint): bigint {
  return (collateral * price36) / ORACLE_SCALE;
}

function healthFactor(collateral: bigint, price36: bigint | null, lltv: number, debt: bigint): number | null {
  if (debt === 0n || price36 === null) return null;
  return (Number(collateralValue(collateral, price36)) * lltv) / Number(debt);
}

export function shapePosition(i: PositionInput): PositionRow {
  const debt = toAssetsUp(i.borrowShares, i.totalBorrowAssets, i.totalBorrowShares);
  const venueHf = healthFactor(i.collateral, i.venuePrice36, i.lltv, debt);
  const shadowHf = healthFactor(i.collateral, i.shadowPrice36, i.lltv, debt);
  return {
    chainId: i.chainId,
    marketId: i.marketId,
    address: i.address,
    takenAt: i.takenAt,
    blockNumber: i.blockNumber,
    collateralSymbol: i.collateralSymbol,
    lltv: i.lltv,
    collateral: i.collateral.toString(),
    borrowShares: i.borrowShares.toString(),
    debtAssets: debt.toString(),
    venuePrice: i.venuePrice36 === null ? null : price36ToHuman(i.venuePrice36, 8, 6),
    shadowPrice: i.shadowPrice36 === null ? null : price36ToHuman(i.shadowPrice36, 8, 6),
    venueHf,
    shadowHf,
    protectionCase: venueHf !== null && shadowHf !== null && shadowHf < 1 && venueHf >= 1,
  };
}

function attempt<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * One aggregate3 call: market totals and oracle price per market, position per borrower. Rows with nothing
 * in them are dropped. Hand-encoded and hand-decoded (encoding.ts) for the same reason as the snapshot reader.
 */
export async function readPositions(
  call: EthCall,
  markets: readonly MarketRow[],
  borrowers: readonly Borrower[],
  shadowPrice36BySymbol: ReadonlyMap<string, bigint>,
  blockNumber: number,
  takenAt: number,
): Promise<PositionRow[]> {
  const byId = new Map(markets.map((m) => [m.id.toLowerCase(), m]));
  const active = borrowers.filter((b) => byId.has(b.marketId.toLowerCase()));
  if (active.length === 0) return [];
  const marketIds = [...new Set(active.map((b) => b.marketId.toLowerCase() as Hex))];
  const calls: Call[] = [
    ...marketIds.flatMap((id): Call[] => {
      const m = byId.get(id) as MarketRow;
      return [
        { target: MAINNET.morpho, callData: callData(SELECTOR.market, wordBytes32(id)) },
        { target: m.oracle, callData: SELECTOR.price },
      ];
    }),
    ...active.map((b): Call => ({ target: MAINNET.morpho, callData: callData(SELECTOR.position, wordBytes32(b.marketId.toLowerCase() as Hex), wordAddress(b.address)) })),
  ];
  const results = decodeAggregate3(await call(MULTICALL3, encodeAggregate3(calls)));
  const marketState = new Map<string, { totalBorrowAssets: bigint; totalBorrowShares: bigint; price36: bigint | null }>();
  marketIds.forEach((id, i) => {
    const mk = results[i * 2];
    const px = results[i * 2 + 1];
    const state = mk?.success ? attempt(() => decodeMarket(mk.data)) : null;
    marketState.set(id, {
      totalBorrowAssets: state?.totalBorrowAssets ?? 0n,
      totalBorrowShares: state?.totalBorrowShares ?? 0n,
      price36: px?.success ? attempt(() => decodeUint(px.data)) : null,
    });
  });
  const base = marketIds.length * 2;
  const rows: PositionRow[] = [];
  active.forEach((b, i) => {
    const r = results[base + i];
    const p = r?.success ? attempt(() => decodePosition(r.data)) : null;
    if (!p) return;
    if (p.borrowShares === 0n && p.collateral === 0n) return;
    const id = b.marketId.toLowerCase();
    const m = byId.get(id) as MarketRow;
    const st = marketState.get(id);
    if (!st) return;
    rows.push(
      shapePosition({
        chainId: b.chainId,
        marketId: id as Hex,
        address: b.address,
        collateralSymbol: m.collateral.symbol,
        lltv: m.lltv,
        collateral: p.collateral,
        borrowShares: p.borrowShares,
        totalBorrowAssets: st.totalBorrowAssets,
        totalBorrowShares: st.totalBorrowShares,
        venuePrice36: st.price36,
        shadowPrice36: shadowPrice36BySymbol.get(m.collateral.symbol) ?? null,
        blockNumber,
        takenAt,
      }),
    );
  });
  return rows;
}
