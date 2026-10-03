import { describe, expect, it } from "vitest";
import { marketIdFromParams, parseDiscovery } from "../src/morpho.js";

describe("marketIdFromParams", () => {
  it("recomputes the Steakhouse AAPLc/USDC market id the plan cites (0xae1a…3c28)", () => {
    const id = marketIdFromParams({
      loan: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      collateral: "0xb200000000000000000000C2e324d24d7eEcd1fb",
      oracle: "0xEcC5c9bf18CB2CfC94C2f7EFf8BDd5837A60AB0e",
      irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
      lltv: 625000000000000000n,
    });
    expect(id).toBe("0xae1a30486234bf7e7ac166c7c03d9bc5f2cd8a39be2c48e73c665ac7148c3c28");
  });
});

describe("parseDiscovery", () => {
  it("keeps only B20-collateral markets with an oracle", () => {
    const parsed = parseDiscovery({
      data: {
        markets: {
          items: [
            {
              marketId: "0xae1a30486234bf7e7ac166c7c03d9bc5f2cd8a39be2c48e73c665ac7148c3c28",
              lltv: "625000000000000000",
              irmAddress: "0x46415998764C29aB2a25CbeA6254146D50D22687",
              listed: true,
              oracle: { address: "0xEcC5c9bf18CB2CfC94C2f7EFf8BDd5837A60AB0e" },
              collateralAsset: { address: "0xb200000000000000000000c2e324d24d7eecd1fb", symbol: "AAPLc" },
              loanAsset: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC" },
            },
            {
              marketId: "0x01",
              lltv: "860000000000000000",
              irmAddress: "0x46415998764C29aB2a25CbeA6254146D50D22687",
              listed: false,
              oracle: null,
              collateralAsset: { address: "0xb2000000000000000000008bC8786B856E61707C", symbol: "METAc" },
              loanAsset: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC" },
            },
            {
              marketId: "0x02",
              lltv: "860000000000000000",
              irmAddress: "0x46415998764C29aB2a25CbeA6254146D50D22687",
              listed: true,
              oracle: { address: "0x0000000000000000000000000000000000000001" },
              collateralAsset: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH" },
              loanAsset: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC" },
            },
          ],
        },
      },
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.collateral.symbol).toBe("AAPLc");
    expect(parsed[0]!.lltv).toBe(625000000000000000n);
  });
});
