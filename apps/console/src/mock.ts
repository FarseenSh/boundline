// Fixtures for every endpoint the console reads, used when the build sets VITE_CONSOLE_MOCK=1. Shapes follow
// the API contract exactly; numbers are the Sepolia book as of 7 Oct 2026 so the pages look real.
import type { PartnerEvent, WebhookCreated, WebhookDelivery, WebhookSummary } from "@boundline/sdk";
import type { ConsoleConfig, DecisionsResponse, Drill, EvidenceBundle, LineResponse, ObligationsResponse, ObservatorySessions, PolicyChange, PolicyResponse, PolicyVersion, ReconciliationResponse, SaturdayModePolicy, SourcesResponse } from "./types.js";
import { hashOf } from "./hashing.js";

const DESK = "0x39aB4Bb0d4fF4b6e2D6cF2B8bC0B5C3f0E5a399a";
const AAPLT = "0xb200000000000000000000000000000000000001";
const NVDAT = "0xb200000000000000000000000000000000000002";
const TSLAT = "0xb200000000000000000000000000000000000003";
const USER = "0xB789aD318945B37566E2549F65526Cc269a482Fc";
const ADMIN = "0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E";
const PARTNER_ID = "0x626f756e646c696e652d617070000000000000000000000000000000000000000";
const MARKET = "0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047";

export const mockConfig: ConsoleConfig = { partnerId: "boundline-app", hasPartnerKey: true, keySource: "console" };

export const mockSessions: ObservatorySessions = {
  takenAt: 1791379410,
  state: "PRE",
  isFeedLive: true,
  nextTransition: { to: "REGULAR", at: 1791379800 },
  lastFeedUpdateAt: 1791378805,
  nextFeedTransition: { at: 1791590400, from: "POST", to: "WEEKEND", kind: "close" },
};

export const mockObligations: ObligationsResponse = {
  correlationId: "mock",
  policyVersion: 4,
  partnerId: PARTNER_ID,
  chainId: 84532,
  count: 3,
  source: "indexer",
  sourceNote: "LineOpened events from the indexer, statuses read live from the desk",
  obligations: [
    { lineId: "1", user: USER, marketId: MARKET, openedAt: 1791146400, openedBlock: 47637801, openTx: "0x" + "a1".repeat(32), decisionHash: "0x" + "d1".repeat(32), lineStatus: "OPEN", obligationStatus: "OPEN", policyVersion: 2, drawnPrincipal: { baseUnits: "2800000", usdc: "2.80" }, holdReason: "0x" + "00".repeat(32) },
    { lineId: "2", user: USER, marketId: "0x7cb7fcc828a7296f8ea18256e0f5763a5588cfe22df9c943088021c762e58cc9", openedAt: 1791330000, openedBlock: 47741000, openTx: "0x" + "a2".repeat(32), decisionHash: "0x" + "d2".repeat(32), lineStatus: "OPEN", obligationStatus: "OPEN", policyVersion: 3, drawnPrincipal: { baseUnits: "0", usdc: "0.00" }, holdReason: "0x" + "00".repeat(32) },
    { lineId: "3", user: USER, marketId: "0xb0e8d25d1c9b822cc718c89666b887698922a7b49fdb00dbdecd70dd4ed9e2f1", openedAt: 1791331000, openedBlock: 47741500, openTx: "0x" + "a3".repeat(32), decisionHash: "0x" + "d3".repeat(32), lineStatus: "OPEN", obligationStatus: "HOLD_SESSION", policyVersion: 4, drawnPrincipal: { baseUnits: "0", usdc: "0.00" }, holdReason: "0x" + "00".repeat(32) },
  ],
};

export const mockLine: LineResponse = {
  correlationId: "mock",
  policyVersion: 2,
  chainId: 84532,
  desk: DESK,
  line: { lineId: "1", partnerId: PARTNER_ID, user: USER, marketId: MARKET, collateralToken: AAPLT, policyVersion: 2, status: "OPEN", holdReason: "0x" + "00".repeat(32), openedAt: 1791146400, drawnPrincipal: { baseUnits: "2800000", usdc: "2.80" } },
  obligationStatus: "OPEN",
  quote: { reason: "NONE", session: "PRE", price8: "33628499999", available: { baseUnits: "1500000", usdc: "1.50" } },
  readAt: 1791379410,
};

export const mockDecisions: DecisionsResponse = {
  correlationId: "mock",
  policyVersion: 2,
  chainId: 84532,
  desk: DESK,
  lineId: "1",
  status: "OPEN",
  source: "indexer",
  count: 5,
  decisions: [
    { action: "OPEN", hash: "0x" + "d1".repeat(32), amount: "0", price8: "0", blockNumber: 47637801, blockTime: 1791146400, txHash: "0x" + "a1".repeat(32), logIndex: 3 },
    { action: "ADD_COLLATERAL", hash: "0x" + "d4".repeat(32), amount: "1000000000", price8: "0", blockNumber: 47637830, blockTime: 1791146460, txHash: "0x" + "a4".repeat(32), logIndex: 5 },
    { action: "DRAW", hash: "0x" + "d5".repeat(32), amount: "5000000", price8: "25512000000", blockNumber: 47751000, blockTime: 1791348000, txHash: "0x" + "a5".repeat(32), logIndex: 2 },
    { action: "REPAY", hash: "0x" + "d6".repeat(32), amount: "2100000", price8: "0", blockNumber: 47752000, blockTime: 1791350000, txHash: "0x" + "a6".repeat(32), logIndex: 4 },
    { action: "REPAY", hash: "0x" + "d7".repeat(32), amount: "100000", price8: "0", blockNumber: 47763777, blockTime: 1791374442, txHash: "0xbbd8463132d3863f135ce30e5618d92919e4c3832b80b76510e97f18b99cb2fb", logIndex: 1 },
  ],
  timeline: [
    { event: "LineOpened", hash: "0x" + "d1".repeat(32), blockNumber: 47637801, blockTime: 1791146400, txHash: "0x" + "a1".repeat(32), logIndex: 2, args: { lineId: "1", user: USER, marketId: MARKET, policyVersion: "2" } },
    { event: "Drawn", hash: "0x" + "d5".repeat(32), blockNumber: 47751000, blockTime: 1791348000, txHash: "0x" + "a5".repeat(32), logIndex: 1, args: { lineId: "1", amount: "5000000", price8: "25512000000", session: "1" } },
  ],
};

export const mockPolicy: PolicyResponse = {
  partnerId: PARTNER_ID,
  name: "boundline-app",
  policyVersion: 4,
  partner: { admin: ADMIN, signer: "0x0000000000000000000000000000000000000000", eligibility: "0x0000000000000000000000000000000000000000", active: true, exposureCap: "1000000000", exposure: "2800000" },
  tickers: [
    { symbol: "AAPLt", collateral: AAPLT, marketId: MARKET, allowed: true, maxLtvWad: "580000000000000000", minDraw: "1000000", maxDraw: "100000000", exposureCap: "500000000", exposure: "2800000", marketLltvWad: "625000000000000000" },
    { symbol: "NVDAt", collateral: NVDAT, marketId: "0x7cb7fcc828a7296f8ea18256e0f5763a5588cfe22df9c943088021c762e58cc9", allowed: true, maxLtvWad: "550000000000000000", minDraw: "1000000", maxDraw: "100000000", exposureCap: "300000000", exposure: "0", marketLltvWad: "625000000000000000" },
    { symbol: "TSLAt", collateral: TSLAT, marketId: "0xb0e8d25d1c9b822cc718c89666b887698922a7b49fdb00dbdecd70dd4ed9e2f1", allowed: true, maxLtvWad: "500000000000000000", minDraw: "1000000", maxDraw: "50000000", exposureCap: "200000000", exposure: "0", marketLltvWad: "625000000000000000" },
  ],
  saturdayMode: { enabled: false, capacityFraction: 0.5, haircutBps: 300 },
};

export const mockWebhooks: (WebhookSummary & { secret: string })[] = [
  { id: "wh_0001", url: "https://ops.partner.example/boundline", events: ["grace", "protect", "settle"], description: "risk desk pager", active: true, createdAt: 1791380000, lastDelivery: { status: "delivered", at: 1791382000, code: 200 }, secret: "whsec_mock_0001" },
];

export const mockDeliveries: Record<string, WebhookDelivery[]> = {
  wh_0001: [
    { id: "dl_0002", eventId: "ev_0002", type: "protect", status: "delivered", attempts: 1, lastCode: 200, lastAttemptAt: 1791382000, nextAttemptAt: null, payloadHash: "0x" + "5e".repeat(32) },
    { id: "dl_0001", eventId: "ev_0001", type: "grace", status: "delivered", attempts: 2, lastCode: 200, lastAttemptAt: 1791381060, nextAttemptAt: null, payloadHash: "0x" + "4d".repeat(32) },
  ],
};

export const mockEvents: PartnerEvent[] = [
  { id: "ev_0002", type: "protect", chainId: 84532, at: 1791381990, source: "indexer", lineId: "1", borrower: USER, txHash: "0x28c1ec44" + "00".repeat(26) + "08a4", decisionHash: "0x87c3ecb6" + "00".repeat(26) + "b53e", data: { repaidUsdc: "0.700000", fromUser: "0.500000", fromPartner: "0.000000", fromAdvance: "0.200000" } },
  { id: "ev_0001", type: "grace", chainId: 84532, at: 1791381000, source: "keeper", lineId: "1", borrower: USER, data: { shadowLtvBps: 5310, graceLtvBps: 5200, targetLtvBps: 4500, amountUsdc: "0.700000" } },
];

/** The built-in echo receiver's memory, per token. */
export const mockEcho: Record<string, unknown[]> = {};

export const mockVersions: PolicyVersion[] = [
  {
    id: "pv_0002",
    status: "applied",
    createdAt: 1791330600,
    appliedAt: 1791331200,
    note: "Register NVDAt and TSLAt with conservative LTVs",
    changes: [
      { scope: "ticker", collateral: NVDAT, field: "allowed", before: false, after: true },
      { scope: "ticker", collateral: NVDAT, field: "maxLtvWad", before: "0", after: "550000000000000000" },
      { scope: "ticker", collateral: TSLAT, field: "allowed", before: false, after: true },
      { scope: "ticker", collateral: TSLAT, field: "maxLtvWad", before: "0", after: "500000000000000000" },
    ],
    calls: [
      { to: DESK, data: "0x" + "11".repeat(100), description: "setTickerPolicy(boundline-app, NVDAt, allowed, 55%, 1 USDC, 100 USDC, cap 300 USDC)" },
      { to: DESK, data: "0x" + "22".repeat(100), description: "setTickerPolicy(boundline-app, TSLAt, allowed, 50%, 1 USDC, 50 USDC, cap 200 USDC)" },
    ],
    policyVersionBefore: 2,
    policyVersionAfter: 4,
    txHash: "0x" + "b2".repeat(32),
  },
  {
    id: "pv_0001",
    status: "prepared",
    createdAt: 1791379000,
    note: "Trim AAPLt max LTV ahead of the weekend",
    changes: [{ scope: "ticker", collateral: AAPLT, field: "maxLtvWad", before: "580000000000000000", after: "550000000000000000" }],
    calls: [{ to: DESK, data: "0x" + "33".repeat(100), description: "setTickerPolicy(boundline-app, AAPLt, allowed, 55%, 1 USDC, 100 USDC, cap 500 USDC)" }],
    policyVersionBefore: 4,
  },
];

export const mockDrills: Drill[] = [
  {
    id: "weekend-gap",
    title: "Weekend gap",
    description: "Feeds hold Friday's close from 20:00 ET; a Morpho market priced by SessionGuard refuses borrow, withdraw and liquidate until Sunday 20:00 ET while repay and add-collateral keep working.",
    venue: "morpho",
    steps: [
      { n: 1, title: "Friday 20:00 ET close", detail: "The keeper mirrors the last mainnet round; the feed's updatedAt stops moving." },
      { n: 2, title: "Borrow attempt while closed", detail: "The desk quotes MARKET_CLOSED / WEEKEND; Morpho reverts MarketClosed(WEEKEND)." },
      { n: 3, title: "Repay while closed", detail: "Accepted: repay carries no oracle read." },
      { n: 4, title: "Sunday 20:00 ET reopen", detail: "First print after reopen recorded by the Observatory capture." },
    ],
    runs: [{ ranAt: 1791165600, chainId: 84532, txs: [{ hash: "0x" + "c1".repeat(32), label: "borrow refused MarketClosed(WEEKEND)" }], outcome: "Refused as designed; reopen captured", evidence: "docs/evidence/reopen-2026-10-04.md" }],
  },
  {
    id: "protection",
    title: "Automated protection",
    description: "The keeper arms the Protector's partial pre-liquidation as a validity transaction while the feed slot holds; Base includes it in the next block.",
    venue: "morpho",
    steps: [
      { n: 1, title: "Position staged in band", detail: "Shadow LTV 60.12% between preLltv 58% and LLTV 62.5%." },
      { n: 2, title: "Keeper sizes the action", detail: "Protector.sizing returns IN_BAND with the largest partial back to 58%." },
      { n: 3, title: "Validity transaction", detail: "storage(feed, slot 5) = held value, bound head+30." },
      { n: 4, title: "Included", detail: "Protected event, shadow LTV 58.00%." },
    ],
    runs: [{ ranAt: 1791360000, chainId: 84532, txs: [{ hash: "0x982c7327" + "ab".repeat(26) + "b695", label: "Protector.protect via validity tx" }], outcome: "Executed: shadow LTV 60.12% → 58.00%", evidence: "deployments/base-sepolia.json#protection.drill" }],
  },
  { id: "stale-feed", title: "Stale feed", description: "The feed stops updating during a live session; the gate reports FEED_STALE and draws are refused until a fresh round.", venue: "oracle", steps: [{ n: 1, title: "Freeze the mirror", detail: "Keeper mirror paused for the test feed." }, { n: 2, title: "Draw refused FEED_STALE", detail: "Quote reason FEED_STALE after the heartbeat." }], runs: [] },
  { id: "registry-pause", title: "Registry pause", description: "The OracleRegistry pauses a token; the gate reports FEED_PAUSED.", venue: "oracle", steps: [{ n: 1, title: "Pause on the mirror registry", detail: "setOracleParams paused=true." }, { n: 2, title: "Draw refused FEED_PAUSED", detail: "" }], runs: [] },
];

export const mockReconciliation: ReconciliationResponse = {
  reconcile: {
    chainId: 84532,
    checkedAt: 1791373541,
    blockNumber: 47763777,
    status: "PASS",
    checks: [
      { id: 187, subject: `market:${MARKET}`, status: "PASS", expected: { totalSupplyAssets: "10000017", totalBorrowAssets: "4605338" }, actual: { totalSupplyAssets: "10000017", totalBorrowAssets: "4605338" } },
      { id: 189, subject: `position:${MARKET}:${USER.toLowerCase()}`, status: "PASS", expected: { borrowShares: "2800000376176", collateral: "1000000000" }, actual: { borrowShares: "2800000376176", collateral: "1000000000" } },
    ],
  },
  roots: {
    chainId: 84532,
    scheme: "keccak256(prev_root || h1 || ... || hn)",
    roots: [
      { day: "2026-10-06", firstBlock: 47750753, lastBlock: 47779283, eventCount: 54, prevRoot: "0x48da19b43415786e1dd70a48a997ea3afec219978315b538c984b96f1af13c74", root: "0x9e21cf08e4f9616aaa5f764dd6551a23de6cc988efa0c3224ab4ba23123829b6", computedAt: 1791345105 },
      { day: "2026-10-05", firstBlock: 47696273, lastBlock: 47737583, eventCount: 33, prevRoot: "0xaa67f08a9fc9f8e20e5c60c6568fffd1bb1c237ffec1611465de0c3d7781e018", root: "0x48da19b43415786e1dd70a48a997ea3afec219978315b538c984b96f1af13c74", computedAt: 1791270586 },
    ],
    today: { day: "2026-10-07", eventCount: 12, rootSoFar: "0x" + "77".repeat(32) },
  },
};

export const mockSources: SourcesResponse = {
  count: 2,
  sources: [
    { id: "credit-desk", chainId: 84532, addresses: 1, topic0s: 12, indexedFilter: true, startBlock: 47637700, addressList: [DESK], cursor: { chainId: 84532, source: "credit-desk", lastBlock: 47805706, lastBlockTime: 1791379700, updatedAt: 1791379704 } },
    { id: "mainnet-feeds", chainId: 8453, addresses: 10, topic0s: 2, indexedFilter: true, startBlock: 52200000, addressList: [], cursor: { chainId: 8453, source: "mainnet-feeds", lastBlock: 52295129, lastBlockTime: 1791379600, updatedAt: 1791379605 } },
  ],
};

export function mockEvidence(): EvidenceBundle {
  const without = {
    generatedAt: 1791379800,
    partnerId: PARTNER_ID,
    policy: mockPolicy,
    lines: mockObligations.obligations.map((o) => ({ lineId: o.lineId, user: o.user, marketId: o.marketId })),
    obligations: mockObligations.obligations,
    decisions: mockDecisions.decisions,
    roots: mockReconciliation.roots,
    reconciliation: mockReconciliation.reconcile,
    drills: mockDrills,
  };
  return { ...without, hash: hashOf(without) };
}

export type MockMethod = "GET" | "POST" | "DELETE";

/** Answers one request from the fixtures; unknown paths get a 404 so the pages exercise their error states. */
export function mockRequest(method: MockMethod, path: string, body?: unknown): { status: number; body: unknown } {
  const p = path.replace(/\?.*$/, "");
  if (method === "GET") {
    if (p === "/config") return { status: 200, body: mockConfig };
    if (p === "/v1/obligations") return { status: 200, body: mockObligations };
    if (/^\/v1\/lines\/\d+$/.test(p)) return { status: 200, body: mockLine };
    if (/^\/v1\/lines\/\d+\/decisions$/.test(p)) return { status: 200, body: mockDecisions };
    if (p === "/v1/policy") return { status: 200, body: mockPolicy };
    if (p === "/v1/policy/versions") return { status: 200, body: { versions: mockVersions } };
    const one = /^\/v1\/policy\/versions\/([^/]+)$/.exec(p);
    if (one) {
      const v = mockVersions.find((x) => x.id === one[1]);
      return v ? { status: 200, body: v } : { status: 404, body: { error: "unknown version" } };
    }
    if (p === "/v1/drills") return { status: 200, body: mockDrills };
    const drill = /^\/v1\/drills\/([^/]+)$/.exec(p);
    if (drill) {
      const d = mockDrills.find((x) => x.id === drill[1]);
      return d ? { status: 200, body: d } : { status: 404, body: { error: "unknown drill" } };
    }
    if (p === "/v1/reconciliation") return { status: 200, body: mockReconciliation };
    if (p === "/v1/evidence/export") return { status: 200, body: mockEvidence() };
    if (p === "/indexer/v1/sources") return { status: 200, body: mockSources };
    if (p === "/v1/webhooks") return { status: 200, body: { webhooks: mockWebhooks.map(({ secret: _secret, ...w }) => w) } };
    const deliveries = /^\/v1\/webhooks\/([^/]+)\/deliveries$/.exec(p);
    if (deliveries) return mockWebhooks.some((w) => w.id === deliveries[1]) ? { status: 200, body: { deliveries: mockDeliveries[deliveries[1]!] ?? [] } } : { status: 404, body: { error: "unknown webhook" } };
    const echo = /^\/v1\/webhooks\/echo\/([0-9a-f]+)$/.exec(p);
    if (echo) return { status: 200, body: { token: echo[1], deliveries: mockEcho[echo[1]!] ?? [] } };
    if (p === "/v1/events") return { status: 200, body: { events: mockEvents } };
    return { status: 404, body: { error: "not found (mock)" } };
  }
  if (method === "DELETE") {
    const one = /^\/v1\/webhooks\/([^/]+)$/.exec(p);
    const i = one ? mockWebhooks.findIndex((w) => w.id === one[1]) : -1;
    if (i < 0) return { status: 404, body: { error: "unknown webhook" } };
    mockWebhooks.splice(i, 1);
    return { status: 204, body: null };
  }
  if (p === "/v1/webhooks") {
    const b = (body ?? {}) as { url?: string; events?: string[]; description?: string };
    if (!b.url || !/^https:\/\//.test(b.url)) return { status: 400, body: { error: "url must be https" } };
    if (!b.events?.length) return { status: 400, body: { error: "choose at least one event" } };
    const id = `wh_${String(mockWebhooks.length + 2).padStart(4, "0")}`;
    const created: WebhookCreated = { id, url: b.url, events: b.events as WebhookCreated["events"], description: b.description ?? null, active: true, createdAt: Math.floor(Date.now() / 1000), lastDelivery: null, secret: `whsec_mock_${id}` };
    mockWebhooks.unshift(created);
    return { status: 201, body: created };
  }
  const test = /^\/v1\/webhooks\/([^/]+)\/test$/.exec(p);
  if (test) {
    const hook = mockWebhooks.find((w) => w.id === test[1]);
    if (!hook) return { status: 404, body: { error: "unknown webhook" } };
    const now = Math.floor(Date.now() / 1000);
    const deliveryId = `dl_${now}`;
    (mockDeliveries[hook.id] ??= []).unshift({ id: deliveryId, eventId: `ev_${now}`, type: "ping", status: "delivered", attempts: 1, lastCode: 200, lastAttemptAt: now, nextAttemptAt: null, payloadHash: "0x" + "9a".repeat(32) });
    const echo = /\/v1\/webhooks\/echo\/([0-9a-f]+)$/.exec(hook.url);
    if (echo) (mockEcho[echo[1]!] ??= []).unshift({ receivedAt: now, type: "ping", deliveryId, verified: true, body: { id: `ev_${now}`, type: "ping", createdAt: now, chainId: 84532, partnerId: PARTNER_ID, data: {} } });
    return { status: 202, body: { deliveryId } };
  }
  if (p === "/v1/policy/versions") {
    const b = (body ?? {}) as { note?: string; tickers?: unknown[]; partner?: unknown; saturdayMode?: SaturdayModePolicy };
    const onDesk = Boolean(b.tickers?.length) || b.partner !== undefined;
    const changes: PolicyChange[] = [];
    if (b.saturdayMode && mockPolicy.saturdayMode) {
      for (const f of ["enabled", "capacityFraction", "haircutBps"] as const) {
        if (b.saturdayMode[f] !== mockPolicy.saturdayMode[f]) changes.push({ scope: "routing", field: `saturdayMode.${f}`, before: mockPolicy.saturdayMode[f], after: b.saturdayMode[f] });
      }
    }
    const v: PolicyVersion & { saturdayMode?: SaturdayModePolicy } = {
      id: `pv_${String(mockVersions.length + 1).padStart(4, "0")}`,
      status: "prepared",
      createdAt: Math.floor(Date.now() / 1000),
      note: b.note ?? "",
      changes,
      // Saturday mode is an off-chain routing policy: a version that changes only it has no desk call to sign.
      calls: onDesk ? [{ to: DESK, data: "0x" + "44".repeat(100), description: "setTickerPolicy(...)" }] : [],
      policyVersionBefore: mockPolicy.policyVersion,
      ...(b.saturdayMode ? { saturdayMode: { ...b.saturdayMode } } : {}),
    };
    mockVersions.unshift(v);
    return { status: 201, body: { policyVersion: mockPolicy.policyVersion, version: v } };
  }
  const applied = /^\/v1\/policy\/versions\/([^/]+)\/applied$/.exec(p);
  if (applied) {
    const v = mockVersions.find((x) => x.id === applied[1]);
    if (!v) return { status: 404, body: { error: "unknown version" } };
    v.status = "applied";
    v.txHash = (body as { txHash?: string })?.txHash ?? null;
    v.appliedAt = Math.floor(Date.now() / 1000);
    // Only a desk call bumps the desk's policy version; a routing-only version applies off chain.
    v.policyVersionAfter = v.calls.length > 0 ? v.policyVersionBefore + 1 : v.policyVersionBefore;
    const sat = (v as PolicyVersion & { saturdayMode?: SaturdayModePolicy }).saturdayMode;
    if (sat) mockPolicy.saturdayMode = { ...sat };
    return { status: 200, body: { policyVersion: v.policyVersionAfter, version: v } };
  }
  return { status: 404, body: { error: "not found (mock)" } };
}
