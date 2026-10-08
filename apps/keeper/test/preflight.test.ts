import { encodeAbiParameters, encodeErrorResult, toFunctionSelector, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { parseState, transitions } from "../src/events.js";
import { BACKOFF_BLOCKS, STANDING, protectFingerprint, type Sizing } from "../src/protect.js";
import { runProtect, simulate, type ProtectRpc } from "../src/protect-job.js";
import { ERRORS, decodeRevert, revertDataOf } from "../src/reverts.js";
import { RpcCallError, type RpcCall, type RpcOutcome } from "../src/rpc.js";
import { LADDER_PROBE } from "../src/vault.js";
import { runVault, simulateBatch, type VaultRpc } from "../src/vault-job.js";

const PRELIQ: Address = "0xdcae709341aab652144e8afcb47479fe49e133a1";
const DEPLOYER: Address = "0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E";
const PROTECTOR: Address = "0x5c546946c909718040dd686f63df6cb5e4df442c";
const FEED: Address = "0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a";
const VAULT: Address = "0x87f600279F021ca859b9903DE884d3A7A169f38c";
const DESK: Address = "0x39aBaDc0aAa12D1F7e259b89536Aa1848997399a";
const account = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000004");
const W = (x: bigint) => x.toString(16).padStart(64, "0");

const UNPAID = encodeErrorResult({ abi: [{ type: "error", name: "Unpaid", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }] }], errorName: "Unpaid", args: [PROTECTOR, 1_805_453n, 1_805_321n] });

describe("decodeRevert", () => {
  it("every selector in the table is the keccak of its signature (checked with viem)", () => {
    for (const [sel, sigs] of Object.entries(ERRORS)) for (const sig of sigs.split(" | ")) expect(toFunctionSelector(sig)).toBe(sel);
    expect(Object.keys(ERRORS).length).toBeGreaterThanOrEqual(98);
  });
  it("names custom errors, reads Error(string) and Panic, and says when it does not know", () => {
    expect(decodeRevert(UNPAID)).toBe("Unpaid(address,uint256,uint256)");
    const msg = encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }], errorName: "Error", args: ["ERC20: transfer amount exceeds balance"] });
    expect(decodeRevert(msg)).toBe('Error("ERC20: transfer amount exceeds balance")');
    expect(decodeRevert(`0x4e487b71${W(0x11n)}`)).toBe("Panic(0x11)");
    expect(decodeRevert("0xdeadbeef")).toBe("unknown error 0xdeadbeef");
    expect(decodeRevert("0x")).toBe("reverted without data");
    expect(decodeRevert(undefined)).toBe("reverted without data");
  });
  it("finds the revert payload on an RPC error in either shape", () => {
    expect(revertDataOf({ data: "0x1234" })).toBe("0x1234");
    expect(revertDataOf({ data: { data: "0xabcd" } })).toBe("0xabcd");
    expect(revertDataOf(new Error("x"))).toBeNull();
  });
});

const sizingTuple = Array.from({ length: 18 }, (_, i) => ({ type: i === 0 ? "uint8" : i === 6 || i === 15 ? "bool" : "uint256" }));
const closeOut: Sizing = {
  standing: "IN_BAND", collateral: 940_611n, borrowShares: 1_805_321_834_834n, debtAssets: 1_805_453n, shadowPrice36: 3_280_000_000_000_000_000_000_000_000_000_000_000n,
  venuePrice36: 0n, venueOracleLive: false, shadowLtvWad: 585_000_000_000_000_000n, venueLtvWad: 0n, preLifWad: 1_011_000_000_000_000_000n, preLcfWad: 10n ** 18n,
  targetLtvWad: 580_000_000_000_000_000n, maxSeizedAssets: 0n, maxRepaidShares: 0n, maxRepaidAssets: 0n, fullCloseAllowed: true, fullCloseSeizedAssets: 556_000n, fullCloseRepaidAssets: 1_805_453n,
};
const encSizing = (s: Sizing): Hex =>
  encodeAbiParameters(sizingTuple as never, [STANDING.indexOf(s.standing), s.collateral, s.borrowShares, s.debtAssets, s.shadowPrice36, s.venuePrice36, s.venueOracleLive, s.shadowLtvWad, s.venueLtvWad, s.preLifWad, s.preLcfWad, s.targetLtvWad, s.maxSeizedAssets, s.maxRepaidShares, s.maxRepaidAssets, s.fullCloseAllowed, s.fullCloseSeizedAssets, s.fullCloseRepaidAssets] as never);
const agg = (payloads: Hex[]): Hex => encodeAbiParameters([{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }], [payloads.map((p) => ({ success: true, returnData: p }))]);

function protectRpc(opts: { latest?: "ok" | "revert" | "down"; pending?: "ok" | "revert" | "down" } = {}) {
  const submissions: Hex[] = [];
  const sims: string[] = [];
  const rpc: ProtectRpc = {
    async read(method, params) {
      if (method === "eth_blockNumber") return "0x2d9fe00";
      if (method === "eth_call") {
        const call = params[0] as { to: string; from?: string };
        if (call.to.toLowerCase() === PROTECTOR.toLowerCase() && call.from) {
          const tag = params[1] as "latest" | "pending";
          sims.push(tag);
          const mode = (tag === "latest" ? opts.latest : opts.pending) ?? "ok";
          if (mode === "revert") throw new RpcCallError("eth_call", { code: 3, message: "execution reverted", data: UNPAID });
          if (mode === "down") throw new Error("eth_call failed on 3 RPC(s): timeout");
          return "0x";
        }
        return agg([encSizing(closeOut)]);
      }
      if (method === "eth_getStorageAt") return `0x${W(1791590400n)}`;
      if (method === "eth_getTransactionCount") return "0x9";
      if (method === "eth_gasPrice") return "0x4c4b40";
      throw new Error(`unexpected ${method}`);
    },
    async submitValidity(raw) {
      submissions.push(raw);
      return `0x${W(BigInt(submissions.length))}` as Hex;
    },
  };
  return { rpc, submissions, sims };
}
const target = { preLiq: PRELIQ, borrower: DEPLOYER, feed: FEED, feedSlot: 5n };
const base = { protector: PROTECTOR, targets: [target], account, chainId: 84532, sleep: async () => undefined };

describe("Protector pre-flight", () => {
  it("an unpayable close-out is simulated, reported would-revert with the decoded error, and never signed", async () => {
    const { rpc, submissions, sims } = protectRpc({ latest: "revert", pending: "revert" });
    const r = await runProtect({ rpc, ...base });
    expect(sims.sort()).toEqual(["latest", "pending"]);
    expect(submissions).toHaveLength(0);
    expect(r.armed).toBeNull();
    expect(r.skipped).toBe("would-revert");
    expect(r.targets[0]!.decision).toEqual({ action: "none", reason: "would-revert", error: "Unpaid(address,uint256,uint256)" });
    expect(r.targets[0]!.simulation).toEqual({ latest: "Unpaid(address,uint256,uint256)", pending: "Unpaid(address,uint256,uint256)" });
    expect(r.targets[0]!.fingerprint).toBe(protectFingerprint(closeOut, "close"));
  });
  it("a clean simulation is signed; a reverting pending blocks; an unavailable pending does not", async () => {
    const ok = protectRpc();
    expect((await runProtect({ rpc: ok.rpc, ...base })).armed).toMatchObject({ action: "close", feeStep: 0 });
    expect(ok.submissions).toHaveLength(1);
    const pendingRevert = protectRpc({ pending: "revert" });
    const r = await runProtect({ rpc: pendingRevert.rpc, ...base });
    expect(r.targets[0]!.decision).toMatchObject({ reason: "would-revert", error: "pending: Unpaid(address,uint256,uint256)" });
    expect(pendingRevert.submissions).toHaveLength(0);
    const pendingDown = protectRpc({ pending: "down" });
    expect((await runProtect({ rpc: pendingDown.rpc, ...base })).armed).not.toBeNull();
  });
  it("cannot simulate → does not sign this tick (simulation-unavailable)", async () => {
    const { rpc, submissions } = protectRpc({ latest: "down" });
    const r = await runProtect({ rpc, ...base });
    expect(r.targets[0]!.decision).toMatchObject({ action: "none", reason: "simulation-unavailable" });
    expect(r.skipped).toBe("simulation-unavailable");
    expect(submissions).toHaveLength(0);
  });
  it("backs off after a revert until the head passes or the fingerprint changes", async () => {
    const fp = protectFingerprint(closeOut, "close");
    const held = protectRpc();
    const r = await runProtect({ rpc: held.rpc, ...base, backoff: () => ({ untilHead: 0x2d9fe00 + 100, fingerprint: fp, error: "Unpaid(address,uint256,uint256)", at: 1 }) });
    expect(r.skipped).toBe("backoff");
    expect(r.targets[0]!.decision).toMatchObject({ reason: "backoff", untilHead: 0x2d9fe00 + 100 });
    expect(held.sims).toHaveLength(0); // no simulation while backing off
    const changed = protectRpc();
    expect((await runProtect({ rpc: changed.rpc, ...base, backoff: () => ({ untilHead: 0x2d9fe00 + 100, fingerprint: "other", error: "x", at: 1 }) })).armed).not.toBeNull();
    const expired = protectRpc();
    expect((await runProtect({ rpc: expired.rpc, ...base, backoff: () => ({ untilHead: 0x2d9fe00, fingerprint: fp, error: "x", at: 1 }) })).armed).not.toBeNull();
  });
  it("the live view simulates with the signer and never signs (dry run)", async () => {
    const { rpc, submissions, sims } = protectRpc();
    const r = await runProtect({ rpc, ...base, dryRun: true });
    expect(r.skipped).toBe("dry-run");
    expect(r.targets[0]!.simulation).toEqual({ latest: "ok", pending: "ok" });
    expect(sims).toHaveLength(2);
    expect(submissions).toHaveLength(0);
  });
  it("simulate() pins the from address and the exact calldata", async () => {
    const seen: unknown[] = [];
    const rpc = { read: async (_m: string, p: unknown[]) => (seen.push(p), "0x") };
    expect((await simulate(rpc, account.address, PROTECTOR, "0x0edfc057")).verdict).toBe("ok");
    expect(seen).toEqual([[{ from: account.address, to: PROTECTOR, data: "0x0edfc057" }, "latest"], [{ from: account.address, to: PROTECTOR, data: "0x0edfc057" }, "pending"]]);
  });
});

describe("vault pre-flight", () => {
  const ADVANCE_CAP = encodeErrorResult({ abi: [{ type: "error", name: "AdvanceCapExceeded", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }] }], errorName: "AdvanceCapExceeded", args: [2_000_000n, 80_000n, 2_000_000n] });
  const line = encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint32" }, { type: "uint8" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint128" }], [`0x${"11".repeat(32)}`, "0xB789aD318945B37566E2549F65526Cc269a482Fc", `0x${"22".repeat(32)}`, "0xB2000000000000000000000E063E65377cA34141", 2, 1, `0x${"0".repeat(64)}`, 1n, 3_220_000n]);
  const quote = encodeAbiParameters(Array.from({ length: 10 }, (_, i) => ({ type: i < 2 ? "uint8" : i === 9 ? "bool" : "uint256" })) as never, [6, 5, 0n, 2_000_000n, 0n, 3_220_175n, 0n, 0n, 5n * 10n ** 17n, false] as never);
  const ladder = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [400_000n, 0n, 1_000_000n, LADDER_PROBE - 1_400_000n]);
  function vaultRpc(sim: "ok" | "revert") {
    const submissions: Hex[] = [];
    const sims: string[] = [];
    const one = (c: RpcCall): RpcOutcome => {
      if (c.method === "eth_blockNumber") return { ok: true, result: "0x2d9fe00" };
      if (c.method === "eth_call") {
        const call = c.params[0] as { to: string; from?: string };
        if (call.from) {
          sims.push(c.params[1] as string);
          return sim === "ok" ? { ok: true, result: "0x" } : { ok: false, error: "rpc 3 execution reverted", data: ADVANCE_CAP };
        }
        return { ok: true, result: agg([`0x${W(BigInt(account.address))}`, `0x${W(0n)}`, line, quote, `0x${W(3n * 10n ** 36n)}`, ladder]) };
      }
      if (c.method === "eth_getStorageAt") return { ok: true, result: `0x${W(1791590400n)}` };
      if (c.method === "eth_getTransactionCount") return { ok: true, result: "0x9" };
      if (c.method === "eth_gasPrice") return { ok: true, result: "0x4c4b40" };
      return { ok: false, error: "unexpected" };
    };
    const rpc: VaultRpc = {
      batch: async (calls) => calls.map(one),
      call: async <T,>(method: string, params: readonly unknown[]) => one({ method, params }) as unknown as T,
      submitValidity: async (raw) => (submissions.push(raw), `0x${W(1n)}` as Hex),
    };
    return { rpc, submissions, sims };
  }
  const t = { lineId: 1n, graceLtvBps: 5200, targetLtvBps: 4500, shadowOracle: "0x7a53b459be6e5e9a12324cc3417bb027daf73f65" as Address, feed: FEED, feedSlot: 5n };
  const vdeps = (rpc: VaultRpc, extra: Record<string, unknown> = {}) => ({ rpc, vault: VAULT, desk: DESK, targets: [t], account, chainId: 84532, sleep: async () => undefined, ...extra });

  it("a reverting repay is reported would-revert with the decoded error and never signed", async () => {
    const { rpc, submissions, sims } = vaultRpc("revert");
    const r = await runVault(vdeps(rpc));
    expect(sims.sort()).toEqual(["latest", "pending"]);
    expect(submissions).toHaveLength(0);
    expect(r.skipped).toBe("would-revert");
    expect(r.targets[0]!.decision).toEqual({ action: "none", reason: "would-revert", error: "AdvanceCapExceeded(uint256,uint256,uint256)" });
    expect(r.targets[0]!.fingerprint).toMatch(/^\d+:400000\/0\/1000000:false:OPEN:/);
  });
  it("a clean simulation is signed; a backoff holds without simulating", async () => {
    const ok = vaultRpc("ok");
    expect((await runVault(vdeps(ok.rpc))).armed).not.toBeNull();
    expect(ok.submissions).toHaveLength(1);
    const first = await runVault(vdeps(vaultRpc("revert").rpc));
    const fp = first.targets[0]!.fingerprint!;
    const held = vaultRpc("ok");
    const r = await runVault(vdeps(held.rpc, { backoff: () => ({ untilHead: 0x2d9fe00 + 10, fingerprint: fp, error: "AdvanceCapExceeded(uint256,uint256,uint256)", at: 1 }) }));
    expect(r.skipped).toBe("backoff");
    expect(held.sims).toHaveLength(0);
    expect(held.submissions).toHaveLength(0);
  });
  it("simulateBatch reads a batch error's revert data", async () => {
    const rpc = { batch: async () => [{ ok: false as const, error: "rpc 3 execution reverted", data: ADVANCE_CAP }, { ok: true as const, result: "0x" }] };
    expect(await simulateBatch(rpc, account.address, VAULT, "0x1bb980bb")).toMatchObject({ verdict: "revert", error: "AdvanceCapExceeded(uint256,uint256,uint256)" });
  });
});

describe("backoff state", () => {
  it("a would-revert starts a backoff (no event); an arming clears it; it lapses at its head", () => {
    const vaultRow = { lineId: "1", graceLtvBps: 5200, targetLtvBps: 4500, line: null, quote: null, sizing: null, ladder: null, funding: null, decision: { action: "none" as const, reason: "would-revert" as const, error: "AdvanceCapExceeded(uint256,uint256,uint256)" }, fingerprint: "fp1" };
    const report = { at: 1, ms: 1, vault: VAULT, keeper: null, signer: null, keeperIsSigner: true, paused: false, head: 47_840_000, targets: [vaultRow], armed: null, skipped: "would-revert" as const, errors: [] };
    const a = transitions(parseState(null), { chainId: 84532, now: 1, vault: report, protect: null, executions: [], head: 47_840_000 });
    expect(a.events).toEqual([]);
    expect(a.next.backoff["line:1"]).toEqual({ untilHead: 47_840_000 + BACKOFF_BLOCKS, fingerprint: "fp1", error: "AdvanceCapExceeded(uint256,uint256,uint256)", at: 1 });
    expect(a.changed).toBe(true);
    // the same revert again does not rewrite the state (no KV write per tick)
    expect(transitions(a.next, { chainId: 84532, now: 2, vault: report, protect: null, executions: [], head: 47_840_060 }).changed).toBe(false);
    const lapsed = transitions(a.next, { chainId: 84532, now: 3, vault: null, protect: null, executions: [], head: 47_840_000 + BACKOFF_BLOCKS });
    expect(lapsed.next.backoff).toEqual({});
    const armed = { lineId: "1", amount: 480_000n, funding: { fromUser: 400_000n, fromPartner: 0n, fromAdvance: 80_000n, shortfall: 0n }, hash: `0x${W(5n)}` as Hex, nonce: 9, bound: 47_840_100, head: 47_840_070, attempts: 1, alreadyKnown: false, feeStep: 0 };
    const cleared = transitions(a.next, { chainId: 84532, now: 4, vault: { ...report, targets: [], armed }, protect: null, executions: [], head: 47_840_070 });
    expect(cleared.next.backoff).toEqual({});
    expect(cleared.events.map((e) => e.type)).toEqual(["protect"]);
  });
});
