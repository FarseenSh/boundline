import { describe, expect, it } from "vitest";
import { MULTICALL3, SELECTOR, decodeAggregate3Calldata, encodeAggregate3Result, wordUint } from "../src/encoding.js";
import { marketIdFromParams, readMarkets, type DiscoveredMarket } from "../src/morpho.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AAPLC = "0xb200000000000000000000C2e324d24d7eEcd1fb";
const ORACLE = "0xEcC5c9bf18CB2CfC94C2f7EFf8BDd5837A60AB0e";
const IRM = "0x46415998764C29aB2a25CbeA6254146D50D22687";
const real: DiscoveredMarket = {
  id: marketIdFromParams({ loan: USDC, collateral: AAPLC, oracle: ORACLE, irm: IRM, lltv: 625000000000000000n }),
  collateral: { address: AAPLC, symbol: "AAPLc" },
  loan: { address: USDC, symbol: "USDC" },
  lltv: 625000000000000000n,
  oracle: ORACLE,
  irm: IRM,
  listed: true,
};
const forged: DiscoveredMarket = { ...real, id: `0x${"11".repeat(32)}` };

describe("readMarkets", () => {
  it("reads totals and prices in one aggregate, flags a forged id and survives a failed price call", async () => {
    let body: { method: string; params: [{ to: string; data: string }, string] } | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      const calls = decodeAggregate3Calldata(body!.params[0].data);
      expect(calls).toHaveLength(4);
      const results = calls.map((c, i) => {
        if (c.callData.startsWith(SELECTOR.market)) return { success: true, data: [1_000_000_000n, 1n, 900_000_000n, 1n, 0n, 0n].map(wordUint).join("") };
        return i === 3 ? { success: false, data: "" } : { success: true, data: wordUint(333_66495000n * 10n ** 26n) };
      });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeAggregate3Result(results) }), { status: 200 });
    }) as unknown as typeof fetch;
    const rows = await readMarkets("https://a.invalid", [real, forged], { fetchImpl });
    expect(body?.method).toBe("eth_call");
    expect(body?.params[0].to).toBe(MULTICALL3);
    expect(rows[0]).toMatchObject({ lltv: 0.625, totalSupplyAssets: "1000000000", totalBorrowAssets: "900000000", utilization: 0.9, idMatchesParams: true });
    expect(rows[0]!.oraclePriceUsd).toBeCloseTo(333.66495, 4);
    expect(rows[1]).toMatchObject({ idMatchesParams: false, oraclePrice36: null, oraclePriceUsd: null });
  });

  it("makes no RPC call for an empty discovery", async () => {
    const fetchImpl = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    expect(await readMarkets("https://a.invalid", [], { fetchImpl })).toEqual([]);
  });
});
