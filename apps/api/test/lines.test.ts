import { describe, expect, it } from "vitest";
import { hashTypedData, toFunctionSelector, type Hex } from "viem";
import { toPartnerId } from "../src/app.js";
import { ADMIN, DESK, MARKET_ID, NOW, OTHER_PARTNER_ID, PARTNER_ID, USER, ZERO32, call, makeDesk, sampleLine, samplePartner, world } from "./helpers.js";

const body = (over: Record<string, unknown> = {}) => ({ partnerId: "boundline-app", user: USER, marketId: MARKET_ID, deadline: NOW + 3600, ...over });
const headers = () => ({ "idempotency-key": `k-${Math.random()}` });

describe("POST /v1/lines", () => {
  it("prepares typed data, the desk-verified digest and the openLine call", async () => {
    const { app } = await world();
    const { res, json } = await call(app, "POST", "/v1/lines", { body: body(), headers: headers() });
    expect(res.status).toBe(200);
    expect(json.partnerId).toBe(PARTNER_ID);
    expect(json.nonce).toBe("0");
    expect(json.deadline).toBe(String(NOW + 3600));
    expect(json.signatureRequired).toBe(false);
    expect(json.signer).toBeNull();
    expect(json.existingLineId).toBe("1");
    expect(json.typedData.domain).toEqual({ name: "Boundline CreditDesk", version: "1", chainId: 84532, verifyingContract: DESK });
    expect(json.typedData.primaryType).toBe("LineAuthorization");
    expect(json.typedData.message).toEqual({ partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, nonce: "0", deadline: String(NOW + 3600) });
    const digest = hashTypedData({
      domain: json.typedData.domain,
      types: { LineAuthorization: json.typedData.types.LineAuthorization },
      primaryType: "LineAuthorization",
      message: { ...json.typedData.message, nonce: 0n, deadline: BigInt(NOW + 3600) },
    });
    expect(json.digest).toBe(digest);
    expect(json.call.to).toBe(DESK);
    expect((json.call.data as string).slice(0, 10)).toBe(toFunctionSelector("openLine(bytes32,bytes32,uint256,bytes)"));
    expect(json.policyVersion).toBe(3);
    expect(res.headers.get("x-policy-version")).toBe("3");
    expect(json.selfCustody).toMatch(/never signs/);
  });

  it("flags a partner signer", async () => {
    const { app } = await world({ desk: makeDesk({ partner: async () => samplePartner({ signer: ADMIN }), lineOf: async () => 0n }) });
    const { json } = await call(app, "POST", "/v1/lines", { body: body(), headers: headers() });
    expect(json.signatureRequired).toBe(true);
    expect(json.signer).toBe(ADMIN);
    expect(json.existingLineId).toBeNull();
    expect(json.call.note).toMatch(/signature/);
  });

  it("refuses when the desk and the API disagree on the digest", async () => {
    const { app } = await world({ desk: makeDesk({ lineAuthorizationDigest: async () => ZERO32 }) });
    const { res, json } = await call(app, "POST", "/v1/lines", { body: body(), headers: headers() });
    expect(res.status).toBe(500);
    expect(json.error).toMatch(/digest mismatch/);
  });

  it("validates the request and scopes it to the partner", async () => {
    const { app } = await world();
    expect((await call(app, "POST", "/v1/lines", { body: body({ partnerId: "someone-else" }), headers: headers() })).res.status).toBe(403);
    expect((await call(app, "POST", "/v1/lines", { body: body({ user: "0x123" }), headers: headers() })).res.status).toBe(400);
    expect((await call(app, "POST", "/v1/lines", { body: body({ marketId: "0x12" }), headers: headers() })).res.status).toBe(400);
    expect((await call(app, "POST", "/v1/lines", { body: body({ deadline: NOW - 1 }), headers: headers() })).res.status).toBe(400);
    expect((await call(app, "POST", "/v1/lines", { body: body({ partnerId: "" }), headers: headers() })).res.status).toBe(400);
  });

  it("answers 404 for a partner the desk does not know and 503 without a desk", async () => {
    const { app } = await world({ desk: makeDesk({ partner: async () => samplePartner({ admin: "0x0000000000000000000000000000000000000000" }) }) });
    expect((await call(app, "POST", "/v1/lines", { body: body(), headers: headers() })).res.status).toBe(404);
    const { app: app2 } = await world({ desk: null });
    expect((await call(app2, "POST", "/v1/lines", { body: body(), headers: headers() })).res.status).toBe(503);
  });

  it("maps a desk read failure to 502", async () => {
    const { app } = await world({ desk: makeDesk({ nonces: async () => { throw new Error("rpc down"); } }) });
    const { res, json } = await call(app, "POST", "/v1/lines", { body: body(), headers: headers() });
    expect(res.status).toBe(502);
    expect(json.detail).toBe("rpc down");
  });
});

describe("GET /v1/lines/:id", () => {
  it("returns the line, the obligation status and a zero-draw quote", async () => {
    const { app, store } = await world({ desk: makeDesk({ obligationStatus: async () => 2 }) });
    const { res, json } = await call(app, "GET", "/v1/lines/1");
    expect(res.status).toBe(200);
    expect(json.line).toMatchObject({ lineId: "1", user: USER, marketId: MARKET_ID, status: "OPEN", policyVersion: 3, drawnPrincipal: { baseUnits: "0", usdc: "0.000000" } });
    expect(json.obligationStatus).toBe("HOLD_SESSION");
    expect(json.quote.reason).toBe("NONE");
    expect(json.quote.draw).toBe("0");
    expect(res.headers.get("x-policy-version")).toBe("3");
    expect(store.lines.has("1")).toBe(true);
  });

  it("keeps the line readable when the quote fails and hides other partners' lines", async () => {
    const { app } = await world({ desk: makeDesk({ quote: async () => { throw new Error("FeedStale"); } }) });
    const { res, json } = await call(app, "GET", "/v1/lines/1");
    expect(res.status).toBe(200);
    expect(json.quote).toEqual({ reason: "UNKNOWN", detail: "FeedStale" });
    const { app: app2 } = await world({ desk: makeDesk({ line: async () => sampleLine({ partnerId: OTHER_PARTNER_ID }) }) });
    expect((await call(app2, "GET", "/v1/lines/1")).res.status).toBe(404);
    const { app: app3 } = await world({ desk: makeDesk({ line: async () => { throw new Error("UnknownLine(9)"); } }) });
    expect((await call(app3, "GET", "/v1/lines/9")).res.status).toBe(404);
    expect((await call(app3, "GET", "/v1/lines/abc")).res.status).toBe(400);
    const { app: app4 } = await world({ desk: null });
    expect((await call(app4, "GET", "/v1/lines/1")).res.status).toBe(503);
  });
});

describe("toPartnerId", () => {
  it("accepts bytes32 and short strings only", () => {
    expect(toPartnerId(MARKET_ID.toUpperCase().replace("0X", "0x"))).toBe(MARKET_ID);
    expect(toPartnerId("boundline-app")).toBe(("0x" + Buffer.from("boundline-app").toString("hex").padEnd(64, "0")) as Hex);
    expect(toPartnerId("0x1234")).toBeNull();
    expect(toPartnerId("")).toBeNull();
    expect(toPartnerId("x".repeat(33))).toBeNull();
    expect(toPartnerId(42)).toBeNull();
  });
});
