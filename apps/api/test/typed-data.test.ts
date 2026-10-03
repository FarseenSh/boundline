import { describe, expect, it } from "vitest";
import { concatHex, encodeAbiParameters, keccak256, stringToHex } from "viem";
import {
  LINE_AUTHORIZATION_TYPEHASH,
  LINE_AUTHORIZATION_TYPE_STRING,
  lineAuthorizationDigest,
  lineAuthorizationTypedData,
  typedDataJson,
} from "../src/typed-data.js";
import { CHAIN_ID, DESK, MARKET_ID, PARTNER_ID, USER } from "./helpers.js";

describe("LineAuthorization typed data", () => {
  const input = { chainId: CHAIN_ID, desk: DESK, partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, nonce: 4n, deadline: 1_791_100_000n };

  it("matches the desk's _hashTypedDataV4 computed by hand", () => {
    expect(LINE_AUTHORIZATION_TYPEHASH).toBe(keccak256(stringToHex(LINE_AUTHORIZATION_TYPE_STRING)));
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [
          keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
          keccak256(stringToHex("Boundline CreditDesk")),
          keccak256(stringToHex("1")),
          BigInt(CHAIN_ID),
          DESK,
        ],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
        [LINE_AUTHORIZATION_TYPEHASH, PARTNER_ID, USER, MARKET_ID, 4n, 1_791_100_000n],
      ),
    );
    const expected = keccak256(concatHex(["0x1901", domainSeparator, structHash]));
    expect(lineAuthorizationDigest(lineAuthorizationTypedData(input))).toBe(expected);
  });

  it("changes with every field", () => {
    const base = lineAuthorizationDigest(lineAuthorizationTypedData(input));
    expect(lineAuthorizationDigest(lineAuthorizationTypedData({ ...input, nonce: 5n }))).not.toBe(base);
    expect(lineAuthorizationDigest(lineAuthorizationTypedData({ ...input, chainId: 8453 }))).not.toBe(base);
    expect(lineAuthorizationDigest(lineAuthorizationTypedData({ ...input, desk: USER }))).not.toBe(base);
  });

  it("serialises bigints for JSON", () => {
    const json = typedDataJson(lineAuthorizationTypedData(input)) as { message: Record<string, string>; types: Record<string, unknown> };
    expect(json.message.nonce).toBe("4");
    expect(json.message.deadline).toBe("1791100000");
    expect(Object.keys(json.types)).toEqual(["EIP712Domain", "LineAuthorization"]);
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});
