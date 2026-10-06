import { describe, expect, it } from "vitest";
import { app } from "../src/index.js";

describe("boundline-keeper", () => {
  it("answers /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "boundline-keeper" });
  });

  it("describes its config without leaking RPC keys", async () => {
    const res = await app.request("/v1/config", {}, { BASE_RPC_URL: "https://a.example/v2/secret", BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chains: { mainnet: { rpc: string[] } }; pairs: unknown[]; keeperAddress: string };
    expect(body.chains.mainnet.rpc).toEqual(["a.example"]);
    expect(body.pairs).toHaveLength(3);
    expect(body.keeperAddress).toBe("0x28A50Eb7C2Db2B04638D3b226c724A1Cfe999894");
  });
});

describe("maxTxPerTick", () => {
  it("falls back to the default when the var is unset, blank or not a whole number", async () => {
    const { maxTxPerTick } = await import("../src/index.js");
    const { MAX_TX_PER_TICK } = await import("../src/config.js");
    expect(maxTxPerTick({})).toBe(MAX_TX_PER_TICK);
    expect(maxTxPerTick({ MAX_TX_PER_TICK: "" })).toBe(MAX_TX_PER_TICK);
    expect(maxTxPerTick({ MAX_TX_PER_TICK: " " })).toBe(MAX_TX_PER_TICK);
    expect(maxTxPerTick({ MAX_TX_PER_TICK: "x" })).toBe(MAX_TX_PER_TICK);
    expect(maxTxPerTick({ MAX_TX_PER_TICK: "1.5" })).toBe(MAX_TX_PER_TICK);
    expect(maxTxPerTick({ MAX_TX_PER_TICK: "-1" })).toBe(MAX_TX_PER_TICK);
  });
  it("honours a whole number, including zero (plan only)", async () => {
    const { maxTxPerTick } = await import("../src/index.js");
    expect(maxTxPerTick({ MAX_TX_PER_TICK: "3" })).toBe(3);
    expect(maxTxPerTick({ MAX_TX_PER_TICK: "0" })).toBe(0);
  });
  it("is reported by /v1/config", async () => {
    const res = await app.request("/v1/config", {}, { BASE_RPC_URL: "https://a.example", BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org", MAX_TX_PER_TICK: "2" });
    const body = (await res.json()) as { maxTxPerTick: number };
    expect(body.maxTxPerTick).toBe(2);
  });
});
