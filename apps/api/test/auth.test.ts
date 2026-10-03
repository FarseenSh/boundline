import { describe, expect, it } from "vitest";
import { authenticate, bearerToken, newPartnerKey, sha256Hex } from "../src/auth.js";
import { createMemoryStore } from "../src/db.js";
import { KEY, PARTNER_ID, call, world } from "./helpers.js";

describe("auth", () => {
  it("parses bearer tokens strictly", () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("")).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer   abc  ")).toBe("abc");
  });

  it("hashes keys with SHA-256 and never compares plaintext", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const store = createMemoryStore();
    const key = newPartnerKey();
    expect(key).toMatch(/^bl_[0-9a-f]{64}$/);
    store.partners.push({ partnerId: PARTNER_ID, name: "p", apiKeyHash: await sha256Hex(key), policyVersion: 1, createdAt: 0 });
    expect(await authenticate(store, `Bearer ${key}`)).not.toBeNull();
    expect(await authenticate(store, `Bearer ${key}x`)).toBeNull();
    expect(await authenticate(store, `Bearer ${await sha256Hex(key)}`)).toBeNull();
  });

  it("refuses a missing key", async () => {
    const { app } = await world();
    const { res, json } = await call(app, "GET", "/v1/obligations", { key: null });
    expect(res.status).toBe(401);
    expect(json.error).toBe("unauthorized");
    expect(res.headers.get("x-correlation-id")).toBeTruthy();
  });

  it("refuses a wrong key", async () => {
    const { app } = await world();
    const { res } = await call(app, "GET", "/v1/obligations", { key: "bl_wrong" });
    expect(res.status).toBe(401);
  });

  it("accepts the right key and reports the policy version", async () => {
    const { app } = await world();
    const { res, json } = await call(app, "GET", "/v1/obligations", { key: KEY });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-policy-version")).toBe("3");
    expect(json.policyVersion).toBe(3);
    expect(json.partnerId).toBe(PARTNER_ID);
  });
});
