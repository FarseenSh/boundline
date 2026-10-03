import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

describe("boundline-indexer", () => {
  it("answers /health without touching the store", async () => {
    const res = await worker.fetch(new Request("http://indexer.local/health"), {} as never, {} as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "boundline-indexer" });
  });
});
