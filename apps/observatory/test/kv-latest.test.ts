import { describe, expect, it } from "vitest";
import { LATEST_REFRESH_SECONDS, decideLatestWrite, fingerprint, storeLatest, type LatestMeta } from "../src/kv-latest.js";
import type { TokenRead } from "../src/reader.js";
import { buildSnapshot, type Snapshot } from "../src/snapshot.js";
import { NOW, calendar, pool, reads, token } from "./fixtures.js";

function snap(at: number, overrides: Parameters<typeof token>[0] = {}, state: Parameters<typeof calendar>[0] = "WEEKEND"): Snapshot {
  return buildSnapshot(reads([token(overrides)], [pool()]), calendar(state), at);
}

describe("fingerprint", () => {
  it("ignores the minute-to-minute drift: time, block, feed age and the DEX price", () => {
    const a = snap(NOW);
    const b = buildSnapshot(
      { ...reads([token()], [pool({ sqrtPriceX96: 43400000000000000000000000000n, tick: -12040 })]), blockNumber: 52117600n, blockTimestamp: NOW + 60 },
      calendar("WEEKEND"),
      NOW + 60,
    );
    expect(b.block).not.toBe(a.block);
    expect(b.tokens[0]!.dexPrice).not.toBe(a.tokens[0]!.dexPrice);
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  const cases: Array<[string, Partial<TokenRead>]> = [
    ["feed answer", { feedAnswer: 33400000000n }],
    ["feed updatedAt", { feedUpdatedAt: 1790959999n }],
    ["registry pause", { registryPaused: true }],
    ["transfer pause", { transferPaused: true, pausedFeatures: [0] }],
    ["registry multiplier", { registryMultiplier: 5n * 10n ** 17n }],
    ["scheduled corporate action", { newUIMultiplier: 25n * 10n ** 16n, effectiveAt: BigInt(NOW + 86400) }],
    ["read errors", { errors: ["feed: timeout"] }],
  ];
  it.each(cases)("changes on %s", (_label, overrides) => {
    expect(fingerprint(snap(NOW + 60, { ...overrides }))).not.toBe(fingerprint(snap(NOW)));
  });

  it("changes when the session turns over", () => {
    expect(fingerprint(snap(NOW + 60, {}, "OVERNIGHT"))).not.toBe(fingerprint(snap(NOW)));
  });
});

describe("decideLatestWrite", () => {
  const prev = snap(NOW);
  const meta: LatestMeta = { writtenAt: NOW };

  it("writes when nothing is stored, or the stored copy predates the metadata", () => {
    expect(decideLatestWrite(null, null, snap(NOW + 60))).toEqual({ write: true, reason: "first" });
    expect(decideLatestWrite(prev, null, snap(NOW + 60))).toEqual({ write: true, reason: "first" });
  });

  it("skips an unchanged snapshot inside the refresh window", () => {
    expect(decideLatestWrite(prev, meta, snap(NOW + 60))).toEqual({ write: false, reason: "unchanged", ageSeconds: 60 });
    expect(decideLatestWrite(prev, meta, snap(NOW + LATEST_REFRESH_SECONDS - 1))).toMatchObject({ write: false });
  });

  it("refreshes once the stored copy is old enough, or when clocks run backwards", () => {
    expect(decideLatestWrite(prev, meta, snap(NOW + LATEST_REFRESH_SECONDS))).toEqual({ write: true, reason: "refresh" });
    expect(decideLatestWrite(prev, meta, snap(NOW - 5))).toEqual({ write: true, reason: "refresh" });
  });

  it("writes a material change at once", () => {
    expect(decideLatestWrite(prev, meta, snap(NOW + 60, { feedAnswer: 33400000000n }))).toEqual({ write: true, reason: "changed" });
    expect(decideLatestWrite(prev, meta, snap(NOW + 60, {}, "OVERNIGHT"))).toEqual({ write: true, reason: "changed" });
  });

  it("stays under the free-tier budget on a quiet day: 1,440 ticks become 144 writes", () => {
    let stored: { value: Snapshot; meta: LatestMeta } | null = null;
    let writes = 0;
    for (let i = 0; i < 1440; i++) {
      const next = snap(NOW + i * 60);
      const d = decideLatestWrite(stored?.value ?? null, stored?.meta ?? null, next);
      if (d.write) {
        writes++;
        stored = { value: next, meta: { writtenAt: next.takenAt } };
      }
    }
    expect(writes).toBe(144);
  });
});

describe("storeLatest", () => {
  function fakeKv() {
    const store = new Map<string, { value: string; metadata: unknown }>();
    let puts = 0;
    const kv = {
      async getWithMetadata(key: string) {
        const hit = store.get(key);
        return { value: hit ? JSON.parse(hit.value) : null, metadata: hit?.metadata ?? null, cacheStatus: null };
      },
      async put(key: string, value: string, opts?: { metadata?: unknown }) {
        puts++;
        store.set(key, { value, metadata: opts?.metadata ?? null });
      },
    } as unknown as KVNamespace;
    return { kv, store, puts: () => puts };
  }

  it("writes the first snapshot with writtenAt metadata, then skips the unchanged minute", async () => {
    const { kv, store, puts } = fakeKv();
    expect(await storeLatest(kv, snap(NOW))).toEqual({ write: true, reason: "first" });
    expect(store.get("latest")?.metadata).toEqual({ writtenAt: NOW });
    expect(await storeLatest(kv, snap(NOW + 60))).toEqual({ write: false, reason: "unchanged", ageSeconds: 60 });
    expect(await storeLatest(kv, snap(NOW + 120, { registryPaused: true }))).toEqual({ write: true, reason: "changed" });
    expect(puts()).toBe(2);
    expect((JSON.parse(store.get("latest")!.value) as Snapshot).tokens[0]!.registryPaused).toBe(true);
  });
});
