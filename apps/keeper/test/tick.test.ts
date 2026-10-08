import { describe, expect, it } from "vitest";
import { planAll, runTick } from "../src/tick.js";
import { fail, fakeChain, ok, PAIRS2, round, side } from "./fake-chain.js";

const ONE = 10n ** 18n;
const A_MAIN = round(36893488147419103512n, 33_366_495_000n, 1_790_959_199n);
const N_MAIN = round(36893488147419104000n, 23_468_592_897n, 1_790_959_200n);

function inSync() {
  return {
    mainnet: side(8453, { block: 52_000_000n, rounds: { AAPLt: ok(A_MAIN), NVDAt: ok(N_MAIN) }, registry: { AAPLt: ok({ multiplier: ONE, paused: false }), NVDAt: ok({ multiplier: ONE, paused: false }) } }),
    sepolia: side(84532, { block: 47_000_000n, rounds: { AAPLt: ok({ ...A_MAIN }), NVDAt: ok({ ...N_MAIN }) }, registry: { AAPLt: ok({ multiplier: ONE, paused: false }), NVDAt: ok({ multiplier: ONE, paused: false }) } }),
  };
}

describe("runTick", () => {
  it("does nothing when both sides match", async () => {
    const chain = fakeChain(inSync());
    const r = await runTick(chain, PAIRS2);
    expect(r.skipped).toBe("nothing-to-do");
    expect(r.planned).toBe(0);
    expect(chain.sent).toEqual([]);
    expect(r.blocks).toEqual({ mainnet: "52000000", sepolia: "47000000" });
    expect(r.symbols.map((s) => s.feed.plan)).toEqual(["skip", "skip"]);
  });

  it("sends feed updates first, then registry updates, with contiguous nonces from the pending nonce", async () => {
    const s = inSync();
    s.sepolia.rounds.set("AAPLt", ok(round(1n, 33_366_495_000n, 1_791_037_640n)));
    s.sepolia.rounds.set("NVDAt", ok(round(1n, 18_750_000_000n, 1_791_037_640n)));
    s.mainnet.registry.set("NVDAt", ok({ multiplier: 2n * ONE, paused: true }));
    const chain = fakeChain({ ...s, nonces: { latest: 3n, pending: 3n } });
    const r = await runTick(chain, PAIRS2, { maxTxPerTick: 10 });
    expect(r.skipped).toBeNull();
    expect(r.planned).toBe(3);
    expect(r.sent).toBe(3);
    expect(r.deferred).toBe(0);
    expect(chain.sent.map((t) => [t.kind, t.nonce])).toEqual([
      ["feed", 3n],
      ["feed", 4n],
      ["registry", 5n],
    ]);
    const aapl = chain.sent[0]!;
    expect(aapl.to).toBe(PAIRS2[0].sepoliaFeed);
    expect(aapl.args).toEqual([A_MAIN.roundId, A_MAIN.answer, A_MAIN.startedAt, A_MAIN.updatedAt, A_MAIN.answeredInRound]);
    expect(chain.sent[1]!.to).toBe(PAIRS2[1].sepoliaFeed);
    const reg = chain.sent[2]!;
    expect(reg.to).toBe(PAIRS2[1].sepoliaToken);
    expect(reg.args).toEqual([2n * ONE, true]);
    // A tick never waits for receipts (CPU budget): every sent row is reported pending.
    expect(chain.waited).toHaveLength(0);
    expect(r.txs.every((t) => t.receipt === "pending")).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("sends one transaction per tick by default and defers the rest", async () => {
    const s = inSync();
    s.sepolia.rounds.set("AAPLt", ok(round(1n, 33_366_495_000n, 1_791_037_640n)));
    s.sepolia.rounds.set("NVDAt", ok(round(1n, 18_750_000_000n, 1_791_037_640n)));
    s.mainnet.registry.set("NVDAt", ok({ multiplier: 2n * ONE, paused: true }));
    const chain = fakeChain({ ...s, nonces: { latest: 3n, pending: 3n } });
    const r = await runTick(chain, PAIRS2);
    expect(r.planned).toBe(3);
    expect(r.sent).toBe(1);
    expect(r.deferred).toBe(2);
    expect(chain.sent.map((t) => [t.kind, t.nonce])).toEqual([["feed", 3n]]);
    expect(r.txs).toHaveLength(1);
    expect(r.txs[0]?.receipt).toBe("pending");
  });

  it("sends nothing with a zero cap but still plans", async () => {
    const s = inSync();
    s.sepolia.rounds.set("AAPLt", ok(round(1n, 1n, 1n)));
    const chain = fakeChain(s);
    const r = await runTick(chain, PAIRS2, { maxTxPerTick: 0 });
    expect(r.planned).toBe(1);
    expect(r.sent).toBe(0);
    expect(r.deferred).toBe(1);
    expect(chain.sent).toEqual([]);
  });

  it("skips the whole tick while a previous transaction is still pending", async () => {
    const s = inSync();
    s.sepolia.rounds.set("AAPLt", ok(round(1n, 1n, 1n)));
    const chain = fakeChain({ ...s, nonces: { latest: 3n, pending: 4n } });
    const r = await runTick(chain, PAIRS2);
    expect(r.skipped).toBe("in-flight");
    expect(r.planned).toBe(1);
    expect(chain.sent).toEqual([]);
    expect(r.nonces).toEqual({ latest: "3", pending: "4" });
  });

  it("reports read-only mode without a key", async () => {
    const s = inSync();
    s.sepolia.rounds.set("AAPLt", ok(round(1n, 1n, 1n)));
    const chain = fakeChain({ ...s, keeper: null });
    const r = await runTick(chain, PAIRS2);
    expect(r.skipped).toBe("no-key");
    expect(r.planned).toBe(1);
    expect(chain.sent).toEqual([]);
  });

  it("stops at the first rejected send so nonces stay contiguous", async () => {
    const s = inSync();
    s.sepolia.rounds.set("AAPLt", ok(round(1n, 1n, 1n)));
    s.sepolia.rounds.set("NVDAt", ok(round(1n, 1n, 1n)));
    const chain = fakeChain({ ...s, failSendAt: 0 });
    const r = await runTick(chain, PAIRS2, { maxTxPerTick: 10 });
    expect(r.planned).toBe(2);
    expect(r.sent).toBe(0);
    expect(chain.sent).toEqual([]);
    expect(r.txs).toHaveLength(1);
    expect(r.txs[0]?.error).toContain("rejected");
    expect(r.errors).toHaveLength(1);
  });

  it("skips a symbol whose mainnet read failed and still serves the others", async () => {
    const s = inSync();
    s.mainnet.rounds.set("AAPLt", fail("execution reverted"));
    s.sepolia.rounds.set("NVDAt", ok(round(1n, 1n, 1n)));
    const chain = fakeChain(s);
    const r = await runTick(chain, PAIRS2);
    expect(r.symbols[0]?.feed).toMatchObject({ plan: "error" });
    expect(r.symbols[0]?.feed.reason).toContain("execution reverted");
    expect(chain.sent.map((t) => t.to)).toEqual([PAIRS2[1].sepoliaFeed]);
  });

  it("treats a failed Sepolia read as unknown and writes", async () => {
    const s = inSync();
    s.sepolia.rounds.set("AAPLt", fail("timeout"));
    const chain = fakeChain(s);
    const r = await runTick(chain, PAIRS2);
    expect(r.symbols[0]?.feed).toMatchObject({ plan: "setRoundData", reason: "sepolia-unknown" });
    expect(chain.sent).toHaveLength(1);
  });

  it("never throws when the chain reads throw", async () => {
    const chain = fakeChain({ ...inSync(), readThrows: true });
    const r = await runTick(chain, PAIRS2);
    expect(r.skipped).toBe("read-failed");
    expect(r.errors[0]).toContain("mainnet rpc down");
  });

  it("planAll is pure and lists every feed update before any registry update", () => {
    const s = inSync();
    s.sepolia.rounds.set("NVDAt", ok(round(1n, 1n, 1n)));
    s.sepolia.registry.set("NVDAt", ok({ multiplier: ONE, paused: true }));
    const { txs, symbols } = planAll(PAIRS2, s.mainnet, s.sepolia, fakeChain(s));
    expect(txs.map((t) => `${t.symbol}/${t.kind}`)).toEqual(["NVDAt/feed", "NVDAt/registry"]);
    expect(symbols[1]?.registry).toEqual({ plan: "setOracleParams", reason: "differs" });
  });

  it("leaves a held symbol alone: a drill on the simulators is not reverted by the mirror", () => {
    const s = inSync();
    s.sepolia.rounds.set("NVDAt", ok(round(1n, 1n, 1n)));
    s.sepolia.registry.set("NVDAt", ok({ multiplier: ONE * 2n, paused: false }));
    const held = planAll(PAIRS2, s.mainnet, s.sepolia, fakeChain(s), { feed: new Set(), registry: new Set(["NVDAt"]) });
    expect(held.txs.map((t) => `${t.symbol}/${t.kind}`)).toEqual(["NVDAt/feed"]);
    expect(held.symbols[1]?.registry).toEqual({ plan: "skip", reason: "held (registry hold)" });
    const both = planAll(PAIRS2, s.mainnet, s.sepolia, fakeChain(s), { feed: new Set(["NVDAt"]), registry: new Set(["NVDAt"]) });
    expect(both.txs).toEqual([]);
    expect(both.symbols[1]?.feed).toEqual({ plan: "skip", reason: "held (feed hold)" });
    expect(both.symbols[0]?.feed.plan).toBe("skip");
  });

  it("runTick threads the hold through to the plan", async () => {
    const s = inSync();
    s.sepolia.registry.set("AAPLt", ok({ multiplier: ONE * 2n, paused: false }));
    const chain = fakeChain(s);
    const r = await runTick(chain, PAIRS2, { hold: { feed: new Set(), registry: new Set(["AAPLt"]) } });
    expect(r.skipped).toBe("nothing-to-do");
    expect(r.planned).toBe(0);
  });
});
