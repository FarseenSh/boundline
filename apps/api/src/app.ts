import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { encodeFunctionData, getAddress, hexToString, isAddress, isHex, stringToHex, type Address, type Hex } from "viem";
import { creditDeskAbi } from "./abi/creditDesk.js";
import { authenticate } from "./auth.js";
import type { PartnerRecord, Store } from "./db.js";
import { ZERO_ADDRESS, type DeskLine, type DeskQuote, type DeskReader } from "./desk.js";
import { requestHash, runIdempotent } from "./idempotency.js";
import { LINE_STATUSES, OBLIGATION_STATUSES, REASONS, SESSIONS, enumName } from "./names.js";
import { canonicalJson, quoteHash } from "./quote-hash.js";
import { formatUsdc, parseBaseUnits, roundDownToCents, roundUpToCents } from "./rounding.js";
import { lineAuthorizationDigest, lineAuthorizationTypedData, typedDataJson } from "./typed-data.js";

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
}

type Vars = { correlationId: string; partner: PartnerRecord };
type Ctx = Context<{ Variables: Vars }>;
interface Out {
  status: number;
  body: Record<string, unknown>;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

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
    effectiveMaxLtv: { wad: q.effectiveMaxLtvWad.toString(), ratio: Number(q.effectiveMaxLtvWad) / 1e18 },
    corporateActionHaircut: q.corporateActionHaircut,
  };
}

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const { store, desk, chainId } = deps;
  const service = deps.serviceName ?? "boundline-api";
  const fetchImpl = deps.fetchImpl ?? fetch;
  const app = new Hono<{ Variables: Vars }>();

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

  app.get("/health", (c) => c.json({ ok: true, service }));

  app.use("/v1/*", async (c, next) => {
    const partner = await authenticate(store, c.req.header("authorization"));
    if (!partner) return fail(c, 401, "unauthorized", { hint: "Authorization: Bearer <partner key>" });
    c.set("partner", partner);
    c.header("X-Policy-Version", String(partner.policyVersion));
    await next();
  });

  /** POST bodies run once per Idempotency-Key; the body's policyVersion and quoteHash become headers. */
  async function idempotent(c: Ctx, handler: (body: Record<string, unknown>) => Promise<Out>): Promise<Response> {
    const key = c.req.header("idempotency-key")?.trim();
    if (!key) return fail(c, 400, "missing Idempotency-Key header");
    const raw = await c.req.text();
    let body: unknown;
    try {
      body = raw.length ? JSON.parse(raw) : {};
    } catch {
      return fail(c, 400, "body is not JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail(c, 400, "body must be a JSON object");
    const partner = c.get("partner");
    const hash = await requestHash(c.req.method, c.req.path, raw);
    const result = await runIdempotent(store, partner.partnerId, key, hash, deps.now(), () => handler(body as Record<string, unknown>));
    if (result.conflict) return fail(c, 422, "Idempotency-Key was already used with a different request");
    c.header("X-Idempotent-Replay", result.replayed ? "true" : "false");
    const out = result.body as Record<string, unknown>;
    if (typeof out.policyVersion === "number") c.header("X-Policy-Version", String(out.policyVersion));
    if (typeof out.quoteHash === "string") c.header("X-Quote-Hash", out.quoteHash);
    return c.json({ ...out, correlationId: c.get("correlationId") }, result.status as ContentfulStatusCode);
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

  async function resolveLineId(partner: PartnerRecord, body: Record<string, unknown>): Promise<{ lineId?: bigint; out?: Out }> {
    if (body.lineId !== undefined) {
      const id = parseBaseUnits(body.lineId);
      if (id === null || id === 0n) return { out: { status: 400, body: { error: "lineId must be a positive integer" } } };
      return { lineId: id };
    }
    const partnerId = toPartnerId(body.partnerId);
    if (!partnerId) return { out: { status: 400, body: { error: "give lineId, or partnerId + user + marketId" } } };
    if (partnerId !== partner.partnerId) return { out: { status: 403, body: { error: "partnerId does not match the authenticated partner" } } };
    if (typeof body.user !== "string" || !isAddress(body.user)) return { out: { status: 400, body: { error: "user must be an address" } } };
    if (!isBytes32(body.marketId)) return { out: { status: 400, body: { error: "marketId must be a bytes32 Morpho market id" } } };
    const id = await desk!.lineOf(partnerId, getAddress(body.user), body.marketId.toLowerCase() as Hex);
    if (id === 0n) return { out: { status: 404, body: { error: "no line for this partner, user and market" } } };
    return { lineId: id };
  }

  async function quoteLine(partner: PartnerRecord, body: Record<string, unknown>): Promise<Out> {
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
    if (line.partnerId.toLowerCase() !== partner.partnerId) return { status: 404, body: { error: "unknown line", lineId: lineId.toString() } };
    if (!validQuote(q)) return { status: 409, body: { reason: "UNKNOWN", detail: "the desk returned an incomplete quote" } };
    const core = quoteCore(lineId, line, q, draw);
    const request = { lineId: lineId.toString(), draw: draw.toString() };
    const hash = quoteHash({ chainId, desk: desk.address, request, response: core, blockNumber: block });
    const now = deps.now();
    await store.saveQuote({ quoteHash: hash, partnerId: partner.partnerId, requestJson: canonicalJson(request), responseJson: canonicalJson(core), createdAt: now });
    await store.rememberLine({ lineId: lineId.toString(), partnerId: partner.partnerId, user: line.user, marketId: line.marketId, firstSeen: now });
    return { status: 200, body: { ...core, quoteHash: hash, chainId, desk: desk.address, blockNumber: block.toString(), quotedAt: now } };
  }

  app.post("/v1/quotes", (c) => idempotent(c, (body) => quoteLine(c.get("partner"), body)));

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

  app.get("/v1/obligations", async (c) => {
    const partner = c.get("partner");
    const asked = c.req.query("partnerId");
    if (asked !== undefined && toPartnerId(asked) !== partner.partnerId) return fail(c, 403, "partnerId does not match the authenticated partner");
    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;

    // The indexer enumerates LineOpened events per partner; the API's own cache of lines it has seen is the fallback.
    let source: "indexer" | "api-cache" = "indexer";
    let sourceNote = "LineOpened events from the indexer, statuses read live from the desk";
    let lines: { lineId: string; user: string; marketId: string; openedAt: number | null; openedBlock: number | null; openTx: string | null; decisionHash: string | null }[] = [];
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
      lines.map(async (l) => {
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
    const idx = await indexerGet<{ events: IndexerEvent[] }>(`/v1/desk/lines/${lineId.toString()}/timeline?chainId=${chainId}`);
    if (idx === null) return fail(c, 501, "not implemented", { plan: "served from the indexer once bound" });
    if (!idx.ok) return fail(c, 502, "indexer unavailable", { status: idx.status, detail: idx.detail });
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
    return c.json({
      correlationId: c.get("correlationId"),
      policyVersion: line.policyVersion,
      chainId,
      desk: desk.address,
      lineId: lineId.toString(),
      status: enumName(LINE_STATUSES, line.status),
      source: "indexer",
      count: decisions.length,
      decisions,
      timeline,
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

  return app;
}
