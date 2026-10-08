import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { echoReceiverUrl, newEchoToken, parseSignatureHeader, verifyWebhookSignature, WEBHOOK_EVENT_COPY, WEBHOOK_EVENT_TYPES, webhookSignature } from "../src/webhooks.js";

const secret = "whsec_test_8c1f0e2a";
const body = JSON.stringify({ id: "evt_1", type: "protect", createdAt: 1791441345, chainId: 84532, partnerId: "0x626f", lineId: "1", data: { amountUsdc: "0.500000" } });
const nodeHmac = (t: number, raw: string): string => createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");

describe("webhook signatures", () => {
  it("signs exactly HMAC-SHA256(secret, t + '.' + rawBody)", async () => {
    expect(await webhookSignature(secret, 1791441345, body)).toBe(nodeHmac(1791441345, body));
  });

  it("parses the header, ignoring junk and keeping every v1", () => {
    const v = "a".repeat(64);
    expect(parseSignatureHeader(`t=1791441345,v1=${v}`)).toEqual({ t: 1791441345, v1: [v] });
    expect(parseSignatureHeader(` t=5 , v1=${"B".repeat(64)}, v1=${v}, v0=zz`)).toEqual({ t: 5, v1: ["b".repeat(64), v] });
    expect(parseSignatureHeader("t=5")).toBeNull();
    expect(parseSignatureHeader("v1=" + v)).toBeNull();
    expect(parseSignatureHeader(`t=x,v1=${v}`)).toBeNull();
    expect(parseSignatureHeader("")).toBeNull();
    expect(parseSignatureHeader(null)).toBeNull();
  });

  it("accepts a fresh, matching delivery", async () => {
    const t = 1791441345;
    const header = `t=${t},v1=${nodeHmac(t, body)}`;
    expect(await verifyWebhookSignature({ secret, header, rawBody: body, now: t + 10 })).toEqual({ ok: true, t });
  });

  it("refuses a changed body, a wrong secret, a stale or missing signature", async () => {
    const t = 1791441345;
    const header = `t=${t},v1=${nodeHmac(t, body)}`;
    expect(await verifyWebhookSignature({ secret, header, rawBody: body.replace("0.500000", "5.000000"), now: t })).toEqual({ ok: false, reason: "mismatch", t });
    expect(await verifyWebhookSignature({ secret: "other", header, rawBody: body, now: t })).toEqual({ ok: false, reason: "mismatch", t });
    expect(await verifyWebhookSignature({ secret, header, rawBody: body, now: t + 301 })).toEqual({ ok: false, reason: "stale", t });
    expect(await verifyWebhookSignature({ secret, header, rawBody: body, now: t + 86_400, toleranceSeconds: 0 })).toEqual({ ok: true, t });
    expect(await verifyWebhookSignature({ secret, header: null, rawBody: body })).toEqual({ ok: false, reason: "missing" });
    expect(await verifyWebhookSignature({ secret, header: "v1=nope", rawBody: body })).toEqual({ ok: false, reason: "malformed" });
  });

  it("accepts any of several v1 values (secret rotation)", async () => {
    const t = 1791441345;
    const header = `t=${t},v1=${"0".repeat(64)},v1=${nodeHmac(t, body)}`;
    expect((await verifyWebhookSignature({ secret, header, rawBody: body, now: t })).ok).toBe(true);
  });
});

describe("webhook helpers", () => {
  it("names every event type in words", () => {
    for (const t of WEBHOOK_EVENT_TYPES) expect(WEBHOOK_EVENT_COPY[t].length).toBeGreaterThan(10);
    expect(WEBHOOK_EVENT_TYPES).toEqual(["grace", "grace.cleared", "protect", "hold", "release", "recovery", "settle"]);
  });

  it("builds echo receiver URLs from 16 random bytes", () => {
    const token = newEchoToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(newEchoToken()).not.toBe(token);
    expect(echoReceiverUrl("https://boundline-api.papermind-ai.workers.dev/", token)).toBe(`https://boundline-api.papermind-ai.workers.dev/v1/webhooks/echo/${token}`);
    expect(() => echoReceiverUrl("https://x", "../../v1/policy")).toThrow(/hex/);
  });
});
