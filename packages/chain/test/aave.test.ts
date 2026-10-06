import { describe, expect, it } from "vitest";
import { decodeFunctionData, keccak256, toBytes } from "viem";
import { AAVE_V4, AAVE_V4_TYPES, aaveEnrolmentCalls, aaveKeyedNonce, aaveSpokeActionsAbi, aaveTakerAbi } from "../src/aave.js";
import { MAINNET } from "../src/addresses.js";

describe("Aave V4 constants", () => {
  it("typehashes match the EIP-712 type strings the deployed contracts hash", () => {
    const encode = (name: keyof typeof AAVE_V4_TYPES) => `${name}(${AAVE_V4_TYPES[name].map((f) => `${f.type} ${f.name}`).join(",")})`;
    expect(keccak256(toBytes(encode("BorrowPermit")))).toBe(AAVE_V4.typehashes.borrowPermit);
    expect(keccak256(toBytes(encode("WithdrawPermit")))).toBe(AAVE_V4.typehashes.withdrawPermit);
    // Nested struct: the referenced type is appended per EIP-712.
    expect(keccak256(toBytes(encode("SetUserPositionManagers") + encode("PositionManagerUpdate")))).toBe(AAVE_V4.typehashes.setUserPositionManagers);
  });

  it("points at the same managers as the address book", () => {
    expect(AAVE_V4.spoke).toBe(MAINNET.aaveMag7Spoke);
    expect(AAVE_V4.taker).toBe(MAINNET.aaveTakerPositionManager);
    expect(AAVE_V4.giver).toBe(MAINNET.aaveGiverPositionManager);
    expect(AAVE_V4.loanReserveId).toBe(7);
  });

  it("packs keyed nonces like NoncesKeyed", () => {
    expect(aaveKeyedNonce(0n, 0n)).toBe(0n);
    expect(aaveKeyedNonce(1n, 2n)).toBe((1n << 64n) | 2n);
    expect(aaveKeyedNonce(0n, 2n ** 64n + 5n)).toBe(5n);
  });
});

describe("aaveEnrolmentCalls", () => {
  const desk = "0x1111111111111111111111111111111111111111" as const;
  const vault = "0x2222222222222222222222222222222222222222" as const;

  it("builds the three-call batch without a vault", () => {
    const calls = aaveEnrolmentCalls({ desk, borrowCap: 500_000_000n });
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.to)).toEqual([AAVE_V4.spoke, AAVE_V4.spoke, AAVE_V4.taker]);
    const a = decodeFunctionData({ abi: aaveSpokeActionsAbi, data: calls[0]!.data });
    expect(a).toEqual({ functionName: "setUserPositionManager", args: [AAVE_V4.taker, true] });
    const b = decodeFunctionData({ abi: aaveSpokeActionsAbi, data: calls[1]!.data });
    expect(b).toEqual({ functionName: "setUserPositionManager", args: [AAVE_V4.giver, true] });
    const c = decodeFunctionData({ abi: aaveTakerAbi, data: calls[2]!.data });
    expect(c).toEqual({ functionName: "approveBorrow", args: [AAVE_V4.spoke, 7n, desk, 500_000_000n] });
  });

  it("adds the vault's withdraw allowance on the collateral reserve when asked", () => {
    const calls = aaveEnrolmentCalls({ desk, borrowCap: 1n, vault, collateralReserveId: 0, withdrawCap: 10n ** 8n });
    expect(calls).toHaveLength(4);
    const d = decodeFunctionData({ abi: aaveTakerAbi, data: calls[3]!.data });
    expect(d).toEqual({ functionName: "approveWithdraw", args: [AAVE_V4.spoke, 0n, vault, 10n ** 8n] });
  });
});
