// Pure helpers behind the Webhooks page: event selection, form checks, the memory of which webhook points at the
// API's built-in echo receiver, and an independent check of an echoed delivery's signature in the browser.
// The signing secret is shown once by the API; for echo webhooks the console keeps it in sessionStorage (gone with
// the tab, same policy as a pasted partner key) so it can re-verify what the receiver got. Nothing else is stored.
import { verifyWebhookSignature, WEBHOOK_EVENT_TYPES, type EchoDelivery, type WebhookEventType } from "@boundline/sdk";

export type EventChoice = WebhookEventType | "*";

export const EVENT_CHOICES: readonly EventChoice[] = Object.freeze(["*", ...WEBHOOK_EVENT_TYPES]);

/** "*" means every event and excludes the others; picking a specific event drops "*". Order follows EVENT_CHOICES. */
export function toggleEvent(selected: readonly EventChoice[], choice: EventChoice): EventChoice[] {
  const has = selected.includes(choice);
  let next: EventChoice[];
  if (choice === "*") next = has ? [] : ["*"];
  else next = has ? selected.filter((c) => c !== choice) : [...selected.filter((c) => c !== "*"), choice];
  return EVENT_CHOICES.filter((c) => next.includes(c));
}

export function validateWebhookForm(form: { url: string; events: readonly EventChoice[] }): string[] {
  const errors: string[] = [];
  let url: URL | null = null;
  try {
    url = new URL(form.url.trim());
  } catch {
    errors.push("the URL is not a valid URL");
  }
  if (url && url.protocol !== "https:") errors.push("deliveries go only to https URLs");
  if (url && /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(url.hostname)) errors.push("a local address cannot receive deliveries from the API");
  if (form.events.length === 0) errors.push("choose at least one event");
  return errors;
}

export interface EchoMemory {
  token: string;
  /** Present only in the tab that registered the webhook. */
  secret: string | null;
}

const TOKEN_KEY = (id: string): string => `boundline-console-echo-token:${id}`;
const SECRET_KEY = (id: string): string => `boundline-console-echo-secret:${id}`;

/** Remember that webhook `id` delivers to the echo receiver `token`; the token survives reloads, the secret only the tab. */
export function rememberEcho(id: string, token: string, secret: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY(id), token);
    window.sessionStorage.setItem(SECRET_KEY(id), secret);
  } catch {
    /* storage can be blocked: the page still works, the echo panel just forgets after a reload */
  }
}

export function echoFor(id: string): EchoMemory | null {
  try {
    const token = window.localStorage.getItem(TOKEN_KEY(id));
    if (!token) return null;
    return { token, secret: window.sessionStorage.getItem(SECRET_KEY(id)) };
  } catch {
    return null;
  }
}

export function forgetEcho(id: string): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY(id));
    window.sessionStorage.removeItem(SECRET_KEY(id));
  } catch {
    /* nothing to do */
  }
}

/** The echo token at the end of an echo receiver URL, or null for any other URL. */
export function echoTokenOf(url: string): string | null {
  const m = /\/v1\/webhooks\/echo\/([0-9a-f]{16,64})$/.exec(url);
  return m?.[1] ?? null;
}

function headerOf(d: EchoDelivery, name: string): string | null {
  const h = d.headers ?? {};
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name.toLowerCase()) return v;
  return null;
}

/**
 * The body bytes to check a signature against: the raw text when the receiver kept it; otherwise the parsed JSON
 * serialised again. The API signs compact `JSON.stringify` output, which a JSON round trip reproduces byte for byte,
 * and an HMAC match proves those exact bytes were signed, so a match on a re-serialised body is still a verification.
 */
export function rawBodyOf(d: EchoDelivery): { raw: string; reserialised: boolean } | null {
  if (typeof d.rawBody === "string") return { raw: d.rawBody, reserialised: false };
  if (typeof d.body === "string") return { raw: d.body, reserialised: false };
  if (d.body !== null && typeof d.body === "object") return { raw: JSON.stringify(d.body), reserialised: true };
  return null;
}

export type LocalCheck = "verified" | "mismatch" | "no-secret" | "no-raw-body" | "no-signature";

/** Re-checks an echoed delivery's signature in the browser with the secret this tab kept (age is not checked: it is a replay). */
export async function checkEchoDelivery(d: EchoDelivery, secret: string | null): Promise<LocalCheck> {
  return (await checkEchoDeliveryDetail(d, secret)).check;
}

export async function checkEchoDeliveryDetail(d: EchoDelivery, secret: string | null): Promise<{ check: LocalCheck; reserialised: boolean }> {
  if (!secret) return { check: "no-secret", reserialised: false };
  const header = d.signature ?? headerOf(d, "boundline-signature");
  if (!header) return { check: "no-signature", reserialised: false };
  const body = rawBodyOf(d);
  if (body === null) return { check: "no-raw-body", reserialised: false };
  const r = await verifyWebhookSignature({ secret, header, rawBody: body.raw, toleranceSeconds: 0 });
  return { check: r.ok ? "verified" : "mismatch", reserialised: body.reserialised };
}

/** The receiver's own verdict: `verified` in the contract, `signatureValid` + `verification` in the partner API. */
export function receiverVerdict(d: EchoDelivery): { ok: boolean | null; words: string | null } {
  const ok = typeof d.verified === "boolean" ? d.verified : typeof d.signatureValid === "boolean" ? d.signatureValid : null;
  return { ok, words: typeof d.verification === "string" ? d.verification : null };
}

/** "shadowLtvBps 5310 · graceLtvBps 5200" for an event's data. */
export function summarizeData(data: Record<string, unknown> | undefined): string {
  if (!data) return "";
  return Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(" · ");
}
