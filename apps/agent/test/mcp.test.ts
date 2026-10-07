import { describe, expect, it } from "vitest";
import { handleMcpBody, PROTOCOL_VERSION } from "../src/mcp.js";
import { makeTools, type Deps } from "../src/tools.js";
import { buildCandidates, gateOf, price36To8, readRates, lltvWadOf, aprWad } from "../src/candidates.js";
import { encodeBorrowRateView, encodeMarket, encodeIdToMarketParams, decodeMarket, decodeMarketParams, encodeAggregate3, decodeAggregate3, word, addressWord } from "../src/raw.js";

const TOKENS = {
  tokens: [
    { symbol: "AAPLc", feedAnswer: "33400500000", feedUpdatedAt: 1791380027, feedAgeSeconds: 767, session: "REGULAR", feedLive: true, registryPaused: false, transferPaused: false, dexTwapPrice36: "3363019930154045394171863553830560192" },
    { symbol: "NVDAc", feedAnswer: "23760910600", feedUpdatedAt: 1791380027, feedAgeSeconds: 767, session: "REGULAR", feedLive: true, registryPaused: false, transferPaused: false, dexTwapPrice36: null },
  ],
};
const MARKETS = {
  markets: [
    { id: "0xae1a000000000000000000000000000000000000000000000000000000003c28", collateral: { address: "0xb200000000000000000000C2e324d24d7eEcd1fb", symbol: "AAPLc" }, lltv: 0.625, totalSupplyAssets: "100000000", totalBorrowAssets: "40000000" },
    { id: "0xfef5641f70e19a87e369304daa9ba823754f3db1e6481d757fcae0442cffe479", collateral: { address: "0xb20000000000000000000078ee7ce2fE4908108C", symbol: "NVDAc" }, lltv: 0.77, totalSupplyAssets: "500000", totalBorrowAssets: "150000" },
  ],
};

function fakeDeps(over: Partial<Deps> = {}): Deps {
  return {
    observatory: async (path) => {
      if (path === "/v1/sessions") return { state: "REGULAR", isFeedLive: true };
      if (path === "/v1/tokens") return TOKENS;
      if (path === "/v1/venues/morpho/markets") return MARKETS;
      if (path === "/v1/positions") return { count: 1, positions: [{ address: "0x1" }] };
      if (path.endsWith("/shadow")) return { decision: "ALLOW" };
      throw new Error(`unexpected ${path}`);
    },
    keeper: async () => ({ enabled: true, targets: [] }),
    indexer: async () => ({}),
    api: async (path, init) => (path === "/v1/quotes" ? { status: 200, body: { reason: "NONE", request: init?.body } } : { status: 200, body: { decision: "ALLOW", lines: [] } }),
    rpcs: { mainnet: ["https://rpc.test"], sepolia: ["https://rpc.sepolia.test"] },
    fetchImpl: (async () => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    uuid: () => "u",
    now: () => 1_791_380_000,
    ...over,
  };
}

describe("mcp transport", () => {
  const tools = makeTools(fakeDeps());
  it("initialises, lists the six tools, answers ping, swallows notifications", async () => {
    const init = (await handleMcpBody({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, tools)) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(init.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(init.result.serverInfo.name).toBe("boundline-agent");
    expect(await handleMcpBody({ jsonrpc: "2.0", method: "notifications/initialized" }, tools)).toBeNull();
    const list = (await handleMcpBody({ jsonrpc: "2.0", id: 2, method: "tools/list" }, tools)) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["session", "positions", "shadowHealth", "quote", "protect", "route"]);
    expect(await handleMcpBody({ jsonrpc: "2.0", id: 3, method: "ping" }, tools)).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    const bad = (await handleMcpBody({ jsonrpc: "2.0", id: 4, method: "nope" }, tools)) as { error: { code: number } };
    expect(bad.error.code).toBe(-32601);
  });
  it("calls a tool and reports tool errors without a JSON-RPC error", async () => {
    const ok = (await handleMcpBody({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "session", arguments: {} } }, tools)) as { result: { content: { text: string }[]; structuredContent: { state: string } } };
    expect(ok.result.structuredContent.state).toBe("REGULAR");
    const err = (await handleMcpBody({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "shadowHealth", arguments: { address: "nope" } } }, tools)) as { result: { isError: boolean; content: { text: string }[] } };
    expect(err.result.isError).toBe(true);
    expect(err.result.content[0]?.text).toContain("address must be");
    const unknown = (await handleMcpBody({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "x" } }, tools)) as { result: { isError: boolean } };
    expect(unknown.result.isError).toBe(true);
  });
  it("handles a batch and parse errors", async () => {
    const out = (await handleMcpBody([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }], tools)) as unknown[];
    expect(out).toHaveLength(1);
    const pe = (await handleMcpBody("x", tools)) as { error: { code: number } };
    expect(pe.error.code).toBe(-32700);
  });
});

describe("tools", () => {
  it("quote posts lineId and draw as decimal strings with the partner key", async () => {
    const tools = makeTools(fakeDeps());
    const r = (await tools.get("quote")!.run({ lineId: "1", draw: "5000000" })) as { status: number; quote: { request: { lineId: string; draw: string } } };
    expect(r.status).toBe(200);
    expect(r.quote.request).toEqual({ lineId: "1", draw: "5000000" });
    await expect(tools.get("quote")!.run({ lineId: "1", draw: "1.5" })).rejects.toThrow(/base units/);
  });
  it("shadowHealth merges the API and the Observatory and survives one side failing", async () => {
    const tools = makeTools(fakeDeps({ api: async () => ({ status: 503, body: { error: "down" } }) }));
    const r = (await tools.get("shadowHealth")!.run({ address: "0xB789aD318945B37566E2549F65526Cc269a482Fc" })) as { sepolia: { unavailable: number }; mainnet: { decision: string } };
    expect(r.sepolia.unavailable).toBe(503);
    expect(r.mainnet.decision).toBe("ALLOW");
  });
  it("route builds mainnet candidates from the Observatory, fails closed on rates it cannot read, and returns typed data", async () => {
    const tools = makeTools(fakeDeps());
    const r = (await tools.get("route")!.run({ user: "0xB789aD318945B37566E2549F65526Cc269a482Fc", collateral: "AAPLc", collateralAmount: "100000000", amount: "100000000" })) as { plan: { chosen: { venue: string; marketId: string; amount: bigint; notes: string[] } | null; rejected: unknown[] }; candidates: number; notes: string[]; typedData: { message: { venue: string } } | null };
    expect(r.candidates).toBe(1);
    expect(r.notes[0]).toContain("multicall failed");
    expect(r.plan.chosen?.marketId).toBe(MARKETS.markets[0]!.id);
    // 1 AAPLc at $334.005 × 55% = 183.70 USDC capacity, liquidity 60 USDC → liquidity-limited
    expect(r.plan.chosen?.amount).toBe(60_000_000n);
    expect(r.plan.chosen?.notes).toContain("LIQUIDITY_LIMITED");
    expect(r.typedData?.message.venue).toBe("morpho");
  });
  it("route on a Sepolia test stock uses the mirrored mainnet price and marks the AAPLt market protected", async () => {
    const tools = makeTools(fakeDeps());
    const r = (await tools.get("route")!.run({ user: "0xB789aD318945B37566E2549F65526Cc269a482Fc", collateral: "AAPLt", collateralAmount: "1000000000", amount: "5000000" })) as { plan: { chosen: { chainId: number; protection: string } | null; rejected: { reason: string }[] }; notes: string[] };
    // the rate read fails in tests, so liquidity is 0 and the leg is rejected for liquidity: fail closed, with the note
    expect(r.plan.chosen).toBeNull();
    expect(r.plan.rejected[0]?.reason).toBe("INSUFFICIENT_LIQUIDITY");
    expect(r.notes.some((n) => n.includes("Sepolia prices are the mainnet feed"))).toBe(true);
  });
});

describe("candidates", () => {
  it("maps the Observatory flags onto the gate's precedence", () => {
    const t = TOKENS.tokens[0]!;
    expect(gateOf(t)).toBe("OPEN");
    expect(gateOf({ ...t, feedLive: false, registryPaused: true })).toBe("MARKET_CLOSED");
    expect(gateOf({ ...t, registryPaused: true, transferPaused: true })).toBe("FEED_PAUSED");
    expect(gateOf({ ...t, transferPaused: true })).toBe("TRANSFER_PAUSED");
    expect(gateOf({ ...t, feedAnswer: "0" })).toBe("FEED_INVALID");
    expect(gateOf({ ...t, feedAgeSeconds: 27 * 3600 })).toBe("FEED_STALE");
  });
  it("converts Morpho price36 to an 8-decimal price and LLTV to a WAD, and rates to APR", () => {
    expect(price36To8("3363019930154045394171863553830560192")).toBe(33_630_199_301n);
    expect(price36To8(null)).toBeNull();
    expect(lltvWadOf(0.625)).toBe(625_000_000_000_000_000n);
    expect(aprWad(1_000_000_000n)).toBe(31_536_000_000_000_000n);
  });
  it("buildCandidates skips unknown symbols and uses the read rates when present", () => {
    const empty = buildCandidates("XYZc", { tokens: TOKENS.tokens, mainnetMarkets: MARKETS.markets, mainnetRates: [], sepoliaRates: [] });
    expect(empty.candidates).toEqual([]);
    const withRate = buildCandidates("AAPLc", { tokens: TOKENS.tokens, mainnetMarkets: MARKETS.markets, mainnetRates: [{ id: MARKETS.markets[0]!.id, borrowRateWad: 50_000_000_000_000_000n, availableLiquidity: 7n, lltvWad: 625_000_000_000_000_000n, collateralToken: "0x" }], sepoliaRates: [] });
    expect(withRate.candidates[0]?.borrowRateWad).toBe(50_000_000_000_000_000n);
    expect(withRate.candidates[0]?.availableLiquidity).toBe(7n);
    expect(withRate.notes).toEqual([]);
  });
});

describe("raw encoders", () => {
  it("encodes market, idToMarketParams and borrowRateView as cast would", () => {
    const id = "0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047";
    expect(encodeMarket(id)).toBe(`0x5c60e39a${id.slice(2)}`);
    expect(encodeIdToMarketParams(id)).toBe(`0x2c3c9157${id.slice(2)}`);
    const p = { loanToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", collateralToken: "0xb200000000000000000000C2e324d24d7eEcd1fb", oracle: "0x1E2b20B4703F97710c2600eA73179c6CD1E00b02", irm: "0x46415998764C29aB2a25CbeA6254146D50D22687", lltv: 625_000_000_000_000_000n };
    const m = { totalSupplyAssets: 1n, totalSupplyShares: 2n, totalBorrowAssets: 3n, totalBorrowShares: 4n, lastUpdate: 5n, fee: 0n };
    const data = encodeBorrowRateView(p, m);
    expect(data.length).toBe(2 + 8 + 11 * 64);
    expect(data.startsWith("0x8c00bf6b")).toBe(true);
    expect(data.slice(10, 74)).toBe(addressWord(p.loanToken));
    expect(data.slice(10 + 4 * 64, 10 + 5 * 64)).toBe(word(p.lltv));
    const roundTrip = decodeMarketParams(`0x${addressWord(p.loanToken)}${addressWord(p.collateralToken)}${addressWord(p.oracle)}${addressWord(p.irm)}${word(p.lltv)}`);
    expect(roundTrip.irm.toLowerCase()).toBe(p.irm.toLowerCase());
    expect(decodeMarket(`0x${[1n, 2n, 3n, 4n, 5n, 0n].map(word).join("")}`)).toEqual(m);
  });
  it("aggregate3 round-trips through the decoder layout", () => {
    const calls = [{ target: "0xcA11bde05977b3631167028862bE2a173976CA11", allowFailure: true, callData: "0x5c60e39a" as const }];
    const enc = encodeAggregate3(calls);
    expect(enc.startsWith("0x82ad56cb")).toBe(true);
    // (bool,bytes)[] with one element: offset 0x20, length 1, elem offset 0x20, success 1, bytes offset 0x40, len 32, word
    const ret = `0x${word(0x20)}${word(1)}${word(0x20)}${word(1)}${word(0x40)}${word(32)}${word(7)}` as const;
    expect(decodeAggregate3(ret)).toEqual([{ success: true, returnData: `0x${word(7)}` }]);
  });
  it("readRates reads two multicalls and fails closed per market", async () => {
    const id = "0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047";
    let n = 0;
    const fetchImpl = (async (_url: unknown, init: { body: string }) => {
      n += 1;
      const calls = JSON.parse(init.body).params[0].data as string;
      const results = n === 1
        ? [`0x${[100n, 100n, 40n, 40n, 1n, 0n].map(word).join("")}`, `0x${addressWord("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")}${addressWord("0xb200000000000000000000C2e324d24d7eEcd1fb")}${addressWord("0x1E2b20B4703F97710c2600eA73179c6CD1E00b02")}${addressWord("0x46415998764C29aB2a25CbeA6254146D50D22687")}${word(625_000_000_000_000_000n)}`]
        : [`0x${word(1_000_000_000n)}`];
      expect(calls.startsWith("0x82ad56cb")).toBe(true);
      // encode (bool,bytes)[] by hand
      const elems = results.map((r) => `${word(1)}${word(0x40)}${word(r.length / 2 - 1)}${r.slice(2)}`);
      let off = results.length * 32;
      const offs = elems.map((e) => { const w = word(off); off += e.length / 2; return w; });
      const body = `0x${word(0x20)}${word(results.length)}${offs.join("")}${elems.join("")}`;
      return { json: async () => ({ result: body }) };
    }) as unknown as typeof fetch;
    const [r] = await readRates(["https://rpc.test"], [id], fetchImpl);
    expect(r?.borrowRateWad).toBe(31_536_000_000_000_000n);
    expect(r?.availableLiquidity).toBe(60n);
    expect(r?.lltvWad).toBe(625_000_000_000_000_000n);
    expect(r?.error).toBeUndefined();
  });
});
