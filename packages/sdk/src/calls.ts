// Every user-signed call the desk accepts, prepared as {to, data, value} so a wallet can batch them
// with wallet_sendCalls or send them one by one. The desk's own access rules apply: draw,
// withdrawCollateral and closeLine are for the line owner (CreditDesk.sol lines 432-496), addCollateral
// and repay are for anyone, and openLine is for the caller who becomes the line owner.
import { encodeFunctionData, maxUint256, type Address, type Hex } from "viem";
import { creditDeskAbi } from "./abi/creditDesk.js";
import { erc20MinimalAbi, morphoMinimalAbi } from "./abi/minimal.js";
import type { BoundlineChainConfig } from "./config.js";
import { payoutRouterOf, preparePayout, type PayoutRequest } from "./payout.js";

export interface Call {
  to: Address;
  data: Hex;
  value: bigint;
}

/** CreditDesk.REPAY_ALL = type(uint256).max: repay exactly the debt by shares and refund the rest. */
export const REPAY_ALL: bigint = maxUint256;

function deskOf(cfg: BoundlineChainConfig): Address {
  if (!cfg.desk) throw new Error(`no CreditDesk on ${cfg.name}`);
  return cfg.desk;
}

const call = (to: Address, data: Hex): Call => ({ to, data, value: 0n });

/** Morpho.setAuthorization(desk, true): lets the desk borrow and withdraw on the user's own position. One-time. */
export function prepareAuthorizeDesk(cfg: BoundlineChainConfig, authorized = true): Call {
  return prepareAuthorize(cfg, deskOf(cfg), authorized);
}

/** Morpho.setAuthorization(target, flag): the same opt-in for any contract (the pre-liquidation contract for protected mode). */
export function prepareAuthorize(cfg: BoundlineChainConfig, target: Address, authorized: boolean): Call {
  return call(cfg.morpho, encodeFunctionData({ abi: morphoMinimalAbi, functionName: "setAuthorization", args: [target, authorized] }));
}

export function prepareApprove(token: Address, spender: Address, amount: bigint): Call {
  return call(token, encodeFunctionData({ abi: erc20MinimalAbi, functionName: "approve", args: [spender, amount] }));
}

export function prepareOpenLine(
  cfg: BoundlineChainConfig,
  args: { partnerId?: Hex; marketId: Hex; deadline: bigint; signature?: Hex },
): Call {
  const partnerId = args.partnerId ?? cfg.partnerId;
  const signature = args.signature ?? "0x";
  return call(deskOf(cfg), encodeFunctionData({ abi: creditDeskAbi, functionName: "openLine", args: [partnerId, args.marketId, args.deadline, signature] }));
}

export function prepareAddCollateral(cfg: BoundlineChainConfig, lineId: bigint, amount: bigint): Call {
  return call(deskOf(cfg), encodeFunctionData({ abi: creditDeskAbi, functionName: "addCollateral", args: [lineId, amount] }));
}

export function prepareDraw(cfg: BoundlineChainConfig, lineId: bigint, amount: bigint): Call {
  return call(deskOf(cfg), encodeFunctionData({ abi: creditDeskAbi, functionName: "draw", args: [lineId, amount] }));
}

export function prepareRepay(cfg: BoundlineChainConfig, lineId: bigint, amount: bigint = REPAY_ALL): Call {
  return call(deskOf(cfg), encodeFunctionData({ abi: creditDeskAbi, functionName: "repay", args: [lineId, amount] }));
}

export function prepareWithdrawCollateral(cfg: BoundlineChainConfig, lineId: bigint, amount: bigint): Call {
  return call(deskOf(cfg), encodeFunctionData({ abi: creditDeskAbi, functionName: "withdrawCollateral", args: [lineId, amount] }));
}

export function prepareCloseLine(cfg: BoundlineChainConfig, lineId: bigint): Call {
  return call(deskOf(cfg), encodeFunctionData({ abi: creditDeskAbi, functionName: "closeLine", args: [lineId] }));
}

export interface BorrowBatchInput {
  lineId: bigint;
  /** USDC base units to draw; 0 to only add collateral. */
  draw: bigint;
  /** Collateral token and raw amount to add first; omit to draw against what is already posted. */
  addCollateral?: { token: Address; amount: bigint };
  /** True when Morpho.isAuthorized(user, desk) is false: the batch starts with the authorisation. */
  needsAuthorization: boolean;
  /** True when the desk's allowance on the collateral token is short of `addCollateral.amount`. */
  needsApproval?: boolean;
  /** Local-money leg: the drawn USDC (or `amountIn` of it) is swapped into `token` and paid to `to` at the end of the batch. */
  payout?: Omit<PayoutRequest, "amountIn"> & { amountIn?: bigint };
}

/** The one-tap borrow: authorise (once) → approve → addCollateral → draw → (approve → payout). Each step is skipped when not needed. */
export function borrowBatch(cfg: BoundlineChainConfig, input: BorrowBatchInput): Call[] {
  const calls: Call[] = [];
  if (input.needsAuthorization) calls.push(prepareAuthorizeDesk(cfg));
  if (input.addCollateral && input.addCollateral.amount > 0n) {
    if (input.needsApproval ?? true) calls.push(prepareApprove(input.addCollateral.token, deskOf(cfg), input.addCollateral.amount));
    calls.push(prepareAddCollateral(cfg, input.lineId, input.addCollateral.amount));
  }
  if (input.draw > 0n) calls.push(prepareDraw(cfg, input.lineId, input.draw));
  if (calls.length === 0) throw new Error("nothing to do: no collateral to add and no draw");
  if (input.payout) {
    const amountIn = input.payout.amountIn ?? input.draw;
    if (amountIn <= 0n) throw new Error("a payout needs a draw (or an explicit amountIn)");
    if (amountIn > input.draw) throw new Error("the payout cannot exceed the draw");
    calls.push(prepareApprove(cfg.usdc, payoutRouterOf(cfg), amountIn));
    calls.push(preparePayout(cfg, { ...input.payout, amountIn }));
  }
  return calls;
}

export interface RepayBatchInput {
  lineId: bigint;
  /** USDC base units, or REPAY_ALL. */
  amount: bigint;
  /** USDC to approve to the desk; for REPAY_ALL pass the current debt plus a small buffer for interest accrued before inclusion. */
  approve: bigint;
}

/** approve USDC → repay. Repay works at any hour: Morpho's repay never reads the oracle. */
export function repayBatch(cfg: BoundlineChainConfig, input: RepayBatchInput): Call[] {
  return [prepareApprove(cfg.usdc, deskOf(cfg), input.approve), prepareRepay(cfg, input.lineId, input.amount)];
}
