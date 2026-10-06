// Aave V4 on Base (aave/aave-v4 v0.5.11): the Equities Hub's MAG7 spoke and the activated position
// managers Boundline routes through (plan M4). Addresses, reserve ids, the enrolment batch and the
// minimal ABIs the TypeScript side needs. Facts verified by live reads on 6 Oct 2026: both managers
// are active on the spoke, both have the spoke registered, the spoke's oracle is 0xaBaf…2A47 with
// `getReservePrice(reserveId)` in 8 decimals, collateral factors AAPLc 78% / NVDAc 70% / TSLAc 65%,
// liquidation target health factor 1.24, USDC (reserve 7) is the only borrowable reserve.
import type { Address, Hex } from "viem";
import { encodeFunctionData } from "viem";
import { MAINNET } from "./addresses.js";

export const AAVE_V4 = {
  chainId: 8453,
  hub: MAINNET.aaveHub,
  spoke: MAINNET.aaveMag7Spoke,
  taker: MAINNET.aaveTakerPositionManager,
  giver: MAINNET.aaveGiverPositionManager,
  configPositionManager: MAINNET.aaveConfigPositionManager,
  signatureGateway: MAINNET.aaveSignatureGateway,
  oracle: "0xaBaf048fD7675Ea34a84332371ffd5D55E322A47" as Address,
  /** The loan reserve: USDC, borrow-only. */
  loanReserveId: 7,
  /** EIP-712 domains of the intent consumers (name, version); verifyingContract is the contract itself. */
  domains: {
    spoke: { name: "Spoke", version: "1" },
    taker: { name: "TakerPositionManager", version: "1" },
  },
  typehashes: {
    borrowPermit: "0x14236ea048da65ffb52a9b32a2c840f24ab374cc31f65faeb7877d22ceca144e" as Hex,
    withdrawPermit: "0x9e6642fd4c06a4c1a5e201f1e41c6b7892fcf06859c796b054c510b80e2a0a3f" as Hex,
    setUserPositionManagers: "0xba01f7bf3d3674c63670ec4a78b0d56aac1ad6e8c84468920b9e61bfe0b9851a" as Hex,
  },
} as const;

/** EIP-712 types for the Taker permits and the spoke's position-manager intent, as the deployed contracts hash them. */
export const AAVE_V4_TYPES = {
  BorrowPermit: [
    { name: "spoke", type: "address" },
    { name: "reserveId", type: "uint256" },
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  WithdrawPermit: [
    { name: "spoke", type: "address" },
    { name: "reserveId", type: "uint256" },
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  SetUserPositionManagers: [
    { name: "onBehalfOf", type: "address" },
    { name: "updates", type: "PositionManagerUpdate[]" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  PositionManagerUpdate: [
    { name: "positionManager", type: "address" },
    { name: "approve", type: "bool" },
  ],
} as const;

/** Aave keyed nonces: the 192-bit key above the 64-bit sequence (`NoncesKeyed._pack`). */
export function aaveKeyedNonce(key: bigint, sequence: bigint): bigint {
  return (key << 64n) | (sequence & 0xffffffffffffffffn);
}

/** Spoke read and write subset the desk, vault, indexer and app use (ISpoke.sol). */
export const aaveSpokeActionsAbi = [
  { type: "function", name: "setUserPositionManager", stateMutability: "nonpayable", inputs: [{ name: "positionManager", type: "address" }, { name: "approve", type: "bool" }], outputs: [] },
  { type: "function", name: "isPositionManager", stateMutability: "view", inputs: [{ name: "user", type: "address" }, { name: "positionManager", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "isPositionManagerActive", stateMutability: "view", inputs: [{ name: "positionManager", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "getUserSuppliedAssets", stateMutability: "view", inputs: [{ name: "reserveId", type: "uint256" }, { name: "user", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getUserTotalDebt", stateMutability: "view", inputs: [{ name: "reserveId", type: "uint256" }, { name: "user", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getUserReserveStatus", stateMutability: "view", inputs: [{ name: "reserveId", type: "uint256" }, { name: "user", type: "address" }], outputs: [{ name: "usingAsCollateral", type: "bool" }, { name: "borrowing", type: "bool" }] },
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "riskPremium", type: "uint256" },
          { name: "avgCollateralFactor", type: "uint256" },
          { name: "healthFactor", type: "uint256" },
          { name: "totalCollateralValue", type: "uint256" },
          { name: "totalDebtValueRay", type: "uint256" },
          { name: "activeCollateralCount", type: "uint256" },
          { name: "borrowCount", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getDynamicReserveConfig",
    stateMutability: "view",
    inputs: [{ name: "reserveId", type: "uint256" }, { name: "dynamicConfigKey", type: "uint32" }],
    outputs: [{ type: "tuple", components: [{ name: "collateralFactor", type: "uint16" }, { name: "maxLiquidationBonus", type: "uint32" }, { name: "liquidationFee", type: "uint16" }] }],
  },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "key", type: "uint192" }], outputs: [{ name: "keyNonce", type: "uint256" }] },
  { type: "function", name: "ORACLE", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "event",
    name: "Supply",
    inputs: [
      { name: "reserveId", type: "uint256", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "suppliedShares", type: "uint256", indexed: false },
      { name: "suppliedAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdraw",
    inputs: [
      { name: "reserveId", type: "uint256", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "withdrawnShares", type: "uint256", indexed: false },
      { name: "withdrawnAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Borrow",
    inputs: [
      { name: "reserveId", type: "uint256", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "drawnShares", type: "uint256", indexed: false },
      { name: "drawnAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Repay",
    inputs: [
      { name: "reserveId", type: "uint256", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "drawnShares", type: "uint256", indexed: false },
      { name: "totalAmountRepaid", type: "uint256", indexed: false },
      {
        name: "premiumDelta",
        type: "tuple",
        indexed: false,
        components: [
          { name: "sharesDelta", type: "int256" },
          { name: "offsetRayDelta", type: "int256" },
          { name: "restoredPremiumRay", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "LiquidationCall",
    inputs: [
      { name: "collateralReserveId", type: "uint256", indexed: true },
      { name: "debtReserveId", type: "uint256", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "liquidator", type: "address", indexed: false },
      { name: "receiveShares", type: "bool", indexed: false },
      { name: "debtAmountRestored", type: "uint256", indexed: false },
      { name: "drawnSharesLiquidated", type: "uint256", indexed: false },
      {
        name: "premiumDelta",
        type: "tuple",
        indexed: false,
        components: [
          { name: "sharesDelta", type: "int256" },
          { name: "offsetRayDelta", type: "int256" },
          { name: "restoredPremiumRay", type: "uint256" },
        ],
      },
      { name: "collateralAmountRemoved", type: "uint256", indexed: false },
      { name: "collateralSharesLiquidated", type: "uint256", indexed: false },
      { name: "collateralSharesToLiquidator", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SetUserPositionManager",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "positionManager", type: "address", indexed: true },
      { name: "approve", type: "bool", indexed: false },
    ],
  },
] as const;

/** Taker position manager: allowances and the two on-behalf actions (ITakerPositionManager.sol). */
export const aaveTakerAbi = [
  { type: "function", name: "approveBorrow", stateMutability: "nonpayable", inputs: [{ name: "spoke", type: "address" }, { name: "reserveId", type: "uint256" }, { name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "approveWithdraw", stateMutability: "nonpayable", inputs: [{ name: "spoke", type: "address" }, { name: "reserveId", type: "uint256" }, { name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  {
    type: "function",
    name: "approveBorrowWithSig",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "spoke", type: "address" },
          { name: "reserveId", type: "uint256" },
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "approveWithdrawWithSig",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "spoke", type: "address" },
          { name: "reserveId", type: "uint256" },
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  { type: "function", name: "borrowAllowance", stateMutability: "view", inputs: [{ name: "spoke", type: "address" }, { name: "reserveId", type: "uint256" }, { name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "withdrawAllowance", stateMutability: "view", inputs: [{ name: "spoke", type: "address" }, { name: "reserveId", type: "uint256" }, { name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "key", type: "uint192" }], outputs: [{ name: "keyNonce", type: "uint256" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "isSpokeRegistered", stateMutability: "view", inputs: [{ name: "spoke", type: "address" }], outputs: [{ type: "bool" }] },
  {
    type: "event",
    name: "BorrowApproval",
    inputs: [
      { name: "spoke", type: "address", indexed: true },
      { name: "reserveId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "spender", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BorrowOnBehalfOf",
    inputs: [
      { name: "spoke", type: "address", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "onBehalfOf", type: "address", indexed: true },
      { name: "reserveId", type: "uint256", indexed: false },
      { name: "drawnShares", type: "uint256", indexed: false },
      { name: "drawnAmount", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Giver position manager: the always-open protective repay (IGiverPositionManager.sol). */
export const aaveGiverAbi = [
  { type: "function", name: "repayOnBehalfOf", stateMutability: "nonpayable", inputs: [{ name: "spoke", type: "address" }, { name: "reserveId", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "onBehalfOf", type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "isSpokeRegistered", stateMutability: "view", inputs: [{ name: "spoke", type: "address" }], outputs: [{ type: "bool" }] },
  {
    type: "event",
    name: "RepayOnBehalfOf",
    inputs: [
      { name: "spoke", type: "address", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "onBehalfOf", type: "address", indexed: true },
      { name: "reserveId", type: "uint256", indexed: false },
      { name: "repaidShares", type: "uint256", indexed: false },
      { name: "repaidAmount", type: "uint256", indexed: false },
    ],
  },
] as const;

/** The spoke's price oracle (IPriceOracle.sol): 8-decimal prices per reserve id. */
export const aavePriceOracleAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "getReservePrice", stateMutability: "view", inputs: [{ name: "reserveId", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

export interface AaveEnrolmentCall {
  to: Address;
  data: Hex;
  value: bigint;
}

/**
 * The calls a user batches (one `wallet_sendCalls`) to put an Aave V4 position under Boundline management:
 * approve Aave's Taker and Giver on the spoke, grant the desk a bounded USDC borrow allowance, and
 * optionally grant the ProtectionVault a withdraw allowance on the collateral reserve for Monday recovery.
 * Boundline is never a position manager itself; the user approves Aave's audited managers.
 */
export function aaveEnrolmentCalls(args: {
  desk: Address;
  borrowCap: bigint;
  vault?: Address;
  collateralReserveId?: number;
  withdrawCap?: bigint;
  spoke?: Address;
  taker?: Address;
  giver?: Address;
  loanReserveId?: number;
}): AaveEnrolmentCall[] {
  const spoke = args.spoke ?? AAVE_V4.spoke;
  const taker = args.taker ?? AAVE_V4.taker;
  const giver = args.giver ?? AAVE_V4.giver;
  const loanReserveId = BigInt(args.loanReserveId ?? AAVE_V4.loanReserveId);
  const calls: AaveEnrolmentCall[] = [
    { to: spoke, value: 0n, data: encodeFunctionData({ abi: aaveSpokeActionsAbi, functionName: "setUserPositionManager", args: [taker, true] }) },
    { to: spoke, value: 0n, data: encodeFunctionData({ abi: aaveSpokeActionsAbi, functionName: "setUserPositionManager", args: [giver, true] }) },
    { to: taker, value: 0n, data: encodeFunctionData({ abi: aaveTakerAbi, functionName: "approveBorrow", args: [spoke, loanReserveId, args.desk, args.borrowCap] }) },
  ];
  if (args.vault && args.withdrawCap && args.withdrawCap > 0n && args.collateralReserveId !== undefined) {
    calls.push({
      to: taker,
      value: 0n,
      data: encodeFunctionData({ abi: aaveTakerAbi, functionName: "approveWithdraw", args: [spoke, BigInt(args.collateralReserveId), args.vault, args.withdrawCap] }),
    });
  }
  return calls;
}
