import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { creditDeskAbi } from "../src/abi/creditDesk.js";
import { createD1Store } from "../src/db.js";
import { diffPolicy, parseMarkets, parseVersionInput, type PolicyView } from "../src/policy.js";
import { AAPLT, ADMIN, DESK, MARKETS, MARKET_ID, NVDAT, OTHER_PARTNER_ID, PARTNER_ID, USER, call, fakeD1, makeDesk, samplePartner, sampleTickerPolicy, world } from "./helpers.js";

const key = () => ({ "idempotency-key": `k-${Math.random()}` });
const TX = `0x${"77".repeat(32)}`;

describe("GET /v1/policy", () => {
  it("reads the partner and one row per market from the desk", async () => {
    const { app } = await world({ desk: makeDesk({ tickerPolicy: async (_p, collateral) => sampleTickerPolicy({ allowed: collateral === AAPLT, exposure: collateral === AAPLT ? 3_000_000n : 0n }) }) });
    const { res, json } = await call(app, "GET", "/v1/policy");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-policy-version")).toBe("3");
    expect(json).toMatchObject({ partnerId: PARTNER_ID, name: "Boundline app", policyVersion: 3, desk: DESK, chainId: 84532 });
    expect(json.partner).toEqual({ admin: ADMIN, signer: "0x0000000000000000000000000000000000000000", eligibility: "0x0000000000000000000000000000000000000000", active: true, exposureCap: "0", exposure: "0" });
    expect(json.tickers).toHaveLength(2);
    expect(json.tickers[0]).toEqual({ symbol: "AAPLt", collateral: AAPLT, marketId: MARKET_ID, allowed: true, maxLtvWad: "500000000000000000", minDraw: "1000000", maxDraw: "100000000", exposureCap: "500000000", exposure: "3000000", marketLltvWad: "625000000000000000" });
    expect(json.tickers[1]).toMatchObject({ symbol: "NVDAt", collateral: NVDAT, allowed: false, exposure: "0" });
  });

  it("needs the desk and a key", async () => {
    const { app } = await world({ desk: null });
    expect((await call(app, "GET", "/v1/policy")).res.status).toBe(503);
    expect((await call(app, "GET", "/v1/policy", { key: null })).res.status).toBe(401);
  });
});

describe("POST /v1/policy/versions", () => {
  it("prepares a version: field diffs and the setTickerPolicy call the admin signs", async () => {
    const { app, store } = await world();
    const body = { note: "raise AAPLt to 55%", tickers: [{ collateral: AAPLT, allowed: true, maxLtvWad: "550000000000000000", minDraw: "1000000", maxDraw: "100000000", exposureCap: "500000000" }] };
    const { res, json } = await call(app, "POST", "/v1/policy/versions", { body, headers: { "idempotency-key": "pv-1" } });
    expect(res.status).toBe(201);
    expect(json.version).toMatchObject({ id: expect.any(String), status: "prepared", note: "raise AAPLt to 55%", policyVersionBefore: 3, policyVersionAfter: null, txHash: null });
    expect(json.version.changes).toEqual([{ scope: "ticker", symbol: "AAPLt", collateral: AAPLT, field: "maxLtvWad", before: "500000000000000000", after: "550000000000000000" }]);
    expect(json.version.calls).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: creditDeskAbi, data: json.version.calls[0].data });
    expect(decoded.functionName).toBe("setTickerPolicy");
    expect(decoded.args).toEqual([PARTNER_ID, AAPLT, true, 550_000_000_000_000_000n, 1_000_000n, 100_000_000n, 500_000_000n]);
    expect(json.version.calls[0]).toMatchObject({ to: DESK, function: "setTickerPolicy" });
    expect(json.version.calls[0].description).toMatch(/maxLtvWad 500000000000000000 → 550000000000000000/);
    expect(json.admin).toBe(ADMIN);
    expect(json.policyVersion).toBe(3);
    expect(store.policyVersions.size).toBe(1);
    // Same key, same body: replayed, not duplicated.
    const again = await call(app, "POST", "/v1/policy/versions", { body, headers: { "idempotency-key": "pv-1" } });
    expect(again.res.headers.get("x-idempotent-replay")).toBe("true");
    expect(again.json.version.id).toBe(json.version.id);
    expect(store.policyVersions.size).toBe(1);
  });

  it("prepares the partner config call too, and refuses a version with nothing to change", async () => {
    const { app } = await world();
    const partner = { signer: USER, eligibility: "0x0000000000000000000000000000000000000000", exposureCap: "1000000000", active: true };
    const { res, json } = await call(app, "POST", "/v1/policy/versions", { body: { note: "signer + cap", partner, tickers: [{ collateral: NVDAT, allowed: false, maxLtvWad: "500000000000000000", minDraw: "0", maxDraw: "0", exposureCap: "0" }] }, headers: key() });
    expect(res.status).toBe(201);
    expect(json.version.calls.map((c: { function: string }) => c.function)).toEqual(["setTickerPolicy", "setPartnerConfig"]);
    const decoded = decodeFunctionData({ abi: creditDeskAbi, data: json.version.calls[1].data });
    expect(decoded.args).toEqual([PARTNER_ID, USER, "0x0000000000000000000000000000000000000000", 1_000_000_000n, true]);
    expect(json.version.changes.filter((c: { scope: string }) => c.scope === "partner").map((c: { field: string }) => c.field)).toEqual(["signer", "exposureCap"]);

    const same = { note: "no-op", tickers: [{ collateral: AAPLT, allowed: true, maxLtvWad: "500000000000000000", minDraw: "1000000", maxDraw: "100000000", exposureCap: "500000000" }] };
    const r = await call(app, "POST", "/v1/policy/versions", { body: same, headers: key() });
    expect(r.res.status).toBe(400);
    expect(r.json.error).toMatch(/no changes/);
  });

  it("validates the body", async () => {
    const { app } = await world();
    const bad = async (body: unknown, re: RegExp) => {
      const r = await call(app, "POST", "/v1/policy/versions", { body, headers: key() });
      expect(r.res.status).toBe(400);
      expect(r.json.error).toMatch(re);
    };
    await bad({ tickers: [] }, /note is required/);
    await bad({ note: "x" }, /tickers, partner and\/or saturdayMode/);
    await bad({ note: "x", tickers: [{ collateral: AAPLT, allowed: true, maxLtvWad: "1000000000000000000" }] }, /maxLtvWad/);
    await bad({ note: "x", tickers: [{ collateral: USER, allowed: true, maxLtvWad: "1" }] }, /not a market/);
    await bad({ note: "x", tickers: [{ collateral: AAPLT, allowed: true, maxLtvWad: "1", minDraw: "5", maxDraw: "4" }] }, /minDraw/);
    await bad({ note: "x", partner: { signer: "nope" } }, /partner.signer/);
    const noKey = await call(app, "POST", "/v1/policy/versions", { body: { note: "x" } });
    expect(noKey.res.status).toBe(400);
    expect(noKey.json.error).toMatch(/Idempotency-Key/);
  });
});

describe("policy version lifecycle", () => {
  async function prepared() {
    const w = await world();
    const body = { note: "v", tickers: [{ collateral: AAPLT, allowed: true, maxLtvWad: "550000000000000000", minDraw: "1000000", maxDraw: "100000000", exposureCap: "500000000" }] };
    const { json } = await call(w.app, "POST", "/v1/policy/versions", { body, headers: key() });
    return { ...w, id: json.version.id as string };
  }

  it("lists newest first and scopes by partner", async () => {
    const { app, store, clock } = await prepared();
    clock.now += 10;
    const second = await call(app, "POST", "/v1/policy/versions", { body: { note: "second", partner: { signer: USER, eligibility: "0x0000000000000000000000000000000000000000", exposureCap: "0", active: true } }, headers: key() });
    await store.savePolicyVersion({ id: "foreign", partnerId: OTHER_PARTNER_ID, status: "prepared", note: "x", changes: [], calls: [], policyVersionBefore: 1, policyVersionAfter: null, txHash: null, createdAt: 1, appliedAt: null });
    const { json } = await call(app, "GET", "/v1/policy/versions");
    expect(json.count).toBe(2);
    expect(json.versions.map((v: { note: string }) => v.note)).toEqual(["second", "v"]);
    expect((await call(app, "GET", `/v1/policy/versions/${second.json.version.id}`)).json.version.note).toBe("second");
    expect((await call(app, "GET", "/v1/policy/versions/foreign")).res.status).toBe(404);
    expect((await call(app, "GET", "/v1/policy/versions/nope")).res.status).toBe(404);
  });

  it("marks a version applied only once the desk's policy version advanced, and updates the partner's version", async () => {
    const { app, id, deps, store } = await prepared();
    const desk = deps.desk!;
    let version = 3;
    desk.partner = async () => samplePartner({ policyVersion: version });
    let r = await call(app, "POST", `/v1/policy/versions/${id}/applied`, { body: { txHash: TX }, headers: key() });
    expect(r.res.status).toBe(409);
    expect(r.json).toMatchObject({ currentPolicyVersion: 3, policyVersionBefore: 3 });
    version = 4;
    r = await call(app, "POST", `/v1/policy/versions/${id}/applied`, { body: { txHash: TX }, headers: key() });
    expect(r.res.status).toBe(200);
    expect(r.json.version).toMatchObject({ status: "applied", policyVersionAfter: 4, txHash: TX, appliedAt: 1_791_040_000 });
    expect(r.res.headers.get("x-policy-version")).toBe("4");
    expect(store.partners[0]!.policyVersion).toBe(4);
    const next = await call(app, "GET", "/v1/policy/versions");
    expect(next.res.headers.get("x-policy-version")).toBe("4");
    r = await call(app, "POST", `/v1/policy/versions/${id}/applied`, { body: { txHash: TX }, headers: key() });
    expect(r.res.status).toBe(200);
    expect(r.json.note).toBe("already applied");
    expect((await call(app, "POST", `/v1/policy/versions/${id}/applied`, { body: { txHash: "0x12" }, headers: key() })).res.status).toBe(400);
    expect((await call(app, "POST", "/v1/policy/versions/nope/applied", { body: { txHash: TX }, headers: key() })).res.status).toBe(404);
  });
});

describe("policy helpers", () => {
  const view: PolicyView = {
    partnerId: PARTNER_ID,
    name: "p",
    policyVersion: 3,
    partner: { admin: ADMIN, signer: "0x0000000000000000000000000000000000000000", eligibility: "0x0000000000000000000000000000000000000000", active: true, exposureCap: "0", exposure: "0" },
    tickers: [{ symbol: "AAPLt", collateral: AAPLT, marketId: MARKET_ID, allowed: true, maxLtvWad: "500000000000000000", minDraw: "1000000", maxDraw: "100000000", exposureCap: "500000000", exposure: "0", marketLltvWad: "625000000000000000" }],
    saturdayMode: { enabled: false, capacityFraction: 0.5, haircutBps: 300 },
  };

  it("parses the MARKETS var as a JSON string", () => {
    const parsed = parseMarkets(JSON.stringify(MARKETS.map((m) => ({ ...m, targetLtvWad: m.targetLtvWad?.toString() }))));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ symbol: "AAPLt", targetLtvWad: 580_000_000_000_000_000n });
    expect(parsed[0]!.preLiquidation?.toLowerCase()).toBe(MARKETS[0]!.preLiquidation?.toLowerCase());
    expect(parsed[1]!.preLiquidation).toBeUndefined();
    expect(parseMarkets(undefined)).toEqual([]);
    expect(() => parseMarkets('[{"symbol":"x"}]')).toThrow(/MARKETS\[0\]/);
  });

  it("diffs only what changed and emits one call per changed ticker", () => {
    const input = parseVersionInput({ note: "n", tickers: [{ collateral: AAPLT, allowed: false, maxLtvWad: "500000000000000000", minDraw: "1000000", maxDraw: "100000000", exposureCap: "500000000" }] }, MARKETS);
    expect("error" in input).toBe(false);
    const { changes, calls } = diffPolicy(DESK, view, input as Exclude<typeof input, { error: string }>);
    expect(changes).toEqual([{ scope: "ticker", symbol: "AAPLt", collateral: AAPLT, field: "allowed", before: true, after: false }]);
    expect(calls).toHaveLength(1);
  });

  it("round-trips policy versions and lines by user through the D1 store", async () => {
    const store = createD1Store(fakeD1());
    await store.savePolicyVersion({ id: "a", partnerId: PARTNER_ID, status: "prepared", note: "n", changes: [{ field: "x" }], calls: [{ to: DESK, data: "0x", description: "d", function: "setTickerPolicy" }], policyVersionBefore: 3, policyVersionAfter: null, txHash: null, createdAt: 10, appliedAt: null });
    await store.savePolicyVersion({ id: "b", partnerId: PARTNER_ID, status: "prepared", note: "later", changes: [], calls: [], policyVersionBefore: 3, policyVersionAfter: null, txHash: null, createdAt: 20, appliedAt: null });
    expect((await store.listPolicyVersions(PARTNER_ID, 10)).map((v) => v.id)).toEqual(["b", "a"]);
    await store.markPolicyVersionApplied(PARTNER_ID, "a", 4, TX, 30);
    expect(await store.getPolicyVersion(PARTNER_ID, "a")).toMatchObject({ status: "applied", policyVersionAfter: 4, txHash: TX, appliedAt: 30, changes: [{ field: "x" }] });
    expect(await store.getPolicyVersion(OTHER_PARTNER_ID, "a")).toBeNull();
    await store.rememberLine({ lineId: "1", partnerId: PARTNER_ID, user: USER, marketId: MARKET_ID, firstSeen: 1 });
    await store.rememberLine({ lineId: "2", partnerId: PARTNER_ID, user: USER.toLowerCase(), marketId: MARKET_ID, firstSeen: 2 });
    expect((await store.listLinesByUser(USER.toUpperCase().replace("0X", "0x"), 10)).map((l) => l.lineId)).toEqual(["2", "1"]);
  });
});
