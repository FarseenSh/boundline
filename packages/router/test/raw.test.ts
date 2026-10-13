import { describe, expect, it } from "vitest";
import { aprWad, buildCandidates, gateOf, MAINNET_PRE_LIQUIDATIONS, MAINNET_SESSION_SAFE_MARKETS, price36To8, type ObservatoryToken } from "../src/candidates.js";
import { addressFromWord, decodeAggregate3, encodeAggregate3, encodeMarket, MORPHO, word, wordAt } from "../src/raw.js";

// The candidate builder and the raw encoders moved here from apps/agent on 8 Oct 2026 (the agent re-exports them and
// keeps its own end-to-end tests); these pin the pieces the partner API now imports through the subpath exports.
describe("raw subpath", () => {
  it("round-trips aggregate3 and reads words", () => {
    const data = encodeAggregate3([{ target: MORPHO, allowFailure: true, callData: encodeMarket(`0x${"ab".repeat(32)}`) }]);
    expect(data.startsWith("0x82ad56cb")).toBe(true);
    // A return of [(true, 0x01…)]: offset 0x20, length 1, element offset 0x20, success, bytes offset 0x40, length 32, payload.
    const ret = `0x${word(0x20)}${word(1)}${word(0x20)}${word(1)}${word(0x40)}${word(32)}${word(7)}` as const;
    const [r] = decodeAggregate3(ret);
    expect(r?.success).toBe(true);
    expect(wordAt(r!.returnData.slice(2), 0)).toBe(7n);
    expect(addressFromWord(BigInt(MORPHO))).toBe(MORPHO.toLowerCase());
  });
});

describe("candidates subpath", () => {
  const token = (over: Partial<ObservatoryToken> = {}): ObservatoryToken => ({
    symbol: "AAPLc", feedAnswer: "33568300000", feedUpdatedAt: 1, feedAgeSeconds: 60, session: "OVERNIGHT", feedLive: true,
    registryPaused: false, transferPaused: false, dexTwapPrice36: "3356830000000000000000000000000000000", ...over,
  });
  it("gates with the SessionGate's precedence and scales prices", () => {
    expect(gateOf(token())).toBe("OPEN");
    expect(gateOf(token({ feedLive: false, registryPaused: true }))).toBe("MARKET_CLOSED");
    expect(gateOf(token({ registryPaused: true, transferPaused: true }))).toBe("FEED_PAUSED");
    expect(gateOf(token({ feedAgeSeconds: 26 * 3600 + 1 }))).toBe("FEED_STALE");
    expect(price36To8("3356830000000000000000000000000000000")).toBe(33_568_300_000n);
    expect(aprWad(1n)).toBe(31_536_000n);
  });
  it("marks mainnet Morpho markets as pricing around the clock (Saturday mode applies there, never on SessionGuard markets)", () => {
    const { candidates } = buildCandidates("AAPLc", {
      tokens: [token()],
      mainnetMarkets: [{ id: `0x${"11".repeat(32)}`, collateral: { address: "0xb200000000000000000000C2e324d24d7eEcd1fb", symbol: "AAPLc" }, lltv: 0.625, totalSupplyAssets: "1000", totalBorrowAssets: "400" }],
      mainnetRates: [],
      sepoliaRates: [],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ chainId: 8453, pricesAroundTheClock: true, availableLiquidity: 600n, protection: "none" });
    const sep = buildCandidates("AAPLt", { tokens: [token()], mainnetMarkets: [], mainnetRates: [], sepoliaRates: [] });
    expect(sep.candidates[0]).toMatchObject({ chainId: 84532, pricesAroundTheClock: false, protection: "pre-liquidation" });
  });
  it("routes a mainnet market as protected once a Boundline pre-liquidation exists for it", () => {
    const id = `0x${"AB".repeat(32)}`;
    const market = { id, collateral: { address: "0xb200000000000000000000C2e324d24d7eEcd1fb", symbol: "AAPLc" }, lltv: 0.86, totalSupplyAssets: "1000", totalBorrowAssets: "400" };
    const inputs = { tokens: [token()], mainnetMarkets: [market], mainnetRates: [], sepoliaRates: [] };
    expect(buildCandidates("AAPLc", inputs).candidates[0]!.protection).toBe("none");
    const withPre = buildCandidates("AAPLc", { ...inputs, preLiquidations: { [id.toLowerCase()]: "0x00000000000000000000000000000000000000aa" } });
    expect(withPre.candidates[0]!.protection).toBe("pre-liquidation");
  });
  it("protects the deployed mainnet markets and keeps Saturday mode off the session-safe one", () => {
    const market = (id: string) => ({ id, collateral: { address: "0xb200000000000000000000C2e324d24d7eEcd1fb", symbol: "AAPLc" }, lltv: 0.625, totalSupplyAssets: "1000", totalBorrowAssets: "400" });
    const steakhouse = "0xae1a30486234bf7e7ac166c7c03d9bc5f2cd8a39be2c48e73c665ac7148c3c28";
    const safe = "0xB50ECABA0652B5A51BDE9A747E9B7A2075C7AB68FD3C6EF7C05EABF6BB0F1D28";
    const { candidates } = buildCandidates("AAPLc", { tokens: [token()], mainnetMarkets: [market(steakhouse), market(safe)], mainnetRates: [], sepoliaRates: [] });
    expect(candidates[0]).toMatchObject({ marketId: steakhouse, protection: "pre-liquidation", pricesAroundTheClock: true });
    expect(candidates[1]).toMatchObject({ marketId: safe, protection: "pre-liquidation", pricesAroundTheClock: false });
    expect(MAINNET_PRE_LIQUIDATIONS[safe.toLowerCase()]).toBe("0x1D6B5C5134C1450f9F07272106aE47637EbFCAFb");
    expect(MAINNET_SESSION_SAFE_MARKETS.has(steakhouse)).toBe(false);
  });
});
