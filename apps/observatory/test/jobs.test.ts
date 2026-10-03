import { describe, expect, it } from "vitest";
import { CAPTURE_AFTER_SECONDS } from "../src/capture.js";
import { runCapture, runPositions, type Logger } from "../src/jobs.js";
import type { MarketRow } from "../src/morpho.js";
import { POSITIONS_EVERY_SECONDS, SCAN_SPAN, type Client } from "../src/positions.js";
import { buildSnapshot, type Snapshot } from "../src/snapshot.js";
import { memoryStores } from "../src/stores.js";
import { REOPEN, weekendCalendar } from "./capture.test.js";
import { pool, reads, token } from "./fixtures.js";

const quiet: Logger = { log: () => undefined, error: () => undefined };
const CLOSE = REOPEN - 48 * 3600;
const cal = weekendCalendar();

function tick(at: number, overrides: Parameters<typeof token>[0] = {}): Snapshot {
  return buildSnapshot(
    { ...reads([token({ feedUpdatedAt: BigInt(CLOSE - 1), ...overrides })], [pool()]), blockNumber: 52200000n + BigInt(Math.floor((at - REOPEN) / 2)), blockTimestamp: at },
    cal,
    at,
  );
}

describe("runCapture", () => {
  it("is idle outside the window and writes nothing", async () => {
    const stores = memoryStores();
    expect(await runCapture(stores.capture, cal, tick(REOPEN - 3600), quiet)).toEqual({ status: "idle" });
    expect(stores.state.runs).toHaveLength(0);
    expect(stores.state.captures).toHaveLength(0);
  });

  it("arms 15 minutes before, records every tick, catches the first print, completes at 90 minutes", async () => {
    const stores = memoryStores();
    const printedAt = REOPEN + 190;
    let ticks = 0;
    for (let at = REOPEN - 15 * 60; at <= REOPEN + CAPTURE_AFTER_SECONDS + 120; at += 60) {
      const s = at >= REOPEN + 4 * 60 ? tick(at, { feedAnswer: 33500000000n, feedUpdatedAt: BigInt(printedAt), feedRoundId: 101n }) : tick(at);
      const r = await runCapture(stores.capture, cal, s, quiet);
      if (r.status !== "idle") ticks += 1;
      if (at === REOPEN - 15 * 60) expect(r).toMatchObject({ status: "recording", phase: "before", transitionAt: REOPEN });
      if (at === REOPEN) expect(r).toMatchObject({ status: "recording", phase: "at" });
    }
    const run = stores.state.runs[0]!;
    expect(stores.state.runs).toHaveLength(1);
    expect(run.armedAt).toBe(REOPEN - 15 * 60);
    expect(run.completedAt).toBe(REOPEN + CAPTURE_AFTER_SECONDS);
    expect(run.summary.ticks).toBe(15 + 90 + 1);
    expect(run.firstUpdateAt).toBe(printedAt);
    expect(run.summary.perToken["AAPLc"]).toMatchObject({ heldAnswer: "33366495000", first: { roundId: "101", lagSeconds: 190 } });
    expect(run.summary.perToken["AAPLc"]?.first?.gapBps).toBeCloseTo(40.01, 1);
    // rows: one per token per tick inside the window; the two ticks after completion add nothing
    expect(stores.state.captures).toHaveLength(106);
    expect(stores.state.captures.filter((r) => r.phase === "before")).toHaveLength(15);
    expect(stores.state.captures.filter((r) => r.phase === "at")).toHaveLength(1);
    expect(ticks).toBe(106); // the two ticks after the window are idle
  });

  it("joins a run late and takes the held print from the snapshot history", async () => {
    const stores = memoryStores({ prints: [{ symbol: "AAPLc", answer: "33366495000", updatedAt: CLOSE - 1, takenAt: CLOSE }] });
    const s = tick(REOPEN + 20 * 60, { feedAnswer: 33000000000n, feedUpdatedAt: BigInt(REOPEN + 150), feedRoundId: 101n });
    const r = await runCapture(stores.capture, cal, s, quiet);
    expect(r).toMatchObject({ status: "recording", phase: "after", transitionAt: REOPEN });
    const t = stores.state.runs[0]!.summary.perToken["AAPLc"]!;
    expect(t.heldAnswer).toBe("33366495000");
    expect(t.first?.gapBps).toBeCloseTo(-109.8, 0);
    expect(stores.state.runs[0]!.armedAt).toBe(REOPEN + 20 * 60);
  });
});

describe("runPositions", () => {
  const MARKET = "0xae1a30486234bf7e7ac166c7c03d9bc5f2cd8a39be2c48e73c665ac7148c3c28" as const;
  const market: MarketRow = {
    id: MARKET,
    collateral: { address: "0xb200000000000000000000C2e324d24d7eEcd1fb", symbol: "AAPLc" },
    loan: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC" },
    oracle: "0xEcC5c9bf18CB2CfC94C2f7EFf8BDd5837A60AB0e",
    irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    lltv: 0.625,
    listed: true,
    totalSupplyAssets: "0",
    totalBorrowAssets: "0",
    utilization: 0,
    oraclePrice36: null,
    oraclePriceUsd: null,
    idMatchesParams: true,
  };
  const A = "0x1111111111111111111111111111111111111111";
  const B = "0x2222222222222222222222222222222222222222";

  function fakeClient(logsByCall: Array<Array<{ id: string; onBehalf: string; block: number }>>, positions: Record<string, { borrowShares: bigint; collateral: bigint }>) {
    const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    let multicalls = 0;
    const client = {
      async getLogs(args: { fromBlock: bigint; toBlock: bigint }) {
        calls.push({ fromBlock: args.fromBlock, toBlock: args.toBlock });
        const batch = logsByCall.shift() ?? [];
        return batch.map((l) => ({ args: { id: l.id, onBehalf: l.onBehalf }, blockNumber: BigInt(l.block) }));
      },
      async multicall(args: { contracts: Array<{ functionName: string; args?: readonly unknown[] }> }) {
        multicalls += 1;
        return args.contracts.map((c) => {
          if (c.functionName === "market") return { status: "success", result: { totalSupplyAssets: 0n, totalSupplyShares: 0n, totalBorrowAssets: 3_000_000_000n, totalBorrowShares: 3_000n * 10n ** 12n, lastUpdate: 0n, fee: 0n } };
          if (c.functionName === "price") return { status: "success", result: 333_66495000n * 10n ** 26n };
          const user = (c.args?.[1] as string).toLowerCase();
          const p = positions[user];
          return p ? { status: "success", result: { supplyShares: 0n, borrowShares: p.borrowShares, collateral: p.collateral } } : { status: "failure", error: new Error("no position") };
        });
      },
    };
    return { client: client as unknown as Client, calls, multicalls: () => multicalls };
  }

  const apiBody = { data: { marketPositions: { items: [{ user: { address: A }, market: { marketId: MARKET }, state: { borrowShares: "1", collateral: "1" } }] } } };
  const fetchImpl = (async () => new Response(JSON.stringify(apiBody), { status: 200 })) as unknown as typeof fetch;

  it("seeds from the API on the first run, scans one span behind the head, and refreshes positions", async () => {
    const stores = memoryStores();
    const { client, calls, multicalls } = fakeClient([[{ id: MARKET, onBehalf: B, block: 52199990 }]], {
      [A]: { borrowShares: 1_500n * 10n ** 12n, collateral: 10n * 10n ** 8n },
      [B]: { borrowShares: 0n, collateral: 0n },
    });
    const snapshot = tick(REOPEN);
    const r = await runPositions({ store: stores.positions, client, markets: [market], fetchImpl, snapshot, log: quiet });
    expect(r.errors).toEqual([]);
    expect(r.seeded).toBe(1);
    expect(r.newBorrowers).toBe(1);
    expect(r.scanned).toEqual({ from: snapshot.block - SCAN_SPAN, to: snapshot.block - 1 });
    expect(calls).toHaveLength(1);
    expect(await stores.positions.cursor(8453)).toBe(snapshot.block - 1);
    expect(stores.state.borrowers.map((b) => b.address)).toEqual([A, B]);
    // B has an empty position and is dropped; A is priced at the venue and the DEX TWAP
    expect(r.refreshed).toBe(1);
    const rows = await stores.positions.latestPositions(8453);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ address: A, collateralSymbol: "AAPLc", debtAssets: "1500000000" });
    expect(rows[0]?.venueHf).toBeCloseTo(1.39, 2);
    expect(rows[0]?.shadowHf).not.toBeNull();
    expect(multicalls()).toBe(1);
  });

  it("advances the cursor by the bounded range and skips the position refresh inside 10 minutes", async () => {
    const stores = memoryStores({ cursors: [{ chainId: 8453, marketId: MARKET, lastBlock: 52199000 }], positions: [], borrowers: [] });
    const { client, calls } = fakeClient([[], []], {});
    const first = tick(REOPEN);
    await stores.positions.addPositions([]);
    const r1 = await runPositions({ store: stores.positions, client, markets: [market], fetchImpl, snapshot: first, log: quiet });
    expect(r1.seeded).toBe(0); // cursor exists and is inside the archive depth: no API call
    expect(r1.scanned).toEqual({ from: 52199001, to: first.block - 1 });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(r1.refreshed).toBe(0); // no borrowers yet, but the refresh ran (first ever)
    const r2 = await runPositions({ store: stores.positions, client, markets: [market], fetchImpl, snapshot: tick(REOPEN + 60), log: quiet });
    expect(r2.scanned?.from).toBe(first.block);
    expect(r2.refreshed).toBe(0); // nothing stored, so lastPositionsTakenAt is still null and it runs again
  });

  it("refreshes only every ten minutes once rows exist, and reseeds after an archive gap", async () => {
    const stores = memoryStores({ cursors: [{ chainId: 8453, marketId: MARKET, lastBlock: 52100000 }] });
    const { client } = fakeClient([[], [], []], { [A]: { borrowShares: 1n, collateral: 10n ** 8n } });
    const s1 = tick(REOPEN);
    const r1 = await runPositions({ store: stores.positions, client, markets: [market], fetchImpl, snapshot: s1, log: quiet });
    expect(r1.skippedFrom).toBe(52100001);
    expect(r1.seeded).toBe(1);
    expect(r1.refreshed).toBe(1);
    const r2 = await runPositions({ store: stores.positions, client, markets: [market], fetchImpl, snapshot: tick(REOPEN + 60), log: quiet });
    expect(r2.refreshed).toBeNull();
    const r3 = await runPositions({ store: stores.positions, client, markets: [market], fetchImpl, snapshot: tick(REOPEN + POSITIONS_EVERY_SECONDS), log: quiet });
    expect(r3.refreshed).toBe(1);
  });

  it("survives a failing RPC and a failing API without throwing", async () => {
    const stores = memoryStores();
    const client = { getLogs: async () => { throw new Error("over rate limit"); }, multicall: async () => { throw new Error("over rate limit"); } } as unknown as Client;
    const badFetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const r = await runPositions({ store: stores.positions, client, markets: [market], fetchImpl: badFetch, snapshot: tick(REOPEN), log: quiet });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("scan:");
    expect(r.refreshed).toBe(0); // no borrowers, nothing to read, empty refresh recorded
  });
});
