import { describe, expect, it } from "vitest";
import { buildStatus, collectStatus } from "../src/status.js";
import { fail, fakeChain, KEEPER, ok, PAIRS2, round, side } from "./fake-chain.js";

const ONE = 10n ** 18n;
const NOW = 1_791_040_000;
const A_MAIN = round(36893488147419103512n, 33_366_495_000n, 1_790_959_199n);

describe("buildStatus", () => {
  it("reports both sides, sync state and lag per pair", () => {
    const mainnet = side(8453, { block: 10n, rounds: { AAPLt: ok(A_MAIN), NVDAt: ok(A_MAIN) }, registry: { AAPLt: ok({ multiplier: ONE, paused: false }), NVDAt: ok({ multiplier: ONE, paused: false }) } });
    const sepolia = side(84532, {
      block: 20n,
      rounds: { AAPLt: ok({ ...A_MAIN }), NVDAt: ok(round(1n, 18_750_000_000n, A_MAIN.updatedAt - 1000n)) },
      registry: { AAPLt: ok({ multiplier: ONE, paused: false }), NVDAt: fail("boom") },
    });
    const s = buildStatus(PAIRS2, mainnet, sepolia, { address: KEEPER, balanceWei: 10n ** 16n }, NOW);
    expect(s.keeper).toEqual({ address: KEEPER, balanceWei: "10000000000000000", balanceEth: 0.01 });
    expect(s.chains.mainnet.block).toBe("10");
    expect(s.pairs[0]?.feed).toMatchObject({ inSync: true, lagSeconds: 0, plan: "in-sync" });
    expect(s.pairs[0]?.feed.mainnet.value).toMatchObject({ price: 333.66495, roundId: "36893488147419103512", ageSeconds: NOW - 1_790_959_199 });
    expect(s.pairs[1]?.feed).toMatchObject({ inSync: false, lagSeconds: 1000, plan: "setRoundData (differs)" });
    expect(s.pairs[1]?.registry).toMatchObject({ inSync: false, plan: "setOracleParams (sepolia-unknown)" });
    expect(s.pairs[1]?.registry.sepolia.error).toBe("boom");
    expect(s.summary).toEqual({ pairs: 2, feedsInSync: 1, registriesInSync: 1, readErrors: 1 });
  });

  it("serialises without bigint and tolerates a missing keeper", async () => {
    const mainnet = side(8453, { rounds: { AAPLt: ok(A_MAIN), NVDAt: ok(A_MAIN) }, registry: { AAPLt: ok({ multiplier: ONE, paused: false }), NVDAt: ok({ multiplier: ONE, paused: false }) } });
    const chain = fakeChain({ mainnet, sepolia: mainnet, keeper: null });
    const s = await collectStatus(chain, PAIRS2, NOW);
    expect(s.keeper).toBeNull();
    expect(() => JSON.stringify(s)).not.toThrow();
    expect(s.summary.feedsInSync).toBe(2);
  });
});
