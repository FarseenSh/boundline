import { describe, expect, it } from "vitest";
import { app, protectionView } from "../src/index.js";

describe("boundline-keeper", () => {
  it("answers /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "boundline-keeper" });
  });

  it("describes its config without leaking RPC keys", async () => {
    const res = await app.request("/v1/config", {}, { BASE_RPC_URL: "https://a.example/v2/secret", BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chains: { mainnet: { rpc: string[] } }; pairs: unknown[]; keeperAddress: string };
    expect(body.chains.mainnet.rpc).toEqual(["a.example"]);
    expect(body.pairs).toHaveLength(3);
    expect(body.keeperAddress).toBe("0x28A50Eb7C2Db2B04638D3b226c724A1Cfe999894");
  });
});

describe("maxTxPerTick", () => {
  it("falls back to the default when the var is unset, blank or not a whole number", async () => {
    const { maxTxPerTick } = await import("../src/index.js");
    const { MAX_TX_PER_TICK } = await import("../src/config.js");
    expect(maxTxPerTick({})).toBe(MAX_TX_PER_TICK);
    expect(maxTxPerTick({ MAX_TX_PER_TICK: "" })).toBe(MAX_TX_PER_TICK);
    expect(maxTxPerTick({ MAX_TX_PER_TICK: " " })).toBe(MAX_TX_PER_TICK);
    expect(maxTxPerTick({ MAX_TX_PER_TICK: "x" })).toBe(MAX_TX_PER_TICK);
    expect(maxTxPerTick({ MAX_TX_PER_TICK: "1.5" })).toBe(MAX_TX_PER_TICK);
    expect(maxTxPerTick({ MAX_TX_PER_TICK: "-1" })).toBe(MAX_TX_PER_TICK);
  });
  it("honours a whole number, including zero (plan only)", async () => {
    const { maxTxPerTick } = await import("../src/index.js");
    expect(maxTxPerTick({ MAX_TX_PER_TICK: "3" })).toBe(3);
    expect(maxTxPerTick({ MAX_TX_PER_TICK: "0" })).toBe(0);
  });
  it("is reported by /v1/config", async () => {
    const res = await app.request("/v1/config", {}, { BASE_RPC_URL: "https://a.example", BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org", MAX_TX_PER_TICK: "2" });
    const body = (await res.json()) as { maxTxPerTick: number };
    expect(body.maxTxPerTick).toBe(2);
  });
});


describe("/v1/protect", () => {
  it("answers disabled without the protection vars", async () => {
    const res = await app.request("/v1/protect", {}, { BASE_RPC_URL: "https://a.example", BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
  });
  it("serialises bigints as decimal strings", async () => {
    const { jsonWithBigints } = await import("../src/index.js");
    expect(jsonWithBigints({ a: 10n ** 20n, b: [1n, { c: 2n }], d: "x" })).toBe('{"a":"100000000000000000000","b":["1",{"c":"2"}],"d":"x"}');
  });
});

describe("mirrorHold", () => {
  it("parses the two comma lists, trims, drops blanks", async () => {
    const { mirrorHold } = await import("../src/env.js");
    expect(mirrorHold({})).toEqual({ feed: new Set(), registry: new Set() });
    expect(mirrorHold({ MIRROR_HOLD_FEED: " AAPLt , ,NVDAt", MIRROR_HOLD_REGISTRY: "TSLAt" })).toEqual({ feed: new Set(["AAPLt", "NVDAt"]), registry: new Set(["TSLAt"]) });
  });
});

describe("hold switch (KV)", () => {
  it("parses the KV value; blank, malformed or wrong-shaped values hold nothing and say why", async () => {
    const { parseKvHold } = await import("../src/env.js");
    expect(parseKvHold(null)).toEqual({ feed: new Set(), registry: new Set() });
    expect(parseKvHold("  ")).toEqual({ feed: new Set(), registry: new Set() });
    expect(parseKvHold('{"feed":[" TSLAt ",""],"registry":["NVDAt",7]}')).toEqual({ feed: new Set(["TSLAt"]), registry: new Set(["NVDAt"]) });
    expect(parseKvHold("{nope").error).toBe("hold: not JSON");
    expect(parseKvHold('["TSLAt"]').error).toBe("hold: not an object");
    expect(parseKvHold('{"feed":"TSLAt"}')).toEqual({ feed: new Set(), registry: new Set() });
  });
  it("unites the vars and the KV hold and names the source", async () => {
    const { mergeHold, parseKvHold } = await import("../src/env.js");
    const none = { feed: new Set<string>(), registry: new Set<string>() };
    expect(mergeHold(none, parseKvHold(null)).source).toBe("none");
    expect(mergeHold({ feed: new Set(["AAPLt"]), registry: new Set() }, parseKvHold(null)).source).toBe("vars");
    const both = mergeHold({ feed: new Set(["AAPLt"]), registry: new Set() }, parseKvHold('{"feed":["TSLAt"],"registry":["TSLAt"]}'));
    expect(both).toEqual({ feed: new Set(["AAPLt", "TSLAt"]), registry: new Set(["TSLAt"]), source: "vars+kv" });
    expect(mergeHold(none, parseKvHold("{bad")).kvError).toBe("hold: not JSON");
  });
  it("readHold never throws: a failing KV read falls back to the vars", async () => {
    const { readHold } = await import("../src/env.js");
    const failing = { get: async () => { throw new Error("kv down"); } } as unknown as KVNamespace;
    const h = await readHold({ MIRROR_HOLD_FEED: "NVDAt", KEEPER_STATE: failing });
    expect([...h.feed]).toEqual(["NVDAt"]);
    expect(h.source).toBe("vars");
    expect(h.kvError).toContain("kv down");
    const kv = { get: async (k: string) => (k === "hold" ? '{"registry":["TSLAt"]}' : null) } as unknown as KVNamespace;
    const h2 = await readHold({ KEEPER_STATE: kv });
    expect([...h2.registry]).toEqual(["TSLAt"]);
    expect(h2.source).toBe("kv");
  });
  it("/v1/config shows the merged hold and its source", async () => {
    const kv = { get: async () => '{"feed":["TSLAt"],"registry":["TSLAt"]}' } as unknown as KVNamespace;
    const res = await app.request("/v1/config", {}, { BASE_RPC_URL: "https://a.example", BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org", MIRROR_HOLD_FEED: "AAPLt", KEEPER_STATE: kv });
    const body = (await res.json()) as { hold: { feed: string[]; registry: string[] }; holdSource: string; holdSwitch: { bound: boolean; key: string } };
    expect(body.hold).toEqual({ feed: ["AAPLt", "TSLAt"], registry: ["TSLAt"] });
    expect(body.holdSource).toBe("vars+kv");
    expect(body.holdSwitch).toEqual({ kvBinding: "KEEPER_STATE", bound: true, key: "hold" });
  });
});

describe("/v1/events/probe", () => {
  it("says unbound without the binding, and relays the API's refusal of an invalid event", async () => {
    const env = { BASE_RPC_URL: "https://a.example", BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org" };
    expect(await (await app.request("/v1/events/probe", {}, env)).json()).toMatchObject({ bound: false });
    const seen: unknown[] = [];
    const API_EVENTS = { ingest: async (e: unknown) => (seen.push(e), { accepted: false, id: "", deliveries: 0, error: "type must be one of grace, …" }) };
    const res = await app.request("/v1/events/probe", {}, { ...env, API_EVENTS });
    expect(await res.json()).toMatchObject({ bound: true, answer: { accepted: false, deliveries: 0 } });
    expect(seen).toEqual([{ type: "probe" }]);
  });
});

describe("protectionView (the harvest job's gate, from what the protection jobs read)", () => {
  type P = Parameters<typeof protectionView>;
  const quote = (reason: string, session: string) => ({ reason, session, price8: 0n, collateralValue: 0n, corporateActionHaircut: false });
  const vault = (q: ReturnType<typeof quote>, action: "protect" | "none" = "none") =>
    ({ armed: null, targets: [{ quote: q, decision: action === "protect" ? { action: "protect" } : { action: "none", reason: "below-grace" } }] }) as unknown as P[1];
  const protect = (live: boolean) => ({ targets: [{ sizing: { venueOracleLive: live } }] }) as unknown as P[0];
  it("is open only in session with nothing wanting the signer", () => {
    expect(protectionView(protect(true), vault(quote("NONE", "OVERNIGHT")), false)).toEqual({ signerWanted: false, marketClosed: false });
    expect(protectionView(protect(true), vault(quote("MARKET_CLOSED", "WEEKEND")), false).marketClosed).toBe(true);
    expect(protectionView(protect(false), vault(quote("NONE", "REGULAR")), false).marketClosed).toBe(true);
    expect(protectionView(protect(true), vault(quote("NONE", "REGULAR"), "protect"), false).signerWanted).toBe(true);
    expect(protectionView(protect(true), vault(quote("NONE", "REGULAR")), true).signerWanted).toBe(true);
    expect(protectionView(null, null, false)).toEqual({ signerWanted: false, marketClosed: false });
  });
});
