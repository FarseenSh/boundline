import { Hono, type Context } from "hono";
import { PatternRouter } from "hono/router/pattern-router";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { encodeFunctionData, getAddress, hexToString, isAddress, isHex, stringToHex, type Address, type Hex } from "viem";
import { creditDeskAbi } from "./abi/creditDesk.js";
import { authenticate } from "./auth.js";
import type { PartnerRecord, PolicyVersionRecord, Store } from "./db.js";
import { ZERO_ADDRESS, type DeskLine, type DeskQuote, type DeskReader } from "./desk.js";
import { getDrill, listDrills } from "./drills.js";
import { sealEvidence } from "./evidence.js";
import { requestHash, runIdempotent } from "./idempotency.js";
import { LINE_STATUSES, OBLIGATION_STATUSES, REASONS, SESSIONS, enumName } from "./names.js";
import { diffPolicy, parseVersionInput, readPolicy, type MarketConfig, type PolicyView } from "./policy.js";
import { canonicalJson, quoteHash } from "./quote-hash.js";
import { decodeSizing, encodeSizing, type Sizing } from "./raw.js";
import { formatUsdc, parseBaseUnits, roundDownToCents, roundUpToCents } from "./rounding.js";
import { lineAuthorizationDigest, lineAuthorizationTypedData, typedDataJson } from "./typed-data.js";
import { x402Middleware, type Facilitator, type X402Config } from "./x402.js";
import { CHAIN_MAINNET, CHAIN_SEPOLIA, effectiveSaturday, mainnetRoute, makePlan, parseRouteInput, sepoliaRoute, typedDataJson as routeTypedDataJson, type ResolvedRoute, type SepoliaRouteDeps } from "./route.js";
import type { RouteSigner } from "./route-signer.js";
import { applyRoutingChanges, DEFAULT_SATURDAY_MODE, parseSaturdayJson, type SaturdayModePolicy } from "./policy.js";
import {
  MAX_WEBHOOKS_PER_PARTNER,
  POLL_SOURCES,
  pollSource,
  retryDue,
  deliveryJson,
  echoJson,
  eventJson,
  ingest,
  newWebhookSecret,
  parseWebhookBody,
  receiveEcho,
  validEchoToken,
  webhookJson,
  type IndexerGet,
  type LineHead,
  type WebhookRuntime,
  type WebhookStore,
} from "./webhooks.js";

export interface AppDeps {
  store: Store;
  /** Null until the desk is deployed: every route that needs it answers 503. */
  desk: DeskReader | null;
  chainId: number;
  /** Unix seconds. */
  now: () => number;
  uuid: () => string;
  indexerUrl?: string;
  fetchImpl?: typeof fetch;
  serviceName?: string;
  /** The desk's markets (symbol, collateral, market id, protection contracts); empty means no policy or shadow rows. */
  markets?: readonly MarketConfig[];
  /** x402 metering of the public routes for callers without a partner key; null or absent turns it off (401 as before). */
  x402?: { cfg: X402Config; facilitator: Facilitator } | null;
  /** POST /v1/route: reads for Base Sepolia (desk, gate, Morpho) and Base mainnet (the Observatory); absent → 501. */
  route?: { sepolia: SepoliaRouteDeps | null; mainnet: { observatory: (path: string) => Promise<unknown>; rpcs: readonly string[]; fetchImpl: typeof fetch } | null };
  /** Signs route plans when the secret ROUTE_SIGNER_KEY exists; null → plans go out unsigned and say so. */
  routeSigner?: RouteSigner | null;
  /** Webhooks and the partner event log; absent → the webhook routes answer 501. */
  webhookStore?: WebhookStore;
  /** Hosts this API answers on: a delivery to one of them is dispatched to the app itself (a Worker fetching its own workers.dev URL gets Cloudflare error 1042). */
  selfHosts?: readonly string[];
  /** Outside webhook deliveries; defaults to the global fetch (an external service, never a binding). */
  deliveryFetch?: typeof fetch;
  /** The desk's line head for a line this API has not seen (webhook attribution, route plans for a line). */
  readLine?: (lineId: bigint) => Promise<LineHead | null>;
  /** Work after the response; the Worker passes ctx.waitUntil, tests collect the promises. */
  defer?: (p: Promise<unknown>) => void;
}

/** Features `/health` advertises; the keeper binds the `Events` entrypoint only once "events-entrypoint" is listed. */
export const FEATURES = ["route", "webhooks", "events-entrypoint", "saturday-mode"] as const;

/** One GET against the indexer (service binding when bound); null when no indexer is configured. */
export function makeIndexerGet(deps: Pick<AppDeps, "indexerUrl" | "fetchImpl">): IndexerGet {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return async (path) => {
    if (!deps.indexerUrl) return null;
    const url = `${deps.indexerUrl.replace(/\/+$/, "")}${path}`;
    try {
      const res = await fetchImpl(url);
      if (!res.ok) return { ok: false, status: res.status, detail: `indexer answered ${res.status}` };
      return { ok: true, data: (await res.json()) as unknown };
    } catch (err) {
      return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
    }
  };
}

/** The webhook engine over the app's deps; `appFetch` serves deliveries addressed to this API itself. */
export function makeWebhookRuntime(deps: AppDeps, appFetch: (req: Request) => Promise<Response>, defer: (p: Promise<unknown>) => void): WebhookRuntime | null {
  if (!deps.webhookStore) return null;
  const selfHosts = new Set((deps.selfHosts ?? []).map((h) => h.toLowerCase()));
  const outside = deps.deliveryFetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  return {
    store: deps.webhookStore,
    lines: deps.store,
    ...(deps.readLine ? { readLine: deps.readLine } : {}),
    now: deps.now,
    uuid: deps.uuid,
    send: (url, init) => {
      let host = "";
      try {
        host = new URL(url).host.toLowerCase();
      } catch {
        // an invalid URL fails in fetch below with a clear error
      }
      return selfHosts.has(host) ? appFetch(new Request(url, init)) : outside(url, init);
    },
    defer,
    log: (line) => console.log(line),
  };
}

type Vars = { correlationId: string; partner: PartnerRecord; metered: boolean };
type Ctx = Context<{ Variables: Vars }>;
interface Out {
  status: number;
  body: Record<string, unknown>;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** The Protector's sizing target when the market config gives none: the AAPLt pre-liquidation's preLltv. */
const DEFAULT_TARGET_LTV_WAD = 580_000_000_000_000_000n;
/** Lines whose decision timelines the evidence export carries, and events per line. */
const EXPORT_TIMELINE_LINES = 10;
const EXPORT_TIMELINE_EVENTS = 100;

/** Routes metered by x402 when the caller has no partner key. */
export function isMeteredRoute(method: string, path: string): boolean {
  if (method === "POST" && path === "/v1/quotes") return true;
  if (method === "POST" && path === "/v1/route") return true;
  if (method === "GET" && /^\/v1\/positions\/0x[0-9a-fA-F]{40}\/shadow$/.test(path)) return true;
  return false;
}

/** bytes32 hex as is (lowercased), or a short string left-aligned and zero-padded the way the desk scripts do it. */
export function toPartnerId(value: unknown): Hex | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (BYTES32.test(value)) return value.toLowerCase() as Hex;
  if (isHex(value)) return null;
  const bytes = new TextEncoder().encode(value);
  return bytes.length <= 32 ? (stringToHex(value, { size: 32 }).toLowerCase() as Hex) : null;
}

function isBytes32(value: unknown): value is Hex {
  return typeof value === "string" && BYTES32.test(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] ?? err.message : String(err);
}

function isUnknownLine(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /UnknownLine/.test(text);
}

/** Every numeric field present and of the right type: anything else fails closed. */
export function validQuote(q: Partial<DeskQuote> | null | undefined): q is DeskQuote {
  if (!q) return false;
  const bigs: (keyof DeskQuote)[] = ["price8", "collateralRaw", "collateralValue", "debt", "maxDebt", "available", "effectiveMaxLtvWad"];
  if (!bigs.every((k) => typeof q[k] === "bigint" && (q[k] as bigint) >= 0n)) return false;
  if (typeof q.reason !== "number" || typeof q.session !== "number") return false;
  if (enumName(REASONS, q.reason) === "UNKNOWN" || enumName(SESSIONS, q.session) === "UNKNOWN") return false;
  return typeof q.corporateActionHaircut === "boolean";
}

function money(x: bigint): { baseUnits: string; usdc: string } {
  return { baseUnits: x.toString(), usdc: formatUsdc(x) };
}

function wadRatio(x: bigint): { wad: string; ratio: number } {
  return { wad: x.toString(), ratio: Number(x) / 1e18 };
}

/** The chain-derived part of a quote response: this is what the quote hash covers. */
export function quoteCore(lineId: bigint, line: DeskLine, q: DeskQuote, draw: bigint): Record<string, unknown> {
  const capacity = roundDownToCents(q.available);
  const protectionFee = roundUpToCents(0n); // no charge is billed today; the helper and the rounding rule stay in place
  return {
    lineId: lineId.toString(),
    partnerId: line.partnerId,
    user: line.user,
    marketId: line.marketId,
    collateralToken: line.collateral,
    lineStatus: enumName(LINE_STATUSES, line.status),
    policyVersion: line.policyVersion,
    draw: draw.toString(),
    reason: enumName(REASONS, q.reason),
    refused: q.reason !== 0,
    session: enumName(SESSIONS, q.session),
    price: { answer8: q.price8.toString(), usd: Number(q.price8) / 1e8 },
    collateral: { raw: q.collateralRaw.toString(), value: money(q.collateralValue) },
    debt: money(q.debt),
    maxDebt: money(q.maxDebt),
    available: money(q.available),
    capacity: { ...money(capacity), rounding: "down to the cent" },
    charges: { protectionFee: { ...money(protectionFee), rounding: "up to the cent" } },
    effectiveMaxLtv: wadRatio(q.effectiveMaxLtvWad),
    corporateActionHaircut: q.corporateActionHaircut,
  };
}

/** The Protector's sizing as JSON (no bigints), with the decision the keeper would take. */
export function sizingJson(s: Sizing): Record<string, unknown> {
  return {
    standing: s.standing,
    collateral: s.collateral.toString(),
    borrowShares: s.borrowShares.toString(),
    debt: money(s.debtAssets),
    shadowPrice36: s.shadowPrice36.toString(),
    venuePrice36: s.venuePrice36.toString(),
    venueOracleLive: s.venueOracleLive,
    shadowLtv: wadRatio(s.shadowLtvWad),
    venueLtv: wadRatio(s.venueLtvWad),
    preLif: wadRatio(s.preLifWad),
    preLcf: wadRatio(s.preLcfWad),
    targetLtv: wadRatio(s.targetLtvWad),
    maxSeizedAssets: s.maxSeizedAssets.toString(),
    maxRepaidShares: s.maxRepaidShares.toString(),
    maxRepaidAssets: money(s.maxRepaidAssets),
    fullCloseAllowed: s.fullCloseAllowed,
    fullCloseSeizedAssets: s.fullCloseSeizedAssets.toString(),
    fullCloseRepaidAssets: money(s.fullCloseRepaidAssets),
    keeperAction:
      s.standing === "IN_BAND"
        ? s.maxSeizedAssets > 0n
          ? "partial pre-liquidation to the target LTV"
          : s.fullCloseAllowed
            ? "full close-out (no partial can pass on this market right now)"
            : "none feasible"
        : "none",
  };
}

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const { store, desk, chainId } = deps;
  const service = deps.serviceName ?? "boundline-api";
  const fetchImpl = deps.fetchImpl ?? fetch;
  const markets: readonly MarketConfig[] = deps.markets ?? [];
  // PatternRouter, not Hono's default SmartRouter: the default compiles one regular expression for every route on the
  // first request, measured at 26 ms of CPU (scripts/bench-cpu.ts, 8 Oct 2026), which a cold isolate on the Workers Free
  // plan (10 ms per invocation) cannot afford; PatternRouter's first match costs 0.2–0.3 ms and later ones are as fast.
  const app = new Hono<{ Variables: Vars }>({ router: new PatternRouter() });

  const fail = (c: Ctx, status: number, error: string, extra: Record<string, unknown> = {}) =>
    c.json({ error, ...extra, correlationId: c.get("correlationId") }, status as ContentfulStatusCode);

  app.use("*", async (c, next) => {
    const id = c.req.header("x-correlation-id")?.trim() || deps.uuid();
    c.set("correlationId", id);
    c.header("X-Correlation-Id", id);
    await next();
  });

  app.onError((err, c) => {
    console.error("unhandled", err);
    return c.json({ error: "internal error", detail: errorMessage(err), correlationId: c.get("correlationId") }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, service, features: FEATURES }));

  /** Partner keys authenticate; without one, a metered route runs the x402 flow and everything else is 401. */
  app.use("/v1/*", async (c, next) => {
    // The built-in demo receiver is where webhook deliveries land: they carry a signature, not a partner key.
    if (c.req.path.startsWith("/v1/webhooks/echo/")) return next();
    const header = c.req.header("authorization");
    if (!header) {
      if (deps.x402 && isMeteredRoute(c.req.method, c.req.path)) {
        c.set("metered", true);
        await next();
        return;
      }
      return fail(c, 401, "unauthorized", { hint: "Authorization: Bearer <partner key>" });
    }
    const partner = await authenticate(store, header);
    if (!partner) return fail(c, 401, "unauthorized", { hint: "Authorization: Bearer <partner key>" });
    c.set("partner", partner);
    c.set("metered", false);
    c.header("X-Policy-Version", String(partner.policyVersion));
    await next();
  });

  if (deps.x402) {
    const { cfg, facilitator } = deps.x402;
    app.use(
      "/v1/*",
      x402Middleware<{ Variables: Vars }>({
        cfg,
        facilitator,
        isMetered: (c) => (c as unknown as Ctx).get("metered") === true,
        correlationId: (c) => (c as unknown as Ctx).get("correlationId"),
        log: (line) => console.log(line),
      }),
    );
  }

  async function readJsonBody(c: Ctx): Promise<{ raw: string; body?: Record<string, unknown>; error?: string }> {
    const raw = await c.req.text();
    let body: unknown;
    try {
      body = raw.length ? JSON.parse(raw) : {};
    } catch {
      return { raw, error: "body is not JSON" };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return { raw, error: "body must be a JSON object" };
    return { raw, body: body as Record<string, unknown> };
  }

  function answer(c: Ctx, out: Out, extraHeaders: Record<string, string> = {}): Response {
    if (typeof out.body.policyVersion === "number") c.header("X-Policy-Version", String(out.body.policyVersion));
    if (typeof out.body.quoteHash === "string") c.header("X-Quote-Hash", out.body.quoteHash);
    for (const [k, v] of Object.entries(extraHeaders)) c.header(k, v);
    return c.json({ ...out.body, correlationId: c.get("correlationId") }, out.status as ContentfulStatusCode);
  }

  /** POST bodies run once per Idempotency-Key; the body's policyVersion and quoteHash become headers. */
  async function idempotent(c: Ctx, handler: (body: Record<string, unknown>) => Promise<Out>): Promise<Response> {
    const key = c.req.header("idempotency-key")?.trim();
    if (!key) return fail(c, 400, "missing Idempotency-Key header");
    const parsed = await readJsonBody(c);
    if (parsed.error || !parsed.body) return fail(c, 400, parsed.error ?? "bad body");
    const partner = c.get("partner");
    const hash = await requestHash(c.req.method, c.req.path, parsed.raw);
    const result = await runIdempotent(store, partner.partnerId, key, hash, deps.now(), () => handler(parsed.body as Record<string, unknown>));
    if (result.conflict) return fail(c, 422, "Idempotency-Key was already used with a different request");
    return answer(c, { status: result.status, body: result.body as Record<string, unknown> }, { "X-Idempotent-Replay": result.replayed ? "true" : "false" });
  }

  /** A metered POST: no partner, no idempotency store (every paid call is its own request). */
  async function direct(c: Ctx, handler: (body: Record<string, unknown>) => Promise<Out>): Promise<Response> {
    const parsed = await readJsonBody(c);
    if (parsed.error || !parsed.body) return fail(c, 400, parsed.error ?? "bad body");
    return answer(c, await handler(parsed.body));
  }

  /** Partner POSTs where a replay key is useful but not required (route plans, webhook registration). */
  function maybeIdempotent(c: Ctx, handler: (body: Record<string, unknown>) => Promise<Out>): Promise<Response> {
    return c.req.header("idempotency-key")?.trim() ? idempotent(c, handler) : direct(c, handler);
  }

  /** ctx.waitUntil when the request has an execution context; the deps hook in tests. */
  function deferFor(c: Ctx): (p: Promise<unknown>) => void {
    if (deps.defer) return deps.defer;
    return (p) => {
      try {
        c.executionCtx.waitUntil(p);
      } catch {
        void p;
      }
    };
  }

  // ------------------------------------------------------------------ lines

  async function prepareLine(partner: PartnerRecord, body: Record<string, unknown>): Promise<Out> {
    if (!desk) return { status: 503, body: { error: "desk not deployed" } };
    const partnerId = toPartnerId(body.partnerId);
    if (!partnerId) return { status: 400, body: { error: "partnerId must be bytes32 hex or a string of at most 32 bytes" } };
    if (partnerId !== partner.partnerId) return { status: 403, body: { error: "partnerId does not match the authenticated partner" } };
    if (typeof body.user !== "string" || !isAddress(body.user)) return { status: 400, body: { error: "user must be an address" } };
    const user: Address = getAddress(body.user);
    if (!isBytes32(body.marketId)) return { status: 400, body: { error: "marketId must be a bytes32 Morpho market id" } };
    const marketId = body.marketId.toLowerCase() as Hex;
    const deadline = parseBaseUnits(body.deadline);
    if (deadline === null || deadline <= BigInt(deps.now())) {
      return { status: 400, body: { error: "deadline must be a unix time in seconds, in the future" } };
    }
    try {
      const [p, nonce, existing] = await Promise.all([desk.partner(partnerId), desk.nonces(user), desk.lineOf(partnerId, user, marketId)]);
      if (p.admin === ZERO_ADDRESS) return { status: 404, body: { error: "partner is not registered on the desk", partnerId } };
      const typedData = lineAuthorizationTypedData({ chainId, desk: desk.address, partnerId, user, marketId, nonce, deadline });
      const local = lineAuthorizationDigest(typedData);
      const onchain = await desk.lineAuthorizationDigest(partnerId, user, marketId, nonce, deadline);
      if (local.toLowerCase() !== onchain.toLowerCase()) {
        return { status: 500, body: { error: "digest mismatch between the API and the desk", local, onchain } };
      }
      const signatureRequired = p.signer !== ZERO_ADDRESS;
      const data = encodeFunctionData({ abi: creditDeskAbi, functionName: "openLine", args: [partnerId, marketId, deadline, "0x"] });
      return {
        status: 200,
        body: {
          policyVersion: p.policyVersion,
          chainId,
          desk: desk.address,
          partnerId,
          partnerActive: p.active,
          user,
          marketId,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
          existingLineId: existing === 0n ? null : existing.toString(),
          signatureRequired,
          signer: signatureRequired ? p.signer : null,
          digest: onchain,
          typedData: typedDataJson(typedData),
          call: {
            to: desk.address,
            data,
            note: signatureRequired
              ? "replace the empty signature argument with the partner's 65-byte signature over `digest` before sending"
              : "send as is: the partner has no signer",
          },
          selfCustody: "the user sends this transaction; Boundline never signs or sends on a user's behalf",
        },
      };
    } catch (err) {
      return { status: 502, body: { error: "desk read failed", detail: errorMessage(err) } };
    }
  }

  app.post("/v1/lines", (c) => idempotent(c, (body) => prepareLine(c.get("partner"), body)));

  // ------------------------------------------------------------------ quotes

  /** `partner` is null on a metered (x402) request: the line is found by id or by the partnerId the caller names. */
  async function resolveLineId(partner: PartnerRecord | null, body: Record<string, unknown>): Promise<{ lineId?: bigint; out?: Out }> {
    if (body.lineId !== undefined) {
      const id = parseBaseUnits(body.lineId);
      if (id === null || id === 0n) return { out: { status: 400, body: { error: "lineId must be a positive integer" } } };
      return { lineId: id };
    }
    const partnerId = toPartnerId(body.partnerId);
    if (!partnerId) return { out: { status: 400, body: { error: "give lineId, or partnerId + user + marketId" } } };
    if (partner && partnerId !== partner.partnerId) return { out: { status: 403, body: { error: "partnerId does not match the authenticated partner" } } };
    if (typeof body.user !== "string" || !isAddress(body.user)) return { out: { status: 400, body: { error: "user must be an address" } } };
    if (!isBytes32(body.marketId)) return { out: { status: 400, body: { error: "marketId must be a bytes32 Morpho market id" } } };
    const id = await desk!.lineOf(partnerId, getAddress(body.user), body.marketId.toLowerCase() as Hex);
    if (id === 0n) return { out: { status: 404, body: { error: "no line for this partner, user and market" } } };
    return { lineId: id };
  }

  async function quoteLine(partner: PartnerRecord | null, body: Record<string, unknown>): Promise<Out> {
    if (!desk) return { status: 503, body: { error: "desk not deployed" } };
    const draw = parseBaseUnits(body.draw ?? "0");
    if (draw === null) return { status: 400, body: { error: "draw must be USDC base units as a decimal string" } };
    let lineId: bigint;
    try {
      const r = await resolveLineId(partner, body);
      if (r.out) return r.out;
      lineId = r.lineId!;
    } catch (err) {
      return { status: 409, body: { reason: "UNKNOWN", detail: errorMessage(err) } };
    }
    let line: DeskLine;
    let q: DeskQuote;
    let block: bigint;
    try {
      [line, q, block] = await Promise.all([desk.line(lineId), desk.quote(lineId, draw), desk.blockNumber()]);
    } catch (err) {
      if (isUnknownLine(err)) return { status: 404, body: { error: "unknown line", lineId: lineId.toString() } };
      return { status: 409, body: { reason: "UNKNOWN", detail: errorMessage(err) } };
    }
    if (partner && line.partnerId.toLowerCase() !== partner.partnerId) return { status: 404, body: { error: "unknown line", lineId: lineId.toString() } };
    if (!validQuote(q)) return { status: 409, body: { reason: "UNKNOWN", detail: "the desk returned an incomplete quote" } };
    const core = quoteCore(lineId, line, q, draw);
    const request = { lineId: lineId.toString(), draw: draw.toString() };
    const hash = quoteHash({ chainId, desk: desk.address, request, response: core, blockNumber: block });
    const now = deps.now();
    const partnerId = partner?.partnerId ?? (line.partnerId.toLowerCase() as Hex);
    await store.saveQuote({ quoteHash: hash, partnerId, requestJson: canonicalJson(request), responseJson: canonicalJson(core), createdAt: now });
    await store.rememberLine({ lineId: lineId.toString(), partnerId, user: line.user, marketId: line.marketId, firstSeen: now });
    return { status: 200, body: { ...core, quoteHash: hash, chainId, desk: desk.address, blockNumber: block.toString(), quotedAt: now, metered: partner === null } };
  }

  app.post("/v1/quotes", (c) => (c.get("metered") ? direct(c, (body) => quoteLine(null, body)) : idempotent(c, (body) => quoteLine(c.get("partner"), body))));

  // ------------------------------------------------------------------ reads

  app.get("/v1/lines/:id", async (c) => {
    const partner = c.get("partner");
    const lineId = parseBaseUnits(c.req.param("id"));
    if (lineId === null || lineId === 0n) return fail(c, 400, "line id must be a positive integer");
    if (!desk) return fail(c, 503, "desk not deployed");
    let line: DeskLine;
    try {
      line = await desk.line(lineId);
    } catch (err) {
      if (isUnknownLine(err)) return fail(c, 404, "unknown line");
      return fail(c, 502, "desk read failed", { detail: errorMessage(err) });
    }
    if (line.partnerId.toLowerCase() !== partner.partnerId) return fail(c, 404, "unknown line");
    c.header("X-Policy-Version", String(line.policyVersion));
    let obligationStatus = "UNKNOWN";
    try {
      obligationStatus = enumName(OBLIGATION_STATUSES, await desk.obligationStatus(lineId));
    } catch (err) {
      console.error("obligationStatus failed", errorMessage(err));
    }
    let quote: Record<string, unknown>;
    try {
      const q = await desk.quote(lineId, 0n);
      quote = validQuote(q) ? quoteCore(lineId, line, q, 0n) : { reason: "UNKNOWN", detail: "the desk returned an incomplete quote" };
    } catch (err) {
      quote = { reason: "UNKNOWN", detail: errorMessage(err) };
    }
    const now = deps.now();
    await store.rememberLine({ lineId: lineId.toString(), partnerId: partner.partnerId, user: line.user, marketId: line.marketId, firstSeen: now });
    return c.json({
      correlationId: c.get("correlationId"),
      policyVersion: line.policyVersion,
      chainId,
      desk: desk.address,
      line: {
        lineId: lineId.toString(),
        partnerId: line.partnerId,
        user: line.user,
        marketId: line.marketId,
        collateralToken: line.collateral,
        policyVersion: line.policyVersion,
        status: enumName(LINE_STATUSES, line.status),
        holdReason: line.holdReason,
        openedAt: Number(line.openedAt),
        drawnPrincipal: money(line.drawnPrincipal),
      },
      obligationStatus,
      quote,
      readAt: now,
    });
  });

  // ------------------------------------------------------------------ indexer-backed reads

  interface IndexerLine {
    lineId: string;
    partnerId?: string;
    user: string;
    marketId: string;
    policyVersion: number;
    decisionHash: string;
    blockNumber: number;
    blockTime: number;
    txHash: string;
  }
  interface IndexerEvent {
    name: string;
    blockNumber: number;
    blockTime: number;
    txHash: string;
    logIndex: number;
    args: Record<string, unknown>;
  }

  /** One GET against the indexer (service binding when bound); `null` when no indexer is configured. */
  async function indexerGet<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; status: number; detail: string } | null> {
    if (!deps.indexerUrl) return null;
    const url = `${deps.indexerUrl.replace(/\/+$/, "")}${path}`;
    try {
      const res = await fetchImpl(url);
      if (!res.ok) return { ok: false, status: res.status, detail: `indexer answered ${res.status}` };
      return { ok: true, data: (await res.json()) as T };
    } catch (err) {
      return { ok: false, status: 0, detail: errorMessage(err) };
    }
  }

  /** bytes32 action names the desk emits (`"OPEN"`, `"DRAW"`, …) back to text; anything else stays hex. */
  function actionName(value: unknown): string {
    if (typeof value !== "string" || !isBytes32(value)) return String(value ?? "");
    try {
      const text = hexToString(value as Hex, { size: 32 });
      return /^[\x20-\x7e]+$/.test(text) ? text : value;
    } catch {
      return value;
    }
  }

  const str = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v) : "");

  interface ObligationRow {
    lineId: string;
    user: string;
    marketId: string;
    openedAt: number | null;
    openedBlock: number | null;
    openTx: string | null;
    decisionHash: string | null;
    lineStatus: string;
    obligationStatus: string;
    policyVersion: number | null;
    drawnPrincipal: { baseUnits: string; usdc: string } | null;
    holdReason: string | null;
  }

  /** The partner's lines from the indexer's LineOpened events (fallback: the API's own cache), statuses read live from the desk. */
  async function collectObligations(partner: PartnerRecord, limit: number): Promise<{ source: "indexer" | "api-cache"; sourceNote: string; obligations: ObligationRow[] }> {
    let source: "indexer" | "api-cache" = "indexer";
    let sourceNote = "LineOpened events from the indexer, statuses read live from the desk";
    let lines: Omit<ObligationRow, "lineStatus" | "obligationStatus" | "policyVersion" | "drawnPrincipal" | "holdReason">[] = [];
    const idx = await indexerGet<{ lines: IndexerLine[] }>(`/v1/desk/lines?chainId=${chainId}&partnerId=${partner.partnerId}&limit=${limit}`);
    if (idx && idx.ok && Array.isArray(idx.data.lines)) {
      lines = idx.data.lines.map((l) => ({
        lineId: str(l.lineId),
        user: str(l.user),
        marketId: str(l.marketId),
        openedAt: Number.isFinite(l.blockTime) ? l.blockTime : null,
        openedBlock: Number.isFinite(l.blockNumber) ? l.blockNumber : null,
        openTx: str(l.txHash) || null,
        decisionHash: str(l.decisionHash) || null,
      }));
      const now = deps.now();
      for (const l of lines) await store.rememberLine({ lineId: l.lineId, partnerId: partner.partnerId, user: l.user, marketId: l.marketId as Hex, firstSeen: now });
    } else {
      source = "api-cache";
      sourceNote = idx === null ? "no indexer bound: lines this API has quoted or looked up" : `indexer unavailable (${idx.ok ? "" : idx.detail}): lines this API has quoted or looked up`;
      lines = (await store.listLines(partner.partnerId, limit)).map((row) => ({ lineId: row.lineId, user: row.user, marketId: row.marketId, openedAt: null, openedBlock: null, openTx: null, decisionHash: null }));
    }
    const obligations = await Promise.all(
      lines.map(async (l): Promise<ObligationRow> => {
        let lineStatus = "UNKNOWN";
        let obligationStatus = "UNKNOWN";
        let policyVersion: number | null = null;
        let drawnPrincipal: { baseUnits: string; usdc: string } | null = null;
        let holdReason: string | null = null;
        if (desk) {
          try {
            const id = BigInt(l.lineId);
            const [line, status] = await Promise.all([desk.line(id), desk.obligationStatus(id)]);
            lineStatus = enumName(LINE_STATUSES, line.status);
            obligationStatus = enumName(OBLIGATION_STATUSES, status);
            policyVersion = line.policyVersion;
            drawnPrincipal = money(line.drawnPrincipal);
            holdReason = line.holdReason;
          } catch {
            // the line stays listed with UNKNOWN statuses; the desk read is retried on the next call
          }
        }
        return { ...l, lineStatus, obligationStatus, policyVersion, drawnPrincipal, holdReason };
      }),
    );
    return { source, sourceNote, obligations };
  }

  app.get("/v1/obligations", async (c) => {
    const partner = c.get("partner");
    const asked = c.req.query("partnerId");
    if (asked !== undefined && toPartnerId(asked) !== partner.partnerId) return fail(c, 403, "partnerId does not match the authenticated partner");
    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;
    const { source, sourceNote, obligations } = await collectObligations(partner, limit);
    return c.json({
      correlationId: c.get("correlationId"),
      policyVersion: partner.policyVersion,
      partnerId: partner.partnerId,
      chainId,
      count: obligations.length,
      source,
      sourceNote,
      obligations,
    });
  });

  /** A line's events from the indexer, split into decisions and the typed events beside them. */
  async function lineTimeline(lineId: string): Promise<{ ok: true; decisions: Record<string, unknown>[]; timeline: Record<string, unknown>[] } | { ok: false; status: number; detail: string } | null> {
    const idx = await indexerGet<{ events: IndexerEvent[] }>(`/v1/desk/lines/${lineId}/timeline?chainId=${chainId}`);
    if (idx === null) return null;
    if (!idx.ok) return idx;
    const events = Array.isArray(idx.data.events) ? idx.data.events : [];
    const decisions = events
      .filter((e) => e.name === "Decision")
      .map((e) => ({
        action: actionName(e.args.action),
        hash: str(e.args.decisionHash),
        amount: str(e.args.amount),
        price8: str(e.args.price8),
        blockNumber: e.blockNumber,
        blockTime: e.blockTime,
        txHash: e.txHash,
        logIndex: e.logIndex,
      }));
    const timeline = events
      .filter((e) => e.name !== "Decision")
      .map((e) => ({
        event: e.name,
        hash: str(e.args.decisionHash) || null,
        blockNumber: e.blockNumber,
        blockTime: e.blockTime,
        txHash: e.txHash,
        logIndex: e.logIndex,
        args: e.args,
      }));
    return { ok: true, decisions, timeline };
  }

  app.get("/v1/lines/:id/decisions", async (c) => {
    const partner = c.get("partner");
    const lineId = parseBaseUnits(c.req.param("id"));
    if (lineId === null || lineId === 0n) return fail(c, 400, "line id must be a positive integer");
    if (!desk) return fail(c, 503, "desk not deployed");
    let line: DeskLine;
    try {
      line = await desk.line(lineId);
    } catch (err) {
      if (isUnknownLine(err)) return fail(c, 404, "unknown line");
      return fail(c, 502, "desk read failed", { detail: errorMessage(err) });
    }
    if (line.partnerId.toLowerCase() !== partner.partnerId) return fail(c, 404, "unknown line");
    c.header("X-Policy-Version", String(line.policyVersion));
    const t = await lineTimeline(lineId.toString());
    if (t === null) return fail(c, 501, "not implemented", { plan: "served from the indexer once bound" });
    if (!t.ok) return fail(c, 502, "indexer unavailable", { status: t.status, detail: t.detail });
    return c.json({
      correlationId: c.get("correlationId"),
      policyVersion: line.policyVersion,
      chainId,
      desk: desk.address,
      lineId: lineId.toString(),
      status: enumName(LINE_STATUSES, line.status),
      source: "indexer",
      count: t.decisions.length,
      decisions: t.decisions,
      timeline: t.timeline,
    });
  });

  app.get("/v1/decisions/:hash", async (c) => {
    const hash = c.req.param("hash");
    if (!isBytes32(hash)) return fail(c, 400, "decision hash must be bytes32 hex");
    if (!deps.indexerUrl) return fail(c, 501, "not implemented", { plan: "served from the indexer's D1 once bound", hash });
    const url = `${deps.indexerUrl.replace(/\/+$/, "")}/v1/events?name=Decision&decisionHash=${hash}&limit=50`;
    let events: unknown[] = [];
    try {
      const res = await fetchImpl(url);
      if (!res.ok) return fail(c, 502, "indexer unavailable", { status: res.status });
      const data = (await res.json()) as unknown;
      events = Array.isArray(data) ? data : ((data as { events?: unknown[] })?.events ?? []);
    } catch (err) {
      return fail(c, 502, "indexer unavailable", { detail: errorMessage(err) });
    }
    const wanted = hash.toLowerCase();
    const match = events.find((e) => {
      const ev = e as { decisionHash?: string; args?: { decisionHash?: string } };
      return (ev.args?.decisionHash ?? ev.decisionHash ?? "").toLowerCase() === wanted;
    });
    if (!match) return fail(c, 404, "decision not found", { hash });
    return c.json({ correlationId: c.get("correlationId"), policyVersion: c.get("partner").policyVersion, hash, decision: match });
  });

  // ------------------------------------------------------------------ shadow positions (metered for callers without a key)

  app.get("/v1/positions/:addr/shadow", async (c) => {
    const addr = c.req.param("addr");
    if (!ADDRESS.test(addr)) return fail(c, 400, "address must be 0x + 40 hex");
    const user = getAddress(addr);
    if (!desk) return fail(c, 503, "desk not deployed");
    const partner: PartnerRecord | null = c.get("metered") ? null : c.get("partner");
    const sources: Record<string, string> = {};

    // Line discovery: the desk's own lineOf for the partner's markets (authoritative), the indexer's LineOpened events, and this API's cache.
    const ids = new Set<string>();
    if (partner) {
      for (const m of markets) {
        try {
          const id = await desk.lineOf(partner.partnerId, user, m.marketId);
          if (id !== 0n) ids.add(id.toString());
          sources.desk = "lineOf per configured market";
        } catch (err) {
          sources.desk = `lineOf failed: ${errorMessage(err)}`;
        }
      }
    }
    const idx = await indexerGet<{ lines: IndexerLine[] }>(`/v1/desk/lines?chainId=${chainId}${partner ? `&partnerId=${partner.partnerId}` : ""}&limit=100`);
    if (idx === null) sources.indexer = "not bound";
    else if (!idx.ok) sources.indexer = `unavailable: ${idx.detail}`;
    else {
      sources.indexer = "LineOpened events";
      for (const l of idx.data.lines ?? []) if (str(l.user).toLowerCase() === user.toLowerCase() && str(l.lineId)) ids.add(str(l.lineId));
    }
    for (const l of await store.listLinesByUser(user, 50)) if (!partner || l.partnerId === partner.partnerId) ids.add(l.lineId);

    const lines = await Promise.all(
      [...ids]
        .sort((a, b) => Number(BigInt(a) - BigInt(b)))
        .map(async (id) => {
          const lineId = BigInt(id);
          let line: DeskLine;
          try {
            line = await desk.line(lineId);
          } catch {
            return null;
          }
          if (partner && line.partnerId.toLowerCase() !== partner.partnerId) return null;
          if (line.user.toLowerCase() !== user.toLowerCase()) return null;
          const market = markets.find((m) => m.marketId === line.marketId.toLowerCase());
          const [quoteRes, statusRes] = await Promise.allSettled([desk.quote(lineId, 0n), desk.obligationStatus(lineId)]);
          const quote = quoteRes.status === "fulfilled" && validQuote(quoteRes.value) ? quoteCore(lineId, line, quoteRes.value, 0n) : { reason: "UNKNOWN", detail: quoteRes.status === "rejected" ? errorMessage(quoteRes.reason) : "incomplete quote" };
          const obligationStatus = statusRes.status === "fulfilled" ? enumName(OBLIGATION_STATUSES, statusRes.value) : "UNKNOWN";
          let protection: Record<string, unknown> | null = null;
          if (market?.preLiquidation && market.protector) {
            try {
              const data = await desk.ethCall(market.protector, encodeSizing(market.preLiquidation, user, market.targetLtvWad ?? DEFAULT_TARGET_LTV_WAD));
              protection = { preLiquidation: market.preLiquidation, protector: market.protector, ...sizingJson(decodeSizing(data)) };
            } catch (err) {
              protection = { preLiquidation: market.preLiquidation, protector: market.protector, standing: "UNKNOWN", detail: errorMessage(err) };
            }
          }
          return {
            lineId: id,
            partnerId: line.partnerId,
            marketId: line.marketId,
            symbol: market?.symbol ?? null,
            collateralToken: line.collateral,
            status: enumName(LINE_STATUSES, line.status),
            obligationStatus,
            policyVersion: line.policyVersion,
            drawnPrincipal: money(line.drawnPrincipal),
            quote,
            protection,
          };
        }),
    );
    const rows = lines.filter((l): l is NonNullable<typeof l> => l !== null);
    const protect = rows.some((l) => l.protection && (l.protection.standing === "IN_BAND" || l.protection.standing === "ABOVE_LLTV"));
    const decision = protect ? "PROTECT" : rows.length === 0 ? "UNKNOWN" : "ALLOW";
    return c.json({
      correlationId: c.get("correlationId"),
      chainId,
      desk: desk.address,
      address: user,
      metered: partner === null,
      count: rows.length,
      decision,
      decisionRule: "PROTECT when any line's Protector standing is IN_BAND or ABOVE_LLTV; ALLOW with lines and no such standing; UNKNOWN without lines",
      lines: rows,
      sources,
      readAt: deps.now(),
    });
  });

  // ------------------------------------------------------------------ policy (console)

  function policyVersionJson(v: PolicyVersionRecord): Record<string, unknown> {
    return {
      id: v.id,
      partnerId: v.partnerId,
      status: v.status,
      note: v.note,
      changes: v.changes,
      calls: v.calls,
      policyVersionBefore: v.policyVersionBefore,
      policyVersionAfter: v.policyVersionAfter,
      txHash: v.txHash,
      createdAt: v.createdAt,
      appliedAt: v.appliedAt,
    };
  }

  /** The partner's off-chain routing policy (Saturday mode) and the version that set it. */
  async function saturdayOf(partnerId: Hex): Promise<{ policy: SaturdayModePolicy; versionId: string | null; updatedAt: number | null }> {
    const row = await store.getPartnerSettings(partnerId);
    return row ? { policy: parseSaturdayJson(row.saturdayJson), versionId: row.versionId, updatedAt: row.updatedAt } : { policy: { ...DEFAULT_SATURDAY_MODE }, versionId: null, updatedAt: null };
  }

  async function applyRouting(partnerId: Hex, changes: readonly unknown[], versionId: string): Promise<SaturdayModePolicy | null> {
    if (!changes.some((x) => (x as { scope?: string })?.scope === "routing")) return null;
    const current = (await saturdayOf(partnerId)).policy;
    const next = applyRoutingChanges(current, changes);
    await store.putPartnerSettings({ partnerId, saturdayJson: JSON.stringify(next), versionId, updatedAt: deps.now() });
    return next;
  }

  async function livePolicy(partner: PartnerRecord): Promise<{ ok: true; policy: PolicyView } | { ok: false; out: Out }> {
    if (!desk) return { ok: false, out: { status: 503, body: { error: "desk not deployed" } } };
    try {
      const saturday = (await saturdayOf(partner.partnerId)).policy;
      return { ok: true, policy: await readPolicy(desk, partner, markets, saturday) };
    } catch (err) {
      return { ok: false, out: { status: 502, body: { error: "desk read failed", detail: errorMessage(err) } } };
    }
  }

  app.get("/v1/policy", async (c) => {
    const partner = c.get("partner");
    const r = await livePolicy(partner);
    if (!r.ok) return answer(c, r.out);
    const sat = await saturdayOf(partner.partnerId);
    c.header("X-Policy-Version", String(r.policy.policyVersion));
    return c.json({
      correlationId: c.get("correlationId"),
      chainId,
      desk: desk!.address,
      ...r.policy,
      saturdayModeSource: { scope: "off-chain routing policy (this API), applied by a policy version, no desk call", versionId: sat.versionId, updatedAt: sat.updatedAt },
      readAt: deps.now(),
    });
  });

  async function prepareVersion(partner: PartnerRecord, body: Record<string, unknown>): Promise<Out> {
    if (!desk) return { status: 503, body: { error: "desk not deployed" } };
    const input = parseVersionInput(body, markets);
    if ("error" in input) return { status: 400, body: { error: input.error } };
    const r = await livePolicy(partner);
    if (!r.ok) return r.out;
    const { changes, calls } = diffPolicy(desk.address, r.policy, input);
    if (changes.length === 0) return { status: 400, body: { error: "no changes against the current policy", policyVersion: r.policy.policyVersion } };
    // A version with only off-chain (routing) changes has nothing to sign: it is applied as it is prepared.
    const offchainOnly = calls.length === 0;
    const now = deps.now();
    const record: PolicyVersionRecord = {
      id: deps.uuid(),
      partnerId: partner.partnerId,
      status: offchainOnly ? "applied" : "prepared",
      note: input.note,
      changes,
      calls,
      policyVersionBefore: r.policy.policyVersion,
      policyVersionAfter: offchainOnly ? r.policy.policyVersion : null,
      txHash: null,
      createdAt: now,
      appliedAt: offchainOnly ? now : null,
    };
    await store.savePolicyVersion(record);
    const saturdayMode = offchainOnly ? await applyRouting(partner.partnerId, changes, record.id) : null;
    return {
      status: 201,
      body: {
        policyVersion: r.policy.policyVersion,
        chainId,
        desk: desk.address,
        version: policyVersionJson(record),
        admin: r.policy.partner.admin,
        ...(offchainOnly
          ? { appliedOffchain: true, saturdayMode, selfCustody: "off-chain routing policy only: nothing to sign, applied now (the desk's policy version is unchanged)" }
          : { selfCustody: "the partner admin signs and sends these calls in order; the API never signs. Then POST /v1/policy/versions/{id}/applied with the transaction hash (routing changes in this version apply then)" }),
      },
    };
  }

  app.post("/v1/policy/versions", (c) => idempotent(c, (body) => prepareVersion(c.get("partner"), body)));

  app.get("/v1/policy/versions", async (c) => {
    const partner = c.get("partner");
    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const versions = await store.listPolicyVersions(partner.partnerId, limit);
    return c.json({ correlationId: c.get("correlationId"), policyVersion: partner.policyVersion, count: versions.length, versions: versions.map(policyVersionJson) });
  });

  app.get("/v1/policy/versions/:id", async (c) => {
    const partner = c.get("partner");
    const v = await store.getPolicyVersion(partner.partnerId, c.req.param("id"));
    if (!v) return fail(c, 404, "unknown policy version");
    return c.json({ correlationId: c.get("correlationId"), policyVersion: partner.policyVersion, version: policyVersionJson(v) });
  });

  async function markApplied(partner: PartnerRecord, id: string, body: Record<string, unknown>): Promise<Out> {
    if (!desk) return { status: 503, body: { error: "desk not deployed" } };
    if (!isBytes32(body.txHash)) return { status: 400, body: { error: "txHash must be bytes32 hex" } };
    const v = await store.getPolicyVersion(partner.partnerId, id);
    if (!v) return { status: 404, body: { error: "unknown policy version" } };
    if (v.status === "applied") return { status: 200, body: { policyVersion: v.policyVersionAfter ?? partner.policyVersion, version: policyVersionJson(v), note: "already applied" } };
    let current: number;
    try {
      current = (await desk.partner(partner.partnerId)).policyVersion;
    } catch (err) {
      return { status: 502, body: { error: "desk read failed", detail: errorMessage(err) } };
    }
    if (current <= v.policyVersionBefore) {
      return { status: 409, body: { error: "the desk's policy version has not advanced; the calls have not been applied yet", currentPolicyVersion: current, policyVersionBefore: v.policyVersionBefore } };
    }
    const now = deps.now();
    await store.markPolicyVersionApplied(partner.partnerId, id, current, body.txHash.toLowerCase(), now);
    await store.setPartnerPolicyVersion(partner.partnerId, current);
    const saturdayMode = await applyRouting(partner.partnerId, v.changes, v.id);
    const updated = (await store.getPolicyVersion(partner.partnerId, id)) ?? { ...v, status: "applied" as const, policyVersionAfter: current, txHash: body.txHash.toLowerCase(), appliedAt: now };
    return { status: 200, body: { policyVersion: current, version: policyVersionJson(updated), ...(saturdayMode ? { saturdayMode } : {}) } };
  }

  app.post("/v1/policy/versions/:id/applied", (c) => idempotent(c, (body) => markApplied(c.get("partner"), c.req.param("id"), body)));

  // ------------------------------------------------------------------ drills, reconciliation, evidence (console)

  app.get("/v1/drills", (c) => {
    const drills = listDrills();
    return c.json({ correlationId: c.get("correlationId"), count: drills.length, drills });
  });

  app.get("/v1/drills/:id", (c) => {
    const d = getDrill(c.req.param("id"));
    if (!d) return fail(c, 404, "unknown drill", { known: listDrills().map((x) => x.id) });
    return c.json({ correlationId: c.get("correlationId"), drill: d });
  });

  async function reconciliation(): Promise<{ ok: true; reconcile: unknown; roots: unknown } | { ok: false; out: Out }> {
    const [rec, roots] = await Promise.all([indexerGet<unknown>("/v1/reconcile/latest"), indexerGet<unknown>("/v1/roots")]);
    if (rec === null || roots === null) return { ok: false, out: { status: 501, body: { error: "not implemented", plan: "served from the indexer once bound" } } };
    if (!rec.ok) return { ok: false, out: { status: 502, body: { error: "indexer unavailable", stage: "reconcile", status: rec.status, detail: rec.detail } } };
    if (!roots.ok) return { ok: false, out: { status: 502, body: { error: "indexer unavailable", stage: "roots", status: roots.status, detail: roots.detail } } };
    return { ok: true, reconcile: rec.data, roots: roots.data };
  }

  app.get("/v1/reconciliation", async (c) => {
    const r = await reconciliation();
    if (!r.ok) return answer(c, r.out);
    return c.json({ correlationId: c.get("correlationId"), source: "indexer", reconcile: r.reconcile, roots: r.roots, readAt: deps.now() });
  });

  app.get("/v1/evidence/export", async (c) => {
    const partner = c.get("partner");
    const generatedAt = deps.now();
    const policy = await livePolicy(partner);
    const { source, sourceNote, obligations } = await collectObligations(partner, 100);
    const decisions: Record<string, unknown>[] = [];
    for (const o of obligations.slice(0, EXPORT_TIMELINE_LINES)) {
      const t = await lineTimeline(o.lineId);
      decisions.push(
        t === null
          ? { lineId: o.lineId, source: "none", decisions: [], timeline: [] }
          : t.ok
            ? { lineId: o.lineId, source: "indexer", decisions: t.decisions.slice(0, EXPORT_TIMELINE_EVENTS), timeline: t.timeline.slice(0, EXPORT_TIMELINE_EVENTS) }
            : { lineId: o.lineId, source: "unavailable", detail: t.detail, decisions: [], timeline: [] },
      );
    }
    const rec = await reconciliation();
    const bundle = sealEvidence({
      schema: "boundline-evidence/1",
      generatedAt,
      chainId,
      desk: desk?.address ?? null,
      partnerId: partner.partnerId,
      partnerName: partner.name,
      policy: policy.ok ? policy.policy : { error: policy.out.body.error ?? "unavailable" },
      obligations: { source, sourceNote, count: obligations.length, rows: obligations },
      decisions,
      reconciliation: rec.ok ? { reconcile: rec.reconcile, roots: rec.roots } : { error: rec.out.body.error ?? "unavailable" },
      drills: listDrills({ full: true }),
    });
    const body = { ...bundle, correlationId: c.get("correlationId") };
    if (c.req.query("format") === "download") {
      c.header("content-disposition", `attachment; filename="boundline-evidence-${partner.name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}-${generatedAt}.json"`);
    }
    c.header("cache-control", "no-store");
    return c.json(body);
  });

  // ------------------------------------------------------------------ route plans (plan M11)

  app.get("/v1/whoami", (c) => {
    const p = c.get("partner");
    return c.json({ correlationId: c.get("correlationId"), partnerId: p.partnerId, name: p.name, policyVersion: p.policyVersion });
  });

  /** The partner a line belongs to: this API's records, else the desk; null when the desk does not know it. */
  async function lineOwner(lineId: string): Promise<Hex | null> {
    const known = await store.getLine(lineId);
    if (known) return known.partnerId.toLowerCase() as Hex;
    try {
      const head = deps.readLine ? await deps.readLine(BigInt(lineId)) : desk ? await desk.line(BigInt(lineId)).then((l) => ({ partnerId: l.partnerId, user: l.user, marketId: l.marketId })) : null;
      if (!head || /^0x0{64}$/.test(head.partnerId)) return null;
      await store.rememberLine({ lineId, partnerId: head.partnerId.toLowerCase() as Hex, user: head.user, marketId: head.marketId, firstSeen: deps.now() });
      return head.partnerId.toLowerCase() as Hex;
    } catch {
      return null;
    }
  }

  async function routeFor(partner: PartnerRecord | null, body: Record<string, unknown>): Promise<Out> {
    if (!deps.route) return { status: 501, body: { error: "not implemented", plan: "route reads are not configured on this Worker" } };
    const input = parseRouteInput(body, toPartnerId);
    if ("error" in input) return { status: 400, body: { error: input.error } };
    if (partner && input.partnerId && input.partnerId !== partner.partnerId) return { status: 403, body: { error: "partnerId does not match the authenticated partner" } };
    const notes: string[] = [];
    let lineId: string | null = null;
    if (input.lineId) {
      if (!partner) notes.push("lineId ignored: a plan is stored on a line only for that line's partner (send the partner key)");
      else {
        if (input.chainId !== CHAIN_SEPOLIA) return { status: 400, body: { error: "a lineId names a desk line: route it on chainId 84532" } };
        const owner = await lineOwner(input.lineId);
        if (owner !== partner.partnerId) return { status: 404, body: { error: "unknown line", lineId: input.lineId } };
        lineId = input.lineId;
      }
    }
    let resolved: ResolvedRoute;
    try {
      if (input.chainId === CHAIN_SEPOLIA) {
        if (!deps.route.sepolia) return { status: 501, body: { error: "not implemented", plan: "Base Sepolia route reads are not configured" } };
        resolved = await sepoliaRoute(deps.route.sepolia, input, partner?.partnerId ?? input.partnerId);
      } else {
        if (!deps.route.mainnet) return { status: 501, body: { error: "not implemented", plan: "Base mainnet route reads (the Observatory binding) are not configured" } };
        resolved = await mainnetRoute(deps.route.mainnet, input);
      }
    } catch (err) {
      return { status: 502, body: { error: "route reads failed", detail: errorMessage(err) } };
    }
    const sat = partner ? (await saturdayOf(partner.partnerId)).policy : null;
    const eff = effectiveSaturday(sat, input.saturdayMode);
    const verifyingContract = input.chainId === CHAIN_SEPOLIA && desk ? desk.address : ZERO_ADDRESS;
    const now = deps.now();
    let planned: ReturnType<typeof makePlan>;
    try {
      planned = makePlan(input, resolved, eff.mode, input.chainId, verifyingContract, now);
      // Capacity mode: plan again for exactly the capacity found, so the signed plan names a real amount.
      if (input.amount === null && planned.plan.chosen) planned = makePlan({ ...input, amount: planned.plan.chosen.capacity }, resolved, eff.mode, input.chainId, verifyingContract, now);
    } catch (err) {
      return { status: 400, body: { error: errorMessage(err) } };
    }
    let signature: Hex | null = null;
    let signer: string | null = null;
    if (planned.typedData && deps.routeSigner) {
      try {
        ({ signature, signer } = await deps.routeSigner.sign(planned.typedData));
      } catch (err) {
        notes.push(`signing failed: ${errorMessage(err)}`);
      }
    }
    const typedData = planned.typedData ? routeTypedDataJson(planned.typedData) : null;
    await store.saveRoutePlan({
      planHash: planned.planHash,
      partnerId: partner?.partnerId ?? null,
      lineId,
      chainId: input.chainId,
      planJson: planned.planJson,
      typedDataJson: typedData ? canonicalJson(typedData) : null,
      digest: planned.digest,
      signature,
      signer,
      createdAt: now,
    });
    const policyVersion = resolved.deskPolicyVersion ?? partner?.policyVersion ?? null;
    return {
      status: 200,
      body: {
        chainId: input.chainId,
        plan: JSON.parse(planned.planJson) as unknown,
        planHash: planned.planHash,
        planHashScheme: "keccak256(utf8(canonicalRoutePlan(plan)))",
        digest: planned.digest,
        typedData,
        signature,
        signer,
        ...(signature ? {} : { note: planned.typedData ? "route signer not configured" : "no route: nothing to sign" }),
        ...(policyVersion !== null ? { policyVersion } : {}),
        policySource: resolved.policySource,
        saturdayMode: { ...(sat ?? DEFAULT_SATURDAY_MODE), applied: eff.applied },
        mode: input.amount === null ? "capacity" : "amount",
        lineId,
        stored: true,
        blockNumber: resolved.blockNumber === null ? null : resolved.blockNumber.toString(),
        candidates: resolved.candidates.length,
        notes: [...notes, ...resolved.notes, ...(eff.note ? [eff.note] : [])],
        authoritative: "the desk's quote at draw time decides; a route plan is advice with a hash",
        metered: partner === null,
      },
    };
  }

  app.post("/v1/route", (c) => (c.get("metered") ? direct(c, (body) => routeFor(null, body)) : maybeIdempotent(c, (body) => routeFor(c.get("partner"), body))));

  app.get("/v1/lines/:id/route", async (c) => {
    const partner = c.get("partner");
    const lineId = c.req.param("id");
    if (!/^[1-9][0-9]{0,30}$/.test(lineId)) return fail(c, 400, "line id must be a positive integer");
    const rec = await store.latestRoutePlanForLine(partner.partnerId, lineId);
    if (!rec) return fail(c, 404, "no route plan stored for this line", { lineId, hint: "POST /v1/route with lineId" });
    return c.json({
      correlationId: c.get("correlationId"),
      lineId,
      chainId: rec.chainId,
      planHash: rec.planHash,
      plan: JSON.parse(rec.planJson) as unknown,
      typedData: rec.typedDataJson ? (JSON.parse(rec.typedDataJson) as unknown) : null,
      digest: rec.digest,
      signature: rec.signature,
      signer: rec.signer,
      ...(rec.signature ? {} : { note: rec.typedDataJson ? "route signer not configured" : "no route: nothing to sign" }),
      createdAt: rec.createdAt,
    });
  });

  // ------------------------------------------------------------------ webhooks (plan M7)

  const webhooksOf = (c: Ctx): WebhookRuntime | null => makeWebhookRuntime(deps, async (req) => app.fetch(req), deferFor(c));

  // The demo receiver first: `echo` must never be read as a webhook id.
  app.post("/v1/webhooks/echo/:token", async (c) => {
    const rt = webhooksOf(c);
    if (!rt) return fail(c, 501, "webhooks are not configured");
    const token = c.req.param("token");
    if (!validEchoToken(token)) return fail(c, 400, "token must be 8 to 64 characters of A-Z, a-z, 0-9, _ or -");
    const rec = await receiveEcho(rt, token, await c.req.text(), c.req.raw.headers);
    return c.json({ correlationId: c.get("correlationId"), received: rec.stored, signatureValid: rec.signatureValid, verification: rec.verification });
  });

  app.get("/v1/webhooks/echo/:token", async (c) => {
    if (!deps.webhookStore) return fail(c, 501, "webhooks are not configured");
    const token = c.req.param("token");
    if (!validEchoToken(token)) return fail(c, 400, "token must be 8 to 64 characters of A-Z, a-z, 0-9, _ or -");
    const rows = await deps.webhookStore.listEcho(token, 20);
    c.header("cache-control", "no-store");
    return c.json({ correlationId: c.get("correlationId"), token, count: rows.length, deliveries: rows.map(echoJson) });
  });

  async function createWebhook(partner: PartnerRecord, body: Record<string, unknown>): Promise<Out> {
    if (!deps.webhookStore) return { status: 501, body: { error: "webhooks are not configured" } };
    const parsed = parseWebhookBody(body);
    if ("error" in parsed) return { status: 400, body: { error: parsed.error } };
    // On this API's own host only the echo receiver may be addressed (deliveries there are dispatched internally).
    const target = new URL(parsed.url);
    if ((deps.selfHosts ?? []).some((h) => h.toLowerCase() === target.host.toLowerCase()) && !/^\/v1\/webhooks\/echo\/[A-Za-z0-9_-]{8,64}$/.test(target.pathname)) {
      return { status: 400, body: { error: "on this API's own host a webhook may only address the echo receiver /v1/webhooks/echo/:token" } };
    }
    if ((await deps.webhookStore.countWebhooks(partner.partnerId)) >= MAX_WEBHOOKS_PER_PARTNER) {
      return { status: 409, body: { error: `at most ${MAX_WEBHOOKS_PER_PARTNER} webhooks per partner; delete one first` } };
    }
    const rec = { id: `wh_${deps.uuid()}`, partnerId: partner.partnerId, url: parsed.url, events: parsed.events, description: parsed.description, secret: newWebhookSecret(), active: true, createdAt: deps.now() };
    await deps.webhookStore.createWebhook(rec);
    return {
      status: 201,
      body: {
        ...webhookJson(rec, null),
        secret: rec.secret,
        signing: { header: "Boundline-Signature", scheme: "t=<unix>,v1=<hex HMAC-SHA256(secret, t + \".\" + raw body)>", toleranceSeconds: 300, note: "the secret is shown once" },
      },
    };
  }

  app.post("/v1/webhooks", (c) => maybeIdempotent(c, (body) => createWebhook(c.get("partner"), body)));

  app.get("/v1/webhooks", async (c) => {
    if (!deps.webhookStore) return fail(c, 501, "webhooks are not configured");
    const ws = deps.webhookStore;
    const hooks = await ws.listWebhooks(c.get("partner").partnerId);
    const rows = await Promise.all(hooks.map(async (w) => webhookJson(w, await ws.lastDelivery(w.id))));
    return c.json({ correlationId: c.get("correlationId"), count: rows.length, webhooks: rows });
  });

  async function deleteWebhook(c: Ctx): Promise<Response> {
    if (!deps.webhookStore) return fail(c, 501, "webhooks are not configured");
    const removed = await deps.webhookStore.deactivateWebhook(c.get("partner").partnerId, c.req.param("id") ?? "");
    if (!removed) return fail(c, 404, "unknown webhook");
    return c.body(null, 204);
  }

  app.delete("/v1/webhooks/:id", (c) => deleteWebhook(c));
  // For proxies that only pass GET and POST (the app and console Workers).
  app.post("/v1/webhooks/:id/delete", (c) => deleteWebhook(c));

  app.post("/v1/webhooks/:id/test", async (c) => {
    const rt = webhooksOf(c);
    if (!rt) return fail(c, 501, "webhooks are not configured");
    const partner = c.get("partner");
    const w = await rt.store.getWebhook(c.req.param("id"));
    if (!w || !w.active || w.partnerId !== partner.partnerId) return fail(c, 404, "unknown webhook");
    const now = deps.now();
    const r = await ingest(rt, {
      type: "ping",
      chainId,
      at: now,
      source: "api",
      partnerId: partner.partnerId,
      data: { message: "Boundline webhook test", webhookId: w.id },
      dedupeKey: `ping:${w.id}:${deps.uuid()}`,
      onlyWebhookId: w.id,
    });
    return c.json({ correlationId: c.get("correlationId"), deliveryId: r.deliveryIds[0] ?? null, eventId: r.id }, 202);
  });

  /** One bounded tick on demand (the cron's work: both indexer sources, then up to two due deliveries). Idempotent. */
  app.post("/v1/webhooks/poll", async (c) => {
    const rt = webhooksOf(c);
    if (!rt) return fail(c, 501, "webhooks are not configured");
    const get = makeIndexerGet(deps);
    const polls = [];
    for (const source of POLL_SOURCES) polls.push(await pollSource(rt, source, chainId, get));
    const retries = await retryDue(rt, 2);
    return c.json({ correlationId: c.get("correlationId"), polls, retries });
  });

  app.get("/v1/webhooks/:id/deliveries", async (c) => {
    if (!deps.webhookStore) return fail(c, 501, "webhooks are not configured");
    const w = await deps.webhookStore.getWebhook(c.req.param("id"));
    if (!w || w.partnerId !== c.get("partner").partnerId) return fail(c, 404, "unknown webhook");
    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const rows = await deps.webhookStore.listDeliveries(w.id, limit);
    return c.json({ correlationId: c.get("correlationId"), webhookId: w.id, count: rows.length, deliveries: rows.map(deliveryJson) });
  });

  app.get("/v1/events", async (c) => {
    if (!deps.webhookStore) return fail(c, 501, "webhooks are not configured");
    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const rows = await deps.webhookStore.listEvents(c.get("partner").partnerId, limit);
    return c.json({ correlationId: c.get("correlationId"), count: rows.length, events: rows.map(eventJson) });
  });

  return app;
}
