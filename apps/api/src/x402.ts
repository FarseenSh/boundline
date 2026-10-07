// x402 metering (plan M7): a request without a partner key on a metered route is answered 402 with the payment
// requirements; a request carrying a signed payment is verified and, once the route answered 2xx, settled through
// the facilitator, which broadcasts the EIP-3009 `transferWithAuthorization` and pays the gas. Partners with a key
// are never metered (they pay by contract).
//
// Wire format, hand-rolled from the x402 specification v2 (specs/x402-specification-v2.md, transports-v2/http.md,
// schemes/exact/scheme_exact_evm.md) because the official middleware packages pull a wallet stack this Worker does
// not need. Both protocol generations are accepted: v2 (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`
// headers, CAIP-2 networks) and v1 (`X-PAYMENT` / `X-PAYMENT-RESPONSE`, network names such as "base-sepolia"), which
// the public facilitator at https://x402.org/facilitator supports side by side (its /supported on 7 Oct 2026 lists
// `{x402Version: 2, exact, eip155:84532}` and `{x402Version: 1, exact, base-sepolia}`).
import type { Address, Hex } from "viem";
import type { Context, Env, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface X402Config {
  payTo: Address;
  /** v1 network name ("base-sepolia"); `caip2` is the v2 identifier for the same chain. */
  network: string;
  caip2: string;
  /** The EIP-3009 token (USDC) and its EIP-712 domain name and version, which the client signs against. */
  asset: Address;
  assetName: string;
  assetVersion: string;
  /** Price in atomic units of `asset` as a decimal string ("10000" = $0.01 of USDC). */
  amount: string;
  /** The same price as a human string, echoed in the 402 body. */
  priceUsdc: string;
  maxTimeoutSeconds: number;
  serviceName: string;
  description: string;
}

/** Known v1 network names to CAIP-2. */
export const CAIP2: Readonly<Record<string, string>> = { "base-sepolia": "eip155:84532", base: "eip155:8453" };

/** USDC on the networks the API meters on. */
export const USDC_BY_NETWORK: Readonly<Record<string, Address>> = {
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

/** "0.01" → "10000" (six decimals, no rounding: more than six decimals is refused). */
export function usdcToAtomic(price: string): string {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(price.trim());
  if (!m) throw new Error(`price must be a decimal USDC amount with at most six decimals: ${price}`);
  const whole = m[1] as string;
  const frac = (m[2] ?? "").padEnd(6, "0");
  return (BigInt(whole) * 1_000_000n + BigInt(frac)).toString();
}

// ---------------------------------------------------------------- protocol objects

export interface RequirementV2 {
  scheme: "exact";
  network: string;
  amount: string;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

export interface RequirementV1 {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  asset: Address;
  extra: { name: string; version: string };
}

export interface PaymentRequiredV2 {
  x402Version: 2;
  error?: string;
  resource: { url: string; description: string; mimeType: string; serviceName: string };
  accepts: RequirementV2[];
}

export function requirementV2(cfg: X402Config): RequirementV2 {
  return {
    scheme: "exact",
    network: cfg.caip2,
    amount: cfg.amount,
    asset: cfg.asset,
    payTo: cfg.payTo,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    extra: { name: cfg.assetName, version: cfg.assetVersion },
  };
}

export function requirementV1(cfg: X402Config, resourceUrl: string): RequirementV1 {
  return {
    scheme: "exact",
    network: cfg.network,
    maxAmountRequired: cfg.amount,
    resource: resourceUrl,
    description: cfg.description,
    mimeType: "application/json",
    payTo: cfg.payTo,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    asset: cfg.asset,
    extra: { name: cfg.assetName, version: cfg.assetVersion },
  };
}

export function paymentRequiredV2(cfg: X402Config, resourceUrl: string, error?: string): PaymentRequiredV2 {
  return {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: { url: resourceUrl, description: cfg.description, mimeType: "application/json", serviceName: cfg.serviceName },
    accepts: [requirementV2(cfg)],
  };
}

// ---------------------------------------------------------------- base64 JSON (headers carry base64-encoded JSON)

export function b64encodeJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin);
}

export function b64decodeJson(text: string): unknown {
  const bin = atob(text.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

// ---------------------------------------------------------------- the client's payment

export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface ExactEvmPayload {
  signature: Hex;
  authorization: Eip3009Authorization;
}

export interface ParsedPayment {
  version: 1 | 2;
  /** The object posted to the facilitator as `paymentPayload`, exactly as the client sent it. */
  paymentPayload: Record<string, unknown>;
  payload: ExactEvmPayload;
  payer: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function exactPayload(v: unknown): ExactEvmPayload | null {
  if (!isRecord(v) || typeof v.signature !== "string" || !isRecord(v.authorization)) return null;
  const a = v.authorization;
  const fields = ["from", "to", "value", "validAfter", "validBefore", "nonce"] as const;
  if (!fields.every((f) => typeof a[f] === "string")) return null;
  return { signature: v.signature as Hex, authorization: Object.fromEntries(fields.map((f) => [f, a[f] as string])) as unknown as Eip3009Authorization };
}

/**
 * Parses the payment header the client sent (v2 `PAYMENT-SIGNATURE` first, then v1 `X-PAYMENT`) and checks that it
 * targets this server's requirement: same scheme, network, amount, asset and payee. Anything else is a reason string.
 */
export function parsePayment(cfg: X402Config, headers: { v2?: string | undefined; v1?: string | undefined }): ParsedPayment | { error: string } {
  const raw = headers.v2 ?? headers.v1;
  if (!raw) return { error: "PAYMENT-SIGNATURE header is required" };
  let body: unknown;
  try {
    body = b64decodeJson(raw);
  } catch {
    return { error: "payment header is not base64-encoded JSON" };
  }
  if (!isRecord(body)) return { error: "payment payload must be a JSON object" };
  const version = body.x402Version;
  if (version !== 1 && version !== 2) return { error: "invalid_x402_version" };
  const payload = exactPayload(body.payload);
  if (!payload) return { error: "invalid_payload" };
  if (version === 2) {
    const accepted = body.accepted;
    if (!isRecord(accepted)) return { error: "invalid_payload: accepted requirement missing" };
    if (accepted.scheme !== "exact") return { error: "unsupported_scheme" };
    if (accepted.network !== cfg.caip2) return { error: "invalid_network" };
    if (accepted.amount !== cfg.amount) return { error: "invalid_exact_evm_payload_authorization_value_mismatch" };
    if (typeof accepted.asset !== "string" || accepted.asset.toLowerCase() !== cfg.asset.toLowerCase()) return { error: "invalid_payment_requirements: asset" };
    if (typeof accepted.payTo !== "string" || accepted.payTo.toLowerCase() !== cfg.payTo.toLowerCase()) return { error: "invalid_exact_evm_payload_recipient_mismatch" };
  } else {
    if (body.scheme !== "exact") return { error: "unsupported_scheme" };
    if (body.network !== cfg.network) return { error: "invalid_network" };
  }
  if (payload.authorization.value !== cfg.amount) return { error: "invalid_exact_evm_payload_authorization_value_mismatch" };
  if (payload.authorization.to.toLowerCase() !== cfg.payTo.toLowerCase()) return { error: "invalid_exact_evm_payload_recipient_mismatch" };
  return { version, paymentPayload: body, payload, payer: payload.authorization.from };
}

// ---------------------------------------------------------------- facilitator

export interface FacilitatorRequest {
  x402Version: 1 | 2;
  paymentPayload: Record<string, unknown>;
  paymentRequirements: RequirementV1 | RequirementV2;
}
export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}
export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  transaction: string;
  network: string;
  payer?: string;
}
export interface Facilitator {
  verify(req: FacilitatorRequest): Promise<VerifyResponse>;
  settle(req: FacilitatorRequest): Promise<SettleResponse>;
}

/** The HTTP facilitator (`POST /verify`, `POST /settle`). Uses the global fetch: this is an external service, never a Worker binding. */
export function createHttpFacilitator(baseUrl: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Facilitator {
  const base = baseUrl.replace(/\/+$/, "");
  async function post<T>(path: string, body: FacilitatorRequest): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`facilitator ${path} answered ${res.status} with a non-JSON body`);
    }
    if (!res.ok) {
      const err = isRecord(json) ? (json.error ?? json.invalidReason ?? json.errorReason) : undefined;
      throw new Error(`facilitator ${path} answered ${res.status}${typeof err === "string" ? `: ${err}` : ""}`);
    }
    return json as T;
  }
  return {
    verify: (req) => post<VerifyResponse>("/verify", req),
    settle: (req) => post<SettleResponse>("/settle", req),
  };
}

// ---------------------------------------------------------------- middleware

export interface X402Deps {
  cfg: X402Config;
  facilitator: Facilitator;
  /** True when this request runs without a partner key on a metered route (the auth middleware decides). */
  isMetered: (c: Context<Env>) => boolean;
  correlationId?: (c: Context<Env>) => string | undefined;
  log?: (line: string) => void;
}

/** What the 402 carries: the v2 object in the `PAYMENT-REQUIRED` header, the v1 shape (plus the v2 object) in the body. */
export function paymentRequiredResponse(c: Context<Env>, deps: X402Deps, error: string): Response {
  const url = c.req.url;
  const v2 = paymentRequiredV2(deps.cfg, url, error);
  c.header("PAYMENT-REQUIRED", b64encodeJson(v2));
  c.header("cache-control", "no-store");
  return c.json(
    {
      x402Version: 1,
      error,
      accepts: [requirementV1(deps.cfg, url)],
      v2,
      price: { usdc: deps.cfg.priceUsdc, atomic: deps.cfg.amount, asset: deps.cfg.asset, network: deps.cfg.network },
      hint: "partners send Authorization: Bearer <partner key> and are not metered; everyone else pays per call through x402 (PAYMENT-SIGNATURE header, or X-PAYMENT for v1 clients)",
      correlationId: deps.correlationId?.(c),
    },
    402,
  );
}

/**
 * Runs the x402 flow on metered requests: 402 with requirements when no payment is attached, verify before the
 * route, settle after a 2xx, `PAYMENT-RESPONSE` (and `X-PAYMENT-RESPONSE`) on the way out. A route that answers
 * non-2xx is never settled: the client is not charged for a refusal.
 */
export function x402Middleware<E extends Env>(deps: X402Deps): MiddlewareHandler<E> {
  return async (c, next) => {
    const ctx = c as unknown as Context<Env>;
    if (!deps.isMetered(ctx)) return next();
    const parsed = parsePayment(deps.cfg, { v2: c.req.header("payment-signature"), v1: c.req.header("x-payment") });
    if ("error" in parsed) return paymentRequiredResponse(ctx, deps, parsed.error);
    const requirements = parsed.version === 2 ? requirementV2(deps.cfg) : requirementV1(deps.cfg, c.req.url);
    const req: FacilitatorRequest = { x402Version: parsed.version, paymentPayload: parsed.paymentPayload, paymentRequirements: requirements };

    let verified: VerifyResponse;
    try {
      verified = await deps.facilitator.verify(req);
    } catch (err) {
      deps.log?.(`x402 verify failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.json({ error: "facilitator unavailable", stage: "verify", detail: err instanceof Error ? err.message : String(err), correlationId: deps.correlationId?.(ctx) }, 502);
    }
    if (!verified.isValid) return paymentRequiredResponse(ctx, deps, verified.invalidReason ?? "payment invalid");

    await next();

    const status = c.res.status;
    if (status < 200 || status >= 300) return;
    let settled: SettleResponse;
    try {
      settled = await deps.facilitator.settle(req);
    } catch (err) {
      deps.log?.(`x402 settle failed: ${err instanceof Error ? err.message : String(err)}`);
      c.res = Response.json({ error: "facilitator unavailable", stage: "settle", detail: err instanceof Error ? err.message : String(err), correlationId: deps.correlationId?.(ctx) }, { status: 502 });
      return;
    }
    const encoded = b64encodeJson(settled);
    if (!settled.success) {
      deps.log?.(`x402 settlement refused: ${settled.errorReason ?? "unknown"} payer=${parsed.payer}`);
      const body = { error: "payment settlement failed", reason: settled.errorReason ?? "unknown", payer: parsed.payer, correlationId: deps.correlationId?.(ctx) };
      c.res = Response.json(body, { status: 402 as ContentfulStatusCode, headers: { "PAYMENT-RESPONSE": encoded, "X-PAYMENT-RESPONSE": encoded, "cache-control": "no-store" } });
      return;
    }
    deps.log?.(`x402 settled ${deps.cfg.amount} ${deps.cfg.assetName} from ${parsed.payer} tx=${settled.transaction}`);
    const out = new Response(c.res.body, c.res);
    out.headers.set("PAYMENT-RESPONSE", encoded);
    out.headers.set("X-PAYMENT-RESPONSE", encoded);
    c.res = out;
  };
}
