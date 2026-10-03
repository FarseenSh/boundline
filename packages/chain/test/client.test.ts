import { describe, expect, it } from "vitest";
import { PUBLIC_RPC_URLS, createBaseClient, splitRpcUrls } from "../src/client.js";

describe("splitRpcUrls", () => {
  it("splits a comma list, trims and drops blanks", () => {
    expect(splitRpcUrls(" https://a.example , ,https://b.example,")).toEqual(["https://a.example", "https://b.example"]);
    expect(splitRpcUrls(undefined)).toEqual([]);
    expect(splitRpcUrls("")).toEqual([]);
  });
});

describe("createBaseClient", () => {
  it("uses a plain http transport for one URL", () => {
    const c = createBaseClient({ chainId: 8453, rpcUrl: "https://a.example" });
    expect(c.transport.type).toBe("http");
    expect(c.chain.id).toBe(8453);
  });
  it("uses a fallback transport, in the given order, for several URLs", () => {
    const c = createBaseClient({ chainId: 8453, rpcUrl: "https://a.example,https://b.example" });
    expect(c.transport.type).toBe("fallback");
    expect((c.transport as { transports: { value?: { url?: string } }[] }).transports.map((t) => t.value?.url)).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
  it("falls back to the verified public list when no URL is given", () => {
    const c = createBaseClient({ chainId: 84532 });
    expect(c.chain.id).toBe(84532);
    expect(c.transport.type).toBe(PUBLIC_RPC_URLS[84532].length > 1 ? "fallback" : "http");
    expect(PUBLIC_RPC_URLS[8453].at(-1)).toBe("https://mainnet.base.org");
  });
});
