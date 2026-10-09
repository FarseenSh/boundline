import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, parseTransaction, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  HARVEST_GAS_LIMIT,
  HARVEST_SELECTOR,
  STANDINGS,
  decideHarvest,
  decodePreview,
  encodeHarvest,
  harvestGate,
  encodePreview,
  parseHarvestTargets,
  runHarvest,
  type HarvestPreview,
  type HarvestRpc,
  type Standing,
} from "../src/harvest-job.js";
import type { RpcCall, RpcOutcome } from "../src/rpc.js";

const HARVESTER: Address = "0x5b1d1975929d764f41BAb9DA32C696ba137BD58E";
const BORROWER: Address = "0xB789aD318945B37566E2549F65526Cc269a482Fc";
const MARKET: Hex = "0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047";
const WAD = 10n ** 18n;
const STEP = 1_000_537_939_576_369_481n; // NVDAc's 1 Oct 2026 dividend step, replayed on AAPLt 9 Oct
const ABI = parseAbi([
  "function keeper() view returns (address)",
  "function preview(address user, bytes32 marketId) view returns ((uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool))",
  "function harvest(address user, bytes32 marketId, uint256 deadline) returns (uint256, uint256)",
]);

/** The live preview just before the 9 Oct harvest (block 47,881,124). */
const READY: HarvestPreview = {
  standing: "READY",
  baseMultiplier: WAD,
  multiplier: STEP,
  collateral: 2_000_000n,
  debt: 3_210_307n,
  price8: 33_669_000_000n,
  dividendRaw: 1_075n,
  dividendValue: 3_619n,
  repayAssets: 3_582n,
  fullRepay: false,
};

function encPreview(p: HarvestPreview): Hex {
  return encodeAbiParameters(
    [{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }],
    [STANDINGS.indexOf(p.standing), p.baseMultiplier, p.multiplier, p.collateral, p.debt, p.price8, p.dividendRaw, p.dividendValue, p.repayAssets, p.fullRepay],
  );
}

describe("harvest encoding", () => {
  it("matches the contract's ABI for keeper, preview and harvest", () => {
    expect(HARVEST_SELECTOR.keeper).toBe(encodeFunctionData({ abi: ABI, functionName: "keeper" }));
    expect(encodePreview({ user: BORROWER, marketId: MARKET }).toLowerCase()).toBe(encodeFunctionData({ abi: ABI, functionName: "preview", args: [BORROWER, MARKET] }).toLowerCase());
    const data = encodeHarvest({ user: BORROWER, marketId: MARKET }, 1_791_531_138n);
    const decoded = decodeFunctionData({ abi: ABI, data });
    expect(decoded.functionName).toBe("harvest");
    expect(decoded.args).toEqual([BORROWER, MARKET, 1_791_531_138n]);
  });
  it("decodes the live 9 Oct preview", () => {
    expect(decodePreview(encPreview(READY))).toEqual(READY);
    expect(() => decodePreview("0x1234")).toThrow(/expected 320/);
  });
  it("parses HARVEST_TARGETS and refuses a malformed entry", () => {
    expect(parseHarvestTargets(undefined)).toEqual([]);
    expect(parseHarvestTargets(` ${BORROWER}:${MARKET.toUpperCase().replace("0X", "0x")} `)).toEqual([{ user: BORROWER, marketId: MARKET }]);
    expect(() => parseHarvestTargets(`${BORROWER}`)).toThrow(/entry 1/);
    expect(() => parseHarvestTargets(`${BORROWER}:${MARKET}:x`)).toThrow(/entry 1/);
  });
});

describe("decideHarvest", () => {
  const at = (standing: Standing): HarvestPreview => ({ ...READY, standing });
  it("harvests READY, re-bases a fall, a split-sized step, HEADROOM and no debt, and leaves the rest alone", () => {
    expect(decideHarvest(READY)).toEqual({ action: "harvest", repayAssets: 3_582n, dividendRaw: 1_075n });
    for (const s of ["STEP_DOWN", "STEP_TOO_LARGE", "HEADROOM", "NO_DEBT"] as const) expect(decideHarvest(at(s)).action).toBe("rebase");
    for (const s of ["NOT_ENROLLED", "GATE_CLOSED", "NO_CHANGE", "TOO_SMALL", "NOT_AUTHORIZED"] as const) expect(decideHarvest(at(s))).toEqual({ action: "none", reason: s });
  });
});

describe("runHarvest", () => {
  const account = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000003");
  const target = { user: BORROWER, marketId: MARKET };

  function fake(opts: { keeper?: Address; preview?: HarvestPreview; pending?: number; latest?: number; simRevert?: boolean; failBatch?: boolean } = {}) {
    const sent: Hex[] = [];
    const multicall = (): Hex =>
      encodeAbiParameters(
        [{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }],
        [[
          { success: true, returnData: encodeAbiParameters([{ type: "address" }], [opts.keeper ?? account.address]) },
          { success: true, returnData: encPreview(opts.preview ?? READY) },
        ]],
      );
    const one = (c: RpcCall): RpcOutcome => {
      switch (c.method) {
        case "eth_blockNumber":
          return { ok: true, result: "0x2da9b74" };
        case "eth_call": {
          const to = (c.params[0] as { to: string }).to.toLowerCase();
          if (to === HARVESTER.toLowerCase()) return opts.simRevert ? { ok: false, error: "rpc 3 execution reverted", data: "0x" } : { ok: true, result: "0x" };
          return { ok: true, result: multicall() };
        }
        case "eth_getTransactionCount":
          return { ok: true, result: `0x${((c.params[1] === "pending" ? opts.pending : opts.latest) ?? 70).toString(16)}` };
        case "eth_gasPrice":
          return { ok: true, result: "0x4c4b40" };
        case "eth_sendRawTransaction":
          sent.push(c.params[0] as Hex);
          return { ok: true, result: `0x${"ab".repeat(32)}` };
        default:
          return { ok: false, error: `unexpected ${c.method}` };
      }
    };
    const rpc: HarvestRpc = {
      async batch(calls) {
        if (opts.failBatch) throw new Error("rpc down");
        return calls.map(one);
      },
      async call<T>(method: string, params: readonly unknown[]) {
        const o = one({ method, params });
        if (!o.ok) throw new Error(o.error);
        return o.result as T;
      },
    };
    return { rpc, sent };
  }
  const deps = (rpc: HarvestRpc, extra: Record<string, unknown> = {}) => ({ rpc, harvester: HARVESTER, targets: [target], account, chainId: 84532, now: () => 1_791_530_538_000, ...extra });

  it("sends harvest(user, market, now + 600) from the signer at the pending nonce when a dividend is READY", async () => {
    const { rpc, sent } = fake();
    const r = await runHarvest(deps(rpc));
    expect(r).toMatchObject({ skipped: null, keeperIsSigner: true, head: 47_881_076 });
    expect(r.sent).toMatchObject({ action: "harvest", nonce: 70, deadline: 1_791_531_138, user: BORROWER });
    expect(sent).toHaveLength(1);
    const tx = parseTransaction(sent[0]!);
    expect(tx).toMatchObject({ to: HARVESTER.toLowerCase(), nonce: 70, gas: HARVEST_GAS_LIMIT, chainId: 84532 });
    expect(decodeFunctionData({ abi: ABI, data: tx.data! }).args).toEqual([BORROWER, MARKET, 1_791_531_138n]);
  });
  it("re-bases on a step down with the same call", async () => {
    const { rpc, sent } = fake({ preview: { ...READY, standing: "STEP_DOWN", baseMultiplier: STEP, multiplier: WAD, dividendRaw: 0n, dividendValue: 0n, repayAssets: 0n } });
    const r = await runHarvest(deps(rpc));
    expect(r.targets[0]!.decision).toEqual({ action: "rebase", from: STEP, to: WAD });
    expect(r.sent?.action).toBe("rebase");
    expect(sent).toHaveLength(1);
  });
  it("does nothing outside an open session or with no change", async () => {
    for (const standing of ["GATE_CLOSED", "NO_CHANGE"] as const) {
      const { rpc, sent } = fake({ preview: { ...READY, standing } });
      expect((await runHarvest(deps(rpc))).skipped).toBe("nothing-to-do");
      expect(sent).toHaveLength(0);
    }
  });
  it("never signs a simulated revert", async () => {
    const { rpc, sent } = fake({ simRevert: true });
    const r = await runHarvest(deps(rpc));
    expect(r.skipped).toBe("would-revert");
    expect(r.targets[0]!.decision?.action).toBe("none");
    expect(sent).toHaveLength(0);
  });
  it("watches until the harvester's keeper is this signer, yields the shared signer, waits while a transaction is in flight", async () => {
    const notKeeper = fake({ keeper: "0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E" });
    expect((await runHarvest(deps(notKeeper.rpc))).skipped).toBe("not-keeper");
    const busy = fake();
    expect((await runHarvest(deps(busy.rpc, { signerBusy: true }))).skipped).toBe("signer-busy");
    const inflight = fake({ pending: 71, latest: 70 });
    expect((await runHarvest(deps(inflight.rpc))).skipped).toBe("in-flight");
    for (const f of [notKeeper, busy, inflight]) expect(f.sent).toHaveLength(0);
  });
  it("never signs in a dry run or without a key, and never throws on a failed read", async () => {
    const dry = fake();
    expect((await runHarvest(deps(dry.rpc, { dryRun: true }))).sent).toBeNull();
    expect(dry.sent).toHaveLength(0);
    const noKey = fake();
    expect((await runHarvest(deps(noKey.rpc, { account: null }))).skipped).toBe("no-key");
    const down = fake({ failBatch: true });
    const r = await runHarvest(deps(down.rpc));
    expect(r.skipped).toBe("read-failed");
    expect(r.errors[0]).toContain("rpc down");
    expect((await runHarvest(deps(fake().rpc, { targets: [] }))).skipped).toBe("no-targets");
  });
});

describe("harvestGate", () => {
  it("reads nothing while a protection job wants the signer or the market is closed", () => {
    expect(harvestGate({ signerWanted: false, marketClosed: false })).toBeNull();
    expect(harvestGate({ signerWanted: true, marketClosed: false })).toBe("signer-busy");
    expect(harvestGate({ signerWanted: false, marketClosed: true })).toBe("market-closed");
    expect(harvestGate({ signerWanted: true, marketClosed: true })).toBe("signer-busy");
  });
});
