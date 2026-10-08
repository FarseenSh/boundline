import { describe, expect, it } from "vitest";
import { createApp, makeWebhookRuntime, type AppDeps } from "../src/app.js";
import { createD1Store } from "../src/db.js";
import {
  BACKOFF_MINUTES,
  MAX_ATTEMPTS,
  MAX_DELIVERY_AGE_SECONDS,
  POLL_MAX_NEW_PER_TICK,
  createD1WebhookStore,
  createMemoryWebhookStore,
  hmacSha256Hex,
  ingest,
  ingestKeeperEvent,
  keeperDedupeKey,
  mapIndexerEvent,
  parseSignatureHeader,
  pollSource,
  retryDue,
  signatureHeader,
  verifySignature,
  type IndexerEventJson,
  type IndexerGet,
  type KeeperEvent,
} from "../src/webhooks.js";
import { MARKET_ID, NOW, OTHER_PARTNER_ID, PARTNER_ID, USER, call, world } from "./helpers.js";
import { sqliteD1 } from "./sqlite.js";

const SELF = "api.test";
const ECHO = (token: string) => `https://${SELF}/v1/webhooks/echo/${token}`;
const VAULT = "0x87f600279f021ca859b9903de884d3a7a169f38c";
const DESK_ADDR = "0x39abadc0aaa12d1f7e259b89536aa1848997399a";
const TX = `0x${"ab".repeat(32)}`;

/** An app with webhooks over a memory store; deferred deliveries are collected so a test can await them. */
async function hooksWorld(over: Partial<AppDeps> = {}) {
  const pending: Promise<unknown>[] = [];
  const webhookStore = createMemoryWebhookStore();
  const w = await world({ webhookStore, selfHosts: [SELF], defer: (p) => pending.push(p), ...over });
  const flush = async () => {
    while (pending.length) await pending.splice(0).reduce((a, p) => a.then(() => p), Promise.resolve() as Promise<unknown>);
  };
  const rt = makeWebhookRuntime(w.deps, async (req) => w.app.fetch(req), (p) => pending.push(p))!;
  return { ...w, webhookStore, flush, rt };
}

describe("signatures", () => {
  it("HMAC-SHA256 matches an independent implementation (Python hmac) and verifies like a partner would", async () => {
    const body = '{"id":"e1","type":"ping"}';
    expect(await hmacSha256Hex("whsec_test", `1791441000.${body}`)).toBe("c0bce08e2823c2275bd3280d1eb420d768a342f4461f93a28cbb620d4caf563e");
    const header = await signatureHeader("whsec_test", 1_791_441_000, body);
    expect(header).toBe("t=1791441000,v1=c0bce08e2823c2275bd3280d1eb420d768a342f4461f93a28cbb620d4caf563e");
    expect(parseSignatureHeader(header)).toEqual({ t: 1_791_441_000, v1: ["c0bce08e2823c2275bd3280d1eb420d768a342f4461f93a28cbb620d4caf563e"] });
    expect(await verifySignature("whsec_test", header, body, 1_791_441_100)).toBe("valid");
    expect(await verifySignature("whsec_other", header, body, 1_791_441_100)).toBe("signature mismatch");
    expect(await verifySignature("whsec_test", header, `${body} `, 1_791_441_100)).toBe("signature mismatch");
    expect(await verifySignature("whsec_test", header, body, 1_791_441_000 + 301)).toBe("timestamp outside tolerance");
    expect(await verifySignature("whsec_test", "v1=abc", body, 1_791_441_000)).toBe("bad signature header");
  });
});

describe("webhook routes", () => {
  it("registers (secret once), lists, tests through the echo receiver with a verified signature, deletes", async () => {
    const { app, flush } = await hooksWorld();
    const created = await call(app, "POST", "/v1/webhooks", { body: { url: ECHO("console-demo-1"), events: ["grace", "protect"], description: "demo" } });
    expect(created.res.status).toBe(201);
    expect(created.json).toMatchObject({ url: ECHO("console-demo-1"), events: ["grace", "protect"], description: "demo", active: true, lastDelivery: null });
    expect(created.json.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(created.json.signing.header).toBe("Boundline-Signature");
    const id = created.json.id as string;

    const listed = await call(app, "GET", "/v1/webhooks");
    expect(listed.json.webhooks).toHaveLength(1);
    expect(listed.json.webhooks[0].secret).toBeUndefined();

    const test = await call(app, "POST", `/v1/webhooks/${id}/test`);
    expect(test.res.status).toBe(202);
    expect(test.json.deliveryId).toBeTruthy();
    await flush();
    const echo = await call(app, "GET", "/v1/webhooks/echo/console-demo-1", { key: null });
    expect(echo.res.status).toBe(200);
    expect(echo.json.count).toBe(1);
    expect(echo.json.deliveries[0]).toMatchObject({ deliveryId: test.json.deliveryId, type: "ping", signatureValid: true, verification: "valid" });
    expect(echo.json.deliveries[0].body).toMatchObject({ type: "ping", partnerId: PARTNER_ID, data: { message: "Boundline webhook test" } });
    const deliveries = await call(app, "GET", `/v1/webhooks/${id}/deliveries`);
    expect(deliveries.json.deliveries[0]).toMatchObject({ id: test.json.deliveryId, type: "ping", status: "delivered", attempts: 1, lastCode: 200 });
    expect((await call(app, "GET", "/v1/webhooks")).json.webhooks[0].lastDelivery).toMatchObject({ status: "delivered", code: 200 });

    expect((await call(app, "POST", `/v1/webhooks/${id}/delete`)).res.status).toBe(204);
    expect((await call(app, "DELETE", `/v1/webhooks/${id}`)).res.status).toBe(404);
    expect((await call(app, "GET", "/v1/webhooks")).json.webhooks).toHaveLength(0);
  });

  it("validates and isolates: https only, known events, at most ten, another partner's webhook is unknown", async () => {
    const { app } = await hooksWorld();
    const bad = async (body: unknown, re: RegExp) => {
      const r = await call(app, "POST", "/v1/webhooks", { body });
      expect(r.res.status).toBe(400);
      expect(r.json.error).toMatch(re);
    };
    await bad({ url: "http://example.com/x", events: ["grace"] }, /https/);
    await bad({ url: "https://example.com/x", events: [] }, /non-empty/);
    await bad({ url: "https://example.com/x", events: ["liquidate"] }, /unknown event/);
    await bad({ url: "https://example.com/x", events: ["*", "grace"] }, /alone/);
    for (let i = 0; i < 10; i += 1) expect((await call(app, "POST", "/v1/webhooks", { body: { url: `https://example.com/${i}`, events: ["*"] } })).res.status).toBe(201);
    expect((await call(app, "POST", "/v1/webhooks", { body: { url: "https://example.com/11", events: ["*"] } })).res.status).toBe(409);
    const { app: other, webhookStore } = await hooksWorld();
    await webhookStore.createWebhook({ id: "wh_x", partnerId: OTHER_PARTNER_ID, url: "https://x.example", events: ["*"], description: "", secret: "s", active: true, createdAt: NOW });
    expect((await call(other, "POST", "/v1/webhooks/wh_x/test")).res.status).toBe(404);
    expect((await call(other, "GET", "/v1/webhooks/wh_x/deliveries")).res.status).toBe(404);
    expect((await call(other, "DELETE", "/v1/webhooks/wh_x")).res.status).toBe(404);
    // the echo receiver takes no key but refuses junk tokens
    expect((await call(other, "GET", "/v1/webhooks/echo/x", { key: null })).res.status).toBe(400);
    // it answers anything, but stores only Boundline's own deliveries for the token in their webhook's URL
    const junk = await call(other, "POST", "/v1/webhooks/echo/somebody-else", { key: null, body: { spam: true }, headers: { "boundline-delivery": "nope" } });
    expect(junk.json).toMatchObject({ received: false, verification: "unknown delivery" });
    expect((await call(other, "GET", "/v1/webhooks/echo/somebody-else", { key: null })).json.count).toBe(0);
    // and on the API's own host only the echo receiver can be a webhook
    expect((await call(app, "DELETE", "/v1/webhooks/x")).res.status).toBe(404);
    const selfRoute = await call(other, "POST", "/v1/webhooks", { body: { url: `https://${SELF}/v1/obligations`, events: ["*"] } });
    expect(selfRoute.res.status).toBe(400);
    expect(selfRoute.json.error).toMatch(/echo receiver/);
  });
});

describe("keeper events (the Events entrypoint's logic)", () => {
  const grace: KeeperEvent = { type: "grace", chainId: 84532, at: NOW, source: "keeper", lineId: "4", data: { shadowLtvBps: 5340, graceLtvBps: 5200, targetLtvBps: 4500 } };

  it("logs a grace event for the line's partner, delivers it to subscribed endpoints only, and deduplicates", async () => {
    const { app, store, rt, flush, webhookStore } = await hooksWorld();
    await store.rememberLine({ lineId: "4", partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, firstSeen: NOW });
    const subscribed = (await call(app, "POST", "/v1/webhooks", { body: { url: ECHO("grace-sink"), events: ["grace"] } })).json.id as string;
    const other = (await call(app, "POST", "/v1/webhooks", { body: { url: ECHO("settle-sink"), events: ["settle"] } })).json.id as string;
    const r = await ingestKeeperEvent(rt, grace);
    expect(r).toMatchObject({ accepted: true, deliveries: 1 });
    await flush();
    expect((await call(app, "GET", "/v1/webhooks/echo/grace-sink", { key: null })).json.deliveries[0]).toMatchObject({ type: "grace", signatureValid: true, body: { type: "grace", lineId: "4", data: { shadowLtvBps: 5340 } } });
    expect((await call(app, "GET", "/v1/webhooks/echo/settle-sink", { key: null })).json.count).toBe(0);
    expect(webhookStore.deliveries.filter((d) => d.webhookId === other)).toHaveLength(0);
    expect(webhookStore.deliveries.filter((d) => d.webhookId === subscribed)).toHaveLength(1);
    // the same event again is a duplicate; a later transition (new `at`) is a new event
    expect(await ingestKeeperEvent(rt, grace)).toMatchObject({ accepted: true, duplicate: true, deliveries: 0 });
    expect((await ingestKeeperEvent(rt, { ...grace, at: NOW + 600 })).duplicate).toBeUndefined();
    const log = await call(app, "GET", "/v1/events");
    expect(log.json.events.map((e: { type: string }) => e.type)).toEqual(["grace", "grace"]);
    expect(await keeperDedupeKey({ ...grace, txHash: TX })).toBe(await keeperDedupeKey({ ...grace, at: NOW + 99, txHash: TX }));
  });

  it("refuses malformed events and attributes unknown lines through the desk", async () => {
    const { rt, webhookStore } = await hooksWorld({ readLine: async () => ({ partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID }) });
    expect(await ingestKeeperEvent(rt, { ...grace, type: "liquidate" })).toMatchObject({ accepted: false, error: expect.stringMatching(/type/) });
    expect(await ingestKeeperEvent(rt, { ...grace, data: { nested: { x: 1 } } })).toMatchObject({ accepted: false, error: expect.stringMatching(/data.nested/) });
    expect(await ingestKeeperEvent(rt, { ...grace, lineId: "77" })).toMatchObject({ accepted: true });
    expect(webhookStore.events.at(-1)).toMatchObject({ partnerId: PARTNER_ID, lineId: "77" });
  });
});

describe("delivery retries", () => {
  it("backs off 1, 2, 4, 8, 16 minutes and gives up after six attempts", async () => {
    let calls = 0;
    const { clock, rt, flush, webhookStore } = await hooksWorld({
      deliveryFetch: (async () => {
        calls += 1;
        return new Response("nope", { status: 500 });
      }) as unknown as typeof fetch,
    });
    await webhookStore.createWebhook({ id: "wh_out", partnerId: PARTNER_ID, url: "https://partner.example/hook", events: ["*"], description: "", secret: "s", active: true, createdAt: NOW });
    await ingest(rt, { type: "protect", chainId: 84532, at: NOW, source: "indexer", partnerId: PARTNER_ID, data: {}, dedupeKey: "k1" });
    await flush();
    const waits: number[] = [];
    for (;;) {
      const d = webhookStore.deliveries[0]!;
      if (d.status !== "pending") break;
      waits.push((d.nextAttemptAt as number) - clock.now);
      clock.now = d.nextAttemptAt as number;
      expect((await retryDue(rt)).attempted).toBe(1);
    }
    expect(waits).toEqual(BACKOFF_MINUTES.map((m) => m * 60));
    expect(webhookStore.deliveries[0]).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, lastCode: 500, nextAttemptAt: null });
    expect(calls).toBe(MAX_ATTEMPTS);
    expect((await retryDue(rt)).attempted).toBe(0);
  });
});

describe("POST /v1/webhooks/poll", () => {
  it("runs one bounded tick on demand with the partner key", async () => {
    const indexer = (async (url: string) => {
      if (String(url).includes("source=sepolia-protection")) return new Response("{}", { status: 404 });
      return Response.json({ events: [{ chainId: 84532, blockNumber: 500, blockTime: NOW, txHash: TX, logIndex: 1, address: DESK_ADDR, name: "Decision", args: { action: `0x${Buffer.from("HOLD").toString("hex").padEnd(64, "0")}`, lineId: "3", amount: "0", decisionHash: TX, price8: "0" } }], next: null });
    }) as unknown as typeof fetch;
    const { app } = await hooksWorld({ indexerUrl: "https://indexer", fetchImpl: indexer });
    const r = await call(app, "POST", "/v1/webhooks/poll");
    expect(r.res.status).toBe(200);
    expect(r.json.polls.map((p: { source: string; status: string }) => [p.source, p.status])).toEqual([["credit-desk", "initialised"], ["sepolia-protection", "unavailable"]]);
    expect(r.json.retries).toEqual({ attempted: 0, delivered: 0, failed: 0 });
    expect((await call(app, "POST", "/v1/webhooks/poll", { key: null })).res.status).toBe(401);
  });
});

describe("the indexer poll", () => {
  const decision = (block: number, time: number, action: string, logIndex = 1): IndexerEventJson => ({
    chainId: 84532, blockNumber: block, blockTime: time, txHash: `0x${block.toString(16).padStart(64, "0")}`, logIndex, address: DESK_ADDR, name: "Decision",
    args: { action: `0x${Buffer.from(action).toString("hex").padEnd(64, "0")}`, amount: "0", decisionHash: `0x${"cd".repeat(32)}`, lineId: "3", price8: "0" },
  });

  it("primes the cursor on the first poll, then takes new events oldest first and queues their deliveries for the retry pass", async () => {
    const { rt, store, webhookStore, flush, clock } = await hooksWorld();
    await store.rememberLine({ lineId: "3", partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, firstSeen: NOW });
    await webhookStore.createWebhook({ id: "wh_1", partnerId: PARTNER_ID, url: ECHO("hold-sink"), events: ["hold", "release"], description: "", secret: "s", active: true, createdAt: NOW });
    let rows: IndexerEventJson[] = [decision(100, NOW - 50, "HOLD"), decision(95, NOW - 60, "DRAW")];
    const asked: string[] = [];
    const indexerGet: IndexerGet = async (path) => {
      asked.push(path);
      return { ok: true, data: { events: /[?&]limit=1(&|$)/.test(path) ? rows.slice(0, 1) : rows, next: null } };
    };
    // first poll: history is not replayed to partners, the cursor is primed at the newest event
    const first = await pollSource(rt, "credit-desk", 84532, indexerGet);
    expect(asked[0]).toBe("/v1/events?chainId=84532&source=credit-desk&limit=1");
    expect(first).toMatchObject({ status: "initialised", fetched: 1, ingested: 0, cursor: 100 });
    expect(webhookStore.events).toHaveLength(0);
    clock.now = NOW + 120;
    rows = [decision(130, NOW + 100, "RELEASE"), decision(120, NOW - 2 * MAX_DELIVERY_AGE_SECONDS, "HOLD", 2), decision(100, NOW - 50, "HOLD")];
    const second = await pollSource(rt, "credit-desk", 84532, indexerGet);
    expect(asked[1]).toBe("/v1/events?chainId=84532&source=credit-desk&limit=100&from=100");
    // oldest first: the day-old HOLD is logged without a delivery, the fresh RELEASE queues one, the cursor block's HOLD is new to the log too
    expect(second).toMatchObject({ status: "ok", fetched: 3, ingested: 3, deliveries: 2, cursor: 130 });
    expect(webhookStore.events.map((e) => [e.type, e.backfill])).toEqual([["hold", false], ["hold", true], ["release", false]]);
    // queued, not sent by the poll: the retry pass sends at most two a tick
    expect(webhookStore.deliveries.map((d) => [d.type, d.status, d.attempts])).toEqual([["hold", "pending", 0], ["release", "pending", 0]]);
    expect(await retryDue(rt)).toEqual({ attempted: 2, delivered: 2, failed: 0 });
    await flush();
    expect(webhookStore.deliveries.map((d) => d.status)).toEqual(["delivered", "delivered"]);
  });

  it("takes at most four new events a tick and resumes from the cursor, so a killed tick never repeats forever", async () => {
    const { rt, store, webhookStore } = await hooksWorld();
    await store.rememberLine({ lineId: "3", partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, firstSeen: NOW });
    await webhookStore.putCursor("credit-desk", 1, NOW);
    const all = Array.from({ length: 15 }, (_, i) => decision(200 + i, NOW - 30, i % 2 ? "RELEASE" : "HOLD"));
    const indexerGet: IndexerGet = async (path) => {
      const from = Number(/from=(\d+)/.exec(path)?.[1] ?? 0);
      return { ok: true, data: { events: all.filter((e) => e.blockNumber >= from).reverse(), next: null } };
    };
    const ticks = [];
    for (let i = 0; i < 5; i += 1) ticks.push(await pollSource(rt, "credit-desk", 84532, indexerGet));
    expect(ticks.map((t) => [t.status, t.ingested, t.cursor])).toEqual([
      ["partial", POLL_MAX_NEW_PER_TICK, 203],
      ["partial", 4, 207],
      ["partial", 4, 211],
      ["ok", 3, 214],
      ["ok", 0, 214],
    ]);
    expect(webhookStore.events).toHaveLength(15);
  });

  it("tolerates a source the indexer does not have yet", async () => {
    const { rt } = await hooksWorld();
    const r = await pollSource(rt, "sepolia-protection", 84532, async () => ({ ok: false, status: 404, detail: "indexer answered 404" }));
    expect(r).toMatchObject({ status: "unavailable", cursor: null });
  });

  it("maps the protection contracts' events to partner webhook types", () => {
    const base = { chainId: 84532, blockNumber: 1, blockTime: NOW, txHash: TX, logIndex: 3, address: VAULT };
    const vault = mapIndexerEvent("sepolia-protection", { ...base, name: "Protected", args: { lineId: "1", user: USER.toLowerCase(), partnerId: PARTNER_ID, repaid: "700000", fromUser: "500000", fromPartner: "0", fromAdvance: "200000", debtBefore: "2300134", debtAfter: "1600134", decisionHash: `0x${"87".repeat(32)}` } });
    expect(vault).toMatchObject({ type: "protect", lineId: "1", partnerId: PARTNER_ID, data: { venue: "desk", repaidUsdc: "0.700000", fromAdvanceUsdc: "0.200000", debtAfterUsdc: "1.600134" } });
    expect(vault?.dedupeKey).toBe(`idx:84532:${TX}:3`);
    const pre = mapIndexerEvent("sepolia-protection", { ...base, name: "Protected", args: { decision: "1", preLiquidation: "0xdcae", borrower: USER.toLowerCase(), seizedAssets: "7116", repaidAssets: "23302", collateralSold: "7005", venuePrice36: "1", shadowPrice36: "1", decisionHash: TX } });
    expect(pre).toMatchObject({ type: "protect", borrower: USER.toLowerCase(), data: { venue: "morpho", repaidUsdc: "0.023302", seizedAssets: "7116" } });
    expect(mapIndexerEvent("sepolia-protection", { ...base, name: "AdvanceSettled", args: { lineId: "1", payer: USER, principal: "200000", fee: "2000", outstandingAfter: "0", decisionHash: TX } })).toMatchObject({ type: "settle", data: { principalUsdc: "0.200000", feeUsdc: "0.002000" } });
    expect(mapIndexerEvent("sepolia-protection", { ...base, name: "CollateralRecovered", args: { lineId: "1", user: USER, token: "0xb2", amount: "5", price8: "1", decisionHash: TX } })?.type).toBe("recovery");
    expect(mapIndexerEvent("sepolia-protection", { ...base, name: "Deposit", args: {} })).toBeNull();
    expect(mapIndexerEvent("credit-desk", { ...base, address: DESK_ADDR, name: "Repaid", args: {} })).toBeNull();
  });
});

describe("the D1 webhook store (real SQL over node:sqlite with the migrations applied)", () => {
  it("round-trips webhooks, events (deduplicated), deliveries (due order), the echo window and cursors", async () => {
    const db = sqliteD1();
    const ws = createD1WebhookStore(db);
    await ws.createWebhook({ id: "wh_a", partnerId: PARTNER_ID, url: "https://a.example", events: ["grace"], description: "d", secret: "s", active: true, createdAt: 1 });
    await ws.createWebhook({ id: "wh_b", partnerId: PARTNER_ID, url: "https://b.example", events: ["*"], description: "", secret: "t", active: true, createdAt: 2 });
    expect((await ws.listWebhooks(PARTNER_ID)).map((w) => w.id)).toEqual(["wh_b", "wh_a"]);
    expect(await ws.countWebhooks(PARTNER_ID)).toBe(2);
    expect(await ws.deactivateWebhook(PARTNER_ID, "wh_a")).toBe(true);
    expect(await ws.deactivateWebhook(PARTNER_ID, "wh_a")).toBe(false);
    expect(await ws.deactivateWebhook(OTHER_PARTNER_ID, "wh_b")).toBe(false);
    expect((await ws.getWebhook("wh_a"))?.active).toBe(false);
    const ev = { id: "e1", partnerId: PARTNER_ID, type: "grace" as const, chainId: 84532, source: "keeper" as const, at: 10, lineId: "4", borrower: null, txHash: null, decisionHash: null, data: { a: 1, b: "x", c: true, d: null }, dedupeKey: "k", backfill: false, createdAt: 11 };
    expect(await ws.insertEvent(ev)).toBe(true);
    expect(await ws.insertEvent({ ...ev, id: "e2" })).toBe(false);
    expect(await ws.listEvents(PARTNER_ID, 10)).toEqual([ev]);
    const d = { id: "d1", webhookId: "wh_b", eventId: "e1", partnerId: PARTNER_ID, type: "grace" as const, status: "pending" as const, attempts: 0, lastCode: null, lastError: null, lastAttemptAt: null, nextAttemptAt: 50, payload: "{}", payloadHash: "h", createdAt: 11 };
    await ws.insertDelivery(d);
    await ws.insertDelivery({ ...d, id: "d2", nextAttemptAt: 40, eventId: "e9" });
    expect((await ws.dueDeliveries(45, 10)).map((x) => x.id)).toEqual(["d2"]);
    expect((await ws.dueDeliveries(60, 10)).map((x) => x.id)).toEqual(["d2", "d1"]);
    await ws.updateDelivery("d1", { status: "delivered", attempts: 1, lastCode: 200, lastError: null, lastAttemptAt: 55, nextAttemptAt: null });
    expect(await ws.getDelivery("d1")).toMatchObject({ status: "delivered", lastCode: 200, nextAttemptAt: null });
    expect((await ws.lastDelivery("wh_b"))?.id).toBe("d1");
    for (let i = 0; i < 25; i += 1) await ws.saveEcho({ token: "tok12345", receivedAt: i, deliveryId: null, eventType: "ping", signatureValid: i % 2 === 0, verification: "v", body: `${i}`, headers: { a: "b" } }, 20);
    const echo = await ws.listEcho("tok12345", 50);
    expect(echo).toHaveLength(20);
    expect(echo[0]).toMatchObject({ body: "24", signatureValid: true, headers: { a: "b" } });
    expect(await ws.getCursor("credit-desk")).toBeNull();
    await ws.putCursor("credit-desk", 47_836_000, 1);
    await ws.putCursor("credit-desk", 47_836_500, 2);
    expect(await ws.getCursor("credit-desk")).toBe(47_836_500);
  });

  it("stores route plans and partner settings through the main store's SQL", async () => {
    const store = createD1Store(sqliteD1());
    await store.rememberLine({ lineId: "4", partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, firstSeen: 1 });
    expect(await store.getLine("4")).toMatchObject({ lineId: "4", partnerId: PARTNER_ID });
    expect(await store.getLine("5")).toBeNull();
    const plan = { planHash: `0x${"01".repeat(32)}` as const, partnerId: PARTNER_ID, lineId: "4", chainId: 84532, planJson: "{}", typedDataJson: null, digest: null, signature: null, signer: null, createdAt: 10 };
    await store.saveRoutePlan(plan);
    await store.saveRoutePlan({ ...plan, planHash: `0x${"02".repeat(32)}`, createdAt: 20 });
    expect((await store.latestRoutePlanForLine(PARTNER_ID, "4"))?.planHash).toBe(`0x${"02".repeat(32)}`);
    expect(await store.latestRoutePlanForLine(OTHER_PARTNER_ID, "4")).toBeNull();
    await store.putPartnerSettings({ partnerId: PARTNER_ID, saturdayJson: '{"enabled":true}', versionId: "v1", updatedAt: 5 });
    await store.putPartnerSettings({ partnerId: PARTNER_ID, saturdayJson: '{"enabled":false}', versionId: "v2", updatedAt: 6 });
    expect(await store.getPartnerSettings(PARTNER_ID)).toEqual({ partnerId: PARTNER_ID, saturdayJson: '{"enabled":false}', versionId: "v2", updatedAt: 6 });
  });
});

void createApp;
