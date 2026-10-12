import { describe, expect, it } from "vitest";
import { CAPTURE_AFTER_SECONDS, emptySummary } from "../src/capture.js";
import { MULTICALL3, SELECTOR, addressAt, decodeAggregate3Calldata, encodeAggregate3Result, wordUint } from "../src/encoding.js";
import { runCapture, runPositions, type Logger } from "../src/jobs.js";
import type { MarketRow } from "../src/morpho.js";
import { BORROW_TOPIC, POSITIONS_EVERY_SECONDS, SCAN_SPAN, type PositionsRpc } from "../src/positions.js";
import { buildSnapshot, type Snapshot } from "../src/snapshot.js";
import { d1Stores, memoryStores } from "../src/stores.js";
import { REOPEN, weekendCalendar } from "./capture.test.js";
import { sqliteD1 } from "./d1-sqlite.js";
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

  it("closes the run on the first tick after the window when no tick lands on its last second (the live 9-12 Oct runs)", async () => {
    const stores = memoryStores();
    const statuses: Array<{ at: number; status: string }> = [];
    // Ticks 38 s past each minute, like the live cron: the last tick inside the window is +5378 s, the next +5438 s.
    for (let at = REOPEN - 15 * 60 + 38; at <= REOPEN + CAPTURE_AFTER_SECONDS + 300; at += 60) {
      const r = await runCapture(stores.capture, cal, tick(at), quiet);
      statuses.push({ at: at - REOPEN, status: r.status });
      if (at === REOPEN + 5438) expect(r).toEqual({ status: "completed", transitionAt: REOPEN, phase: "after", ticks: 105 });
    }
    const run = stores.state.runs[0]!;
    expect(run.completedAt).toBe(REOPEN + CAPTURE_AFTER_SECONDS);
    expect(run.summary.ticks).toBe(105); // 15 before, 1 at, 89 after: the live runs' shape
    expect(stores.state.captures).toHaveLength(105);
    expect(Math.max(...stores.state.captures.map((r) => r.takenAt))).toBe(REOPEN + 5378); // nothing recorded after the window
    expect(statuses.filter((s) => s.at > 5378).map((s) => s.status)).toEqual(["completed", "idle", "idle", "idle", "idle"]);
  });

  it("closes runs a stopped cron left open on a later idle tick, newest reported, nothing recorded", async () => {
    const open = (transitionAt: number, kind: "reopen" | "close") => ({
      transitionAt,
      fromSession: kind === "reopen" ? ("WEEKEND" as const) : ("POST" as const),
      toSession: kind === "reopen" ? ("OVERNIGHT" as const) : ("WEEKEND" as const),
      kind,
      armedAt: transitionAt + 40,
      firstUpdateAt: kind === "reopen" ? transitionAt + 21 : null,
      completedAt: null,
      summary: { ...emptySummary(), ticks: 90, lastTickAt: transitionAt + 5378 },
    });
    const stores = memoryStores({ runs: [open(CLOSE, "close"), open(REOPEN, "reopen")] });
    const later = REOPEN + 26 * 3600; // Monday evening: outside every window
    expect(await runCapture(stores.capture, cal, tick(later), quiet)).toEqual({ status: "completed", transitionAt: REOPEN, phase: "after", ticks: 90 });
    expect(stores.state.runs.map((r) => [r.transitionAt, r.completedAt])).toEqual([
      [CLOSE, CLOSE + CAPTURE_AFTER_SECONDS],
      [REOPEN, REOPEN + CAPTURE_AFTER_SECONDS],
    ]);
    expect(stores.state.captures).toHaveLength(0);
    expect(await runCapture(stores.capture, cal, tick(later + 60), quiet)).toEqual({ status: "idle" });
  });

  it("does the same through the D1 statements (SQLite)", async () => {
    const s = sqliteD1();
    const store = d1Stores(s.db).capture;
    for (let at = REOPEN + 5378 - 120; at <= REOPEN + 5438; at += 60) await runCapture(store, cal, tick(at), quiet);
    const run = await store.getRun(REOPEN);
    expect(run).toMatchObject({ transitionAt: REOPEN, completedAt: REOPEN + CAPTURE_AFTER_SECONDS });
    expect(run?.summary.ticks).toBe(3);
    expect(await store.rowsFor(REOPEN)).toHaveLength(3);
    expect(await runCapture(store, cal, tick(REOPEN + 5498), quiet)).toEqual({ status: "idle" });
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

  const pad = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;

  function fakeRpc(logsByCall: Array<Array<{ id: string; onBehalf: string; block: number }>>, positions: Record<string, { borrowShares: bigint; collateral: bigint }>) {
    const calls: Array<{ fromBlock: number; toBlock: number }> = [];
    let multicalls = 0;
    const rpc: PositionsRpc = {
      async getLogs(f) {
        expect(f.topics[0]).toBe(BORROW_TOPIC);
        expect(f.topics[1]).toEqual([MARKET]);
        calls.push({ fromBlock: f.fromBlock, toBlock: f.toBlock });
        const batch = logsByCall.shift() ?? [];
        return batch.map((l) => ({
          address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const,
          topics: [BORROW_TOPIC, l.id as `0x${string}`, pad(l.onBehalf) as `0x${string}`, pad(l.onBehalf) as `0x${string}`],
          data: "0x" as const,
          blockNumber: `0x${l.block.toString(16)}` as `0x${string}`,
          transactionHash: "0x" as const,
          logIndex: "0x0" as const,
        }));
      },
      // One aggregate3 eth_call per refresh: answer by selector, like Multicall3 would.
      async call(to, data) {
        expect(to).toBe(MULTICALL3);
        multicalls += 1;
        const results = decodeAggregate3Calldata(data).map((c) => {
          const selector = c.callData.slice(0, 10);
          const body = c.callData.slice(10);
          if (selector === SELECTOR.market) return { success: true, data: [0n, 0n, 3_000_000_000n, 3_000n * 10n ** 12n, 0n, 0n].map(wordUint).join("") };
          if (selector === SELECTOR.price) return { success: true, data: wordUint(333_66495000n * 10n ** 26n) };
          const user = addressAt(body, 1);
          const p = positions[user];
          return p ? { success: true, data: [0n, p.borrowShares, p.collateral].map(wordUint).join("") } : { success: false, data: "" };
        });
        return encodeAggregate3Result(results);
      },
    };
    return { rpc, calls, multicalls: () => multicalls };
  }

  const apiBody = { data: { marketPositions: { items: [{ user: { address: A }, market: { marketId: MARKET }, state: { borrowShares: "1", collateral: "1" } }] } } };
  const fetchImpl = (async () => new Response(JSON.stringify(apiBody), { status: 200 })) as unknown as typeof fetch;

  it("seeds from the API on the first run, scans one span behind the head, and refreshes positions", async () => {
    const stores = memoryStores();
    const { rpc, calls, multicalls } = fakeRpc([[{ id: MARKET, onBehalf: B, block: 52199990 }]], {
      [A]: { borrowShares: 1_500n * 10n ** 12n, collateral: 10n * 10n ** 8n },
      [B]: { borrowShares: 0n, collateral: 0n },
    });
    const snapshot = tick(REOPEN);
    const r = await runPositions({ store: stores.positions, rpc, markets: [market], fetchImpl, snapshot, log: quiet });
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
    const { rpc, calls } = fakeRpc([[], []], {});
    const first = tick(REOPEN);
    await stores.positions.addPositions([]);
    const r1 = await runPositions({ store: stores.positions, rpc, markets: [market], fetchImpl, snapshot: first, log: quiet });
    expect(r1.seeded).toBe(0); // cursor exists and is inside the archive depth: no API call
    expect(r1.scanned).toEqual({ from: 52199001, to: first.block - 1 });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(r1.refreshed).toBe(0); // no borrowers yet, but the refresh ran (first ever)
    const r2 = await runPositions({ store: stores.positions, rpc, markets: [market], fetchImpl, snapshot: tick(REOPEN + 60), log: quiet });
    expect(r2.scanned?.from).toBe(first.block);
    expect(r2.refreshed).toBe(0); // nothing stored, so lastPositionsTakenAt is still null and it runs again
  });

  it("refreshes only every ten minutes once rows exist, and reseeds after an archive gap", async () => {
    const stores = memoryStores({ cursors: [{ chainId: 8453, marketId: MARKET, lastBlock: 52100000 }] });
    const { rpc } = fakeRpc([[], [], []], { [A]: { borrowShares: 1n, collateral: 10n ** 8n } });
    const s1 = tick(REOPEN);
    const r1 = await runPositions({ store: stores.positions, rpc, markets: [market], fetchImpl, snapshot: s1, log: quiet });
    expect(r1.skippedFrom).toBe(52100001);
    expect(r1.seeded).toBe(1);
    expect(r1.refreshed).toBe(1);
    const r2 = await runPositions({ store: stores.positions, rpc, markets: [market], fetchImpl, snapshot: tick(REOPEN + 60), log: quiet });
    expect(r2.refreshed).toBeNull();
    const r3 = await runPositions({ store: stores.positions, rpc, markets: [market], fetchImpl, snapshot: tick(REOPEN + POSITIONS_EVERY_SECONDS), log: quiet });
    expect(r3.refreshed).toBe(1);
  });

  it("survives a failing RPC and a failing API without throwing", async () => {
    const stores = memoryStores();
    const rpc: PositionsRpc = { getLogs: async () => { throw new Error("over rate limit"); }, call: async () => { throw new Error("over rate limit"); } };
    const badFetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const r = await runPositions({ store: stores.positions, rpc, markets: [market], fetchImpl: badFetch, snapshot: tick(REOPEN), log: quiet });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("scan:");
    expect(r.refreshed).toBe(0); // no borrowers, nothing to read, empty refresh recorded
  });
});
