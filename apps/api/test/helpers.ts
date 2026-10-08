import type { Address, Hex } from "viem";
import { createApp, toPartnerId, type AppDeps } from "../src/app.js";
import { sha256Hex } from "../src/auth.js";
import { createMemoryStore, SQL, type Db, type DbStatement } from "../src/db.js";
import { ZERO_ADDRESS, type DeskLine, type DeskMarket, type DeskPartner, type DeskQuote, type DeskReader, type DeskTickerPolicy } from "../src/desk.js";
import type { MarketConfig } from "../src/policy.js";
import { lineAuthorizationDigest, lineAuthorizationTypedData } from "../src/typed-data.js";
import type { Facilitator, FacilitatorRequest, SettleResponse, VerifyResponse, X402Config } from "../src/x402.js";

export const CHAIN_ID = 84532;
export const DESK: Address = "0x1000000000000000000000000000000000000001";
export const ADMIN: Address = "0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E";
export const USER: Address = "0xB789aD318945B37566E2549F65526Cc269a482Fc";
export const AAPLT: Address = "0xB2000000000000000000000E063E65377cA34141";
export const NVDAT: Address = "0xB200000000000000000000AEd76Eae58870E2ae6";
export const MARKET_ID: Hex = "0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047";
export const NVDA_MARKET_ID: Hex = "0x7cb7fcc828a7296f8ea18256e0f5763a5588cfe22df9c943088021c762e58cc9";
export const PRE_LIQ: Address = "0xdcae709341aab652144e8afcb47479fe49e133a1";
export const PROTECTOR: Address = "0x5c546946c909718040dd686f63df6cb5e4df442c";
export const PARTNER_ID: Hex = toPartnerId("boundline-app") as Hex;
export const OTHER_PARTNER_ID: Hex = toPartnerId("someone-else") as Hex;
export const ZERO32: Hex = `0x${"0".repeat(64)}`;
export const KEY = "bl_test_key_for_boundline_app";
export const NOW = 1_791_040_000;
export const PAY_TO: Address = "0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E";
export const USDC_SEPOLIA: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** The markets the test desk serves: AAPLt with protected mode, NVDAt without. */
export const MARKETS: MarketConfig[] = [
  { symbol: "AAPLt", collateral: AAPLT, marketId: MARKET_ID, preLiquidation: PRE_LIQ, protector: PROTECTOR, targetLtvWad: 580_000_000_000_000_000n },
  { symbol: "NVDAt", collateral: NVDAT, marketId: NVDA_MARKET_ID },
];

export function sampleQuote(over: Partial<DeskQuote> = {}): DeskQuote {
  return {
    reason: 0,
    session: 2, // REGULAR
    price8: 33_366_495_000n,
    collateralRaw: 1_000_000_000n, // 10 AAPLt
    collateralValue: 3_336_649_500n, // 3,336.6495 USDC
    debt: 0n,
    maxDebt: 1_835_157_225n, // 55% of the value
    available: 1_835_157_225n,
    effectiveMaxLtvWad: 550_000_000_000_000_000n,
    corporateActionHaircut: false,
    ...over,
  };
}

export function sampleLine(over: Partial<DeskLine> = {}): DeskLine {
  return {
    partnerId: PARTNER_ID,
    user: USER,
    marketId: MARKET_ID,
    collateral: AAPLT,
    policyVersion: 3,
    status: 1, // OPEN
    holdReason: ZERO32,
    openedAt: 1_791_038_000n,
    drawnPrincipal: 0n,
    ...over,
  };
}

export function samplePartner(over: Partial<DeskPartner> = {}): DeskPartner {
  return { admin: ADMIN, signer: ZERO_ADDRESS, eligibility: ZERO_ADDRESS, active: true, policyVersion: 3, exposureCap: 0n, exposure: 0n, ...over };
}

export function sampleTickerPolicy(over: Partial<DeskTickerPolicy> = {}): DeskTickerPolicy {
  return { allowed: true, maxLtvWad: 500_000_000_000_000_000n, minDraw: 1_000_000n, maxDraw: 100_000_000n, exposureCap: 500_000_000n, exposure: 3_000_000n, ...over };
}

export function sampleMarket(over: Partial<DeskMarket> = {}): DeskMarket {
  return {
    loanToken: USDC_SEPOLIA,
    collateralToken: AAPLT,
    oracle: "0x1589aAb40fF0b2E0C4c679e70865eb97A24e5854",
    irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    lltv: 625_000_000_000_000_000n,
    collateralDecimals: 8,
    loanDecimals: 6,
    enabled: true,
    ...over,
  };
}

/** ABI-encodes a Protector.Sizing (18 words) the way the contract returns it. */
export function encodeSizingReturn(over: Partial<Record<string, bigint | boolean | number>> = {}): Hex {
  const v = {
    standing: 2n, // BELOW_BAND
    collateral: 1_000_000_000n,
    borrowShares: 2_800_000_376_176n,
    debtAssets: 2_800_132n,
    shadowPrice36: 3_362_849_999_900_000_000_000_000_000_000_000_000n,
    venuePrice36: 3_362_849_999_900_000_000_000_000_000_000_000_000n,
    venueOracleLive: true,
    shadowLtvWad: 832_666_339_810_776n,
    venueLtvWad: 832_666_339_810_776n,
    preLifWad: 0n,
    preLcfWad: 0n,
    targetLtvWad: 580_000_000_000_000_000n,
    maxSeizedAssets: 0n,
    maxRepaidShares: 0n,
    maxRepaidAssets: 0n,
    fullCloseAllowed: false,
    fullCloseSeizedAssets: 0n,
    fullCloseRepaidAssets: 0n,
    ...over,
  };
  const word = (x: bigint | boolean | number) => (typeof x === "boolean" ? (x ? 1n : 0n) : BigInt(x)).toString(16).padStart(64, "0");
  return `0x${Object.values(v).map(word).join("")}` as Hex;
}

/** A desk whose every read succeeds with the samples; override any method. */
export function makeDesk(over: Partial<DeskReader> = {}): DeskReader {
  return {
    address: DESK,
    chainId: CHAIN_ID,
    blockNumber: async () => 47_635_000n,
    quote: async () => sampleQuote(),
    line: async () => sampleLine(),
    obligationStatus: async () => 1,
    partner: async () => samplePartner(),
    tickerPolicy: async () => sampleTickerPolicy(),
    market: async () => sampleMarket(),
    nonces: async () => 0n,
    lineOf: async () => 1n,
    lineAuthorizationDigest: async (partnerId, user, marketId, nonce, deadline) =>
      lineAuthorizationDigest(lineAuthorizationTypedData({ chainId: CHAIN_ID, desk: DESK, partnerId, user, marketId, nonce, deadline })),
    ethCall: async () => encodeSizingReturn(),
    ...over,
  };
}

/** In-memory D1 that understands exactly the statements in SQL. */
export function fakeD1(): Db & { tables: Record<string, Record<string, unknown>[]> } {
  const tables: Record<string, Record<string, unknown>[]> = { partners: [], idempotency: [], quotes: [], lines: [], policy_versions: [], route_plans: [], partner_settings: [] };
  const t = (name: string) => tables[name] as Record<string, unknown>[];
  const byRecency = (x: Record<string, unknown>, y: Record<string, unknown>) =>
    Number(y.first_seen) - Number(x.first_seen) || Number(BigInt(y.line_id as string) - BigInt(x.line_id as string));
  function exec(sql: string, a: unknown[]): Record<string, unknown>[] {
    switch (sql) {
      case SQL.FIND_PARTNER:
        return t("partners").filter((r) => r.api_key_hash === a[0]);
      case SQL.SET_PARTNER_POLICY_VERSION:
        for (const r of t("partners")) if (r.partner_id === a[0]) r.policy_version = a[1];
        return [];
      case SQL.GET_IDEMPOTENT:
        return t("idempotency").filter((r) => r.partner_id === a[0] && r.key === a[1]);
      case SQL.PUT_IDEMPOTENT: {
        tables.idempotency = t("idempotency").filter((r) => !(r.key === a[0] && r.partner_id === a[1]));
        t("idempotency").push({ key: a[0], partner_id: a[1], request_hash: a[2], status: a[3], response_json: a[4], created_at: a[5] });
        return [];
      }
      case SQL.SAVE_QUOTE:
        if (!t("quotes").some((r) => r.quote_hash === a[0])) {
          t("quotes").push({ quote_hash: a[0], partner_id: a[1], request_json: a[2], response_json: a[3], created_at: a[4] });
        }
        return [];
      case SQL.REMEMBER_LINE:
        if (!t("lines").some((r) => r.line_id === a[0])) {
          t("lines").push({ line_id: a[0], partner_id: a[1], user: a[2], market_id: a[3], first_seen: a[4] });
        }
        return [];
      case SQL.LIST_LINES:
        return t("lines").filter((r) => r.partner_id === a[0]).sort(byRecency).slice(0, Number(a[1]));
      case SQL.LIST_LINES_BY_USER:
        return t("lines").filter((r) => String(r.user).toLowerCase() === String(a[0]).toLowerCase()).sort(byRecency).slice(0, Number(a[1]));
      case SQL.SAVE_POLICY_VERSION:
        t("policy_versions").push({ id: a[0], partner_id: a[1], status: a[2], note: a[3], changes_json: a[4], calls_json: a[5], policy_version_before: a[6], policy_version_after: a[7], tx_hash: a[8], created_at: a[9], applied_at: a[10] });
        return [];
      case SQL.GET_POLICY_VERSION:
        return t("policy_versions").filter((r) => r.partner_id === a[0] && r.id === a[1]);
      case SQL.LIST_POLICY_VERSIONS:
        return t("policy_versions")
          .filter((r) => r.partner_id === a[0])
          .sort((x, y) => Number(y.created_at) - Number(x.created_at) || (String(y.id) > String(x.id) ? 1 : -1))
          .slice(0, Number(a[1]));
      case SQL.MARK_POLICY_VERSION_APPLIED:
        for (const r of t("policy_versions")) {
          if (r.partner_id === a[0] && r.id === a[1]) Object.assign(r, { status: "applied", policy_version_after: a[2], tx_hash: a[3], applied_at: a[4] });
        }
        return [];
      case SQL.GET_LINE:
        return t("lines").filter((r) => r.line_id === a[0]);
      case SQL.SAVE_ROUTE_PLAN:
        if (!t("route_plans").some((r) => r.plan_hash === a[0])) {
          t("route_plans").push({ plan_hash: a[0], partner_id: a[1], line_id: a[2], chain_id: a[3], plan_json: a[4], typed_data_json: a[5], digest: a[6], signature: a[7], signer: a[8], created_at: a[9] });
        }
        return [];
      case SQL.LATEST_ROUTE_PLAN_FOR_LINE:
        return t("route_plans")
          .filter((r) => r.partner_id === a[0] && r.line_id === a[1])
          .sort((x, y) => Number(y.created_at) - Number(x.created_at) || (String(y.plan_hash) > String(x.plan_hash) ? 1 : -1))
          .slice(0, 1);
      case SQL.GET_PARTNER_SETTINGS:
        return t("partner_settings").filter((r) => r.partner_id === a[0]);
      case SQL.PUT_PARTNER_SETTINGS:
        tables.partner_settings = t("partner_settings").filter((r) => r.partner_id !== a[0]);
        t("partner_settings").push({ partner_id: a[0], saturday_json: a[1], version_id: a[2], updated_at: a[3] });
        return [];
      default:
        throw new Error(`fakeD1: unexpected SQL ${sql}`);
    }
  }
  return {
    tables,
    prepare(sql: string): DbStatement {
      let args: unknown[] = [];
      const stmt: DbStatement = {
        bind(...values) {
          args = values;
          return stmt;
        },
        async first<T>() {
          return (exec(sql, args)[0] as T | undefined) ?? null;
        },
        async all<T>() {
          return { results: exec(sql, args) as T[] };
        },
        async run() {
          exec(sql, args);
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

export const X402_CFG: X402Config = {
  payTo: PAY_TO,
  network: "base-sepolia",
  caip2: "eip155:84532",
  asset: USDC_SEPOLIA,
  assetName: "USDC",
  assetVersion: "2",
  amount: "10000",
  priceUsdc: "0.01",
  maxTimeoutSeconds: 300,
  serviceName: "Boundline partner API",
  description: "test resource",
};

/** A facilitator that records what it was asked and answers from the given responses. */
export function fakeFacilitator(over: { verify?: VerifyResponse | Error; settle?: SettleResponse | Error } = {}): Facilitator & { calls: { kind: "verify" | "settle"; req: FacilitatorRequest }[] } {
  const calls: { kind: "verify" | "settle"; req: FacilitatorRequest }[] = [];
  const verify = over.verify ?? { isValid: true, payer: USER };
  const settle = over.settle ?? { success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:84532", payer: USER };
  return {
    calls,
    async verify(req) {
      calls.push({ kind: "verify", req });
      if (verify instanceof Error) throw verify;
      return verify;
    },
    async settle(req) {
      calls.push({ kind: "settle", req });
      if (settle instanceof Error) throw settle;
      return settle;
    },
  };
}

export interface TestWorld {
  deps: AppDeps;
  store: ReturnType<typeof createMemoryStore>;
  app: ReturnType<typeof createApp>;
  clock: { now: number };
}

/** An app over a memory store with one registered partner (KEY, PARTNER_ID, policy version 3) and the two test markets. */
export async function world(over: Partial<AppDeps> = {}): Promise<TestWorld> {
  const store = createMemoryStore();
  store.partners.push({ partnerId: PARTNER_ID, name: "Boundline app", apiKeyHash: await sha256Hex(KEY), policyVersion: 3, createdAt: NOW - 1000 });
  const clock = { now: NOW };
  let n = 0;
  const deps: AppDeps = {
    store,
    desk: makeDesk(),
    chainId: CHAIN_ID,
    now: () => clock.now,
    uuid: () => `uuid-${++n}`,
    markets: MARKETS,
    ...over,
  };
  return { deps, store, app: createApp(deps), clock };
}

export interface CallOptions {
  key?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function call(app: ReturnType<typeof createApp>, method: string, path: string, opts: CallOptions = {}) {
  const headers = new Headers(opts.headers ?? {});
  if (opts.key !== null) headers.set("authorization", `Bearer ${opts.key ?? KEY}`);
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  const res = await app.request(path, init);
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { res, json: json as Record<string, any>, text };
}
