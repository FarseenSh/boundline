import type { Address, Hex } from "viem";
import { createApp, toPartnerId, type AppDeps } from "../src/app.js";
import { sha256Hex } from "../src/auth.js";
import { createMemoryStore, SQL, type Db, type DbStatement } from "../src/db.js";
import { ZERO_ADDRESS, type DeskLine, type DeskPartner, type DeskQuote, type DeskReader } from "../src/desk.js";
import { lineAuthorizationDigest, lineAuthorizationTypedData } from "../src/typed-data.js";

export const CHAIN_ID = 84532;
export const DESK: Address = "0x1000000000000000000000000000000000000001";
export const ADMIN: Address = "0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E";
export const USER: Address = "0xB789aD318945B37566E2549F65526Cc269a482Fc";
export const AAPLT: Address = "0xB2000000000000000000000E063E65377cA34141";
export const MARKET_ID: Hex = "0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047";
export const PARTNER_ID: Hex = toPartnerId("boundline-app") as Hex;
export const OTHER_PARTNER_ID: Hex = toPartnerId("someone-else") as Hex;
export const ZERO32: Hex = `0x${"0".repeat(64)}`;
export const KEY = "bl_test_key_for_boundline_app";
export const NOW = 1_791_040_000;

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
    nonces: async () => 0n,
    lineOf: async () => 1n,
    lineAuthorizationDigest: async (partnerId, user, marketId, nonce, deadline) =>
      lineAuthorizationDigest(lineAuthorizationTypedData({ chainId: CHAIN_ID, desk: DESK, partnerId, user, marketId, nonce, deadline })),
    ...over,
  };
}

/** In-memory D1 that understands exactly the statements in SQL. */
export function fakeD1(): Db & { tables: Record<string, Record<string, unknown>[]> } {
  const tables: Record<string, Record<string, unknown>[]> = { partners: [], idempotency: [], quotes: [], lines: [] };
  const t = (name: string) => tables[name] as Record<string, unknown>[];
  function exec(sql: string, a: unknown[]): Record<string, unknown>[] {
    switch (sql) {
      case SQL.FIND_PARTNER:
        return t("partners").filter((r) => r.api_key_hash === a[0]);
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
        return t("lines")
          .filter((r) => r.partner_id === a[0])
          .sort((x, y) => Number(y.first_seen) - Number(x.first_seen) || Number(BigInt(y.line_id as string) - BigInt(x.line_id as string)))
          .slice(0, Number(a[1]));
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

export interface TestWorld {
  deps: AppDeps;
  store: ReturnType<typeof createMemoryStore>;
  app: ReturnType<typeof createApp>;
  clock: { now: number };
}

/** An app over a memory store with one registered partner (KEY, PARTNER_ID, policy version 3). */
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
