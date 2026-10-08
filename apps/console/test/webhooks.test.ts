import { webhookSignature } from "@boundline/sdk";
import { describe, expect, it } from "vitest";
import { mockRequest } from "../src/mock.js";
import { versionOf } from "../src/policy.js";
import type { PolicyResponse, PolicyVersion } from "../src/types.js";
import { checkEchoDelivery, checkEchoDeliveryDetail, echoTokenOf, EVENT_CHOICES, rawBodyOf, receiverVerdict, summarizeData, toggleEvent, validateWebhookForm } from "../src/webhooks.js";

describe("event selection", () => {
  it("'*' excludes the specific events and the other way round, in a stable order", () => {
    expect(EVENT_CHOICES[0]).toBe("*");
    expect(toggleEvent([], "*")).toEqual(["*"]);
    expect(toggleEvent(["*"], "*")).toEqual([]);
    expect(toggleEvent(["*"], "grace")).toEqual(["grace"]);
    expect(toggleEvent(["grace"], "*")).toEqual(["*"]);
    expect(toggleEvent(["settle"], "grace")).toEqual(["grace", "settle"]);
    expect(toggleEvent(["grace", "settle"], "grace")).toEqual(["settle"]);
  });
});

describe("the registration form", () => {
  it("wants an https URL that the API can reach and at least one event", () => {
    expect(validateWebhookForm({ url: "https://ops.partner.example/hooks", events: ["grace"] })).toEqual([]);
    expect(validateWebhookForm({ url: "http://ops.partner.example/hooks", events: ["grace"] })).toEqual(["deliveries go only to https URLs"]);
    expect(validateWebhookForm({ url: "https://localhost:8787/x", events: ["grace"] })).toEqual(["a local address cannot receive deliveries from the API"]);
    expect(validateWebhookForm({ url: "not a url", events: [] })).toEqual(["the URL is not a valid URL", "choose at least one event"]);
  });
  it("recognises the API's echo receiver URL", () => {
    const token = "0123456789abcdef0123456789abcdef";
    expect(echoTokenOf(`https://boundline-api.papermind-ai.workers.dev/v1/webhooks/echo/${token}`)).toBe(token);
    expect(echoTokenOf("https://ops.partner.example/hooks")).toBeNull();
  });
});

describe("re-checking an echoed delivery in the browser", () => {
  const secret = "whsec_mock_wh_0002";
  const raw = JSON.stringify({ id: "ev_9", type: "ping", createdAt: 1791441345, chainId: 84532, partnerId: "0x626f", data: {} });
  const t = 1791441345;
  // The SDK's own suite pins webhookSignature to node:crypto's HMAC; here it only produces a valid header.
  const signed = webhookSignature(secret, t, raw);

  it("verifies with the tab's secret and the raw body the receiver kept", async () => {
    const v1 = await signed;
    expect(await checkEchoDelivery({ rawBody: raw, headers: { "Boundline-Signature": `t=${t},v1=${v1}` } }, secret)).toBe("verified");
    expect(await checkEchoDelivery({ body: raw, signature: `t=${t},v1=${v1}` }, secret)).toBe("verified");
    expect(await checkEchoDelivery({ rawBody: raw.replace("ping", "pong"), signature: `t=${t},v1=${v1}` }, secret)).toBe("mismatch");
  });
  it("says why it cannot check", async () => {
    const v1 = await signed;
    expect(await checkEchoDelivery({ rawBody: raw, signature: `t=${t},v1=${v1}` }, null)).toBe("no-secret");
    expect(await checkEchoDelivery({ rawBody: raw }, secret)).toBe("no-signature");
    expect(await checkEchoDelivery({ body: 42 as unknown as string, signature: `t=${t},v1=${v1}` }, secret)).toBe("no-raw-body");
    expect(rawBodyOf({})).toBeNull();
  });
  it("checks the partner API's echo shape: parsed body, lower-case headers, signatureValid", async () => {
    const v1 = await signed;
    const echoed = { receivedAt: t, deliveryId: "dl_1", type: "ping", signatureValid: true, verification: "valid", headers: { "boundline-signature": `t=${t},v1=${v1}`, "boundline-event": "ping" }, body: JSON.parse(raw) as unknown };
    expect(await checkEchoDeliveryDetail(echoed, secret)).toEqual({ check: "verified", reserialised: true });
    expect(receiverVerdict(echoed)).toEqual({ ok: true, words: "valid" });
    expect(receiverVerdict({ signatureValid: false, verification: "signature mismatch" })).toEqual({ ok: false, words: "signature mismatch" });
    expect(receiverVerdict({ verified: true })).toEqual({ ok: true, words: null });
    expect(receiverVerdict({})).toEqual({ ok: null, words: null });
  });
  it("summarises event data in one line", () => {
    expect(summarizeData({ shadowLtvBps: 5310, graceLtvBps: 5200, nested: { x: 1 }, none: null })).toBe("shadowLtvBps 5310 · graceLtvBps 5200");
    expect(summarizeData(undefined)).toBe("");
  });
});

describe("fixtures: webhooks, events, the echo receiver and Saturday mode", () => {
  it("registers, tests, echoes and deletes a webhook", () => {
    const token = "fedcba9876543210fedcba9876543210";
    const created = mockRequest("POST", "/v1/webhooks", { url: `https://boundline-api.papermind-ai.workers.dev/v1/webhooks/echo/${token}`, events: ["*"] });
    expect(created.status).toBe(201);
    const hook = created.body as { id: string; secret: string };
    expect(hook.secret).toMatch(/^whsec_/);
    const listed = (mockRequest("GET", "/v1/webhooks").body as { webhooks: Record<string, unknown>[] }).webhooks;
    expect(listed.find((w) => w.id === hook.id)).toBeDefined();
    expect(listed.every((w) => !("secret" in w))).toBe(true);
    expect(mockRequest("POST", `/v1/webhooks/${hook.id}/test`, {}).status).toBe(202);
    expect((mockRequest("GET", `/v1/webhooks/${hook.id}/deliveries`).body as { deliveries: { type: string }[] }).deliveries[0]!.type).toBe("ping");
    expect((mockRequest("GET", `/v1/webhooks/echo/${token}`).body as { deliveries: { verified: boolean }[] }).deliveries[0]!.verified).toBe(true);
    expect(mockRequest("DELETE", `/v1/webhooks/${hook.id}`).status).toBe(204);
    expect(mockRequest("DELETE", `/v1/webhooks/${hook.id}`).status).toBe(404);
    expect(mockRequest("POST", "/v1/webhooks", { url: "http://x", events: ["grace"] }).status).toBe(400);
    expect((mockRequest("GET", "/v1/events").body as { events: unknown[] }).events.length).toBeGreaterThan(0);
  });
  it("a Saturday-only version carries no desk call and applies without bumping the desk's version", () => {
    const before = (mockRequest("GET", "/v1/policy").body as PolicyResponse).policyVersion;
    const v = versionOf(mockRequest("POST", "/v1/policy/versions", { note: "weekend pilot", saturdayMode: { enabled: true, capacityFraction: 0.5, haircutBps: 300 } }).body);
    expect(v.calls).toEqual([]);
    expect(v.changes).toEqual([{ scope: "routing", field: "saturdayMode.enabled", before: false, after: true }]);
    const applied = versionOf(mockRequest("POST", `/v1/policy/versions/${v.id}/applied`, {}).body);
    expect(applied.status).toBe("applied");
    expect(applied.policyVersionAfter).toBe(before);
    expect((mockRequest("GET", "/v1/policy").body as PolicyResponse).saturdayMode?.enabled).toBe(true);
  });
});
