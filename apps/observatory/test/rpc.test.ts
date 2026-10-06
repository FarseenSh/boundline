import { describe, expect, it } from "vitest";
import { RpcError, ethCaller, jsonRpc, logsGetter } from "../src/rpc.js";

function fakeFetch(script: Record<string, () => Response | Error>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const step = script[url];
    if (!step) throw new Error(`unexpected url ${url}`);
    const out = step();
    if (out instanceof Error) throw out;
    return out;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ok = (result: unknown) => () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });

describe("jsonRpc", () => {
  it("walks the list past a network error, an HTTP error and a JSON-RPC error to the first result", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "https://a.invalid": () => new Error("fetch failed"),
      "https://b.invalid": () => new Response("rate limited", { status: 429 }),
      "https://c.invalid": () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } }), { status: 200 }),
      "https://d.invalid": ok("0x01"),
    });
    const result = await jsonRpc<string>(["https://a.invalid", "https://b.invalid", "https://c.invalid", "https://d.invalid"], "eth_call", [], { fetchImpl });
    expect(result).toBe("0x01");
    expect(calls).toHaveLength(4);
  });

  it("names every host and failure when all fail, and refuses an empty list", async () => {
    const { fetchImpl } = fakeFetch({ "https://a.invalid": () => new Response("", { status: 500 }), "https://b.invalid": ok(null) });
    const err = await jsonRpc(["https://a.invalid", "https://b.invalid"], "eth_blockNumber", [], { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).attempts).toEqual([
      { host: "a.invalid", error: "http 500" },
      { host: "b.invalid", error: "empty result" },
    ]);
    expect((err as Error).message).toContain("eth_blockNumber failed on 2 RPC(s)");
    await expect(jsonRpc([], "eth_blockNumber", [], { fetchImpl })).rejects.toBeInstanceOf(RpcError);
  });

  it("posts the JSON-RPC envelope with the eth_call params at latest", async () => {
    let body: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xabc" }), { status: 200 });
    }) as unknown as typeof fetch;
    const call = ethCaller(["https://a.invalid"], { fetchImpl });
    expect(await call("0xcA11bde05977b3631167028862bE2a173976CA11", "0x82ad56cb")).toBe("0xabc");
    expect(body).toEqual({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: "0xcA11bde05977b3631167028862bE2a173976CA11", data: "0x82ad56cb" }, "latest"] });
  });

  it("sends eth_getLogs with hex block quantities and the topic filter", async () => {
    let body: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const getLogs = logsGetter(["https://a.invalid"], { fetchImpl });
    expect(await getLogs({ address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", topics: ["0x01", ["0x02"]], fromBlock: 52_200_000, toBlock: 52_201_999 })).toEqual([]);
    expect(body).toEqual({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", topics: ["0x01", ["0x02"]], fromBlock: "0x31c8240", toBlock: "0x31c8a0f" }] });
  });
});
