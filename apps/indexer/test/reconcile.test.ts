import { describe, expect, it } from "vitest";
import { positionJson, reconcileMarket, replayMarket, totalsJson, type ChainReader, type MarketTotals, type PositionState } from "../src/reconcile.js";
import { MemoryStore } from "../src/store-memory.js";
import { BORROWER, CHAIN, DEPLOYER, MARKET, MORPHO, row, txHash } from "./fixtures.js";

const OTHER = "0x1111111111111111111111111111111111111111111111111111111111111111";

function ev(name: string, args: Record<string, unknown>, blockNumber: number, logIndex: number) {
  return row({ name, argsJson: JSON.stringify({ id: MARKET, ...args }), blockNumber, logIndex, txHash: txHash(blockNumber * 10 + logIndex) });
}

const sequence = [
  ev("CreateMarket", { marketParams: {} }, 100, 0),
  ev("Supply", { caller: DEPLOYER, onBehalf: DEPLOYER, assets: "10000000", shares: "10000000000000" }, 110, 1),
  ev("SupplyCollateral", { caller: BORROWER, onBehalf: BORROWER, assets: "1000000000" }, 120, 0),
  ev("AccrueInterest", { prevBorrowRate: "0", interest: "0", feeShares: "0" }, 130, 0),
  ev("Borrow", { caller: BORROWER, onBehalf: BORROWER, receiver: BORROWER, assets: "1000000", shares: "1000000000000" }, 130, 1),
  ev("AccrueInterest", { prevBorrowRate: "1", interest: "500", feeShares: "0" }, 140, 0),
  ev("Repay", { caller: BORROWER, onBehalf: BORROWER, assets: "400000", shares: "399800079968" }, 140, 1),
  ev("WithdrawCollateral", { caller: BORROWER, onBehalf: BORROWER, receiver: BORROWER, assets: "100000000" }, 150, 0),
  // an event of another market must be ignored
  row({ name: "Borrow", argsJson: JSON.stringify({ id: OTHER, caller: BORROWER, onBehalf: BORROWER, receiver: BORROWER, assets: "5", shares: "5" }), blockNumber: 151, logIndex: 0, txHash: txHash(9999) }),
];

describe("replayMarket", () => {
  it("replays shares, collateral and totals in block order whatever the input order", () => {
    const r = replayMarket([...sequence].reverse(), MARKET);
    expect(r.eventCount).toBe(8);
    expect(r.lastBlock).toBe(150);
    expect(r.positions.get(DEPLOYER)).toEqual({ supplyShares: 10_000_000_000_000n, borrowShares: 0n, collateral: 0n });
    expect(r.positions.get(BORROWER)).toEqual({ supplyShares: 0n, borrowShares: 1_000_000_000_000n - 399_800_079_968n, collateral: 900_000_000n });
    expect(r.totals).toEqual({
      totalSupplyAssets: 10_000_500n,
      totalSupplyShares: 10_000_000_000_000n,
      totalBorrowAssets: 600_500n,
      totalBorrowShares: 600_199_920_032n,
    });
    expect(r.feeShares).toBe(0n);
  });
  it("applies a liquidation with bad debt", () => {
    const r = replayMarket(
      [
        ev("Supply", { caller: DEPLOYER, onBehalf: DEPLOYER, assets: "1000", shares: "1000000" }, 1, 0),
        ev("SupplyCollateral", { caller: BORROWER, onBehalf: BORROWER, assets: "50" }, 2, 0),
        ev("Borrow", { caller: BORROWER, onBehalf: BORROWER, receiver: BORROWER, assets: "600", shares: "600000" }, 3, 0),
        ev("Liquidate", { caller: DEPLOYER, borrower: BORROWER, repaidAssets: "400", repaidShares: "400000", seizedAssets: "50", badDebtAssets: "200", badDebtShares: "200000" }, 4, 0),
      ],
      MARKET,
    );
    expect(r.positions.get(BORROWER)).toEqual({ supplyShares: 0n, borrowShares: 0n, collateral: 0n });
    expect(r.totals).toEqual({ totalSupplyAssets: 800n, totalSupplyShares: 1_000_000n, totalBorrowAssets: 0n, totalBorrowShares: 0n });
  });
});

function reader(positions: Record<string, PositionState>, totals: MarketTotals, failPinned = false): ChainReader {
  return {
    async position(_m, _id, user, block) {
      if (failPinned && block !== null) throw new Error("missing trie node");
      return positions[user.toLowerCase()] ?? { supplyShares: 0n, borrowShares: 0n, collateral: 0n };
    },
    async market(_m, _id, block) {
      if (failPinned && block !== null) throw new Error("missing trie node");
      return totals;
    },
  };
}

describe("reconcileMarket", () => {
  const expectedTotals = { totalSupplyAssets: 10_000_500n, totalSupplyShares: 10_000_000_000_000n, totalBorrowAssets: 600_500n, totalBorrowShares: 600_199_920_032n };
  const expectedPositions: Record<string, PositionState> = {
    [DEPLOYER]: { supplyShares: 10_000_000_000_000n, borrowShares: 0n, collateral: 0n },
    [BORROWER]: { supplyShares: 0n, borrowShares: 600_199_920_032n, collateral: 900_000_000n },
  };

  it("passes when the chain agrees, pinned at the replay's last block", async () => {
    const store = new MemoryStore();
    await store.insertEvents(sequence);
    const out = await reconcileMarket(store, reader(expectedPositions, expectedTotals), { chainId: CHAIN, morpho: MORPHO, marketId: MARKET }, 1_791_050_000);
    expect(out.blockNumber).toBe(150);
    expect(out.usedLatest).toBe(false);
    expect(out.rows.map((r) => r.status)).toEqual(["PASS", "PASS", "PASS"]);
    expect(out.rows[0]?.subject).toBe(`market:${MARKET}`);
    expect(out.rows[0]?.expectedJson).toBe(totalsJson(expectedTotals));
    const latest = await store.latestReconciliations(CHAIN);
    expect(latest).toHaveLength(3);
    expect(latest.every((r) => r.checkedAt === 1_791_050_000)).toBe(true);
  });
  it("fails the subject that drifted and keeps the others passing", async () => {
    const store = new MemoryStore();
    await store.insertEvents(sequence);
    const drifted: Record<string, PositionState> = { ...expectedPositions, [BORROWER]: { supplyShares: 0n, borrowShares: 600_199_920_032n, collateral: 1n } };
    const out = await reconcileMarket(store, reader(drifted, expectedTotals), { chainId: CHAIN, morpho: MORPHO, marketId: MARKET }, 5);
    const byStatus = Object.fromEntries(out.rows.map((r) => [r.subject, r.status]));
    expect(byStatus[`position:${MARKET}:${BORROWER}`]).toBe("FAIL");
    expect(byStatus[`position:${MARKET}:${DEPLOYER}`]).toBe("PASS");
    expect(out.rows.find((r) => r.status === "FAIL")?.actualJson).toBe(positionJson(drifted[BORROWER] as PositionState));
  });
  it("falls back to the latest state when the pinned block cannot be read", async () => {
    const store = new MemoryStore();
    await store.insertEvents(sequence);
    const out = await reconcileMarket(store, reader(expectedPositions, expectedTotals, true), { chainId: CHAIN, morpho: MORPHO, marketId: MARKET }, 6);
    expect(out.usedLatest).toBe(true);
    expect(out.blockNumber).toBe(0);
    expect(out.rows.every((r) => r.status === "PASS")).toBe(true);
  });
  it("records SKIP when the market has no events yet", async () => {
    const store = new MemoryStore();
    const out = await reconcileMarket(store, reader({}, expectedTotals), { chainId: CHAIN, morpho: MORPHO, marketId: MARKET }, 7);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.status).toBe("SKIP");
  });
});
