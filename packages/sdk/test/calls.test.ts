import { encodeFunctionData, maxUint256 } from "viem";
import { describe, expect, it } from "vitest";
import { creditDeskAbi } from "../src/abi/creditDesk.js";
import { erc20MinimalAbi, morphoMinimalAbi } from "../src/abi/minimal.js";
import {
  REPAY_ALL,
  borrowBatch,
  prepareAddCollateral,
  prepareApprove,
  prepareAuthorize,
  prepareAuthorizeDesk,
  prepareCloseLine,
  prepareDraw,
  prepareOpenLine,
  prepareRepay,
  prepareWithdrawCollateral,
  repayBatch,
} from "../src/calls.js";
import { BASE_MAINNET, BASE_SEPOLIA } from "../src/config.js";

const cfg = BASE_SEPOLIA;
const desk = cfg.desk!;
const user = "0xB789aD318945B37566E2549F65526Cc269a482Fc" as const;
const market = cfg.markets[0]!;

describe("prepared calls encode exactly what the ABI says", () => {
  it("authorise the desk on Morpho", () => {
    const c = prepareAuthorizeDesk(cfg);
    expect(c.to).toBe(cfg.morpho);
    expect(c.value).toBe(0n);
    expect(c.data).toBe(encodeFunctionData({ abi: morphoMinimalAbi, functionName: "setAuthorization", args: [desk, true] }));
    expect(prepareAuthorizeDesk(cfg, false).data).toBe(encodeFunctionData({ abi: morphoMinimalAbi, functionName: "setAuthorization", args: [desk, false] }));
    expect(prepareAuthorize(cfg, user, true).data).toBe(encodeFunctionData({ abi: morphoMinimalAbi, functionName: "setAuthorization", args: [user, true] }));
  });
  it("approve", () => {
    const c = prepareApprove(cfg.usdc, desk, 5_000_000n);
    expect(c.to).toBe(cfg.usdc);
    expect(c.data).toBe(encodeFunctionData({ abi: erc20MinimalAbi, functionName: "approve", args: [desk, 5_000_000n] }));
  });
  it("openLine with the default partner and an empty signature", () => {
    const c = prepareOpenLine(cfg, { marketId: market.id, deadline: 1_800_000_000n });
    expect(c.to).toBe(desk);
    expect(c.data).toBe(encodeFunctionData({ abi: creditDeskAbi, functionName: "openLine", args: [cfg.partnerId, market.id, 1_800_000_000n, "0x"] }));
  });
  it("addCollateral, draw, repay, withdraw, close", () => {
    expect(prepareAddCollateral(cfg, 1n, 100_000_000n).data).toBe(encodeFunctionData({ abi: creditDeskAbi, functionName: "addCollateral", args: [1n, 100_000_000n] }));
    expect(prepareDraw(cfg, 1n, 1_000_000n).data).toBe(encodeFunctionData({ abi: creditDeskAbi, functionName: "draw", args: [1n, 1_000_000n] }));
    expect(prepareRepay(cfg, 1n, 1_000_000n).data).toBe(encodeFunctionData({ abi: creditDeskAbi, functionName: "repay", args: [1n, 1_000_000n] }));
    expect(prepareRepay(cfg, 1n).data).toBe(encodeFunctionData({ abi: creditDeskAbi, functionName: "repay", args: [1n, maxUint256] }));
    expect(prepareWithdrawCollateral(cfg, 1n, 50_000_000n).data).toBe(encodeFunctionData({ abi: creditDeskAbi, functionName: "withdrawCollateral", args: [1n, 50_000_000n] }));
    expect(prepareCloseLine(cfg, 1n).data).toBe(encodeFunctionData({ abi: creditDeskAbi, functionName: "closeLine", args: [1n] }));
  });
  it("REPAY_ALL is type(uint256).max", () => {
    expect(REPAY_ALL).toBe(2n ** 256n - 1n);
  });
  it("refuses a chain without a desk", () => {
    expect(() => prepareDraw(BASE_MAINNET, 1n, 1n)).toThrow(/no CreditDesk/);
  });
});

describe("batches", () => {
  it("full borrow: authorise → approve → addCollateral → draw", () => {
    const b = borrowBatch(cfg, { lineId: 1n, draw: 2_000_000n, addCollateral: { token: market.collateral, amount: 100_000_000n }, needsAuthorization: true });
    expect(b.map((c) => c.to)).toEqual([cfg.morpho, market.collateral, desk, desk]);
    expect(b[1]!.data).toBe(encodeFunctionData({ abi: erc20MinimalAbi, functionName: "approve", args: [desk, 100_000_000n] }));
    expect(b[3]!.data).toBe(prepareDraw(cfg, 1n, 2_000_000n).data);
  });
  it("draw only when already authorised and collateralised", () => {
    const b = borrowBatch(cfg, { lineId: 1n, draw: 2_000_000n, needsAuthorization: false });
    expect(b).toHaveLength(1);
    expect(b[0]!.data).toBe(prepareDraw(cfg, 1n, 2_000_000n).data);
  });
  it("skips the approval when the allowance already covers it", () => {
    const b = borrowBatch(cfg, { lineId: 1n, draw: 0n, addCollateral: { token: market.collateral, amount: 1n }, needsAuthorization: false, needsApproval: false });
    expect(b.map((c) => c.to)).toEqual([desk]);
  });
  it("refuses an empty batch", () => {
    expect(() => borrowBatch(cfg, { lineId: 1n, draw: 0n, needsAuthorization: false })).toThrow(/nothing to do/);
  });
  it("repay batch approves USDC then repays", () => {
    const b = repayBatch(cfg, { lineId: 1n, amount: REPAY_ALL, approve: 1_010_000n });
    expect(b.map((c) => c.to)).toEqual([cfg.usdc, desk]);
    expect(b[0]!.data).toBe(encodeFunctionData({ abi: erc20MinimalAbi, functionName: "approve", args: [desk, 1_010_000n] }));
    expect(b[1]!.data).toBe(prepareRepay(cfg, 1n).data);
  });
});
