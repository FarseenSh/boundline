import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SEPOLIA_PROTECTION, SEPOLIA_STACK, SOURCE_IDS, sepoliaSources } from "../src/sources.js";

interface Record_ {
  contracts: Record<string, { address: string; block: number }>;
  stocks: Record<string, { token: string; feed: string; sessionGuard: string; block: number }>;
  markets: Record<string, { id: string; block: number; params: { collateralToken: string; oracle: string } }>;
  morpho: { address: string };
  protection: { protector: { address: string } };
  reserve: { boundlineReserve: { address: string }; deskProtectionVault: { address: string } };
  payout: { router: { address: string } };
}

const file = resolve(dirname(fileURLToPath(import.meta.url)), "../../../deployments/base-sepolia.json");
const record = JSON.parse(readFileSync(file).toString()) as Record_;

describe("SEPOLIA_STACK matches deployments/base-sepolia.json", () => {
  it("contracts", () => {
    expect(SEPOLIA_STACK.marketCalendar).toBe(record.contracts.MarketCalendar?.address);
    expect(SEPOLIA_STACK.mirrorOracleRegistry).toBe(record.contracts.MirrorOracleRegistry?.address);
    expect(SEPOLIA_STACK.sessionGate).toBe(record.contracts.SessionGate?.address);
    expect(SEPOLIA_STACK.blocks.oracleStack).toBe(record.contracts.SessionGate?.block);
    expect(SEPOLIA_STACK.morpho).toBe(record.morpho.address);
  });
  it("stocks and feeds", () => {
    for (const sym of ["AAPLt", "NVDAt", "TSLAt"] as const) {
      expect(SEPOLIA_STACK.feeds[sym]).toBe(record.stocks[sym]?.feed);
      expect(SEPOLIA_STACK.tokens[sym]).toBe(record.stocks[sym]?.token);
      expect(SEPOLIA_STACK.blocks.stocks).toBe(record.stocks[sym]?.block);
    }
  });
  it("protection stack", () => {
    expect(SEPOLIA_PROTECTION.protector.toLowerCase()).toBe(record.protection.protector.address.toLowerCase());
    expect(SEPOLIA_PROTECTION.boundlineReserve).toBe(record.reserve.boundlineReserve.address);
    expect(SEPOLIA_PROTECTION.deskProtectionVault).toBe(record.reserve.deskProtectionVault.address);
    expect(SEPOLIA_PROTECTION.localPayoutRouter).toBe(record.payout.router.address);
  });
  it("market", () => {
    const m = record.markets["AAPLt/USDC"];
    expect(SEPOLIA_STACK.market.id).toBe(m?.id);
    expect(SEPOLIA_STACK.market.collateral).toBe(m?.params.collateralToken);
    expect(SEPOLIA_STACK.market.oracle).toBe(m?.params.oracle);
    expect(SEPOLIA_STACK.blocks.market).toBe(m?.block);
  });
});

describe("sepoliaSources", () => {
  it("registers the market and the oracle stack, and the desk only with an address", () => {
    const base = sepoliaSources({});
    expect(base.map((s) => s.id)).toEqual([SOURCE_IDS.morphoMarketAaplt, SOURCE_IDS.oracleStack, SOURCE_IDS.sepoliaProtection]);
    expect(base[0]?.topics[1]).toBe(SEPOLIA_STACK.market.id);
    expect(base[1]?.addresses).toHaveLength(6);
    expect(sepoliaSources({ CREDIT_DESK_SEPOLIA: "" }).map((s) => s.id)).toHaveLength(3);
    expect(sepoliaSources({ CREDIT_DESK_SEPOLIA: "not an address" })).toHaveLength(3);
    const withDesk = sepoliaSources({ CREDIT_DESK_SEPOLIA: "0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854" });
    expect(withDesk.map((s) => s.id)).toEqual([SOURCE_IDS.morphoMarketAaplt, SOURCE_IDS.oracleStack, SOURCE_IDS.creditDesk, SOURCE_IDS.sepoliaProtection]);
  });
  it("follows the four protection contracts from just before the Protector's deployment, every topic", () => {
    const p = sepoliaSources({}).find((s) => s.id === SOURCE_IDS.sepoliaProtection)!;
    expect(p.addresses).toEqual([SEPOLIA_PROTECTION.protector, SEPOLIA_PROTECTION.deskProtectionVault, SEPOLIA_PROTECTION.boundlineReserve, SEPOLIA_PROTECTION.localPayoutRouter]);
    expect(p.topics).toEqual([]);
    expect(p.startBlock).toBe(47_760_000);
  });
});
