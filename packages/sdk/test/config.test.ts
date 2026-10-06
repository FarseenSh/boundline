import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { BASE_MAINNET, BASE_SEPOLIA, BOUNDLINE_PARTNER_ID, configFor, explorer, marketByCollateral, marketById, partnerIdOf, stockBySymbol, stockByToken } from "../src/config.js";

describe("config", () => {
  it("partner id is bytes32(\"boundline-app\") as deployed", () => {
    expect(partnerIdOf("boundline-app")).toBe("0x626f756e646c696e652d61707000000000000000000000000000000000000000");
    expect(BOUNDLINE_PARTNER_ID).toBe(partnerIdOf("boundline-app"));
    expect(() => partnerIdOf("")).toThrow();
    expect(() => partnerIdOf("x".repeat(33))).toThrow();
  });
  it("Sepolia book matches deployments/base-sepolia.json", () => {
    const c = configFor(84532);
    expect(c.desk).toBe(getAddress("0x39aBaDc0aAa12D1F7e259b89536Aa1848997399a"));
    expect(c.gate).toBe(getAddress("0x92f59437d4ef5CDcEAe2CcDE89B03A7B4B1Ae427"));
    expect(c.markets[0]?.id).toBe("0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047");
    expect(c.markets[0]?.lltvWad).toBe(625_000_000_000_000_000n);
    expect(stockBySymbol(c, "AAPLt")?.token).toBe(getAddress("0xB2000000000000000000000E063E65377cA34141"));
    expect(stockByToken(c, "0xb2000000000000000000000e063e65377ca34141")?.symbol).toBe("AAPLt");
    expect(marketByCollateral(c, "0xb2000000000000000000000e063e65377ca34141")?.symbol).toBe("AAPLt");
    expect(marketById(c, "0x4A03B124A170A913931F00AB87F7966D388370CF457C0A3C4FB6FCF4FBB88047")?.symbol).toBe("AAPLt");
  });
  it("mainnet has no desk yet and unknown chains throw", () => {
    expect(BASE_MAINNET.desk).toBeNull();
    expect(() => configFor(1)).toThrow(/no configuration/);
  });
  it("explorer links", () => {
    expect(explorer.tx(BASE_SEPOLIA, "0xabc")).toBe("https://sepolia.basescan.org/tx/0xabc");
    expect(explorer.address(BASE_SEPOLIA, BASE_SEPOLIA.desk!)).toContain("/address/0x39aB");
  });
});
