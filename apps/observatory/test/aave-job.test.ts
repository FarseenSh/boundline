import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { AAVE_CHAIN_ID, AAVE_SELECTOR, type AaveBorrowerRecord } from "../src/aave-positions.js";
import { runAavePositions, type Logger } from "../src/jobs.js";
import { buildSnapshot } from "../src/snapshot.js";
import { memoryStores } from "../src/stores.js";
import { ACCOUNT_WORDS, BORROWER, DEBT_USDC, LIVE_HF, META, SUPPLIED, fakeSpokeCall } from "./aave-fixtures.js";
import { NOW, calendar, pool, reads, token } from "./fixtures.js";

const quiet: Logger = { log: () => undefined, error: () => undefined };
const snapshot = buildSnapshot(reads([token()], [pool()]), calendar("WEEKEND"), NOW);

function borrower(i: number): AaveBorrowerRecord {
  const address = `0x${(i + 1).toString(16).padStart(40, "0")}` as Address;
  return { chainId: AAVE_CHAIN_ID, address, firstSeenBlock: 1, lastSeenBlock: 2, reserveIds: [7], source: "indexer", updatedAt: NOW };
}

describe("runAavePositions", () => {
  it("merges the indexer's borrowers, reads a rotating batch, stores rows and advances the offset", async () => {
    const stores = memoryStores();
    const list = [...Array.from({ length: 30 }, (_, i) => borrower(i)), { ...borrower(99), address: BORROWER }];
    const accounts = new Map([[BORROWER, { account: ACCOUNT_WORDS, debt: DEBT_USDC, supplied: SUPPLIED }]]);
    const deps = { store: stores.aave, call: fakeSpokeCall(accounts), meta: async () => META, borrowers: async () => list, snapshot, log: quiet };
    const first = await runAavePositions(deps);
    expect(first).toMatchObject({ known: 31, newBorrowers: 31, scanned: 25, nextOffset: 25, errors: [] });
    // the fixture borrower sorts last (0x84…) and is outside the first batch; every other address is empty
    expect(first.refreshed).toBe(0);
    const second = await runAavePositions(deps);
    expect(second).toMatchObject({ known: 31, newBorrowers: 0, scanned: 25, nextOffset: 19, refreshed: 1, protectionCases: 0 });
    const latest = await stores.aave.latestPositions(AAVE_CHAIN_ID);
    expect(latest).toHaveLength(1);
    expect(latest[0]?.address).toBe(BORROWER);
    expect(latest[0]?.venueHf).toBeCloseTo(LIVE_HF, 6);
    expect(latest[0]?.takenAt).toBe(NOW);
    expect(latest[0]?.blockNumber).toBe(snapshot.block);
    expect(await stores.aave.scanOffset(AAVE_CHAIN_ID)).toBe(19);
  });

  it("writes only what the indexer knows and D1 does not: nothing on a steady-state tick", async () => {
    const stores = memoryStores();
    let upserts = 0;
    const counting = { ...stores.aave, upsertBorrowers: async (l: readonly AaveBorrowerRecord[]) => (upserts += 1, stores.aave.upsertBorrowers(l)) };
    const list = [borrower(0), borrower(1)];
    const deps = { store: counting, call: fakeSpokeCall(new Map()), meta: async () => META, borrowers: async () => list, snapshot, log: quiet };
    expect((await runAavePositions(deps)).newBorrowers).toBe(2);
    expect(upserts).toBe(1);
    expect((await runAavePositions(deps)).newBorrowers).toBe(0);
    expect(upserts).toBe(1); // same list, same blocks: no batch sent
    const later = [{ ...borrower(0), lastSeenBlock: 50 }, borrower(1), borrower(2)];
    const r = await runAavePositions({ ...deps, borrowers: async () => later });
    expect(upserts).toBe(2);
    expect(r.newBorrowers).toBe(1); // borrower 2 is new; borrower 0 only advanced
    expect(r.known).toBe(3);
    expect((await stores.aave.borrowers(AAVE_CHAIN_ID)).find((b) => b.address === borrower(0).address)?.lastSeenBlock).toBe(50);
  });

  it("keeps reading the known list when the indexer fails, and records the error", async () => {
    const stores = memoryStores({ aaveBorrowers: [{ ...borrower(0), address: BORROWER }] });
    const accounts = new Map([[BORROWER, { account: ACCOUNT_WORDS, debt: DEBT_USDC, supplied: SUPPLIED }]]);
    const r = await runAavePositions({
      store: stores.aave,
      call: fakeSpokeCall(accounts),
      meta: async () => META,
      borrowers: async () => {
        throw new Error("indexer answered 503");
      },
      snapshot,
      log: quiet,
    });
    expect(r.errors).toEqual(["borrowers: indexer answered 503"]);
    expect(r).toMatchObject({ known: 1, scanned: 1, refreshed: 1, nextOffset: 0 });
  });

  it("records a read failure without touching the offset", async () => {
    const stores = memoryStores({ aaveBorrowers: [borrower(0)], aaveOffsets: [{ chainId: AAVE_CHAIN_ID, offset: 0 }] });
    const r = await runAavePositions({
      store: stores.aave,
      call: async () => {
        throw new Error("rpc down");
      },
      meta: async () => META,
      borrowers: async () => [],
      snapshot,
      log: quiet,
    });
    expect(r.errors).toEqual(["positions: rpc down"]);
    expect(await stores.aave.scanOffset(AAVE_CHAIN_ID)).toBe(0);
    expect(stores.state.aavePositions).toHaveLength(0);
  });

  it("does nothing with no borrowers at all", async () => {
    const stores = memoryStores();
    let calls = 0;
    const r = await runAavePositions({ store: stores.aave, call: fakeSpokeCall(new Map(), { onCall: () => (calls += 1) }), meta: async () => META, borrowers: async () => [], snapshot, log: quiet });
    expect(r).toMatchObject({ known: 0, scanned: 0, refreshed: 0, nextOffset: 0, errors: [] });
    expect(calls).toBe(0);
  });

  it("upserts borrowers: a later lastSeenBlock updates, an older one is ignored", async () => {
    const stores = memoryStores();
    expect(await stores.aave.upsertBorrowers([borrower(0)])).toBe(1);
    expect(await stores.aave.upsertBorrowers([{ ...borrower(0), lastSeenBlock: 9, reserveIds: [7, 0] }])).toBe(0);
    expect((await stores.aave.borrowers(AAVE_CHAIN_ID))[0]).toMatchObject({ lastSeenBlock: 9, reserveIds: [7, 0] });
    expect(await stores.aave.upsertBorrowers([{ ...borrower(0), lastSeenBlock: 3 }])).toBe(0);
    expect((await stores.aave.borrowers(AAVE_CHAIN_ID))[0]?.lastSeenBlock).toBe(9);
  });
});

describe("selectors the job depends on", () => {
  it("are the ones the fake answers", () => {
    expect(Object.keys(AAVE_SELECTOR)).toHaveLength(8);
  });
});
