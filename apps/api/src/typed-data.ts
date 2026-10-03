import { hashTypedData, keccak256, stringToHex, type Address, type Hex } from "viem";

/** Mirrors CreditDesk's EIP712("Boundline CreditDesk", "1") and LINE_AUTHORIZATION_TYPEHASH. */
export const EIP712_NAME = "Boundline CreditDesk";
export const EIP712_VERSION = "1";

export const LINE_AUTHORIZATION_TYPES = {
  LineAuthorization: [
    { name: "partnerId", type: "bytes32" },
    { name: "user", type: "address" },
    { name: "marketId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const LINE_AUTHORIZATION_TYPE_STRING =
  "LineAuthorization(bytes32 partnerId,address user,bytes32 marketId,uint256 nonce,uint256 deadline)";

export const LINE_AUTHORIZATION_TYPEHASH: Hex = keccak256(stringToHex(LINE_AUTHORIZATION_TYPE_STRING));

export interface LineAuthorizationInput {
  chainId: number;
  desk: Address;
  partnerId: Hex;
  user: Address;
  marketId: Hex;
  nonce: bigint;
  deadline: bigint;
}

export interface LineAuthorizationTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: typeof LINE_AUTHORIZATION_TYPES;
  primaryType: "LineAuthorization";
  message: { partnerId: Hex; user: Address; marketId: Hex; nonce: bigint; deadline: bigint };
}

/** The typed data a partner signer signs so a user can open a line; `openLine` verifies it against the same digest. */
export function lineAuthorizationTypedData(input: LineAuthorizationInput): LineAuthorizationTypedData {
  return {
    domain: { name: EIP712_NAME, version: EIP712_VERSION, chainId: input.chainId, verifyingContract: input.desk },
    types: LINE_AUTHORIZATION_TYPES,
    primaryType: "LineAuthorization",
    message: {
      partnerId: input.partnerId,
      user: input.user,
      marketId: input.marketId,
      nonce: input.nonce,
      deadline: input.deadline,
    },
  };
}

/** The EIP-712 digest for the typed data, computed locally; the desk's `lineAuthorizationDigest` view must agree. */
export function lineAuthorizationDigest(td: LineAuthorizationTypedData): Hex {
  return hashTypedData(td);
}

/** JSON-safe copy for responses (bigints as decimal strings). */
export function typedDataJson(td: LineAuthorizationTypedData): unknown {
  return {
    domain: td.domain,
    types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...td.types },
    primaryType: td.primaryType,
    message: { ...td.message, nonce: td.message.nonce.toString(), deadline: td.message.deadline.toString() },
  };
}

const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;
