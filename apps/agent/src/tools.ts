// The six tools. Each takes its I/O through `Deps` so the tests run with fakes; the Worker (index.ts) wires the
// service bindings and the RPC lists.
import { canonicalRoutePlan, route, routePlanTypedData, type PartnerPolicy, type RoutePlan, type SaturdayMode } from "@boundline/router";
import { buildCandidates, readRates, SEPOLIA_MARKETS, type ObservatoryMarket, type ObservatoryToken } from "./candidates.js";
import type { ToolHandler } from "./mcp.js";

export interface Deps {
  /** GET on a bound service: path like "/v1/sessions"; returns the parsed JSON or throws. */
  observatory(path: string): Promise<unknown>;
  keeper(path: string): Promise<unknown>;
  indexer(path: string): Promise<unknown>;
  /** The partner API with the Worker's partner key; `init.body` is JSON; returns { status, body }. */
  api(path: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<{ status: number; body: unknown }>;
  rpcs: { mainnet: readonly string[]; sepolia: readonly string[] };
  fetchImpl: typeof fetch;
  uuid(): string;
  now(): number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[0-9]+$/;

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`${key} is required`);
    return "";
  }
  return String(v);
}

function decimal(args: Record<string, unknown>, key: string): bigint {
  const v = str(args, key);
  if (!DECIMAL.test(v)) throw new Error(`${key} must be a decimal string of base units`);
  return BigInt(v);
}

function address(args: Record<string, unknown>, key: string): string {
  const v = str(args, key);
  if (!ADDRESS.test(v)) throw new Error(`${key} must be 0x + 40 hex`);
  return v;
}

export function makeTools(deps: Deps): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const add = (t: ToolHandler) => tools.set(t.definition.name, t);

  add({
    definition: {
      name: "session",
      description: "The current NYSE session on Base (PRE, REGULAR, POST, OVERNIGHT, WEEKEND, HOLIDAY), whether the Coinbase stock feeds are live, and the next feed transition. Source: the Boundline Observatory.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    run: () => deps.observatory("/v1/sessions"),
  });

  add({
    definition: {
      name: "positions",
      description: "Real borrower positions on the Base mainnet B20 credit venues with venue health versus shadow health at the 24/7 DEX TWAP and a protection flag. venue: morpho (default) or aave.",
      inputSchema: { type: "object", properties: { venue: { type: "string", enum: ["morpho", "aave"] } }, additionalProperties: false },
    },
    run: (args) => deps.observatory(str(args, "venue", false) === "aave" ? "/v1/venues/aave/positions" : "/v1/positions"),
  });

  add({
    definition: {
      name: "shadowHealth",
      description: "Shadow health for one address: its Boundline lines with the desk quote and the Protector's standing (BELOW_BAND, IN_BAND, ABOVE_LLTV) on Base Sepolia through the partner API, and its mainnet venue positions through the Observatory. Decision PROTECT / ALLOW / UNKNOWN.",
      inputSchema: { type: "object", properties: { address: { type: "string", description: "0x + 40 hex" } }, required: ["address"], additionalProperties: false },
    },
    run: async (args) => {
      const addr = address(args, "address");
      const [api, obs] = await Promise.all([
        deps.api(`/v1/positions/${addr}/shadow`).catch((err: unknown) => ({ status: 0, body: { error: err instanceof Error ? err.message : String(err) } })),
        deps.observatory(`/v1/positions/${addr}/shadow`).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) })),
      ]);
      return { address: addr, sepolia: api.status === 200 ? api.body : { unavailable: api.status, body: api.body }, mainnet: obs };
    },
  });

  add({
    definition: {
      name: "quote",
      description: "Quote a draw on a Boundline credit line (Base Sepolia): reason code, session, price, collateral value, debt, capacity, effective max LTV and the quote hash. draw in USDC base units (6 decimals) as a decimal string; 0 for capacity only.",
      inputSchema: { type: "object", properties: { lineId: { type: "string" }, draw: { type: "string", description: "USDC base units, decimal string" } }, required: ["lineId"], additionalProperties: false },
    },
    run: async (args) => {
      const lineId = decimal(args, "lineId").toString();
      const draw = (args.draw === undefined ? 0n : decimal(args, "draw")).toString();
      const r = await deps.api("/v1/quotes", { method: "POST", body: { lineId, draw } });
      return { status: r.status, quote: r.body };
    },
  });

  add({
    definition: {
      name: "protect",
      description: "What the Boundline keeper would do right now for every watched borrower: the Protector's on-chain sizing (standing, shadow and venue LTV, the largest partial, whether a close-out may run) and the decision it arms as a validity transaction. Read-only.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    run: () => deps.keeper("/v1/protect"),
  });

  add({
    definition: {
      name: "route",
      description: "Route a draw: choose the venue and market for a user's collateral by borrow rate, effective LTV, liquidity, protection and session state, and return the deterministic route plan (chosen leg, alternatives, every rejection with its reason) with its canonical JSON and EIP-712 typed data. collateral: a Coinbase stock symbol (AAPLc, NVDAc, …) for the mainnet Morpho markets or a Boundline test stock (AAPLt, NVDAt, TSLAt) for the session-safe Sepolia markets. collateralAmount in 8-decimal base units, amount in USDC base units.",
      inputSchema: {
        type: "object",
        properties: {
          user: { type: "string" },
          collateral: { type: "string" },
          collateralAmount: { type: "string", description: "8-decimal base units" },
          amount: { type: "string", description: "USDC base units" },
          maxLtvBps: { type: "integer", description: "partner policy max LTV in bps (default 5500)" },
          minDraw: { type: "string", description: "USDC base units (default 1000000 = 1 USDC)" },
          preferProtection: { type: "boolean" },
          saturdayMode: { type: "object", properties: { enabled: { type: "boolean" }, haircutBps: { type: "integer" } } },
        },
        required: ["user", "collateral", "collateralAmount", "amount"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const user = address(args, "user");
      const collateral = str(args, "collateral");
      const collateralAmount = decimal(args, "collateralAmount");
      const amount = decimal(args, "amount");
      const maxLtvBps = args.maxLtvBps === undefined ? 5500 : Number(args.maxLtvBps);
      if (!Number.isInteger(maxLtvBps) || maxLtvBps <= 0 || maxLtvBps >= 10_000) throw new Error("maxLtvBps must be an integer in (0, 10000)");
      const minDraw = args.minDraw === undefined ? 1_000_000n : decimal(args, "minDraw");
      const saturdayMode = args.saturdayMode && typeof args.saturdayMode === "object" ? (args.saturdayMode as SaturdayMode) : undefined;
      const policy: PartnerPolicy = { allowed: true, maxLtvWad: BigInt(maxLtvBps) * 10n ** 14n, minDraw, maxDraw: 0n, exposureHeadroom: 10n ** 30n };

      const [tokensRes, marketsRes] = await Promise.all([deps.observatory("/v1/tokens"), deps.observatory("/v1/venues/morpho/markets")]);
      const tokens = ((tokensRes as { tokens?: ObservatoryToken[] }).tokens ?? []) as ObservatoryToken[];
      const mainnetMarkets = ((marketsRes as { markets?: ObservatoryMarket[] }).markets ?? []) as ObservatoryMarket[];
      const isSepolia = SEPOLIA_MARKETS.some((m) => m.collateral === collateral);
      const ids = isSepolia ? SEPOLIA_MARKETS.filter((m) => m.collateral === collateral).map((m) => m.id) : mainnetMarkets.filter((m) => m.collateral.symbol === collateral).map((m) => m.id);
      const rates = await readRates(isSepolia ? deps.rpcs.sepolia : deps.rpcs.mainnet, ids, deps.fetchImpl).catch((err: unknown) => {
        return ids.map((id) => ({ id, borrowRateWad: 0n, availableLiquidity: 0n, lltvWad: 0n, collateralToken: "", error: err instanceof Error ? err.message : String(err) }));
      });
      const { candidates, notes } = buildCandidates(collateral, { tokens, mainnetMarkets, mainnetRates: isSepolia ? [] : rates, sepoliaRates: isSepolia ? rates : [] });
      const plan: RoutePlan = route({ user, collateral, collateralAmount, collateralDecimals: 8, amount, policy, now: deps.now(), ...(saturdayMode ? { saturdayMode } : {}), ...(args.preferProtection === undefined ? {} : { preferProtection: Boolean(args.preferProtection) }) }, candidates);
      const chainId = isSepolia ? 84532 : 8453;
      const typedData = plan.chosen ? routePlanTypedData(plan, chainId, "0x0000000000000000000000000000000000000000") : null;
      return {
        plan,
        candidates: candidates.length,
        notes,
        canonical: canonicalRoutePlan(plan),
        typedData,
        signature: null,
        signing: "the partner API signs route plans when they are stored on an obligation; this surface is read-only",
      };
    },
  });

  return tools;
}
