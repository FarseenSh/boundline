import { custom, decodeFunctionData, encodeFunctionData, encodeFunctionResult, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { deskProtectionVaultAbi } from "../src/abi/deskProtectionVault.js";
import { erc20MinimalAbi } from "../src/abi/minimal.js";
import { BASE_MAINNET, BASE_SEPOLIA } from "../src/config.js";
import { createBoundline } from "../src/index.js";
import { advanceDue, hasAdvance, prepareRepayAdvance, prepareVaultDeposit, prepareVaultWithdraw, vaultOf } from "../src/vault.js";

const cfg = BASE_SEPOLIA;
const vault = cfg.deskProtectionVault!;
const user = getAddress("0xB789aD318945B37566E2549F65526Cc269a482Fc");
const keeper = getAddress("0x40668755c993A551dB05E844fF9150A0C00a0373");
const reserve = cfg.reserve!;

type Handler = { selector: string; result: Hex };
const sel = (data: Hex): string => data.slice(0, 10).toLowerCase();
const fn = (functionName: string, args: readonly unknown[] = []) => sel(encodeFunctionData({ abi: deskProtectionVaultAbi, functionName, args } as never));
const res = (functionName: string, result: unknown) => encodeFunctionResult({ abi: deskProtectionVaultAbi, functionName, result } as never);

// The 7 Oct live cycle in numbers: 1 USDC user reserve deposited, 0.2 USDC advanced on line 1 with a 1% fee.
const handlers: Handler[] = [
  { selector: fn("userBalance", [user]), result: res("userBalance", 0n) },
  { selector: fn("partnerBalance", [cfg.partnerId]), result: res("partnerBalance", 0n) },
  { selector: fn("advanceOf", [1n]), result: res("advanceOf", { outstanding: 200_000n, feeOutstanding: 2_000n, totalAdvanced: 200_000n, totalSettled: 0n, lastAdvanceAt: 1791370000n, lastSettledAt: 0n }) },
  { selector: fn("previewProtect", [1n, 700_000n]), result: res("previewProtect", { fromUser: 500_000n, fromPartner: 0n, fromAdvance: 200_000n, shortfall: 0n }) },
  { selector: fn("debtOf", [1n]), result: res("debtOf", 1_600_173n) },
  { selector: fn("heldCollateral", [1n]), result: res("heldCollateral", 0n) },
  { selector: fn("keeper"), result: res("keeper", keeper) },
  { selector: fn("funder"), result: res("funder", reserve) },
  { selector: fn("paused"), result: res("paused", false) },
  { selector: fn("advanceLiquidity"), result: res("advanceLiquidity", 1_000_000n) },
  { selector: fn("advanceCapPerLine"), result: res("advanceCapPerLine", 2_000_000n) },
  { selector: fn("advanceFeeBps"), result: res("advanceFeeBps", 100) },
  { selector: fn("totalOutstanding"), result: res("totalOutstanding", 0n) },
  { selector: fn("feesCollected"), result: res("feesCollected", 0n) },
];

const seen: { to: string; data: string }[] = [];
const transport = custom({
  async request({ method, params }: { method: string; params?: unknown }) {
    if (method === "eth_chainId") return "0x14a34";
    if (method !== "eth_call") throw new Error(`unexpected ${method}`);
    const [tx] = params as [{ to: string; data: Hex }];
    seen.push({ to: tx.to, data: tx.data });
    if (tx.to.toLowerCase() !== vault.toLowerCase()) throw new Error(`unexpected target ${tx.to}`);
    const h = handlers.find((x) => x.selector === sel(tx.data));
    if (!h) throw new Error(`no handler for ${sel(tx.data)}`);
    return h.result;
  },
});

describe("DeskProtectionVault reads", () => {
  const b = createBoundline({ chainId: 84532, transport });

  it("is wired on Sepolia; mainnet has no vault yet", () => {
    expect(b.vault?.vault).toBe(vault);
    expect(BASE_MAINNET.deskProtectionVault).toBeNull();
    expect(() => vaultOf(BASE_MAINNET)).toThrow(/no DeskProtectionVault/);
  });

  it("reads the reserves, a line's advance, the funding preview and the debt", async () => {
    expect(await b.vault!.userBalance(user)).toBe(0n);
    expect(await b.vault!.partnerBalance()).toBe(0n);
    const a = await b.vault!.advanceOf(1n);
    expect(a).toEqual({ outstanding: 200_000n, feeOutstanding: 2_000n, totalAdvanced: 200_000n, totalSettled: 0n, lastAdvanceAt: 1791370000, lastSettledAt: 0 });
    expect(advanceDue(a)).toBe(202_000n);
    expect(hasAdvance(a)).toBe(true);
    expect(hasAdvance({ outstanding: 0n, feeOutstanding: 0n })).toBe(false);
    expect(await b.vault!.previewProtect(1n, 700_000n)).toEqual({ fromUser: 500_000n, fromPartner: 0n, fromAdvance: 200_000n, shortfall: 0n });
    expect(await b.vault!.debtOf(1n)).toBe(1_600_173n);
    expect(await b.vault!.heldCollateral(1n)).toBe(0n);
  });

  it("reads the terms in one go", async () => {
    expect(await b.vault!.terms()).toEqual({ vault, keeper, funder: reserve, paused: false, advanceLiquidity: 1_000_000n, advanceCapPerLine: 2_000_000n, advanceFeeBps: 100, totalOutstanding: 0n, feesCollected: 0n });
  });
});

describe("DeskProtectionVault calls", () => {
  it("deposit approves USDC to the vault for exactly the amount, then deposits", () => {
    const calls = prepareVaultDeposit(cfg, 400_000n);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.to).toBe(cfg.usdc);
    expect(decodeFunctionData({ abi: erc20MinimalAbi, data: calls[0]!.data })).toEqual({ functionName: "approve", args: [vault, 400_000n] });
    expect(calls[1]!.to).toBe(vault);
    expect(decodeFunctionData({ abi: deskProtectionVaultAbi, data: calls[1]!.data })).toEqual({ functionName: "deposit", args: [400_000n] });
    expect(calls.every((c) => c.value === 0n)).toBe(true);
  });

  it("depositFor funds someone else's reserve; approve can be skipped", () => {
    const calls = prepareVaultDeposit(cfg, 1_000_000n, { for: user.toLowerCase() as `0x${string}`, approve: false });
    expect(calls).toHaveLength(1);
    expect(decodeFunctionData({ abi: deskProtectionVaultAbi, data: calls[0]!.data })).toEqual({ functionName: "depositFor", args: [user, 1_000_000n] });
  });

  it("withdraw and settle an advance", () => {
    const w = prepareVaultWithdraw(cfg, 250_000n);
    expect(w.to).toBe(vault);
    expect(decodeFunctionData({ abi: deskProtectionVaultAbi, data: w.data })).toEqual({ functionName: "withdraw", args: [250_000n] });
    const s = prepareRepayAdvance(cfg, 1n, 202_000n);
    expect(decodeFunctionData({ abi: erc20MinimalAbi, data: s[0]!.data })).toEqual({ functionName: "approve", args: [vault, 202_000n] });
    expect(decodeFunctionData({ abi: deskProtectionVaultAbi, data: s[1]!.data })).toEqual({ functionName: "repayAdvance", args: [1n, 202_000n] });
    expect(prepareRepayAdvance(cfg, 1n, 202_000n, { approve: false })).toHaveLength(1);
  });

  it("refuses zero amounts and a chain without a vault", () => {
    expect(() => prepareVaultDeposit(cfg, 0n)).toThrow(/positive/);
    expect(() => prepareVaultWithdraw(cfg, 0n)).toThrow(/positive/);
    expect(() => prepareRepayAdvance(cfg, 1n, 0n)).toThrow(/positive/);
    expect(() => prepareVaultDeposit(BASE_MAINNET, 1n)).toThrow(/no DeskProtectionVault/);
  });

  it("is reachable from the Boundline object", () => {
    const b = createBoundline({ chainId: 84532, transport });
    expect(b.prepare.vaultDeposit(1n)).toHaveLength(2);
    expect(b.prepare.vaultWithdraw(1n).to).toBe(vault);
    expect(b.prepare.repayAdvance(4n, 1n)).toHaveLength(2);
  });
});
