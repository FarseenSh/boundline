// x402 metering of the agent's REST aliases (plan M12: "the same endpoints metered by x402"). A caller without a partner
// key pays $0.01 USDC on Base Sepolia per tool call through the x402.org facilitator; a partner key (checked against
// the partner API) is never metered; the MCP endpoint stays free. A copy of apps/api/src/x402.ts's protocol code
// without the Hono middleware (the agent is a plain fetch handler and the Workers do not import each other): v2
// (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`, CAIP-2 networks) and v1 (`X-PAYMENT` /
// `X-PAYMENT-RESPONSE`) side by side, as the public facilitator supports both. A refusal is never settled.
export type Address = `0x${string}`;

export interface X402Config {
  payTo: Address;
  network: string;
  caip2: string;
  asset: Address;
  assetName: string;
  assetVersion: string;
  /** Atomic units of the asset ("10000" = $0.01 of USDC). */
  amount: string;
  priceUsdc: string;
  maxTimeoutSeconds: number;
  serviceName: string;
  description: string;
}

export const CAIP2: Readonly<Record<string, string>> = { "base-sepolia": "eip155:84532", base: "eip155:8453" };
export const USDC_BY_NETWORK: Readonly<Record<string, Address>> = {
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function usdcToAtomic(price: string): string {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(price.trim());
  if (!m) throw new Error(`price must be a decimal USDC amount with at most six decimals: ${price}`);
  return (BigInt(m[1] as string) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"))).toString();
}

export interface X402Env {
  X402_ENABLED?: string;
  X402_PAY_TO?: string;
  X402_FACILITATOR?: string;
  X402_NETWORK?: string;
  X402_PRICE_USDC?: string;
}

/** The config from the vars; null when metering is off. Misconfiguration throws, loudly. */
export function x402ConfigFrom(env: X402Env): X402Config | null {
  if (env.X402_ENABLED !== "true") return null;
  const network = (env.X402_NETWORK || "base-sepolia").trim();
  const caip2 = CAIP2[network];
  if (!caip2) throw new Error(`X402_NETWORK ${network} is not a network the agent meters on`);
  if (!env.X402_PAY_TO || !ADDRESS.test(env.X402_PAY_TO)) throw new Error("X402_PAY_TO must be an address");
  const asset = USDC_BY_NETWORK[network];
  if (!asset) throw new Error(`no USDC known on ${network}`);
  const priceUsdc = (env.X402_PRICE_USDC || "0.01").trim();
  return {
    payTo: env.X402_PAY_TO as Address,
    network,
    caip2,
    asset,
    assetName: "USDC",
    assetVersion: "2",
    amount: usdcToAtomic(priceUsdc),
    priceUsdc,
    maxTimeoutSeconds: 300,
    serviceName: "Boundline agent surface",
    description: "Boundline agent tools over REST: session, positions, shadow health, quotes, protection and routes for tokenized stocks on Base",
  };
}

export function requirementV2(cfg: X402Config) {
  return { scheme: "exact" as const, network: cfg.caip2, amount: cfg.amount, asset: cfg.asset, payTo: cfg.payTo, maxTimeoutSeconds: cfg.maxTimeoutSeconds, extra: { name: cfg.assetName, version: cfg.assetVersion } };
}

export function requirementV1(cfg: X402Config, resource: string) {
  return {
    scheme: "exact" as const,
    network: cfg.network,
    maxAmountRequired: cfg.amount,
    resource,
    description: cfg.description,
    mimeType: "application/json",
    payTo: cfg.payTo,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    asset: cfg.asset,
    extra: { name: cfg.assetName, version: cfg.assetVersion },
  };
}

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

export interface ParsedPayment {
  version: 1 | 2;
  paymentPayload: Record<string, unknown>;
  payer: string;
}

/** The client's payment header checked against this server's requirement (scheme, network, amount, asset, payee). */
export function parsePayment(cfg: X402Config, headers: { v2?: string | null; v1?: string | null }): ParsedPayment | { error: string } {
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
  const p = body.payload;
  if (!isRecord(p) || typeof p.signature !== "string" || !isRecord(p.authorization)) return { error: "invalid_payload" };
  const a = p.authorization;
  if (!["from", "to", "value", "validAfter", "validBefore", "nonce"].every((f) => typeof a[f] === "string")) return { error: "invalid_payload" };
  if (version === 2) {
    const acc = body.accepted;
    if (!isRecord(acc)) return { error: "invalid_payload: accepted requirement missing" };
    if (acc.scheme !== "exact") return { error: "unsupported_scheme" };
    if (acc.network !== cfg.caip2) return { error: "invalid_network" };
    if (acc.amount !== cfg.amount) return { error: "invalid_exact_evm_payload_authorization_value_mismatch" };
    if (typeof acc.asset !== "string" || acc.asset.toLowerCase() !== cfg.asset.toLowerCase()) return { error: "invalid_payment_requirements: asset" };
    if (typeof acc.payTo !== "string" || acc.payTo.toLowerCase() !== cfg.payTo.toLowerCase()) return { error: "invalid_exact_evm_payload_recipient_mismatch" };
  } else {
    if (body.scheme !== "exact") return { error: "unsupported_scheme" };
    if (body.network !== cfg.network) return { error: "invalid_network" };
  }
  if (a.value !== cfg.amount) return { error: "invalid_exact_evm_payload_authorization_value_mismatch" };
  if (String(a.to).toLowerCase() !== cfg.payTo.toLowerCase()) return { error: "invalid_exact_evm_payload_recipient_mismatch" };
  return { version, paymentPayload: body, payer: String(a.from) };
}

export interface FacilitatorRequest {
  x402Version: 1 | 2;
  paymentPayload: Record<string, unknown>;
  paymentRequirements: unknown;
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

/** The HTTP facilitator (`POST /verify`, `POST /settle`) over the global fetch: an external service, never a binding. */
export function createHttpFacilitator(baseUrl: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Facilitator {
  const base = baseUrl.replace(/\/+$/, "");
  async function post<T>(path: string, body: FacilitatorRequest): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(25_000) });
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
  return { verify: (req) => post<VerifyResponse>("/verify", req), settle: (req) => post<SettleResponse>("/settle", req) };
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

/** 402 with the requirements: the v2 object in the `PAYMENT-REQUIRED` header, the v1 shape plus the v2 object in the body. */
export function paymentRequired(cfg: X402Config, url: string, error: string): Response {
  const v2 = { x402Version: 2, error, resource: { url, description: cfg.description, mimeType: "application/json", serviceName: cfg.serviceName }, accepts: [requirementV2(cfg)] };
  return jsonResponse(
    {
      x402Version: 1,
      error,
      accepts: [requirementV1(cfg, url)],
      v2,
      price: { usdc: cfg.priceUsdc, atomic: cfg.amount, asset: cfg.asset, network: cfg.network },
      hint: "send Authorization: Bearer <partner key> (never metered), pay per call through x402 (PAYMENT-SIGNATURE, or X-PAYMENT for v1 clients), or use the free MCP endpoint POST /mcp",
    },
    402,
    { "PAYMENT-REQUIRED": b64encodeJson(v2) },
  );
}

/**
 * Runs `handler` behind a payment: 402 without one, verify before, settle only after a 2xx, `PAYMENT-RESPONSE` (and
 * `X-PAYMENT-RESPONSE`) on the way out. A non-2xx answer is never settled: nobody pays for a refusal.
 */
export async function meter(request: Request, cfg: X402Config, facilitator: Facilitator, handler: () => Promise<Response>, log: (line: string) => void = () => undefined): Promise<Response> {
  const parsed = parsePayment(cfg, { v2: request.headers.get("payment-signature"), v1: request.headers.get("x-payment") });
  if ("error" in parsed) return paymentRequired(cfg, request.url, parsed.error);
  const req: FacilitatorRequest = { x402Version: parsed.version, paymentPayload: parsed.paymentPayload, paymentRequirements: parsed.version === 2 ? requirementV2(cfg) : requirementV1(cfg, request.url) };
  let verified: VerifyResponse;
  try {
    verified = await facilitator.verify(req);
  } catch (err) {
    return jsonResponse({ error: "facilitator unavailable", stage: "verify", detail: err instanceof Error ? err.message : String(err) }, 502);
  }
  if (!verified.isValid) return paymentRequired(cfg, request.url, verified.invalidReason ?? "payment invalid");
  const res = await handler();
  if (res.status < 200 || res.status >= 300) return res;
  let settled: SettleResponse;
  try {
    settled = await facilitator.settle(req);
  } catch (err) {
    log(`x402 settle failed: ${err instanceof Error ? err.message : String(err)}`);
    return jsonResponse({ error: "facilitator unavailable", stage: "settle", detail: err instanceof Error ? err.message : String(err) }, 502);
  }
  const encoded = b64encodeJson(settled);
  if (!settled.success) {
    log(`x402 settlement refused: ${settled.errorReason ?? "unknown"} payer=${parsed.payer}`);
    return jsonResponse({ error: "payment settlement failed", reason: settled.errorReason ?? "unknown", payer: parsed.payer }, 402, { "PAYMENT-RESPONSE": encoded, "X-PAYMENT-RESPONSE": encoded });
  }
  log(`x402 settled ${cfg.amount} ${cfg.assetName} from ${parsed.payer} tx=${settled.transaction}`);
  const out = new Response(res.body, res);
  out.headers.set("PAYMENT-RESPONSE", encoded);
  out.headers.set("X-PAYMENT-RESPONSE", encoded);
  return out;
}
