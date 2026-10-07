import { describe, expect, it } from "vitest";
import { rehashBundle } from "../src/hashing.js";
import { mockRequest } from "../src/mock.js";
import type { EvidenceBundle, PolicyResponse, PolicyVersion } from "../src/types.js";

describe("fixtures (VITE_CONSOLE_MOCK=1)", () => {
  it("answers every page's reads with the contract's shapes", () => {
    const policy = mockRequest("GET", "/v1/policy").body as PolicyResponse;
    expect(policy.tickers.map((t) => t.symbol)).toEqual(["AAPLt", "NVDAt", "TSLAt"]);
    expect(mockRequest("GET", "/v1/obligations?limit=5").status).toBe(200);
    expect(mockRequest("GET", "/v1/lines/1/decisions").status).toBe(200);
    expect(mockRequest("GET", "/v1/drills").status).toBe(200);
    expect(mockRequest("GET", "/v1/drills/protection").status).toBe(200);
    expect(mockRequest("GET", "/v1/drills/nope").status).toBe(404);
    expect(mockRequest("GET", "/v1/reconciliation").status).toBe(200);
    expect(mockRequest("GET", "/indexer/v1/sources").status).toBe(200);
    expect(mockRequest("GET", "/v1/unknown").status).toBe(404);
  });
  it("prepares and applies a policy version", () => {
    const before = (mockRequest("GET", "/v1/policy/versions").body as { versions: PolicyVersion[] }).versions.length;
    const created = mockRequest("POST", "/v1/policy/versions", { note: "test", tickers: [] });
    expect(created.status).toBe(201);
    const v = created.body as PolicyVersion;
    expect(v.status).toBe("prepared");
    expect((mockRequest("GET", "/v1/policy/versions").body as { versions: PolicyVersion[] }).versions).toHaveLength(before + 1);
    const applied = mockRequest("POST", `/v1/policy/versions/${v.id}/applied`, { txHash: "0x" + "ab".repeat(32) });
    expect(applied.status).toBe(200);
    expect((applied.body as PolicyVersion).status).toBe("applied");
    expect((mockRequest("GET", `/v1/policy/versions/${v.id}`).body as PolicyVersion).txHash).toBe("0x" + "ab".repeat(32));
    expect(mockRequest("POST", "/v1/policy/versions/missing/applied", {}).status).toBe(404);
  });
  it("ships an evidence bundle whose hash the browser's recomputation reproduces", () => {
    const bundle = mockRequest("GET", "/v1/evidence/export").body as EvidenceBundle;
    expect(bundle.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(rehashBundle(bundle as unknown as Record<string, unknown>)).toBe(bundle.hash);
  });
});
