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
