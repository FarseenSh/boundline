import { describe, expect, it } from "vitest";
import { applyRoutingChanges, DEFAULT_SATURDAY_MODE, parseSaturdayInput, parseSaturdayJson, saturdayFractionBps } from "../src/policy.js";
import { AAPLT, call, makeDesk, samplePartner, world } from "./helpers.js";

const key = () => ({ "idempotency-key": `k-${Math.random()}` });
const TX = `0x${"77".repeat(32)}`;

describe("Saturday mode as a partner policy option", () => {
  it("is off by default and shows in GET /v1/policy", async () => {
    const { app } = await world();
    const { json } = await call(app, "GET", "/v1/policy");
    expect(json.saturdayMode).toEqual({ enabled: false, capacityFraction: 0.5, haircutBps: 300 });
    expect(json.saturdayModeSource).toMatchObject({ versionId: null, updatedAt: null });
  });

  it("a routing-only version has nothing to sign: it is applied as it is prepared, versioned like the rest", async () => {
    const { app } = await world();
    const r = await call(app, "POST", "/v1/policy/versions", { body: { note: "allow Saturday draws on around-the-clock venues", saturdayMode: { enabled: true, capacityFraction: 0.25 } }, headers: key() });
    expect(r.res.status).toBe(201);
    expect(r.json.appliedOffchain).toBe(true);
    expect(r.json.saturdayMode).toEqual({ enabled: true, capacityFraction: 0.25, haircutBps: 300 });
    expect(r.json.version).toMatchObject({ status: "applied", calls: [], policyVersionBefore: 3, policyVersionAfter: 3, txHash: null });
    expect(r.json.version.changes).toEqual([
      { scope: "routing", field: "saturdayMode.enabled", before: false, after: true },
      { scope: "routing", field: "saturdayMode.capacityFraction", before: "0.5", after: "0.25" },
    ]);
    const policy = await call(app, "GET", "/v1/policy");
    expect(policy.json.saturdayMode).toEqual({ enabled: true, capacityFraction: 0.25, haircutBps: 300 });
    expect(policy.json.saturdayModeSource.versionId).toBe(r.json.version.id);
    const history = await call(app, "GET", "/v1/policy/versions");
    expect(history.json.versions[0]).toMatchObject({ id: r.json.version.id, status: "applied" });
    // the same settings again: nothing to change
    const again = await call(app, "POST", "/v1/policy/versions", { body: { note: "same", saturdayMode: { enabled: true, capacityFraction: 0.25 } }, headers: key() });
    expect(again.res.status).toBe(400);
  });

  it("with desk changes in the same version, the routing part waits for the signed calls", async () => {
    let desked = 3;
    const { app } = await world({ desk: makeDesk({ partner: async () => samplePartner({ policyVersion: desked }) }) });
    const body = { note: "both", saturdayMode: { enabled: true, haircutBps: 500 }, tickers: [{ collateral: AAPLT, allowed: true, maxLtvWad: "450000000000000000", minDraw: "1000000", maxDraw: "100000000", exposureCap: "500000000" }] };
    const r = await call(app, "POST", "/v1/policy/versions", { body, headers: key() });
    expect(r.json.version.status).toBe("prepared");
    expect(r.json.version.calls).toHaveLength(1);
    expect((await call(app, "GET", "/v1/policy")).json.saturdayMode.enabled).toBe(false);
    desked = 4;
    const applied = await call(app, "POST", `/v1/policy/versions/${r.json.version.id}/applied`, { body: { txHash: TX }, headers: key() });
    expect(applied.res.status).toBe(200);
    expect(applied.json.saturdayMode).toEqual({ enabled: true, capacityFraction: 0.5, haircutBps: 500 });
    expect((await call(app, "GET", "/v1/policy")).json.saturdayMode).toEqual({ enabled: true, capacityFraction: 0.5, haircutBps: 500 });
  });

  it("validates: at most half the capacity, basis-point granularity, a haircut in [0, 5000]", async () => {
    const { app } = await world();
    const bad = async (saturdayMode: unknown, re: RegExp) => {
      const r = await call(app, "POST", "/v1/policy/versions", { body: { note: "x", saturdayMode }, headers: key() });
      expect(r.res.status).toBe(400);
      expect(r.json.error).toMatch(re);
    };
    await bad({ capacityFraction: 0.2 }, /enabled/);
    await bad({ enabled: true, capacityFraction: 0.6 }, /capacityFraction/);
    await bad({ enabled: true, capacityFraction: 0.12345 }, /four decimals/);
    await bad({ enabled: true, haircutBps: 5_001 }, /haircutBps/);
    await bad({ enabled: true, haircutBps: 1.5 }, /haircutBps/);
    expect(parseSaturdayInput({ enabled: false })).toEqual({ enabled: false });
  });

  it("parses stored JSON defensively and applies only valid routing changes", () => {
    expect(parseSaturdayJson(null)).toEqual(DEFAULT_SATURDAY_MODE);
    expect(parseSaturdayJson("{bad")).toEqual(DEFAULT_SATURDAY_MODE);
    expect(parseSaturdayJson('{"enabled":true,"capacityFraction":0.9,"haircutBps":1}')).toEqual(DEFAULT_SATURDAY_MODE);
    expect(saturdayFractionBps({ enabled: true, capacityFraction: 0.25, haircutBps: 0 })).toBe(2_500);
    const next = applyRoutingChanges(DEFAULT_SATURDAY_MODE, [{ scope: "ticker", field: "maxLtvWad", after: "1" }, { scope: "routing", field: "saturdayMode.enabled", after: true }, { scope: "routing", field: "saturdayMode.haircutBps", after: "250" }]);
    expect(next).toEqual({ enabled: true, capacityFraction: 0.5, haircutBps: 250 });
    expect(applyRoutingChanges(DEFAULT_SATURDAY_MODE, [{ scope: "routing", field: "saturdayMode.capacityFraction", after: "0.9" }])).toEqual(DEFAULT_SATURDAY_MODE);
  });
});
