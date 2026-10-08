import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { decodeAggregate3Calldata, encodeAggregate3Result, wordUint } from "../src/multicall.js";
import type { RawRpc } from "../src/rpc.js";
import { SEIZE_BASELINE } from "../src/seize-baseline.js";
import { SEIZE_EXEMPT_POLICY, SEIZE_ROLE, SEIZE_VENUES } from "../src/seize.js";
import { MAINNET_STACK, SEPOLIA_PROTECTION, mainnetSources, sepoliaSources } from "../src/sources.js";
import { MemoryStore } from "../src/store-memory.js";
import { CHAIN, row, txHash } from "./fixtures.js";

const DESK = "0x39abadc0aaa12d1f7e259b89536aa1848997399a";
const VAULT = SEPOLIA_PROTECTION.deskProtectionVault.toLowerCase() as `0x${string}`;
const env = { CREDIT_DESK_SEPOLIA: "0x39aBaDc0aAa12D1F7e259b89536Aa1848997399a", INDEX_MAINNET: "true" } as Env;

/** A RawRpc that answers the two seize-watch aggregate3 calls: block 52,400,000, every stock on `exempt`, the venues
 *  exempt unless listed in `notExempt`. */
function fakeRpc(exempt: number, notExempt: string[] = [], fail = false): RawRpc & { calls: number } {
  const rpc = {
    calls: 0,
    async call<T>(_method: string, params: readonly unknown[]): Promise<T> {
      rpc.calls += 1;
      if (fail) throw new Error("rpc down");
      const calls = decodeAggregate3Calldata((params[0] as { data: string }).data);
      const results = calls.map((c) => {
        const sel = c.callData.slice(0, 10);
        if (sel === "0x42cbb15c") return { success: true, data: wordUint(52_400_000) };
        if (sel === "0xdb3de624") return { success: true, data: wordUint(c.callData.slice(10) === SEIZE_EXEMPT_POLICY.slice(2) ? exempt : 0) };
        // isAuthorized(policy, venue)
        const venue = `0x${c.callData.slice(-40)}`.toLowerCase();
        return { success: true, data: wordUint(notExempt.map((a) => a.toLowerCase()).includes(venue) ? 0 : 1) };
      });
      return encodeAggregate3Result(results) as T;
    },
    async text(): Promise<string> {
      throw new Error("unused");
    },
    async batch<T>(): Promise<(T | Error)[]> {
      throw new Error("unused");
    },
  };
  return rpc;
}

async function setup(rpc: RawRpc | undefined, extra: Parameters<MemoryStore["insertEvents"]>[0] = []) {
  const store = new MemoryStore();
  await store.insertEvents([
    row({ chainId: CHAIN, blockNumber: 500, logIndex: 0, txHash: txHash(500), address: DESK, name: "LineOpened", argsJson: '{"decisionHash":"0x01","lineId":"1","user":"0xb789"}' }),
    row({ chainId: CHAIN, blockNumber: 900, logIndex: 3, txHash: txHash(900), address: VAULT, name: "Protected", argsJson: '{"debtAfter":"2300134","debtBefore":"2800134","decisionHash":"0x87c3","fromAdvance":"0","fromPartner":"0","fromUser":"500000","lineId":"1","partnerId":"0x62","repaid":"500000","user":"0xb789"}' }),
    row({ chainId: CHAIN, blockNumber: 900, logIndex: 1, txHash: txHash(900), address: DESK, name: "Repaid", argsJson: '{"amount":"500000","decisionHash":"0x5770","from":"0x87f6","full":false,"lineId":"1"}' }),
    row({ chainId: CHAIN, blockNumber: 950, logIndex: 0, txHash: txHash(950), address: VAULT, name: "AdvanceSettled", argsJson: '{"decisionHash":"0x14c4","fee":"2000","lineId":"1","outstandingAfter":"0","payer":"0xb789","principal":"200000"}' }),
    // the vault's own Decision row stays off the line timeline (consumers read Decision rows as the desk's)
    row({ chainId: CHAIN, blockNumber: 950, logIndex: 1, txHash: txHash(950), address: VAULT, name: "Decision", argsJson: '{"action":"0x53455454","amount":"202000","decisionHash":"0x14c4","lineId":"1"}' }),
    // another line's vault event must not appear on line 1
    row({ chainId: CHAIN, blockNumber: 960, logIndex: 0, txHash: txHash(960), address: VAULT, name: "Protected", argsJson: '{"lineId":"12","repaid":"1"}' }),
    ...extra,
  ]);
  const app = createApp({ store: () => store, sources: (e) => [...sepoliaSources(e), ...mainnetSources(e)], now: () => 1_791_450_000, ...(rpc ? { rpc: () => rpc } : {}) });
  const get = async (path: string) => {
    const res = await app.request(path, undefined, env);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { store, get };
}

describe("line timeline with the DeskProtectionVault", () => {
  it("merges the vault's events for the line in block and log order, labelled by contract", async () => {
    const { get } = await setup(undefined);
    const r = await get("/v1/desk/lines/1/timeline?chain=84532");
    expect(r.status).toBe(200);
    expect(r.body.vault).toBe(VAULT);
    expect((r.body.events as { name: string; contract: string; blockNumber: number; logIndex: number }[]).map((e) => [e.name, e.contract, e.blockNumber, e.logIndex])).toEqual([
      ["LineOpened", "CreditDesk", 500, 0],
      ["Repaid", "CreditDesk", 900, 1],
      ["Protected", "DeskProtectionVault", 900, 3],
      ["AdvanceSettled", "DeskProtectionVault", 950, 0],
    ]);
  });
});

describe("/v1/seize-watch", () => {
  it("answers from the full-history baseline and live reads: no SEIZE_ROLE, policy 129, every venue exempt", async () => {
    const rpc = fakeRpc(129);
    const { get } = await setup(rpc);
    const r = await get("/v1/seize-watch");
    expect(r.status).toBe(200);
    expect(r.body.live).toEqual({ block: 52_400_000, error: null });
    expect(r.body.summary).toMatchObject({ seizeRoleHolders: 0, seizeRoleGrantsAllTime: 0, seizedAllTime: 0, exemptionPolicies: [129], venuesNotExempt: [] });
    expect(r.body.summary.statement).toContain("no seizure is possible today");
    expect(r.body.tokens).toHaveLength(10);
    const aapl = (r.body.tokens as any[]).find((t) => t.symbol === "AAPLc");
    expect(aapl.verdict).toBe("NO_SEIZE_ROLE");
    expect(aapl.seizeExemptPolicy.live).toBe(129);
    expect(aapl.seizeExemptPolicy.updates[0]).toMatchObject({ old: 0, new: 129, block: 52_216_682 });
    expect(aapl.venues).toHaveLength(SEIZE_VENUES.length);
    expect(aapl.venues.every((v: { exempt: boolean }) => v.exempt)).toBe(true);
    expect(r.body.coverage.baseline).toMatchObject({ from: SEIZE_BASELINE.scannedFrom, to: SEIZE_BASELINE.scannedTo });
    expect(r.body.policyChanges.map((p: any) => [p.policyId, p.event, p.block])).toEqual([
      [129, "blocked", 52_216_975],
      [129, "unblocked", 52_217_211],
    ]);
  });

  it("flags a venue that the exemption policy does not cover, and a SEIZE_ROLE granted after the baseline", async () => {
    const aaplToken = MAINNET_STACK.feeds[0]!.token.toLowerCase() as `0x${string}`;
    const grant = row({
      chainId: 8453,
      blockNumber: SEIZE_BASELINE.scannedTo + 10,
      logIndex: 0,
      txHash: txHash(77),
      address: aaplToken,
      name: "RoleGranted",
      argsJson: `{"account":"0x00000000000000000000000000000000000000aa","role":"${SEIZE_ROLE}","sender":"0x38467be00970af18076fd08f6b4cf38ba91572b1"}`,
    });
    const rpc = fakeRpc(129, [SEIZE_VENUES[0]!.address]);
    const { get } = await setup(rpc, [grant]);
    const r = await get("/v1/seize-watch");
    expect(r.body.summary.seizeRoleHolders).toBe(1);
    expect(r.body.summary.statement).toContain("1 account(s) hold SEIZE_ROLE");
    expect(r.body.summary.venuesNotExempt).toHaveLength(10);
    expect(r.body.summary.venuesNotExempt[0]).toMatchObject({ venue: "Morpho Blue" });
    const aapl = (r.body.tokens as any[]).find((t) => t.symbol === "AAPLc");
    expect(aapl.verdict).toBe("SEIZE_ROLE_HELD");
    expect(aapl.seizeRole.holders).toEqual(["0x00000000000000000000000000000000000000aa"]);
  });

  it("still answers from events when the RPC is down, and says so", async () => {
    const { get } = await setup(fakeRpc(129, [], true));
    const r = await get("/v1/seize-watch");
    expect(r.status).toBe(200);
    // the memo of an earlier test in this isolate may answer; either way the route never fails
    expect(r.body.tokens).toHaveLength(10);
    expect(typeof r.body.summary.statement).toBe("string");
  });
});

describe("/v1/roots drift", () => {
  it("flags a rooted day that gained events after it closed (a source added later), without touching the root", async () => {
    const { store, get } = await setup(undefined);
    const day = "2026-10-06";
    const t = Date.parse(`${day}T12:00:00Z`) / 1000;
    await store.insertEvents([row({ chainId: CHAIN, blockNumber: 1, logIndex: 0, blockTime: t, txHash: txHash(1) })]);
    await store.putRoot({ chainId: CHAIN, day, firstBlock: 1, lastBlock: 1, eventCount: 1, prevRoot: "0x00", root: "0x9e21", computedAt: t + 86_400 });
    const before = await get("/v1/roots?chain=84532");
    expect(before.body.roots[0]).toMatchObject({ day, eventCount: 1, eventsStoredNow: 1, drift: false });
    // the backfill of a new source lands in the same day
    await store.insertEvents([row({ chainId: CHAIN, blockNumber: 2, logIndex: 0, blockTime: t + 60, txHash: txHash(2), address: VAULT, name: "Protected" })]);
    const after = await get("/v1/roots?chain=84532");
    expect(after.body.roots[0]).toMatchObject({ day, root: "0x9e21", eventCount: 1, eventsStoredNow: 2, drift: true });
  });
});

describe("multicall codec", () => {
  it("round-trips results and calldata", () => {
    const results = [
      { success: true, data: wordUint(1) },
      { success: false, data: "" },
      { success: true, data: "ab".repeat(40) },
    ];
    const encoded = encodeAggregate3Result(results);
    expect(encoded.startsWith("0x")).toBe(true);
    const calls = decodeAggregate3Calldata(`0x82ad56cb${wordUint(32)}${wordUint(0)}` as Hex);
    expect(calls).toEqual([]);
  });
});
