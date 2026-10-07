import { describe, expect, it } from "vitest";
import { b64decodeJson, b64encodeJson, parsePayment, usdcToAtomic } from "../src/x402.js";
import { MARKET_ID, PARTNER_ID, PAY_TO, USDC_SEPOLIA, USER, X402_CFG, call, fakeFacilitator, makeDesk, world } from "./helpers.js";

const SIG = `0x${"ab".repeat(65)}`;
const authorization = (over: Partial<Record<string, string>> = {}) => ({
  from: USER,
  to: PAY_TO,
  value: "10000",
  validAfter: "1791040000",
  validBefore: "1791040300",
  nonce: `0x${"11".repeat(32)}`,
  ...over,
});

/** A v2 PaymentPayload as @x402/fetch would build it from the 402's requirement. */
const v2Payment = (over: Record<string, unknown> = {}) =>
  b64encodeJson({
    x402Version: 2,
    resource: { url: "https://api/v1/quotes", description: "test resource", mimeType: "application/json" },
    accepted: { scheme: "exact", network: "eip155:84532", amount: "10000", asset: USDC_SEPOLIA, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } },
    payload: { signature: SIG, authorization: authorization() },
    ...over,
  });

/** A v1 payload as x402-fetch 1.x sends it. */
const v1Payment = (over: Record<string, unknown> = {}) =>
  b64encodeJson({ x402Version: 1, scheme: "exact", network: "base-sepolia", payload: { signature: SIG, authorization: authorization() }, ...over });

async function metered(over: Parameters<typeof fakeFacilitator>[0] = {}, desk = makeDesk()) {
  const facilitator = fakeFacilitator(over);
  const w = await world({ desk, x402: { cfg: X402_CFG, facilitator } });
  return { ...w, facilitator };
}

describe("x402 metering", () => {
  it("answers 402 with the requirements in both generations when a metered route is called without a key", async () => {
    const { app, facilitator } = await metered();
    const { res, json } = await call(app, "POST", "/v1/quotes", { key: null, body: { lineId: "1" } });
    expect(res.status).toBe(402);
    expect(json.x402Version).toBe(1);
    expect(json.error).toBe("PAYMENT-SIGNATURE header is required");
    expect(json.accepts).toHaveLength(1);
    expect(json.accepts[0]).toMatchObject({ scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000", payTo: PAY_TO, asset: USDC_SEPOLIA, mimeType: "application/json", maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } });
    expect(json.accepts[0].resource).toMatch(/\/v1\/quotes$/);
    expect(json.price).toEqual({ usdc: "0.01", atomic: "10000", asset: USDC_SEPOLIA, network: "base-sepolia" });
    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();
    const v2 = b64decodeJson(header as string) as Record<string, any>;
    expect(v2.x402Version).toBe(2);
    expect(v2.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "10000", asset: USDC_SEPOLIA, payTo: PAY_TO, extra: { name: "USDC", version: "2" } });
    expect(v2.resource.url).toMatch(/\/v1\/quotes$/);
    expect(v2.resource.serviceName).toBe("Boundline partner API");
    expect(json.v2).toEqual(v2);
    expect(res.headers.get("x-correlation-id")).toBeTruthy();
    expect(facilitator.calls).toHaveLength(0);
  });

  it("keeps every other route at 401 without a key, and never meters a partner with a key", async () => {
    const { app, facilitator } = await metered();
    expect((await call(app, "GET", "/v1/obligations", { key: null })).res.status).toBe(401);
    expect((await call(app, "GET", "/v1/lines/1", { key: null })).res.status).toBe(401);
    const { res, json } = await call(app, "POST", "/v1/quotes", { body: { lineId: "1" }, headers: { "idempotency-key": "k1" } });
    expect(res.status).toBe(200);
    expect(json.metered).toBe(false);
    expect(res.headers.get("payment-response")).toBeNull();
    expect(facilitator.calls).toHaveLength(0);
    expect((await call(app, "GET", `/v1/positions/${USER}/shadow`)).res.status).toBe(200);
  });

  it("verifies before the route and settles after a 2xx (v2 headers)", async () => {
    const { app, facilitator, store } = await metered();
    const { res, json } = await call(app, "POST", "/v1/quotes", { key: null, body: { lineId: "1", draw: "1000000" }, headers: { "payment-signature": v2Payment() } });
    expect(res.status).toBe(200);
    expect(json.metered).toBe(true);
    expect(json.reason).toBe("NONE");
    expect(json.quoteHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(facilitator.calls.map((c) => c.kind)).toEqual(["verify", "settle"]);
    const verify = facilitator.calls[0]!.req;
    expect(verify.x402Version).toBe(2);
    expect(verify.paymentRequirements).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "10000", asset: USDC_SEPOLIA, payTo: PAY_TO });
    expect((verify.paymentPayload as any).payload.authorization.from).toBe(USER);
    const settled = b64decodeJson(res.headers.get("payment-response") as string) as Record<string, unknown>;
    expect(settled).toMatchObject({ success: true, network: "eip155:84532", payer: USER });
    expect(res.headers.get("x-payment-response")).toBe(res.headers.get("payment-response"));
    // The quote is recorded under the line's own partner, since no partner authenticated.
    expect(store.quotes.get(json.quoteHash)?.partnerId).toBe(json.partnerId);
  });

  it("accepts a v1 X-PAYMENT header and talks v1 to the facilitator", async () => {
    const { app, facilitator, store } = await metered();
    await store.rememberLine({ lineId: "1", partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, firstSeen: 1 }); // keyless discovery uses the indexer and this cache
    const { res, json } = await call(app, "GET", `/v1/positions/${USER}/shadow`, { key: null, headers: { "x-payment": v1Payment() } });
    expect(res.status).toBe(200);
    expect(json.metered).toBe(true);
    expect(json.decision).toBe("ALLOW");
    const verify = facilitator.calls[0]!.req;
    expect(verify.x402Version).toBe(1);
    expect(verify.paymentRequirements).toMatchObject({ scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000", payTo: PAY_TO, asset: USDC_SEPOLIA });
    expect((verify.paymentRequirements as any).resource).toMatch(/\/shadow$/);
    expect(res.headers.get("x-payment-response")).toBeTruthy();
  });

  it("answers 402 again when the facilitator says the payment is invalid, and never settles", async () => {
    const { app, facilitator } = await metered({ verify: { isValid: false, invalidReason: "insufficient_funds", payer: USER } });
    const { res, json } = await call(app, "POST", "/v1/quotes", { key: null, body: { lineId: "1" }, headers: { "payment-signature": v2Payment() } });
    expect(res.status).toBe(402);
    expect(json.error).toBe("insufficient_funds");
    expect(res.headers.get("payment-required")).toBeTruthy();
    expect(facilitator.calls.map((c) => c.kind)).toEqual(["verify"]);
  });

  it("does not charge for a refusal: a route answering non-2xx is never settled", async () => {
    const { app, facilitator } = await metered({}, makeDesk({ line: async () => { throw new Error("UnknownLine(9)"); } }));
    const { res, json } = await call(app, "POST", "/v1/quotes", { key: null, body: { lineId: "9" }, headers: { "payment-signature": v2Payment() } });
    expect(res.status).toBe(404);
    expect(json.error).toBe("unknown line");
    expect(facilitator.calls.map((c) => c.kind)).toEqual(["verify"]);
    expect(res.headers.get("payment-response")).toBeNull();
  });

  it("turns a failed settlement into a 402 that carries the settlement response", async () => {
    const { app } = await metered({ settle: { success: false, errorReason: "invalid_transaction_state", transaction: "", network: "eip155:84532", payer: USER } });
    const { res, json } = await call(app, "POST", "/v1/quotes", { key: null, body: { lineId: "1" }, headers: { "payment-signature": v2Payment() } });
    expect(res.status).toBe(402);
    expect(json).toMatchObject({ error: "payment settlement failed", reason: "invalid_transaction_state", payer: USER });
    expect(b64decodeJson(res.headers.get("payment-response") as string)).toMatchObject({ success: false, errorReason: "invalid_transaction_state" });
  });

  it("answers 502 when the facilitator is unreachable", async () => {
    const { app } = await metered({ verify: new Error("connect ETIMEDOUT") });
    const { res, json } = await call(app, "POST", "/v1/quotes", { key: null, body: { lineId: "1" }, headers: { "payment-signature": v2Payment() } });
    expect(res.status).toBe(502);
    expect(json).toMatchObject({ error: "facilitator unavailable", stage: "verify" });
  });

  it("rejects a payment that does not match the requirement before asking the facilitator", async () => {
    const { app, facilitator } = await metered();
    const wrongAmount = v2Payment({ payload: { signature: SIG, authorization: authorization({ value: "9999" }) } });
    let r = await call(app, "POST", "/v1/quotes", { key: null, body: { lineId: "1" }, headers: { "payment-signature": wrongAmount } });
    expect(r.res.status).toBe(402);
    expect(r.json.error).toBe("invalid_exact_evm_payload_authorization_value_mismatch");
    const wrongNetwork = v1Payment({ network: "base" });
    r = await call(app, "POST", "/v1/quotes", { key: null, body: { lineId: "1" }, headers: { "x-payment": wrongNetwork } });
    expect(r.json.error).toBe("invalid_network");
    r = await call(app, "POST", "/v1/quotes", { key: null, body: { lineId: "1" }, headers: { "payment-signature": "not base64 json" } });
    expect(r.res.status).toBe(402);
    expect(r.json.error).toMatch(/base64/);
    expect(facilitator.calls).toHaveLength(0);
  });

  it("stays at 401 for keyless calls when metering is off", async () => {
    const { app } = await world();
    expect((await call(app, "POST", "/v1/quotes", { key: null, body: { lineId: "1" } })).res.status).toBe(401);
    expect((await call(app, "GET", `/v1/positions/${USER}/shadow`, { key: null })).res.status).toBe(401);
  });
});

describe("x402 helpers", () => {
  it("converts USDC prices to atomic units without rounding", () => {
    expect(usdcToAtomic("0.01")).toBe("10000");
    expect(usdcToAtomic("1")).toBe("1000000");
    expect(usdcToAtomic("0.000001")).toBe("1");
    expect(usdcToAtomic("12.5")).toBe("12500000");
    expect(() => usdcToAtomic("0.0000001")).toThrow();
    expect(() => usdcToAtomic("1e-2")).toThrow();
  });

  it("round-trips base64 JSON including non-ASCII text", () => {
    const value = { a: "déjà vu ✓", n: 1, nested: { x: [1, 2] } };
    expect(b64decodeJson(b64encodeJson(value))).toEqual(value);
  });

  it("parses payments of both generations and names the mismatch", () => {
    const ok = parsePayment(X402_CFG, { v2: v2Payment() });
    expect("error" in ok ? ok.error : ok.version).toBe(2);
    const v1 = parsePayment(X402_CFG, { v1: v1Payment() });
    expect("error" in v1 ? v1.error : v1.payer).toBe(USER);
    const wrongPayee = parsePayment(X402_CFG, { v2: v2Payment({ payload: { signature: SIG, authorization: authorization({ to: USER }) } }) });
    expect("error" in wrongPayee && wrongPayee.error).toBe("invalid_exact_evm_payload_recipient_mismatch");
    expect("error" in parsePayment(X402_CFG, {}) && parsePayment(X402_CFG, {})).toMatchObject({ error: "PAYMENT-SIGNATURE header is required" });
  });
});
