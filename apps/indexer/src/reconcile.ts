import type { Address, Hex } from "viem";
import type { RawRpc } from "./rpc.js";
import type { EventRow } from "./decode.js";
import type { ReconciliationRow, Store } from "./store.js";

export interface PositionState {
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
}

export interface MarketTotals {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
}

export interface Replay {
  positions: Map<string, PositionState>;
  totals: MarketTotals;
  /** Fee shares minted to Morpho's fee recipient (unknown from events); non-zero only when the market has a fee. */
  feeShares: bigint;
  lastBlock: number;
  eventCount: number;
}

const ZERO: PositionState = { supplyShares: 0n, borrowShares: 0n, collateral: 0n };

function big(v: unknown): bigint {
  return typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? BigInt(v) : 0n;
}

/**
 * Replays this market's Morpho events (oldest first) into per-address positions and market totals, exactly
 * as Morpho's storage moves: shares and collateral are exact; assets move by the amounts the events carry,
 * including `AccrueInterest`, so totals match `market(id)` whenever every event is present.
 */
export function replayMarket(rows: readonly EventRow[], marketId: Hex): Replay {
  const id = marketId.toLowerCase();
  const positions = new Map<string, PositionState>();
  const totals: MarketTotals = { totalSupplyAssets: 0n, totalSupplyShares: 0n, totalBorrowAssets: 0n, totalBorrowShares: 0n };
  let feeShares = 0n;
  let lastBlock = 0;
  let eventCount = 0;
  const at = (addr: string): PositionState => {
    const k = addr.toLowerCase();
    const p = positions.get(k) ?? { ...ZERO };
    positions.set(k, p);
    return p;
  };
  const sorted = [...rows].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  for (const row of sorted) {
    const args = JSON.parse(row.argsJson) as Record<string, unknown>;
    if (typeof args.id !== "string" || args.id.toLowerCase() !== id) continue;
    eventCount += 1;
    lastBlock = Math.max(lastBlock, row.blockNumber);
    switch (row.name) {
      case "Supply": {
        at(String(args.onBehalf)).supplyShares += big(args.shares);
        totals.totalSupplyAssets += big(args.assets);
        totals.totalSupplyShares += big(args.shares);
        break;
      }
      case "Withdraw": {
        at(String(args.onBehalf)).supplyShares -= big(args.shares);
        totals.totalSupplyAssets -= big(args.assets);
        totals.totalSupplyShares -= big(args.shares);
        break;
      }
      case "SupplyCollateral": {
        at(String(args.onBehalf)).collateral += big(args.assets);
        break;
      }
      case "WithdrawCollateral": {
        at(String(args.onBehalf)).collateral -= big(args.assets);
        break;
      }
      case "Borrow": {
        at(String(args.onBehalf)).borrowShares += big(args.shares);
        totals.totalBorrowAssets += big(args.assets);
        totals.totalBorrowShares += big(args.shares);
        break;
      }
      case "Repay": {
        at(String(args.onBehalf)).borrowShares -= big(args.shares);
        totals.totalBorrowAssets -= big(args.assets);
        totals.totalBorrowShares -= big(args.shares);
        break;
      }
      case "Liquidate": {
        const p = at(String(args.borrower));
        p.borrowShares -= big(args.repaidShares);
        p.collateral -= big(args.seizedAssets);
        totals.totalBorrowAssets -= big(args.repaidAssets);
        totals.totalBorrowShares -= big(args.repaidShares);
        // Bad debt: Morpho zeroes the borrower's remaining shares and socialises the assets across suppliers.
        p.borrowShares -= big(args.badDebtShares);
        totals.totalBorrowShares -= big(args.badDebtShares);
        totals.totalBorrowAssets -= big(args.badDebtAssets);
        totals.totalSupplyAssets -= big(args.badDebtAssets);
        break;
      }
      case "AccrueInterest": {
        totals.totalBorrowAssets += big(args.interest);
        totals.totalSupplyAssets += big(args.interest);
        totals.totalSupplyShares += big(args.feeShares);
        feeShares += big(args.feeShares);
        break;
      }
      default:
        break; // CreateMarket and anything else move no balances
    }
  }
  return { positions, totals, feeShares, lastBlock, eventCount };
}

export function positionJson(p: PositionState): string {
  return JSON.stringify({ supplyShares: p.supplyShares.toString(), borrowShares: p.borrowShares.toString(), collateral: p.collateral.toString() });
}

export function totalsJson(t: MarketTotals): string {
  return JSON.stringify({
    totalSupplyAssets: t.totalSupplyAssets.toString(),
    totalSupplyShares: t.totalSupplyShares.toString(),
    totalBorrowAssets: t.totalBorrowAssets.toString(),
    totalBorrowShares: t.totalBorrowShares.toString(),
  });
}

/** Live reads the reconciliation compares against; `rawChainReader` is the real one. */
export interface ChainReader {
  position(morpho: Address, marketId: Hex, user: Address, blockNumber: number | null): Promise<PositionState>;
  market(morpho: Address, marketId: Hex, blockNumber: number | null): Promise<MarketTotals>;
}

// Morpho Blue `market(bytes32)` and `position(bytes32,address)` (morpho-blue v1.0.0), encoded by hand: the reads are two
// fixed shapes, and viem's readContract runs its multicall batcher, which cost ~17 ms warm / ~90 ms cold in the
// Observatory on 6 Oct 2026, over the Free plan's 10 ms.
const MARKET_SELECTOR = "5c60e39a";
const POSITION_SELECTOR = "93c52062";

function words(result: Hex, count: number): bigint[] {
  const body = result.startsWith("0x") ? result.slice(2) : result;
  if (body.length < count * 64) throw new Error(`short eth_call answer: ${body.length / 2} bytes, want ${count * 32}`);
  return Array.from({ length: count }, (_, i) => BigInt(`0x${body.slice(i * 64, i * 64 + 64)}`));
}

function id32(marketId: Hex): string {
  const body = marketId.slice(2).toLowerCase();
  if (body.length !== 64) throw new Error(`market id must be bytes32: ${marketId}`);
  return body;
}

export function marketCalldata(marketId: Hex): Hex {
  return `0x${MARKET_SELECTOR}${id32(marketId)}`;
}

export function positionCalldata(marketId: Hex, user: Address): Hex {
  return `0x${POSITION_SELECTOR}${id32(marketId)}${user.slice(2).toLowerCase().padStart(64, "0")}`;
}

/** The ChainReader over a raw JSON-RPC client: `eth_call` at the pinned block, or `latest` when it is null. */
export function rawChainReader(rpc: RawRpc): ChainReader {
  const tag = (n: number | null) => (n === null ? "latest" : `0x${n.toString(16)}`);
  return {
    async position(morpho, marketId, user, blockNumber) {
      const r = await rpc.call<Hex>("eth_call", [{ to: morpho, data: positionCalldata(marketId, user) }, tag(blockNumber)]);
      const [supplyShares, borrowShares, collateral] = words(r, 3) as [bigint, bigint, bigint];
      return { supplyShares, borrowShares, collateral };
    },
    async market(morpho, marketId, blockNumber) {
      const r = await rpc.call<Hex>("eth_call", [{ to: morpho, data: marketCalldata(marketId) }, tag(blockNumber)]);
      const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares] = words(r, 6) as [bigint, bigint, bigint, bigint];
      return { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares };
    },
  };
}

export interface MarketToReconcile {
  chainId: number;
  morpho: Address;
  marketId: Hex;
}

export interface ReconcileOutcome {
  rows: ReconciliationRow[];
  blockNumber: number;
  /** True when the pinned-block read failed and the comparison used the latest state instead. */
  usedLatest: boolean;
}

/**
 * Replays the stored events of one market and compares every seen address and the totals with live reads at the
 * replay's last block (falling back to the latest state when the RPC cannot serve that block).
 */
export async function reconcileMarket(store: Store, reader: ChainReader, m: MarketToReconcile, now: number): Promise<ReconcileOutcome> {
  const rows = await store.eventsOfAddress(m.chainId, m.morpho);
  const replay = replayMarket(rows, m.marketId);
  const subjectMarket = `market:${m.marketId}`;
  if (replay.eventCount === 0) {
    const skip: ReconciliationRow = {
      chainId: m.chainId,
      subject: subjectMarket,
      checkedAt: now,
      blockNumber: 0,
      expectedJson: "{}",
      actualJson: "{}",
      status: "SKIP",
    };
    await store.insertReconciliations([skip]);
    return { rows: [skip], blockNumber: 0, usedLatest: false };
  }
  let pinned: number | null = replay.lastBlock;
  let usedLatest = false;
  let actualTotals: MarketTotals;
  try {
    actualTotals = await reader.market(m.morpho, m.marketId, pinned);
  } catch {
    pinned = null;
    usedLatest = true;
    actualTotals = await reader.market(m.morpho, m.marketId, null);
  }
  const out: ReconciliationRow[] = [];
  const expectedTotals = totalsJson(replay.totals);
  const actualTotalsJson = totalsJson(actualTotals);
  out.push({
    chainId: m.chainId,
    subject: subjectMarket,
    checkedAt: now,
    blockNumber: pinned ?? 0,
    expectedJson: expectedTotals,
    actualJson: actualTotalsJson,
    status: expectedTotals === actualTotalsJson ? "PASS" : "FAIL",
  });
  for (const [user, expected] of replay.positions) {
    const actual = await reader.position(m.morpho, m.marketId, user as Address, pinned);
    const e = positionJson(expected);
    const a = positionJson(actual);
    out.push({
      chainId: m.chainId,
      subject: `position:${m.marketId}:${user}`,
      checkedAt: now,
      blockNumber: pinned ?? 0,
      expectedJson: e,
      actualJson: a,
      status: e === a ? "PASS" : "FAIL",
    });
  }
  await store.insertReconciliations(out);
  return { rows: out, blockNumber: pinned ?? 0, usedLatest };
}
