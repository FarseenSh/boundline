import { aggregatorV3Abi, b20AssetAbi, clPoolAbi, oracleRegistryAbi } from "@boundline/chain";
import { decodeFunctionResult, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MULTICALL3, decodeAggregate3, type CallResult } from "../src/encoding.js";
import { DEFAULT_PLAN, HEAD_CALLS, POOL_STRIDE, TOKEN_STRIDE, callAggregate3, createRpcReader, rpcUrlsOf, shapeReads, type ChainReads } from "../src/reader.js";
import { fixture } from "./encoding.test.js";

/** The same reads decoded by viem, call by call, as the reference. */
function referenceReads(results: CallResult[]): ChainReads {
  const data = (i: number): Hex => `0x${results[i]!.data}`;
  const tokens = DEFAULT_PLAN.tokens.map((t, i) => {
    const b = HEAD_CALLS + i * TOKEN_STRIDE;
    const round = decodeFunctionResult({ abi: aggregatorV3Abi, functionName: "latestRoundData", data: data(b) });
    const params = decodeFunctionResult({ abi: oracleRegistryAbi, functionName: "getOracleParams", data: data(b + 2) });
    return {
      symbol: t.symbol,
      address: t.address,
      feed: t.feed,
      feedRoundId: round[0],
      feedAnswer: round[1],
      feedUpdatedAt: round[3],
      feedDecimals: decodeFunctionResult({ abi: aggregatorV3Abi, functionName: "decimals", data: data(b + 1) }),
      registryMultiplier: params[0],
      registryPaused: params[1],
      transferPaused: decodeFunctionResult({ abi: b20AssetAbi, functionName: "isPaused", data: data(b + 3) }),
      pausedFeatures: [...decodeFunctionResult({ abi: b20AssetAbi, functionName: "pausedFeatures", data: data(b + 4) })],
      uiMultiplier: decodeFunctionResult({ abi: b20AssetAbi, functionName: "uiMultiplier", data: data(b + 5) }),
      newUIMultiplier: decodeFunctionResult({ abi: b20AssetAbi, functionName: "newUIMultiplier", data: data(b + 6) }),
      effectiveAt: decodeFunctionResult({ abi: b20AssetAbi, functionName: "effectiveAt", data: data(b + 7) }),
      errors: [] as string[],
    };
  });
  const poolBase = HEAD_CALLS + DEFAULT_PLAN.tokens.length * TOKEN_STRIDE;
  const pools = DEFAULT_PLAN.pooled.map((t, i) => {
    const b = poolBase + i * POOL_STRIDE;
    const slot0 = decodeFunctionResult({ abi: clPoolAbi, functionName: "slot0", data: data(b) });
    const [cums] = decodeFunctionResult({ abi: clPoolAbi, functionName: "observe", data: data(b + 2) });
    return {
      symbol: t.symbol,
      pool: t.aerodromePool!,
      sqrtPriceX96: slot0[0],
      tick: slot0[1],
      liquidity: decodeFunctionResult({ abi: clPoolAbi, functionName: "liquidity", data: data(b + 1) }),
      tickCumulatives: [cums[0]!, cums[1]!] as [bigint, bigint],
      twapWindow: 3600,
    };
  });
  return {
    chainId: 8453,
    blockNumber: BigInt(data(0)),
    blockTimestamp: Number(BigInt(data(1))),
    tokens,
    pools,
  };
}

describe("shapeReads on the recorded mainnet response", () => {
  const results = decodeAggregate3(fixture.result);

  it("was recorded for the current default plan (re-run scripts/record-aggregate3.ts if the token list changed)", () => {
    expect(fixture.calldata).toBe(DEFAULT_PLAN.data);
  });

  it("equals viem's decoding field by field, with no read errors", () => {
    const ours = shapeReads(DEFAULT_PLAN, results);
    expect(ours).toEqual(referenceReads(results));
    expect(ours.tokens).toHaveLength(10);
    expect(ours.pools).toHaveLength(2);
    expect(ours.tokens.every((t) => t.errors.length === 0)).toBe(true);
    expect(ours.tokens[0]!.feedAnswer).toBeGreaterThan(100n * 10n ** 8n);
  });

  it("takes the block number and timestamp from the aggregate itself", () => {
    const ours = shapeReads(DEFAULT_PLAN, results);
    expect(ours.blockNumber).toBeGreaterThan(52_000_000n);
    expect(Math.abs(ours.blockTimestamp - Date.parse(fixture.recordedAt) / 1000)).toBeLessThan(120);
  });

  it("keeps the row and names the call when one read fails or decodes short", () => {
    // a failed call, and a "successful" one whose return data is shorter than one word
    const broken = results.map((r, i) => (i === HEAD_CALLS ? { success: false, data: "" } : i === HEAD_CALLS + 4 ? { success: true, data: "00".repeat(20) } : r));
    const ours = shapeReads(DEFAULT_PLAN, broken);
    expect(ours.tokens[0]!.errors).toEqual(["latestRoundData", "pausedFeatures"]);
    expect(ours.tokens[0]!.feedAnswer).toBe(0n);
    expect(ours.tokens[0]!.pausedFeatures).toEqual([]);
    expect(ours.tokens[1]!.errors).toEqual([]);
  });

  it("drops the TWAP when observe fails and refuses a failed block helper", () => {
    const poolBase = HEAD_CALLS + 10 * TOKEN_STRIDE;
    const noObserve = results.map((r, i) => (i === poolBase + 2 ? { success: false, data: "" } : r));
    expect(shapeReads(DEFAULT_PLAN, noObserve).pools[0]!.tickCumulatives).toBeNull();
    expect(() => shapeReads(DEFAULT_PLAN, results.map((r, i) => (i === 0 ? { success: false, data: "" } : r)))).toThrow(/getBlockNumber/);
    expect(() => shapeReads(DEFAULT_PLAN, results.slice(1))).toThrow(/87 results/);
  });
});

describe("callAggregate3 and createRpcReader", () => {
  it("send one eth_call to Multicall3 at latest through the fallback list and decode the answer", async () => {
    const seen: unknown[] = [];
    const call = async (to: string, data: string) => (seen.push({ to, data }), fixture.result);
    const results = await callAggregate3(call, DEFAULT_PLAN.data);
    expect(results).toHaveLength(88);
    expect(seen[0]).toEqual({ to: MULTICALL3, data: DEFAULT_PLAN.data });
  });

  it("reads a snapshot over a fake fetch, falling past a dead RPC", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      urls.push(url);
      if (url.includes("dead")) throw new Error("connect ECONNREFUSED");
      const body = JSON.parse(init.body as string) as { method: string; params: [{ to: string; data: string }, string] };
      expect(body.method).toBe("eth_call");
      expect(body.params).toEqual([{ to: MULTICALL3, data: DEFAULT_PLAN.data }, "latest"]);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: fixture.result }), { status: 200 });
    }) as unknown as typeof fetch;
    const reader = createRpcReader("https://dead.invalid/rpc,https://live.invalid/rpc", { fetchImpl });
    const reads = await reader.read();
    expect(urls).toEqual(["https://dead.invalid/rpc", "https://live.invalid/rpc"]);
    expect(reads.tokens).toHaveLength(10);
    expect(reads.blockNumber).toBeGreaterThan(52_000_000n);
  });

  it("falls back to the public mainnet list when no RPC is configured", () => {
    expect(rpcUrlsOf("")).toEqual(["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://mainnet.base.org"]);
    expect(rpcUrlsOf(" https://a.invalid ,, https://b.invalid ")).toEqual(["https://a.invalid", "https://b.invalid"]);
  });
});
