// The console's client for its own Worker proxy. A pasted partner key goes out as a bearer (the Worker forwards
// it); without one the Worker adds its own. Every error carries the status and the API's body so the pages can
// say exactly what happened (a 404 means "not live yet" for the routes Lane D is adding).
import { ENV } from "./env.js";
import { getPastedKey } from "./keystore.js";
import { mockRequest } from "./mock.js";
import type { ApiError } from "./types.js";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
    readonly path: string,
  ) {
    super(body?.error ? `${body.error}${body.detail ? ` (${body.detail})` : ""}` : `request to ${path} answered ${status}`);
    this.name = "ApiRequestError";
  }
  get notLive(): boolean {
    return this.status === 404 || this.status === 501;
  }
}

export interface ApiResult<T> {
  data: T;
  correlationId: string | null;
  policyVersion: number | null;
  replay: boolean;
}

function headers(extra: Record<string, string> = {}): Headers {
  const h = new Headers({ accept: "application/json", ...extra });
  const key = getPastedKey();
  if (key) h.set("authorization", `Bearer ${key}`);
  return h;
}

async function parse<T>(res: Response, path: string): Promise<ApiResult<T>> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: `non-JSON answer (${res.status})`, detail: text.slice(0, 200) };
  }
  if (!res.ok) throw new ApiRequestError(res.status, (body as ApiError | null) ?? { error: `HTTP ${res.status}` }, path);
  const pv = res.headers.get("x-policy-version");
  return { data: body as T, correlationId: res.headers.get("x-correlation-id"), policyVersion: pv ? Number(pv) : null, replay: res.headers.get("x-idempotent-replay") === "true" };
}

export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  if (ENV.mock) {
    const r = mockRequest("GET", path);
    if (r.status >= 400) throw new ApiRequestError(r.status, r.body as ApiError, path);
    return { data: r.body as T, correlationId: "mock", policyVersion: null, replay: false };
  }
  const res = await fetch(`${ENV.apiBase}${path}`, { headers: headers(), cache: "no-store" });
  return parse<T>(res, path);
}

export function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function apiPost<T>(path: string, body: unknown, idempotencyKey: string = newIdempotencyKey()): Promise<ApiResult<T>> {
  if (ENV.mock) {
    const r = mockRequest("POST", path, body);
    if (r.status >= 400) throw new ApiRequestError(r.status, r.body as ApiError, path);
    return { data: r.body as T, correlationId: "mock", policyVersion: null, replay: false };
  }
  const res = await fetch(`${ENV.apiBase}${path}`, {
    method: "POST",
    headers: headers({ "content-type": "application/json", "idempotency-key": idempotencyKey }),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return parse<T>(res, path);
}

/** DELETE through the proxy (removing a webhook); a 204 answers with `data: null`. */
export async function apiDelete(path: string): Promise<ApiResult<null>> {
  if (ENV.mock) {
    const r = mockRequest("DELETE", path);
    if (r.status >= 400) throw new ApiRequestError(r.status, r.body as ApiError, path);
    return { data: null, correlationId: "mock", policyVersion: null, replay: false };
  }
  const res = await fetch(`${ENV.apiBase}${path}`, { method: "DELETE", headers: headers(), cache: "no-store" });
  return parse<null>(res, path);
}

/** The whole bundle as a file, through the same proxy (a plain link could not carry a pasted key). */
export async function downloadJson(path: string, filename: string): Promise<void> {
  let text: string;
  if (ENV.mock) text = JSON.stringify(mockRequest("GET", path).body, null, 2);
  else {
    const res = await fetch(`${ENV.apiBase}${path}`, { headers: headers(), cache: "no-store" });
    if (!res.ok) throw new ApiRequestError(res.status, null, path);
    text = await res.text();
  }
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
