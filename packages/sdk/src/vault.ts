// The desk-side protection vault (DeskProtectionVault, live on Base Sepolia since 7 Oct 2026): the funding ladder
// behind the any-hour protective repay on a CreditDesk line. Step 1 is the user's own USDC reserve in this vault, step 2
// the partner's, step 3 a bounded advance funded by the Boundline Reserve and settled later with its fee. This file
// reads the vault (reserves, a line's advance, how a protect would be funded right now, the line's debt, the terms)
// and prepares the calls a user signs: deposit (with the USDC approve), withdraw, and settling an advance.
// The keeper alone calls `protect`; nothing here can move a user's reserve except the user.
import { encodeFunctionData, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { deskProtectionVaultAbi } from "./abi/deskProtectionVault.js";
import { prepareApprove, type Call } from "./calls.js";
import type { BoundlineChainConfig } from "./config.js";

/** One line's advance account: principal and fee still owed, lifetime totals, and when it last moved. */
export interface VaultAdvance {
  outstanding: bigint;
  feeOutstanding: bigint;
  totalAdvanced: bigint;
  totalSettled: bigint;
  lastAdvanceAt: number;
  lastSettledAt: number;
}

/** How a protective repay of a given size would be paid for right now, rung by rung; `shortfall` is what no rung covers. */
export interface VaultFunding {
  fromUser: bigint;
  fromPartner: bigint;
  fromAdvance: bigint;
  shortfall: bigint;
}

export interface VaultTerms {
  vault: Address;
  /** The only address allowed to call `protect`, `recover` and `returnCollateral`. */
  keeper: Address;
  /** The Boundline Reserve (or another funder) that places and recalls advance liquidity. */
  funder: Address;
  paused: boolean;
  /** USDC the vault may advance right now. */
  advanceLiquidity: bigint;
  /** Per-line ceiling on outstanding advances (0 = no per-line cap). */
  advanceCapPerLine: bigint;
  advanceFeeBps: number;
  totalOutstanding: bigint;
  feesCollected: bigint;
}

export interface VaultReader {
  readonly vault: Address;
  /** The user's protection reserve (ladder step 1), USDC base units. */
  userBalance(user: Address): Promise<bigint>;
  /** The partner's protection reserve (ladder step 2); defaults to the config's partner. */
  partnerBalance(partnerId?: Hex): Promise<bigint>;
  advanceOf(lineId: bigint): Promise<VaultAdvance>;
  /** The vault's own answer to "how would `amount` be funded for this line now". */
  previewProtect(lineId: bigint, amount: bigint): Promise<VaultFunding>;
  /** The line's debt on Morpho with interest accrued: the number `protect` works from. */
  debtOf(lineId: bigint): Promise<bigint>;
  /** Collateral the vault recovered through the desk and holds for the line. */
  heldCollateral(lineId: bigint): Promise<bigint>;
  terms(): Promise<VaultTerms>;
}

export function vaultOf(cfg: BoundlineChainConfig): Address {
  if (!cfg.deskProtectionVault) throw new Error(`no DeskProtectionVault on ${cfg.name}`);
  return cfg.deskProtectionVault;
}

/** What settling a line's advance costs right now: `repayAdvance` takes the principal first, then the fee. */
export function advanceDue(a: Pick<VaultAdvance, "outstanding" | "feeOutstanding">): bigint {
  return a.outstanding + a.feeOutstanding;
}

/** True when the line owes the vault anything (principal or fee). */
export function hasAdvance(a: Pick<VaultAdvance, "outstanding" | "feeOutstanding">): boolean {
  return advanceDue(a) > 0n;
}

export function createVaultReader(client: PublicClient, cfg: BoundlineChainConfig): VaultReader {
  const vault = vaultOf(cfg);
  const read = client.readContract.bind(client);
  return {
    vault,
    userBalance: (user) => read({ address: vault, abi: deskProtectionVaultAbi, functionName: "userBalance", args: [getAddress(user)] }),
    partnerBalance: (partnerId = cfg.partnerId) => read({ address: vault, abi: deskProtectionVaultAbi, functionName: "partnerBalance", args: [partnerId] }),
    async advanceOf(lineId) {
      const a = await read({ address: vault, abi: deskProtectionVaultAbi, functionName: "advanceOf", args: [lineId] });
      return {
        outstanding: a.outstanding,
        feeOutstanding: a.feeOutstanding,
        totalAdvanced: a.totalAdvanced,
        totalSettled: a.totalSettled,
        lastAdvanceAt: Number(a.lastAdvanceAt),
        lastSettledAt: Number(a.lastSettledAt),
      };
    },
    async previewProtect(lineId, amount) {
      const f = await read({ address: vault, abi: deskProtectionVaultAbi, functionName: "previewProtect", args: [lineId, amount] });
      return { fromUser: f.fromUser, fromPartner: f.fromPartner, fromAdvance: f.fromAdvance, shortfall: f.shortfall };
    },
    debtOf: (lineId) => read({ address: vault, abi: deskProtectionVaultAbi, functionName: "debtOf", args: [lineId] }),
    heldCollateral: (lineId) => read({ address: vault, abi: deskProtectionVaultAbi, functionName: "heldCollateral", args: [lineId] }),
    async terms() {
      const [keeper, funder, paused, advanceLiquidity, advanceCapPerLine, advanceFeeBps, totalOutstanding, feesCollected] = await Promise.all([
        read({ address: vault, abi: deskProtectionVaultAbi, functionName: "keeper" }),
        read({ address: vault, abi: deskProtectionVaultAbi, functionName: "funder" }),
        read({ address: vault, abi: deskProtectionVaultAbi, functionName: "paused" }),
        read({ address: vault, abi: deskProtectionVaultAbi, functionName: "advanceLiquidity" }),
        read({ address: vault, abi: deskProtectionVaultAbi, functionName: "advanceCapPerLine" }),
        read({ address: vault, abi: deskProtectionVaultAbi, functionName: "advanceFeeBps" }),
        read({ address: vault, abi: deskProtectionVaultAbi, functionName: "totalOutstanding" }),
        read({ address: vault, abi: deskProtectionVaultAbi, functionName: "feesCollected" }),
      ]);
      return { vault, keeper, funder, paused, advanceLiquidity, advanceCapPerLine, advanceFeeBps: Number(advanceFeeBps), totalOutstanding, feesCollected };
    },
  };
}

const vaultCall = (cfg: BoundlineChainConfig, data: Hex): Call => ({ to: vaultOf(cfg), data, value: 0n });

export interface VaultDepositOptions {
  /** Fund someone else's reserve (`depositFor`): a partner topping up a user, a friend, a keeper. Default: the caller's own. */
  for?: Address;
  /** False when the vault's USDC allowance already covers `amount` (skip the approve). Default true. */
  approve?: boolean;
}

/** approve(USDC → vault) then `deposit(amount)` (or `depositFor(user, amount)`): ladder step 1, the user's own protection reserve. */
export function prepareVaultDeposit(cfg: BoundlineChainConfig, amount: bigint, opts: VaultDepositOptions = {}): Call[] {
  if (amount <= 0n) throw new Error("deposit amount must be positive");
  const calls: Call[] = [];
  if (opts.approve ?? true) calls.push(prepareApprove(cfg.usdc, vaultOf(cfg), amount));
  const data = opts.for
    ? encodeFunctionData({ abi: deskProtectionVaultAbi, functionName: "depositFor", args: [getAddress(opts.for), amount] })
    : encodeFunctionData({ abi: deskProtectionVaultAbi, functionName: "deposit", args: [amount] });
  calls.push(vaultCall(cfg, data));
  return calls;
}

/** `withdraw(amount)`: the reserve goes back to its owner at any hour (the vault refuses more than the balance). */
export function prepareVaultWithdraw(cfg: BoundlineChainConfig, amount: bigint): Call {
  if (amount <= 0n) throw new Error("withdraw amount must be positive");
  return vaultCall(cfg, encodeFunctionData({ abi: deskProtectionVaultAbi, functionName: "withdraw", args: [amount] }));
}

/**
 * approve(USDC → vault) then `repayAdvance(lineId, amount)`: anyone may settle a line's advance, principal first, then the
 * fee; the vault pulls only what is owed. Pass `advanceDue(await reader.advanceOf(lineId))` to settle it all.
 */
export function prepareRepayAdvance(cfg: BoundlineChainConfig, lineId: bigint, amount: bigint, opts: { approve?: boolean } = {}): Call[] {
  if (amount <= 0n) throw new Error("settlement amount must be positive");
  const calls: Call[] = [];
  if (opts.approve ?? true) calls.push(prepareApprove(cfg.usdc, vaultOf(cfg), amount));
  calls.push(vaultCall(cfg, encodeFunctionData({ abi: deskProtectionVaultAbi, functionName: "repayAdvance", args: [lineId, amount] })));
  return calls;
}
