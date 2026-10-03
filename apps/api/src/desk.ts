import type { Address, Hex } from "viem";
import type { BaseClient } from "@boundline/chain";
import { creditDeskAbi } from "./abi/creditDesk.js";

// Reads from the CreditDesk, behind an interface so handlers are testable without an RPC.

export interface DeskQuote {
  reason: number;
  session: number;
  price8: bigint;
  collateralRaw: bigint;
  collateralValue: bigint;
  debt: bigint;
  maxDebt: bigint;
  available: bigint;
  effectiveMaxLtvWad: bigint;
  corporateActionHaircut: boolean;
}

export interface DeskLine {
  partnerId: Hex;
  user: Address;
  marketId: Hex;
  collateral: Address;
  policyVersion: number;
  status: number;
  holdReason: Hex;
  openedAt: bigint;
  drawnPrincipal: bigint;
}

export interface DeskPartner {
  admin: Address;
  signer: Address;
  eligibility: Address;
  active: boolean;
  policyVersion: number;
  exposureCap: bigint;
  exposure: bigint;
}

export interface DeskReader {
  readonly address: Address;
  readonly chainId: number;
  blockNumber(): Promise<bigint>;
  quote(lineId: bigint, amount: bigint): Promise<DeskQuote>;
  line(lineId: bigint): Promise<DeskLine>;
  obligationStatus(lineId: bigint): Promise<number>;
  partner(partnerId: Hex): Promise<DeskPartner>;
  nonces(user: Address): Promise<bigint>;
  lineOf(partnerId: Hex, user: Address, marketId: Hex): Promise<bigint>;
  lineAuthorizationDigest(partnerId: Hex, user: Address, marketId: Hex, nonce: bigint, deadline: bigint): Promise<Hex>;
}

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** The viem-backed reader; every call is a single eth_call against the desk. */
export function createDeskReader(client: BaseClient, address: Address, chainId: number): DeskReader {
  const abi = creditDeskAbi;
  return {
    address,
    chainId,
    blockNumber: () => client.getBlockNumber(),
    async quote(lineId, amount) {
      const q = await client.readContract({ address, abi, functionName: "quote", args: [lineId, amount] });
      return {
        reason: q.reason,
        session: q.session,
        price8: q.price8,
        collateralRaw: q.collateralRaw,
        collateralValue: q.collateralValue,
        debt: q.debt,
        maxDebt: q.maxDebt,
        available: q.available,
        effectiveMaxLtvWad: q.effectiveMaxLtvWad,
        corporateActionHaircut: q.corporateActionHaircut,
      };
    },
    async line(lineId) {
      const l = await client.readContract({ address, abi, functionName: "line", args: [lineId] });
      return {
        partnerId: l.partnerId,
        user: l.user,
        marketId: l.marketId,
        collateral: l.collateral,
        policyVersion: l.policyVersion,
        status: l.status,
        holdReason: l.holdReason,
        openedAt: l.openedAt,
        drawnPrincipal: l.drawnPrincipal,
      };
    },
    obligationStatus: (lineId) => client.readContract({ address, abi, functionName: "obligationStatus", args: [lineId] }),
    async partner(partnerId) {
      const p = await client.readContract({ address, abi, functionName: "partner", args: [partnerId] });
      return {
        admin: p.admin,
        signer: p.signer,
        eligibility: p.eligibility,
        active: p.active,
        policyVersion: p.policyVersion,
        exposureCap: p.exposureCap,
        exposure: p.exposure,
      };
    },
    nonces: (user) => client.readContract({ address, abi, functionName: "nonces", args: [user] }),
    lineOf: (partnerId, user, marketId) =>
      client.readContract({ address, abi, functionName: "lineOf", args: [partnerId, user, marketId] }),
    lineAuthorizationDigest: (partnerId, user, marketId, nonce, deadline) =>
      client.readContract({ address, abi, functionName: "lineAuthorizationDigest", args: [partnerId, user, marketId, nonce, deadline] }),
  };
}
