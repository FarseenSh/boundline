import { getAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { AavePositionRow } from "../src/aave-positions.js";
import { liveCalendar } from "../src/calendar-impl.js";
import { appendSnapshot } from "../src/d1.js";
import type { PositionRow } from "../src/positions.js";
import { buildSnapshot } from "../src/snapshot.js";
import { LATEST_POSITIONS_WINDOW_SECONDS, d1Stores, memoryStores } from "../src/stores.js";
import { sqliteD1, type SqliteD1 } from "./d1-sqlite.js";
import { reads, token } from "./fixtures.js";

const T = 1791800000;
const W = LATEST_POSITIONS_WINDOW_SECONDS;
const M1 = "0xae1a30486234bf7e7ac166c7c03d9bc5f2cd8a39be2c48e73c665ac7148c3c28" as Hex;
const M2 = "0xb4b4c9f8a2c3fa6d2f6f43b4e0be8bb1c5d1a1d7ff0e6a3a4bd4c0b4d5e63d13" as Hex;
const A = "0xaaaa00000000000000000000000000000000aaaa" as Address; // stored lowercase (Borrow-log scan)
const B = getAddress("0xbbbb00000000000000000000000000000000bbbb"); // stored checksummed (Morpho's API)
const C = "0xcccc00000000000000000000000000000000cccc" as Address;

function pos(marketId: Hex, address: Address, takenAt: number, over: Partial<PositionRow> = {}): PositionRow {
  return {
    chainId: 8453,
    marketId,
    address,
    takenAt,
    blockNumber: 52_500_000 + (takenAt - T),
    collateralSymbol: "AAPLc",
    lltv: 0.625,
    collateral: "1000000000",
    borrowShares: "1500000000000000",
    debtAssets: "1500000001",
    venuePrice: 333.66,
    shadowPrice: 330,
    venueHf: 1.39,
    shadowHf: 1.37,
    protectionCase: false,
    ...over,
  };
}

/** Refreshes every 15 minutes from `from` to `to` inclusive, like the positions job. */
function refreshes(marketId: Hex, address: Address, from: number, to: number, over: Partial<PositionRow> = {}): PositionRow[] {
  const out: PositionRow[] = [];
  for (let t = from; t <= to; t += 900) out.push(pos(marketId, address, t, over));
  return out;
}

const morphoRows: PositionRow[] = [
  ...refreshes(M1, A, T - 8 * 3600, T, { shadowHf: 1.2 }),
  ...refreshes(M2, A, T - 8 * 3600, T, { shadowHf: 0.95, protectionCase: true }),
  ...refreshes(M1, B, T - 8 * 3600, T - W, { shadowHf: null, shadowPrice: null }), // last row exactly at the window's start
  ...refreshes(M2, C, T - 8 * 3600, T - W - 900), // closed: last row before the window
  pos(M2, C, T - W - 1),
];

function aave(address: Address, takenAt: number, over: Partial<AavePositionRow> = {}): AavePositionRow {
  return {
    chainId: 8453,
    venue: "aave",
    spoke: "0x17905Db0e4A3514467539956c084180616AE7B8D",
    address,
    takenAt,
    blockNumber: 52_500_000 + (takenAt - T),
    debtUsdc: "3099171323",
    debtValueUsd: 3098.7,
    collateralValueUsd: 7159.39,
    shadowCollateralValueUsd: 6000,
    shadowCoverage: 0.13,
    collateral: [{ reserveId: 5, symbol: "NVDAc", raw: "420066094", amount: 4.20066094, collateralFactor: 0.7, venuePrice: 238.15, shadowPrice: 120, venueValueUsd: 1000.4, shadowValueUsd: 504 }],
    venueHf: 1.6809,
    modelHf: 1.6809,
    shadowHf: 1.5,
    protectionCase: false,
    riskPremiumBps: 0,
    avgCollateralFactor: 0.7275,
    ...over,
  };
}

/** The Aave batch: 25 borrowers a tick every five minutes, so with 31 known each borrower is read every ten minutes. */
function aaveRefreshes(address: Address, from: number, to: number, over: Partial<AavePositionRow> = {}): AavePositionRow[] {
  const out: AavePositionRow[] = [];
  for (let t = from; t <= to; t += 600) out.push(aave(address, t, over));
  return out;
}

const X = "0x1111000000000000000000000000000000001111" as Address;
const Y = "0x2222000000000000000000000000000000002222" as Address;
const Z = "0x3333000000000000000000000000000000003333" as Address;
const aaveRows: AavePositionRow[] = [
  ...aaveRefreshes(X, T - 6 * 3600, T, { shadowHf: 1.01, protectionCase: true }),
  ...aaveRefreshes(Y, T - 6 * 3600, T - W, { shadowHf: 2.1 }),
  ...aaveRefreshes(Z, T - 6 * 3600, T - W - 600),
];

function lastExecuted(s: SqliteD1, fragment: string) {
  const hit = [...s.executed].reverse().find((e) => e.sql.includes(fragment));
  if (!hit) throw new Error(`no statement containing ${fragment}`);
  return hit;
}

describe("d1Stores on SQLite with every migration: positions read inside the window", () => {
  it("returns the latest row per (market, address) written in the last two hours, in the memory store's order", async () => {
    const s = sqliteD1();
    const d1 = d1Stores(s.db);
    await d1.positions.addPositions(morphoRows);
    const mem = memoryStores({ positions: morphoRows });
    const got = await d1.positions.latestPositions(8453);
    expect(got.map((p) => `${p.marketId}:${p.address}:${p.takenAt}`)).toEqual([`${M2}:${A}:${T}`, `${M1}:${A}:${T}`, `${M1}:${B}:${T - W}`]);
    expect(got).toEqual(await mem.positions.latestPositions(8453));
    expect(await d1.positions.lastPositionsTakenAt(8453)).toBe(T);
    expect(await d1.positions.latestPositions(1)).toEqual([]);
  });

  it("reads a range of the (chain_id, taken_at) index, never the whole history", async () => {
    const s = sqliteD1();
    const d1 = d1Stores(s.db);
    await d1.positions.addPositions(morphoRows);
    await d1.positions.latestPositions(8453);
    const latest = lastExecuted(s, "FROM positions p");
    const range = (d: string) => /SEARCH p USING INDEX positions_chain_taken \(chain_id=\? AND taken_at>\?\)/.test(d);
    expect(s.plan(latest).some(range)).toBe(true);
    expect(s.plan(latest).some((d) => /sqlite_autoindex_positions_1 \(chain_id=\? AND market_id=\? AND address=\? AND taken_at>\?\)/.test(d))).toBe(true); // the newer-row probe
    s.raw.exec("ANALYZE"); // D1 may hold planner statistics; a GROUP BY form fell back to the full primary key under them
    expect(s.plan(latest).some(range)).toBe(true);
    await d1.positions.lastPositionsTakenAt(8453);
    const newest = s.plan(lastExecuted(s, "SELECT taken_at AS t FROM positions"));
    expect(newest).toEqual(["SEARCH positions USING COVERING INDEX positions_chain_taken (chain_id=?)"]);
  });

  it("finds an address under either spelling through the (address, taken_at) index, history beyond the window included", async () => {
    const s = sqliteD1();
    const d1 = d1Stores(s.db);
    await d1.positions.addPositions(morphoRows);
    const forB = await d1.positions.positionsForAddress("0xBBBB00000000000000000000000000000000BBBB" as Address);
    expect(forB.length).toBe(25); // T-8h .. T-2h every 15 minutes
    expect(forB[0]?.takenAt).toBe(T - W);
    const forA = await d1.positions.positionsForAddress(getAddress(A));
    expect(forA).toHaveLength(50);
    expect(forA[0]).toMatchObject({ takenAt: T, marketId: M1 }); // ties on taken_at by market id
    expect(forA[1]).toMatchObject({ takenAt: T, marketId: M2 });
    const plan = s.plan(lastExecuted(s, "WHERE address IN"));
    expect(plan.some((d) => /USING INDEX positions_address \(address=\?\)/.test(d))).toBe(true);
    expect(await memoryStores({ positions: morphoRows }).positions.positionsForAddress(getAddress(A))).toHaveLength(50);
  });

  it("keeps the Aave view to the window too: latest row per borrower, protection cases first", async () => {
    const s = sqliteD1();
    const d1 = d1Stores(s.db);
    await d1.aave.addPositions(aaveRows);
    const got = await d1.aave.latestPositions(8453);
    expect(got.map((p) => `${p.address}:${p.takenAt}`)).toEqual([`${X}:${T}`, `${Y}:${T - W}`]);
    expect(got).toEqual(await memoryStores({ aavePositions: aaveRows }).aave.latestPositions(8453));
    const latest = lastExecuted(s, "FROM aave_positions p");
    const range = (d: string) => /SEARCH p USING INDEX aave_positions_chain_taken \(chain_id=\? AND taken_at>\?\)/.test(d);
    expect(s.plan(latest).some(range)).toBe(true);
    s.raw.exec("ANALYZE");
    expect(s.plan(latest).some(range)).toBe(true);
  });

  it("answers the held print from one entry of (symbol, feed_updated_at, taken_at), never sorting a weekend of snapshots", async () => {
    const s = sqliteD1();
    const d1 = d1Stores(s.db);
    const cal = liveCalendar;
    const held = T - 50 * 3600;
    for (let at = held + 60; at < T; at += 3600) await appendSnapshot(s.db, buildSnapshot(reads([token({ feedUpdatedAt: BigInt(held), feedAnswer: 33366495000n })], []), cal, at));
    await appendSnapshot(s.db, buildSnapshot(reads([token({ feedUpdatedAt: BigInt(T + 30), feedAnswer: 33500000000n })], []), cal, T + 60));
    expect(await d1.capture.lastHeldPrint("AAPLc", T)).toEqual({ answer: "33366495000", updatedAt: held });
    expect(await d1.capture.lastHeldPrint("AAPLc", held - 1)).toBeNull();
    const plan = s.plan(lastExecuted(s, "FROM snapshots"));
    expect(plan).toEqual(["SEARCH snapshots USING INDEX snapshots_symbol_updated (symbol=? AND feed_updated_at<?)"]);
  });

  it("before migration 0004 the same statements were full-history reads (the regression this guards)", async () => {
    const s = sqliteD1("0003");
    const d1 = d1Stores(s.db);
    await d1.positions.addPositions(morphoRows);
    await d1.positions.lastPositionsTakenAt(8453);
    const newest = s.plan(lastExecuted(s, "SELECT taken_at AS t FROM positions"));
    expect(newest.join(" ")).toMatch(/USE TEMP B-TREE FOR ORDER BY/);
    expect(await d1.positions.latestPositions(8453)).toHaveLength(3); // same answer, just the slow way
  });
});
