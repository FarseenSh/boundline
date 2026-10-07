import { encodeAbiParameters, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import {
  AAVE_BATCH_PER_TICK,
  AAVE_SELECTOR,
  AAVE_SPOKE,
  KV_AAVE_META,
  USER_STRIDE,
  cachedAaveMeta,
  decodeAccountData,
  parseIndexerBorrowers,
  planPositions,
  readAaveMeta,
  readAavePositions,
  rotate,
  shadowUsdFromSnapshot,
  shapeAavePosition,
  type AaveMeta,
} from "../src/aave-positions.js";
import { decodeAggregate3Calldata, encodeAggregate3, type Call } from "../src/encoding.js";
import { buildSnapshot } from "../src/snapshot.js";
import { ACCOUNT_WORDS, BORROWER, DEBT_USDC, LIVE_ACCOUNTS, LIVE_HF, META, ORACLE, PRICES, SUPPLIED, fakeSpokeCall, words } from "./aave-fixtures.js";
import { NOW, calendar, pool, reads, token } from "./fixtures.js";

describe("selectors", () => {
  it("match viem's for every spoke and oracle signature", () => {
    const sigs: Record<keyof typeof AAVE_SELECTOR, string> = {
      getUserAccountData: "getUserAccountData(address)",
      getUserTotalDebt: "getUserTotalDebt(uint256,address)",
      getUserSuppliedAssets: "getUserSuppliedAssets(uint256,address)",
      getReserve: "getReserve(uint256)",
      getReserveConfig: "getReserveConfig(uint256)",
      getDynamicReserveConfig: "getDynamicReserveConfig(uint256,uint32)",
      oracle: "ORACLE()",
      getReservePrice: "getReservePrice(uint256)",
    };
    for (const [k, sig] of Object.entries(sigs)) expect(AAVE_SELECTOR[k as keyof typeof AAVE_SELECTOR]).toBe(toFunctionSelector(sig));
  });
});

describe("decodeAccountData", () => {
  it("reads the seven-word struct as viem encodes it", () => {
    const data = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [...ACCOUNT_WORDS],
    ).slice(2);
    const a = decodeAccountData(data);
    expect(a.riskPremiumBps).toBe(0);
    expect(a.avgCollateralFactor).toBeCloseTo(0.72752, 5);
    expect(a.healthFactor).toBe(1680896609923236325n);
    expect(a.activeCollateralCount).toBe(6);
    expect(a.borrowCount).toBe(1);
  });

  it("turns the no-debt sentinel into null", () => {
    expect(decodeAccountData(words(0n, 0n, (1n << 256n) - 1n, 0n, 0n, 0n, 0n)).healthFactor).toBeNull();
  });
});

describe("planPositions", () => {
  it("asks the oracle for every reserve price, then nine calls per borrower", () => {
    const calls = decodeAggregate3Calldata(encodeAggregate3(planPositions(META, [BORROWER, "0x2222222222222222222222222222222222222222"])));
    expect(calls).toHaveLength(8 + 2 * USER_STRIDE);
    expect(calls.slice(0, 8).every((c) => c.target.toLowerCase() === ORACLE.toLowerCase() && c.callData.startsWith(AAVE_SELECTOR.getReservePrice))).toBe(true);
    const first = calls[8] as Call;
    expect(first.target.toLowerCase()).toBe(AAVE_SPOKE.toLowerCase());
    expect(first.callData).toBe(`${AAVE_SELECTOR.getUserAccountData}000000000000000000000000${BORROWER.slice(2).toLowerCase()}`);
    expect((calls[9] as Call).callData.startsWith(AAVE_SELECTOR.getUserTotalDebt)).toBe(true);
    expect((calls[10] as Call).callData.startsWith(AAVE_SELECTOR.getUserSuppliedAssets)).toBe(true);
  });
});

describe("shapeAavePosition", () => {
  const base = {
    address: BORROWER,
    account: decodeAccountData(words(...ACCOUNT_WORDS)),
    debtUsdc: DEBT_USDC,
    supplied: new Map(Object.entries(SUPPLIED).map(([k, v]) => [Number(k), v])),
    prices: new Map(Object.entries(PRICES).map(([k, v]) => [Number(k), v])),
    shadowUsdBySymbol: new Map<string, number>(),
    meta: META,
    blockNumber: 52295129,
    takenAt: 1791380000,
  };

  it("reproduces the spoke's health factor from collateral × factor / debt", () => {
    const p = shapeAavePosition(base);
    expect(p).not.toBeNull();
    expect(p?.venueHf).toBeCloseTo(LIVE_HF, 6);
    expect(p?.modelHf).toBeCloseTo(LIVE_HF, 3);
    expect(p?.collateralValueUsd).toBeCloseTo(7159.39, 0);
    expect(p?.debtValueUsd).toBeCloseTo(3098.7, 0);
    expect(p?.collateral).toHaveLength(6); // AAPLc is 0
    expect(p?.collateral.map((l) => l.symbol)).toEqual(["AMZNc", "GOOGLc", "METAc", "MSFTc", "NVDAc", "TSLAc"]);
    // nothing has a DEX price here: shadow equals venue, no coverage, no case
    expect(p?.shadowHf).toBeCloseTo(p?.modelHf as number, 9);
    expect(p?.shadowCoverage).toBe(0);
    expect(p?.protectionCase).toBe(false);
  });

  it("applies the DEX TWAP only to the reserves that have a pool and flags the case below 1.05", () => {
    // NVDAc at $120 on the DEX while the venue still holds $238.15: the weighted NVDAc leg halves.
    const p = shapeAavePosition({ ...base, shadowUsdBySymbol: new Map([["NVDAc", 120]]) });
    const nvda = p?.collateral.find((l) => l.symbol === "NVDAc");
    expect(nvda?.shadowPrice).toBe(120);
    expect(nvda?.venuePrice).toBeCloseTo(238.153, 2);
    expect(p?.shadowCoverage).toBeCloseTo((4.20066094 * 238.15304306 * 0.7) / 5208.6, 2);
    expect(p?.shadowHf as number).toBeLessThan(p?.modelHf as number);
    expect(p?.protectionCase).toBe(false); // still about 1.52
    const crash = shapeAavePosition({ ...base, shadowUsdBySymbol: new Map([["NVDAc", 1], ["AAPLc", 1]]) });
    expect(crash?.shadowHf as number).toBeLessThan(1.5);
    const everything = shapeAavePosition({
      ...base,
      shadowUsdBySymbol: new Map(["AMZNc", "GOOGLc", "METAc", "MSFTc", "NVDAc", "TSLAc"].map((s) => [s, 100])),
    });
    expect(everything?.shadowCoverage).toBeCloseTo(1, 9);
    expect(everything?.shadowHf as number).toBeLessThan(1.05);
    expect(everything?.protectionCase).toBe(true);
  });

  it("keeps a debt-free collateral row with null health, drops an empty one", () => {
    const noDebt = shapeAavePosition({ ...base, debtUsdc: 0n, account: decodeAccountData(words(0n, 0n, (1n << 256n) - 1n, 0n, 0n, 6n, 0n)) });
    expect(noDebt?.venueHf).toBeNull();
    expect(noDebt?.modelHf).toBeNull();
    expect(noDebt?.protectionCase).toBe(false);
    expect(shapeAavePosition({ ...base, debtUsdc: 0n, supplied: new Map() })).toBeNull();
  });
});

describe("readAaveMeta and the KV cache", () => {
  it("reads records then configs in two aggregate calls", async () => {
    const batches: Call[][] = [];
    const meta = await readAaveMeta(fakeSpokeCall(LIVE_ACCOUNTS, { onCall: (c) => batches.push(c) }), 1791380000);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(9); // 8 reserves + ORACLE()
    expect(batches[1]).toHaveLength(16); // dynamic config + config per reserve
    expect(meta.oracle.toLowerCase()).toBe(ORACLE.toLowerCase());
    expect(meta.reserves.map((r) => r.collateralFactorBps)).toEqual([7800, 7300, 7600, 6500, 7900, 7000, 6500, 0]);
    expect(meta.reserves[7]).toMatchObject({ symbol: "USDC", decimals: 6, borrowable: true });
    expect(meta.reserves[0]?.symbol).toBe("AAPLc");
  });

  it("throws when the records are unreadable", async () => {
    await expect(readAaveMeta(fakeSpokeCall(LIVE_ACCOUNTS, { fail: new Set([AAVE_SELECTOR.getReserve]) }), 1)).rejects.toThrow(/unreadable/);
  });

  function fakeKv(initial: AaveMeta | null) {
    const store = new Map<string, string>();
    if (initial) store.set(KV_AAVE_META, JSON.stringify(initial));
    let puts = 0;
    const kv = {
      async get(key: string) {
        const v = store.get(key);
        return v === undefined ? null : JSON.parse(v);
      },
      async put(key: string, value: string) {
        puts += 1;
        store.set(key, value);
      },
    } as unknown as KVNamespace;
    return { kv, puts: () => puts };
  }

  it("serves a fresh copy without a read, re-reads a stale one, and falls back to stale on failure", async () => {
    let calls = 0;
    const call = fakeSpokeCall(LIVE_ACCOUNTS, { onCall: () => (calls += 1) });
    const fresh = fakeKv({ ...META, readAt: 1000 });
    expect((await cachedAaveMeta(fresh.kv, call, 1000 + 100)).readAt).toBe(1000);
    expect(calls).toBe(0);
    const stale = fakeKv({ ...META, readAt: 1000 });
    expect((await cachedAaveMeta(stale.kv, call, 1000 + 7200)).readAt).toBe(8200);
    expect(calls).toBe(2);
    expect(stale.puts()).toBe(1);
    const broken = fakeSpokeCall(LIVE_ACCOUNTS, { fail: new Set([AAVE_SELECTOR.getReserve]) });
    const stale2 = fakeKv({ ...META, readAt: 1000 });
    expect((await cachedAaveMeta(stale2.kv, broken, 1000 + 7200)).readAt).toBe(1000);
    await expect(cachedAaveMeta(fakeKv(null).kv, broken, 5)).rejects.toThrow();
  });
});

describe("readAavePositions", () => {
  it("decodes one batch into rows, skipping borrowers whose reads failed and empty positions", async () => {
    const other = "0x2222222222222222222222222222222222222222";
    const rows = await readAavePositions(fakeSpokeCall(LIVE_ACCOUNTS), META, [BORROWER, other], new Map([["NVDAc", 200]]), 52295129, 1791380000);
    expect(rows).toHaveLength(1); // `other` has no debt and no collateral
    expect(rows[0]).toMatchObject({ venue: "aave", address: BORROWER, debtUsdc: DEBT_USDC.toString(), blockNumber: 52295129, takenAt: 1791380000 });
    expect(rows[0]?.venueHf).toBeCloseTo(LIVE_HF, 6);
    expect(rows[0]?.collateral.find((l) => l.symbol === "NVDAc")?.shadowPrice).toBe(200);
    const failed = await readAavePositions(fakeSpokeCall(LIVE_ACCOUNTS, { fail: new Set([AAVE_SELECTOR.getUserAccountData]) }), META, [BORROWER], new Map(), 1, 1);
    expect(failed).toHaveLength(0);
    expect(await readAavePositions(fakeSpokeCall(LIVE_ACCOUNTS), META, [], new Map(), 1, 1)).toEqual([]);
  });
});

describe("rotate", () => {
  it("walks the list in bounded batches and wraps", () => {
    const all = Array.from({ length: 31 }, (_, i) => i);
    const a = rotate(all, 0);
    expect(a.picked).toHaveLength(AAVE_BATCH_PER_TICK);
    expect(a.picked[0]).toBe(0);
    expect(a.nextOffset).toBe(25);
    const b = rotate(all, a.nextOffset);
    expect(b.picked.slice(0, 6)).toEqual([25, 26, 27, 28, 29, 30]);
    expect(b.picked[6]).toBe(0);
    expect(b.nextOffset).toBe(19);
    expect(rotate([1, 2, 3], 7)).toEqual({ picked: [2, 3, 1], nextOffset: 0 });
    expect(rotate([], 3)).toEqual({ picked: [], nextOffset: 0 });
  });
});

describe("parseIndexerBorrowers", () => {
  it("keeps well-formed entries, lowercases, drops junk", () => {
    const out = parseIndexerBorrowers(
      { borrowers: [{ address: "0x84C47EB3757F739460D04E330389647828A8D980", firstBlock: 1, lastBlock: 2, reserveIds: ["7", "x"] }, { address: "nope", firstBlock: 1, lastBlock: 2 }] },
      99,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ address: BORROWER, firstSeenBlock: 1, lastSeenBlock: 2, reserveIds: [7], source: "indexer", updatedAt: 99 });
    expect(parseIndexerBorrowers({}, 1)).toEqual([]);
  });
});

describe("shadowUsdFromSnapshot", () => {
  it("converts the snapshot's 36-scale TWAP to USD per share", () => {
    const s = buildSnapshot(reads([token()], [pool()]), calendar("WEEKEND"), NOW);
    const m = shadowUsdFromSnapshot(s);
    expect(m.get("AAPLc")).toBeCloseTo(s.tokens[0]?.dexTwap1h as number, 6);
    expect(shadowUsdFromSnapshot(buildSnapshot(reads([token()], []), calendar("WEEKEND"), NOW)).size).toBe(0);
  });
});
