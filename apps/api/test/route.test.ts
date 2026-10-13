import { canonicalRoutePlan } from "@boundline/router";
import { hashTypedData, keccak256, recoverTypedDataAddress, stringToHex, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { AppDeps } from "../src/app.js";
import { CHAIN_SEPOLIA, decodeLineHead, decodePartner, decodeTickerPolicy, decodeVerdict, makePlan, parseDecimalUnits, parseRouteInput, routePlanDigest, type ResolvedRoute } from "../src/route.js";
import { routeSignerFrom } from "../src/route-signer.js";
import { toPartnerId } from "../src/app.js";
import { AAPLT, DESK, KEY, MARKETS, MARKET_ID, NOW, OTHER_PARTNER_ID, PARTNER_ID, USDC_SEPOLIA, USER, X402_CFG, call, fakeFacilitator, world } from "./helpers.js";
import { addr, fakeRpc, word } from "./rpc-fake.js";

const MORPHO: Address = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const GATE: Address = "0x92f59437d4ef5CDcEAe2CcDE89B03A7B4B1Ae427";
const IRM: Address = "0x46415998764C29aB2a25CbeA6254146D50D22687";
const VAULT: Address = "0x87f600279F021ca859b9903DE884d3A7A169f38c";
const ORACLE: Address = "0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854";
const PRICE8 = 33_568_300_000n; // AAPLc 8 Oct 2026 06:35 UTC, 335.683
const RATE_PER_SECOND = 1_268_391_679n; // ≈ 4 % APR
/** anvil's account 0: a public test key, used here only to sign typed data in a test. */
const TEST_SIGNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

interface SepoliaState {
  gateState?: number;
  session?: number;
  allowed?: boolean;
  partnerActive?: boolean;
  partnerAdmin?: Address;
  failIrm?: boolean;
  lineOwner?: Hex;
}

function sepoliaRpc(st: SepoliaState = {}) {
  return fakeRpc((to, data) => {
    const sel = data.slice(0, 10);
    const t = to.toLowerCase();
    if (sel === "0x42cbb15c") return `0x${word(47_836_573n)}`;
    if (t === MORPHO.toLowerCase() && sel === "0x5c60e39a") return `0x${[10_000_220n, 10_000_220_000_000n, 3_405_541n, 3_405_541_000_000n, 1_791_441_000n, 0n].map(word).join("")}`;
    if (t === MORPHO.toLowerCase() && sel === "0x2c3c9157") return `0x${addr(USDC_SEPOLIA)}${addr(AAPLT)}${addr(ORACLE)}${addr(IRM)}${word(625_000_000_000_000_000n)}`;
    if (t === GATE.toLowerCase() && sel === "0xc23697a8") return `0x${[st.gateState ?? 0, st.session ?? 4, PRICE8, 1_791_401_927n, 10n ** 18n, 0n, 0n].map((x) => word(BigInt(x))).join("")}`;
    if (t === DESK.toLowerCase() && sel === "0xac1b3140") return `0x${[st.allowed === false ? 0n : 1n, 500_000_000_000_000_000n, 1_000_000n, 100_000_000n, 500_000_000n, 3_000_000n].map(word).join("")}`;
    if (t === DESK.toLowerCase() && sel === "0xfa2ca900") return `0x${addr(st.partnerAdmin ?? USER)}${word(0n)}${word(0n)}${word(st.partnerActive === false ? 0n : 1n)}${word(1n)}${word(1_000_000_000n)}${word(3_000_000n)}`;
    if (t === IRM.toLowerCase() && sel === "0x8c00bf6b") return st.failIrm ? null : `0x${word(RATE_PER_SECOND)}`;
    if (t === DESK.toLowerCase() && sel === "0x3c7d9255") return `0x${(st.lineOwner ?? PARTNER_ID).slice(2)}${addr(USER)}${MARKET_ID.slice(2)}${addr(AAPLT)}${word(1n)}${word(1n)}${word(0n)}${word(1n)}${word(0n)}`;
    return null;
  });
}

function routeDeps(rpc: typeof fetch): NonNullable<AppDeps["route"]> {
  return { sepolia: { rpcs: ["https://rpc.sepolia.test"], fetchImpl: rpc, desk: DESK, gate: GATE, morpho: MORPHO, markets: MARKETS, vault: VAULT }, mainnet: null };
}

const BODY = { chainId: 84532, borrower: USER, collateral: [{ symbol: "AAPLt", amount: "0.02" }], amountUsdc: "3.00", preferProtection: true };
const VALUE = (2_000_000n * PRICE8 * 1_000_000n) / (100_000_000n * 100_000_000n); // 0.02 AAPLt at 335.683 = 6.713660 USDC

describe("POST /v1/route on Base Sepolia", () => {
  it("routes 0.02 AAPLt under the partner's on-chain policy: the protected market, unsigned without a signer", async () => {
    const rpc = sepoliaRpc();
    const { app, store } = await world({ route: routeDeps(rpc), routeSigner: null });
    const { res, json } = await call(app, "POST", "/v1/route", { body: BODY });
    expect(res.status).toBe(200);
    expect(VALUE).toBe(6_713_660n);
    expect(json.plan.chosen).toMatchObject({
      venue: "morpho",
      chainId: 84532,
      marketId: MARKET_ID,
      amount: "3000000",
      capacity: (VALUE / 2n).toString(), // policy 50 % < LLTV 62.5 %, under liquidity 6.594679 and every cap
      protection: "pre-liquidation",
      priceSource: "feed",
      session: "open",
      price8: PRICE8.toString(),
      expectedRateWad: (RATE_PER_SECOND * 31_536_000n).toString(),
      notes: ["PROTECTED"],
    });
    expect(json.plan.reasonCodes).toEqual(["ROUTED"]);
    expect(json.signature).toBeNull();
    expect(json.signer).toBeNull();
    expect(json.note).toBe("route signer not configured");
    expect(json.policyVersion).toBe(1);
    expect(res.headers.get("x-policy-version")).toBe("1");
    expect(json.policySource).toMatch(/ticker policy/);
    expect(json.blockNumber).toBe("47836573");
    expect(json.metered).toBe(false);
    expect(json.saturdayMode).toEqual({ enabled: false, capacityFraction: 0.5, haircutBps: 300, applied: false });
    // the plan hash is keccak256 over the canonical plan, the digest is the EIP-712 hash of the typed data
    expect(json.planHash).toBe(keccak256(stringToHex(JSON.stringify(sortKeys(json.plan)))));
    expect(json.typedData.domain).toEqual({ name: "Boundline Router", version: "1", chainId: 84532, verifyingContract: DESK });
    expect(json.typedData.message).toMatchObject({ user: USER, collateral: "AAPLt", venue: "morpho", amount: "3000000", protection: "pre-liquidation", reasons: "ROUTED,PROTECTED" });
    expect(json.digest).toBe(hashTypedData(typedDataFromJson(json.typedData)));
    // one multicall carried the six reads, then one call to the IRM
    const targets = rpc.calls.map((c) => c.to.toLowerCase());
    expect(targets).toEqual(["0xca11bde05977b3631167028862be2a173976ca11", MORPHO.toLowerCase(), MORPHO.toLowerCase(), GATE.toLowerCase(), DESK.toLowerCase(), DESK.toLowerCase(), IRM.toLowerCase()]);
    expect(store.routePlans.size).toBe(1);
  });

  it("refuses while the market is closed: no route, nothing to sign", async () => {
    const { app } = await world({ route: routeDeps(sepoliaRpc({ gateState: 1, session: 5 })) });
    const { res, json } = await call(app, "POST", "/v1/route", { body: BODY });
    expect(res.status).toBe(200);
    expect(json.plan.chosen).toBeNull();
    expect(json.plan.reasonCodes).toEqual(["NO_ROUTE"]);
    expect(json.plan.rejected).toEqual([{ venue: "morpho", marketId: MARKET_ID, reason: "MARKET_CLOSED" }]);
    expect(json.typedData).toBeNull();
    expect(json.digest).toBeNull();
    expect(json.note).toBe("no route: nothing to sign");
    expect(json.notes.join(" ")).toMatch(/MARKET_CLOSED, session WEEKEND/);
  });

  it("asks for the capacity when no amount is given, and plans exactly that amount", async () => {
    const { app } = await world({ route: routeDeps(sepoliaRpc()) });
    const { json } = await call(app, "POST", "/v1/route", { body: { ...BODY, amountUsdc: undefined } });
    expect(json.mode).toBe("capacity");
    expect(json.plan.requested).toBe((VALUE / 2n).toString());
    expect(json.plan.chosen.amount).toBe((VALUE / 2n).toString());
    expect(json.plan.reasonCodes).toEqual(["ROUTED"]);
  });

  it("fails closed when the partner is not allowed, and when a read fails it says so (rate 0)", async () => {
    const blocked = await world({ route: routeDeps(sepoliaRpc({ allowed: false })) });
    expect((await call(blocked.app, "POST", "/v1/route", { body: BODY })).json.plan.rejected[0].reason).toBe("TICKER_NOT_ALLOWED");
    const inactive = await world({ route: routeDeps(sepoliaRpc({ partnerActive: false })) });
    const r = await call(inactive.app, "POST", "/v1/route", { body: BODY });
    expect(r.json.plan.rejected[0].reason).toBe("TICKER_NOT_ALLOWED");
    expect(r.json.notes.join(" ")).toMatch(/inactive/);
    const noRate = await world({ route: routeDeps(sepoliaRpc({ failIrm: true })) });
    const nr = await call(noRate.app, "POST", "/v1/route", { body: BODY });
    expect(nr.json.plan.chosen.expectedRateWad).toBe("0");
    expect(nr.json.notes.join(" ")).toMatch(/IRM rate read failed/);
  });

  it("stores a plan on the partner's line and serves it back; another partner's line is unknown", async () => {
    const { app } = await world({ route: routeDeps(sepoliaRpc()), readLine: async () => decodeLineHead(`0x${PARTNER_ID.slice(2)}${addr(USER)}${MARKET_ID.slice(2)}` as Hex) });
    expect((await call(app, "GET", "/v1/lines/4/route")).res.status).toBe(404);
    const made = await call(app, "POST", "/v1/route", { body: { ...BODY, lineId: "4" } });
    expect(made.json.lineId).toBe("4");
    const got = await call(app, "GET", "/v1/lines/4/route");
    expect(got.res.status).toBe(200);
    expect(got.json).toMatchObject({ lineId: "4", chainId: 84532, planHash: made.json.planHash, digest: made.json.digest, signature: null, note: "route signer not configured" });
    expect(got.json.plan).toEqual(made.json.plan);

    const other = await world({ route: routeDeps(sepoliaRpc()), readLine: async () => decodeLineHead(`0x${OTHER_PARTNER_ID.slice(2)}${addr(USER)}${MARKET_ID.slice(2)}` as Hex) });
    const r = await call(other.app, "POST", "/v1/route", { body: { ...BODY, lineId: "9" } });
    expect(r.res.status).toBe(404);
    expect(r.json.error).toBe("unknown line");
  });

  it("is x402-metered for callers without a key; a keyless caller may name a partner's public policy", async () => {
    const facilitator = fakeFacilitator();
    const { app } = await world({ route: routeDeps(sepoliaRpc()), x402: { cfg: X402_CFG, facilitator } });
    const unpaid = await call(app, "POST", "/v1/route", { key: null, body: BODY });
    expect(unpaid.res.status).toBe(402);
    expect(unpaid.json.accepts[0]).toMatchObject({ network: "base-sepolia", maxAmountRequired: "10000" });
    const off = await world({ route: routeDeps(sepoliaRpc()), x402: null });
    expect((await call(off.app, "POST", "/v1/route", { key: null, body: BODY })).res.status).toBe(401);
    // partner keys are never metered, and a key cannot route under someone else's partner id
    const mismatch = await call(app, "POST", "/v1/route", { body: { ...BODY, partnerId: "someone-else" } });
    expect(mismatch.res.status).toBe(403);
    expect(facilitator.calls).toHaveLength(0);
  });

  it("signs the typed data when a route signer is configured, and the signature recovers to it", async () => {
    const signer = routeSignerFrom(TEST_SIGNER_KEY)!;
    const { app } = await world({ route: routeDeps(sepoliaRpc()), routeSigner: signer });
    const { json } = await call(app, "POST", "/v1/route", { body: BODY });
    expect(json.signer).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"); // anvil account 0
    expect(json.note).toBeUndefined();
    const recovered = await recoverTypedDataAddress({ ...typedDataFromJson(json.typedData), signature: json.signature as Hex });
    expect(recovered).toBe(json.signer);
    expect(routeSignerFrom(undefined)).toBeNull();
    expect(routeSignerFrom("0x1234")).toBeNull();
  });

  it("validates the body", async () => {
    const { app } = await world({ route: routeDeps(sepoliaRpc()) });
    const bad = async (body: unknown, re: RegExp) => {
      const r = await call(app, "POST", "/v1/route", { body });
      expect(r.res.status).toBe(400);
      expect(r.json.error).toMatch(re);
    };
    await bad({ ...BODY, chainId: 1 }, /chainId/);
    await bad({ ...BODY, collateral: [] }, /non-empty/);
    await bad({ ...BODY, collateral: [{ symbol: "AAPLt", amount: "0.02" }, { symbol: "NVDAt", amount: "1" }] }, /one collateral/);
    await bad({ ...BODY, collateral: [{ symbol: "AAPLt", amount: "0.000000001" }] }, /at most 8 decimals/);
    await bad({ ...BODY, amountUsdc: "1.0000001" }, /at most 6 decimals/);
    await bad({ ...BODY, borrower: "0x12" }, /borrower/);
    await bad({ ...BODY, lineId: "0" }, /lineId/);
    await bad({ ...BODY, maxLtvBps: 9_500 }, /maxLtvBps/);
    const unknown = await call(app, "POST", "/v1/route", { body: { ...BODY, collateral: [{ symbol: "MSFTt", amount: "1" }] } });
    expect(unknown.json.plan.chosen).toBeNull();
    expect(unknown.json.notes[0]).toMatch(/not a market the desk serves/);
  });
});

describe("POST /v1/route on Base mainnet", () => {
  const tokens = (feedLive: boolean) => ({
    tokens: [{ symbol: "AAPLc", feedAnswer: PRICE8.toString(), feedUpdatedAt: NOW - 600, feedAgeSeconds: 600, session: feedLive ? "OVERNIGHT" : "WEEKEND", feedLive, registryPaused: false, transferPaused: false, dexTwapPrice36: "3340000000000000000000000000000000000" }],
  });
  const STEAKHOUSE = "0xae1a30486234bf7e7ac166c7c03d9bc5f2cd8a39be2c48e73c665ac7148c3c28";
  const markets = { markets: [{ id: STEAKHOUSE, collateral: { address: "0xb200000000000000000000C2e324d24d7eEcd1fb", symbol: "AAPLc" }, lltv: 0.625, totalSupplyAssets: "250000000", totalBorrowAssets: "100000000" }] };
  const mainnetRpc = fakeRpc((to, data) => {
    const sel = data.slice(0, 10);
    if (sel === "0x5c60e39a") return `0x${[250_000_000n, 250_000_000_000_000n, 100_000_000n, 100_000_000_000_000n, 1_791_441_000n, 0n].map(word).join("")}`;
    if (sel === "0x2c3c9157") return `0x${addr("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")}${addr("0xb200000000000000000000C2e324d24d7eEcd1fb")}${addr(ORACLE)}${addr(IRM)}${word(625_000_000_000_000_000n)}`;
    if (sel === "0x8c00bf6b") return `0x${word(RATE_PER_SECOND)}`;
    return null;
  });
  const deps = (feedLive: boolean): NonNullable<AppDeps["route"]> => ({ sepolia: null, mainnet: { observatory: async (path) => (path === "/v1/tokens" ? tokens(feedLive) : markets), rpcs: ["https://rpc.test"], fetchImpl: mainnetRpc } });

  it("routes 1 AAPLc to the Steakhouse market at the live rate, protected by Boundline's pre-liquidation, default 55 % policy", async () => {
    const { app } = await world({ route: deps(true) });
    const { json } = await call(app, "POST", "/v1/route", { body: { chainId: 8453, borrower: USER, collateral: [{ symbol: "AAPLc", amount: "1" }] } });
    expect(json.plan.chosen).toMatchObject({ venue: "morpho", chainId: 8453, marketId: STEAKHOUSE, protection: "pre-liquidation", expectedRateWad: (RATE_PER_SECOND * 31_536_000n).toString() });
    const value = (100_000_000n * PRICE8 * 1_000_000n) / (100_000_000n * 100_000_000n);
    // 55 % of 335.683 USDC is 184.625650, above the 150 USDC the market can lend: liquidity is the bound that bites
    expect((value * 550_000_000_000_000_000n) / 10n ** 18n).toBe(184_625_650n);
    expect(json.plan.chosen.capacity).toBe("150000000");
    expect(json.plan.chosen.notes).toContain("LIQUIDITY_LIMITED");
    expect(json.policySource).toMatch(/no Boundline desk on Base mainnet/);
    expect(json.typedData.domain.verifyingContract).toBe("0x0000000000000000000000000000000000000000");
  });

  it("Saturday mode applies only when the partner policy enables it; the request may opt out", async () => {
    const { app, store } = await world({ route: deps(false) });
    const body = { chainId: 8453, borrower: USER, collateral: [{ symbol: "AAPLc", amount: "1" }] };
    const off = await call(app, "POST", "/v1/route", { body: { ...body, saturdayMode: true } });
    expect(off.json.plan.chosen).toBeNull();
    expect(off.json.plan.rejected[0].reason).toBe("MARKET_CLOSED");
    expect(off.json.notes.join(" ")).toMatch(/Saturday mode is off in the partner policy/);
    await store.putPartnerSettings({ partnerId: PARTNER_ID, saturdayJson: JSON.stringify({ enabled: true, capacityFraction: 0.25, haircutBps: 400 }), versionId: "v", updatedAt: NOW });
    const on = await call(app, "POST", "/v1/route", { body });
    expect(on.json.saturdayMode).toEqual({ enabled: true, capacityFraction: 0.25, haircutBps: 400, applied: true });
    expect(on.json.plan.chosen).toMatchObject({ session: "saturday", priceSource: "twap-haircut" });
    expect(on.json.plan.chosen.notes).toContain("SATURDAY_REDUCED_CAPACITY");
    expect(on.json.plan.reasonCodes).toContain("SATURDAY_MODE");
    // min(held 335.683, TWAP 334.00) less 400 bps = 320.64; a quarter of 55 % of that
    const price = (33_400_000_000n * 9_600n) / 10_000n;
    expect(on.json.plan.chosen.price8).toBe(price.toString());
    const value = (100_000_000n * price * 1_000_000n) / (100_000_000n * 100_000_000n);
    expect(on.json.plan.chosen.capacity).toBe((((value * 550_000_000_000_000_000n) / 10n ** 18n) * 2_500n / 10_000n).toString());
    const opted = await call(app, "POST", "/v1/route", { body: { ...body, saturdayMode: false } });
    expect(opted.json.plan.chosen).toBeNull();
    expect(opted.json.saturdayMode.applied).toBe(false);
  });
});

describe("route maths and encoders", () => {
  it("parses decimal units exactly", () => {
    expect(parseDecimalUnits("0.02", 8)).toBe(2_000_000n);
    expect(parseDecimalUnits("3", 6)).toBe(3_000_000n);
    expect(parseDecimalUnits("1.5", 0)).toBeNull();
    expect(parseDecimalUnits("-1", 6)).toBeNull();
    expect(parseDecimalUnits("1e3", 6)).toBeNull();
  });

  it("decodes the gate verdict, ticker policy and partner words (int256 answers keep their sign)", () => {
    const neg = (1n << 256n) - 5n;
    expect(decodeVerdict(`0x${[5n, 5n, neg, 7n, 10n ** 18n, 1n, 0n].map(word).join("")}` as Hex)).toEqual({ state: "FEED_INVALID", session: "WEEKEND", answer: -5n, updatedAt: 7n, multiplier: 10n ** 18n, registryPaused: true, transferPaused: false });
    expect(decodeVerdict(`0x${[6n, 0n, 0n, 0n, 0n, 0n, 0n].map(word).join("")}` as Hex).state).toBe("UNKNOWN");
    expect(decodeTickerPolicy(`0x${[1n, 5n, 6n, 7n, 8n, 9n].map(word).join("")}` as Hex)).toEqual({ allowed: true, maxLtvWad: 5n, minDraw: 6n, maxDraw: 7n, exposureCap: 8n, exposure: 9n });
    expect(decodePartner(`0x${addr(USER)}${word(0n)}${word(0n)}${word(1n)}${word(3n)}${word(4n)}${word(5n)}` as Hex)).toEqual({ admin: USER.toLowerCase(), active: true, policyVersion: 3, exposureCap: 4n, exposure: 5n });
    expect(() => decodeVerdict("0x00" as Hex)).toThrow(/7 words/);
  });

  it("hand-rolls the EIP-712 digest exactly as viem's hashTypedData", () => {
    const input = parseRouteInput({ ...BODY }, toPartnerId);
    if ("error" in input) throw new Error(input.error);
    const resolved: ResolvedRoute = {
      candidates: [{ venue: "morpho", chainId: CHAIN_SEPOLIA, marketId: MARKET_ID, collateral: "AAPLt", collateralDecimals: 8, loanDecimals: 6, borrowRateWad: 4n * 10n ** 16n, lltvWad: 625n * 10n ** 15n, availableLiquidity: 6_594_679n, protection: "pre-liquidation", gate: "OPEN", feedPrice8: PRICE8, twapPrice8: null, pricesAroundTheClock: false }],
      policy: { allowed: true, maxLtvWad: 5n * 10n ** 17n, minDraw: 1_000_000n, maxDraw: 100_000_000n, exposureHeadroom: 10n ** 12n },
      policySource: "test",
      deskPolicyVersion: 1,
      blockNumber: 1n,
      notes: [],
    };
    const p = makePlan(input, resolved, null, CHAIN_SEPOLIA, DESK, NOW);
    expect(p.typedData).not.toBeNull();
    expect(routePlanDigest(p.typedData!)).toBe(hashTypedData(p.typedData! as unknown as Parameters<typeof hashTypedData>[0]));
    expect(p.planHash).toBe(keccak256(stringToHex(canonicalRoutePlan(p.plan))));
  });
});

/** The JSON typed data back to viem's shape (uint fields as bigints). */
function typedDataFromJson(td: { domain: { chainId: number; verifyingContract: string; name: string; version: string }; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, string> }) {
  const { EIP712Domain: _d, ...types } = td.types;
  const message = Object.fromEntries(
    Object.entries(td.message).map(([k, v]) => {
      const t = types.RoutePlan?.find((f) => f.name === k)?.type ?? "string";
      return [k, t.startsWith("uint") ? BigInt(v) : v];
    }),
  );
  return { domain: { ...td.domain, verifyingContract: td.domain.verifyingContract as Address }, types, primaryType: "RoutePlan" as const, message } as unknown as Parameters<typeof hashTypedData>[0];
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

void KEY;
