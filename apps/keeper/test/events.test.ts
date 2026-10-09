import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  ARMED_EXPIRY_BLOCKS,
  PROTECTOR_PROTECTED_TOPIC,
  apiTick,
  decodeExecutions,
  emitEvents,
  executionReads,
  parseState,
  transitions,
  type EventsBinding,
  type KeeperEvent,
  type KeeperState,
} from "../src/events.js";
import type { ProtectReport } from "../src/protect-job.js";
import { rpcClient, RpcCallError, RpcError, type FetchLike } from "../src/rpc.js";
import { VAULT_PROTECTED_TOPIC, type VaultSizing } from "../src/vault.js";
import type { VaultReport, VaultTargetReport } from "../src/vault-job.js";
import { warmed } from "../src/warm.js";

const VAULT: Address = "0x87f600279F021ca859b9903DE884d3A7A169f38c";
const PROTECTOR: Address = "0x5c546946c909718040dd686f63df6cb5e4df442c";
const BORROWER: Address = "0xB789aD318945B37566E2549F65526Cc269a482Fc";
const DEPLOYER: Address = "0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E";
const W = (x: bigint) => x.toString(16).padStart(64, "0");

const sizing = (standing: VaultSizing["standing"], ltvBps: bigint): VaultSizing => ({
  standing,
  collateralRaw: 2_000_000n,
  debt: 3_220_175n,
  shadowPrice36: 3n * 10n ** 36n,
  shadowValue: 6_000_000n,
  shadowLtvWad: ltvBps * 10n ** 14n,
  venueValue: null,
  venueLtvWad: null,
  graceLtvWad: 52n * 10n ** 16n,
  targetLtvWad: 45n * 10n ** 16n,
  amount: standing === "IN_GRACE" ? 520_000n : 0n,
});
const row = (s: VaultSizing | null): VaultTargetReport => ({
  lineId: "1",
  graceLtvBps: 5200,
  targetLtvBps: 4500,
  line: { user: BORROWER, partnerId: "0x00" as Hex, status: "OPEN", drawnPrincipal: 3_220_000n, marketId: "0x00" as Hex, collateral: "0xB2000000000000000000000E063E65377cA34141" },
  quote: { reason: "MARKET_CLOSED", session: "WEEKEND", price8: 0n, collateralValue: 0n, corporateActionHaircut: false },
  sizing: s,
  ladder: null,
  funding: null,
  decision: null,
});
const vaultReport = (s: VaultSizing | null, armed: VaultReport["armed"] = null): VaultReport => ({
  at: 1, ms: 1, vault: VAULT, keeper: null, signer: null, keeperIsSigner: true, paused: false, head: 47_840_000, targets: [row(s)], armed, skipped: null, errors: [],
});
const base = { chainId: 84532, now: 1_791_600_000, protect: null as ProtectReport | null, executions: [], head: 47_840_000 };

describe("state", () => {
  it("parses a stored state and falls back to empty on anything else", () => {
    expect(parseState(null)).toEqual({ v: 1, grace: {}, armed: {}, backoff: {} });
    expect(parseState("{nope")).toEqual({ v: 1, grace: {}, armed: {}, backoff: {} });
    expect(parseState('{"v":2}')).toEqual({ v: 1, grace: {}, armed: {}, backoff: {} });
    // a state written before backoff existed still parses
    expect(parseState('{"v":1,"grace":{},"armed":{}}').backoff).toEqual({});
    expect(parseState('{"v":1,"grace":{"line:1":5},"armed":{}}').grace).toEqual({ "line:1": 5 });
  });
});

describe("transitions", () => {
  const empty: KeeperState = { v: 1, grace: {}, armed: {}, backoff: {} };
  it("emits grace once on entry, nothing while it stays, grace.cleared on a definite exit", () => {
    const a = transitions(empty, { ...base, vault: vaultReport(sizing("IN_GRACE", 5270n)) });
    expect(a.events.map((e) => e.type)).toEqual(["grace"]);
    expect(a.events[0]).toMatchObject({ lineId: "1", borrower: BORROWER, data: { shadowLtvPct: "52.70", graceLtvBps: 5200, amountUsdc: "0.520000", session: "WEEKEND" } });
    expect(a.changed).toBe(true);
    const b = transitions(a.next, { ...base, vault: vaultReport(sizing("IN_GRACE", 5300n)) });
    expect(b.events).toEqual([]);
    expect(b.changed).toBe(false);
    const unread = transitions(a.next, { ...base, vault: vaultReport(null) });
    expect(unread.events).toEqual([]); // a failed read never clears grace
    const noPrice = transitions(a.next, { ...base, vault: vaultReport(sizing("NO_SHADOW_PRICE", 0n)) });
    expect(noPrice.events).toEqual([]);
    const c = transitions(a.next, { ...base, vault: vaultReport(sizing("BELOW_GRACE", 4500n)) });
    expect(c.events.map((e) => e.type)).toEqual(["grace.cleared"]);
    expect(c.next.grace).toEqual({});
  });
  it("emits one protect event per arming episode, not per re-arm", () => {
    const armed = { lineId: "1", amount: 520_000n, funding: { fromUser: 400_000n, fromPartner: 0n, fromAdvance: 120_000n, shortfall: 0n }, hash: `0x${"aa".repeat(32)}` as Hex, nonce: 4, bound: 47_840_030, head: 47_840_000, attempts: 1, alreadyKnown: false, feeStep: 0 };
    const a = transitions({ v: 1, grace: { "line:1": 1 }, armed: {}, backoff: {} }, { ...base, vault: vaultReport(sizing("IN_GRACE", 5270n), armed) });
    expect(a.events.map((e) => `${e.type}:${e.data.phase}`)).toEqual(["protect:armed"]);
    expect(a.events[0]).toMatchObject({ txHash: armed.hash, data: { amountUsdc: "0.520000", fromAdvanceUsdc: "0.120000", predicate: "feed round held" } });
    expect(a.next.armed["line:1"]).toMatchObject({ kind: "vault-repay", head: 47_840_000, nonce: 4 });
    const again = transitions(a.next, { ...base, vault: vaultReport(sizing("IN_GRACE", 5270n), { ...armed, hash: `0x${"bb".repeat(32)}` as Hex }) });
    expect(again.events).toEqual([]);
    expect(again.changed).toBe(false);
  });
  it("closes the episode when the vault's Protected log shows up, and expires it otherwise", () => {
    const state: KeeperState = { v: 1, grace: { "line:1": 1 }, armed: { "line:1": { kind: "vault-repay", head: 47_840_000, nonce: 4, at: 1, lineId: "1" } }, backoff: {} };
    const reads = executionReads(state, VAULT, PROTECTOR);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.call.params[0]).toMatchObject({ address: VAULT, topics: [VAULT_PROTECTED_TOPIC, `0x${W(1n)}`], fromBlock: `0x${(47_840_000).toString(16)}` });
    const log = { transactionHash: `0x${"cd".repeat(32)}`, blockNumber: "0x2d9fb41", topics: [], data: `0x${W(520_000n)}${W(400_000n)}${W(0n)}${W(120_000n)}${W(3_220_175n)}${W(2_700_175n)}${"ef".repeat(32)}` };
    const executions = decodeExecutions(reads, [{ ok: true, result: [log] }], state);
    expect(executions[0]).toMatchObject({ key: "line:1", txHash: log.transactionHash, decisionHash: `0x${"ef".repeat(32)}`, data: { phase: "executed", repaidUsdc: "0.520000", fromAdvanceUsdc: "0.120000", debtAfterUsdc: "2.700175" } });
    const done = transitions(state, { ...base, vault: vaultReport(sizing("BELOW_GRACE", 4500n)), executions });
    expect(done.events.map((e) => `${e.type}:${e.data.phase ?? e.data.standing}`)).toEqual(["grace.cleared:BELOW_GRACE", "protect:executed"]);
    expect(done.next.armed).toEqual({});
    const stale = transitions(state, { ...base, vault: null, head: 47_840_000 + ARMED_EXPIRY_BLOCKS + 1 });
    expect(stale.next.armed).toEqual({});
    expect(decodeExecutions(reads, [{ ok: true, result: [] }], state)).toEqual([]);
  });
  it("tracks the Protector's targets the same way, IN_BAND being their grace", () => {
    const protect = {
      at: 1, ms: 1, head: 47_840_000, signer: null, armed: { preLiq: "0xdcae709341aab652144e8afcb47479fe49e133a1" as Address, borrower: DEPLOYER, action: "close", hash: `0x${"11".repeat(32)}` as Hex, nonce: 7, bound: 47_840_030, attempts: 1, alreadyKnown: false, feeStep: 0, maxFeePerGas: "21000000", maxPriorityFeePerGas: "1000000" },
      skipped: null, errors: [],
      targets: [{ preLiq: "0xdcae709341aab652144e8afcb47479fe49e133a1" as Address, borrower: DEPLOYER, decision: { action: "close" as const, seizedAssets: 0n as const, repaidShares: 1n, expectedRepaid: 1n }, sizing: { standing: "IN_BAND" as const, collateral: 1n, borrowShares: 1n, debtAssets: 1n, shadowPrice36: 1n, venuePrice36: 1n, venueOracleLive: false, shadowLtvWad: 59n * 10n ** 16n, venueLtvWad: 1n, preLifWad: 1n, preLcfWad: 1n, targetLtvWad: 1n, maxSeizedAssets: 0n, maxRepaidShares: 0n, maxRepaidAssets: 0n, fullCloseAllowed: true, fullCloseSeizedAssets: 1n, fullCloseRepaidAssets: 1n } }],
    } satisfies ProtectReport;
    const r = transitions({ v: 1, grace: {}, armed: {}, backoff: {} }, { ...base, vault: null, protect });
    expect(r.events.map((e) => `${e.type}:${e.data.phase ?? e.data.standing}`)).toEqual(["grace:IN_BAND", "protect:armed"]);
    expect(r.next.armed[`borrower:${DEPLOYER.toLowerCase()}`]).toMatchObject({ kind: "pre-liquidation", head: 47_840_000, nonce: 7 });
    const reads = executionReads(r.next, VAULT, PROTECTOR);
    expect(reads[0]!.call.params[0]).toMatchObject({ address: PROTECTOR, topics: [PROTECTOR_PROTECTED_TOPIC, null, null, `0x${DEPLOYER.slice(2).toLowerCase().padStart(64, "0")}`] });
  });
});

describe("emitEvents", () => {
  const evt: KeeperEvent = { type: "grace", chainId: 84532, at: 1, source: "keeper", lineId: "1", data: {} };
  it("logs only without the binding", async () => {
    expect(await emitEvents(undefined, [evt])).toEqual(["grace:unsent(no binding)"]);
    expect(await emitEvents(undefined, [])).toEqual([]);
  });
  it("sends through the binding and never throws", async () => {
    const seen: KeeperEvent[] = [];
    const ok: EventsBinding = { ingest: async (e) => (seen.push(e), { accepted: true, id: "ev_1", deliveries: 2 }) };
    expect(await emitEvents(ok, [evt])).toEqual(["grace:accepted:ev_1:2"]);
    expect(seen).toEqual([evt]);
    const bad: EventsBinding = { ingest: async () => { throw new Error("no such entrypoint"); } };
    expect(await emitEvents(bad, [evt])).toEqual(["grace:failed(no such entrypoint)"]);
  });
});

describe("apiTick", () => {
  const ingest: EventsBinding["ingest"] = async () => ({ accepted: true, id: "ev_1", deliveries: 0 });
  it("is a no-op without a binding or without tick", async () => {
    expect(await apiTick(undefined)).toBe("unbound");
    expect(await apiTick({ ingest })).toBe("unbound");
  });
  it("reports the API's cron outcome and never throws", async () => {
    let calls = 0;
    expect(await apiTick({ ingest, tick: async () => (calls++, { cron: "ok", polled: "credit-desk" }) })).toBe("ok");
    expect(await apiTick({ ingest, tick: async () => ({ polled: 0 }) })).toBe("ok");
    expect(await apiTick({ ingest, tick: async () => { throw new Error("no such method"); } })).toBe("failed(no such method)");
    expect(await apiTick({ ingest, tick: () => new Promise(() => {}) }, 5)).toBe("failed(timeout)");
    expect(calls).toBe(1);
  });
});

describe("rpcClient", () => {
  const respond = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
  it("falls through dead and erroring nodes in order, and returns a revert at once", async () => {
    const hits: string[] = [];
    const f: FetchLike = async (url, init) => {
      hits.push(url);
      const req = JSON.parse(String(init.body)) as { id: number; method: string };
      if (url === "https://a") return respond({}, 503);
      if (url === "https://b") return respond({ jsonrpc: "2.0", id: req.id, error: { code: -32005, message: "rate limited" } });
      if (req.method === "eth_call") return respond({ jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted" } });
      return respond({ jsonrpc: "2.0", id: req.id, result: "0x10" });
    };
    const c = rpcClient(["https://a", "https://b", "https://c"], f, 0);
    expect(await c.call("eth_blockNumber", [])).toBe("0x10");
    expect(hits).toEqual(["https://a", "https://b", "https://c"]);
    await expect(c.call("eth_call", [{}])).rejects.toBeInstanceOf(RpcCallError);
    await expect(rpcClient([], f, 0).call("eth_chainId", [])).rejects.toBeInstanceOf(RpcError);
  });
  it("answers a batch per entry and skips a node that does not batch", async () => {
    const f: FetchLike = async (url, init) => {
      const req = JSON.parse(String(init.body)) as { id: number; method: string }[];
      if (url === "https://nobatch") return respond({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch not supported" } });
      return respond(req.map((r) => (r.method === "bad" ? { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "no such method" } } : { jsonrpc: "2.0", id: r.id, result: r.method })).reverse());
    };
    const out = await rpcClient(["https://nobatch", "https://ok"], f, 0).batch([{ method: "eth_blockNumber", params: [] }, { method: "bad", params: [] }, { method: "eth_gasPrice", params: [] }]);
    expect(out).toEqual([{ ok: true, result: "eth_blockNumber" }, { ok: false, error: "rpc -32601 no such method" }, { ok: true, result: "eth_gasPrice" }]);
  });
  it("re-sends a batch to the next node when any entry is rate-limited, and keeps the last node's answer", async () => {
    const hits: string[] = [];
    const limitedAnswer = (req: { id: number; method: string }[]) =>
      req.map((r, i) => (i === 1 ? { jsonrpc: "2.0", id: r.id, error: { code: -32007, message: "25/second request limit reached - reduce calls per second or upgrade your account" } } : { jsonrpc: "2.0", id: r.id, result: "0x1" }));
    const f: FetchLike = async (url, init) => {
      hits.push(url);
      const req = JSON.parse(String(init.body)) as { id: number; method: string }[];
      if (url === "https://limited" || url === "https://last") return respond(limitedAnswer(req));
      return respond(req.map((r) => ({ jsonrpc: "2.0", id: r.id, result: "0x2" })));
    };
    const calls = [{ method: "eth_blockNumber", params: [] }, { method: "eth_call", params: [] }];
    expect(await rpcClient(["https://limited", "https://ok"], f, 0).batch(calls)).toEqual([{ ok: true, result: "0x2" }, { ok: true, result: "0x2" }]);
    expect(hits).toEqual(["https://limited", "https://ok"]);
    const last = await rpcClient(["https://limited", "https://last"], f, 0).batch(calls);
    expect(last[1]).toMatchObject({ ok: false, error: expect.stringContaining("-32007") });
    // a revert in a batch is the chain's answer, not the node's: no re-send
    hits.length = 0;
    const revertF: FetchLike = async (url, init) => {
      hits.push(url);
      const req = JSON.parse(String(init.body)) as { id: number }[];
      return respond(req.map((r) => ({ jsonrpc: "2.0", id: r.id, error: { code: 3, message: "execution reverted" } })));
    };
    await rpcClient(["https://a", "https://b"], revertF, 0).batch(calls);
    expect(hits).toEqual(["https://a"]);
  });
});

describe("module-scope warm-up", () => {
  it("runs to the end without throwing (it swallows failures, so prove there are none)", async () => {
    await expect(warmed).resolves.toBeUndefined();
    const { runWarmUp } = await import("../src/warm.js");
    await expect(runWarmUp()).resolves.toMatchObject({ protectArmed: true, vaultArmed: true, mirrorSent: 1, events: ["grace:IN_GRACE", "grace:IN_BAND", "protect:armed", "protect:executed"] });
  });
});
