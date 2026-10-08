// Webhooks: where Boundline posts a partner's line events (grace, protect, hold, release, recovery, settle). Register
// an https endpoint and choose events; the signing secret is shown once. "Use the built-in echo receiver" registers the
// partner API's own demo receiver, so a test delivery can be watched end to end without running a server, and this tab
// re-checks each echoed signature with the secret it was shown.
import { echoReceiverUrl, formatEt, newEchoToken, WEBHOOK_EVENT_COPY, type EchoDelivery, type WebhookCreated, type WebhookSummary } from "@boundline/sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiDelete, apiPost } from "../api.js";
import { ErrorNote } from "../components/ErrorNote.jsx";
import { Tag } from "../components/Tag.jsx";
import { ENV } from "../env.js";
import { useDeliveries, useEcho, useWebhooks } from "../hooks.js";
import type { Tone } from "../timeline.js";
import { checkEchoDeliveryDetail, echoFor, echoTokenOf, EVENT_CHOICES, forgetEcho, receiverVerdict, rememberEcho, toggleEvent, validateWebhookForm, type EventChoice, type LocalCheck } from "../webhooks.js";

function deliveryTone(status: string): Tone {
  return status === "delivered" ? "live" : status === "failed" ? "bad" : status === "pending" ? "warn" : "plain";
}

const LOCAL_CHECK_WORDS: Record<LocalCheck, string> = {
  verified: "signature verified in this tab",
  mismatch: "signature does NOT match the secret",
  "no-secret": "secret not kept in this tab (registered elsewhere)",
  "no-raw-body": "receiver kept no raw body to check",
  "no-signature": "no signature header recorded",
};

function EchoRow({ d, secret }: { d: EchoDelivery; secret: string | null }) {
  const [check, setCheck] = useState<{ check: LocalCheck; reserialised: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    void checkEchoDeliveryDetail(d, secret).then((c) => alive && setCheck(c));
    return () => {
      alive = false;
    };
  }, [d, secret]);
  const at = typeof d.receivedAt === "number" ? d.receivedAt : null;
  const type = d.type ?? d.event ?? (typeof d.body === "object" && d.body ? String((d.body as { type?: unknown }).type ?? "") : "");
  const receiver = receiverVerdict(d);
  return (
    <tr>
      <td>{at ? formatEt(at, { seconds: true }) : "—"}</td>
      <td>{type || "—"}</td>
      <td>
        <Tag tone={receiver.ok === true ? "live" : receiver.ok === false ? "bad" : "plain"} title={receiver.words ?? undefined}>
          {receiver.ok === true ? "receiver: valid" : receiver.ok === false ? `receiver: ${receiver.words ?? "invalid"}` : "receiver: not checked"}
        </Tag>
      </td>
      <td>
        {check ? (
          <Tag tone={check.check === "verified" ? "live" : check.check === "mismatch" ? "bad" : "plain"} title={check.reserialised ? "checked against the JSON body serialised again (the receiver keeps the parsed body)" : undefined}>
            {LOCAL_CHECK_WORDS[check.check]}
            {check.reserialised && (check.check === "verified" || check.check === "mismatch") ? " (re-serialised body)" : ""}
          </Tag>
        ) : (
          "…"
        )}
      </td>
      <td>
        <code title={typeof d.body === "string" ? d.body : JSON.stringify(d.body)}>{d.deliveryId ?? "—"}</code>
      </td>
    </tr>
  );
}

function EchoPanel({ webhookId, token }: { webhookId: string; token: string }) {
  const echo = useEcho(token);
  const secret = echoFor(webhookId)?.secret ?? null;
  const deliveries = echo.data?.deliveries ?? [];
  return (
    <div className="inner-panel">
      <h4>Echo receiver</h4>
      <p className="mute">
        The partner API's built-in receiver at <code>{echoReceiverUrl(ENV.apiPublicUrl, token)}</code> keeps the last deliveries it got. Refreshes every 5 s.
      </p>
      {echo.error ? <ErrorNote error={echo.error} what="Echo receiver" /> : null}
      {deliveries.length === 0 && !echo.error ? <p className="mute">Nothing received yet: send a test.</p> : null}
      {deliveries.length > 0 ? (
        <table className="ledger inner">
          <thead>
            <tr>
              <th>Received (ET)</th>
              <th>Event</th>
              <th>Receiver's check</th>
              <th>This tab's check</th>
              <th>Delivery</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((d, i) => (
              <EchoRow key={`${d.deliveryId ?? i}`} d={d} secret={secret} />
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function WebhookCard({ w }: { w: WebhookSummary }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const deliveries = useDeliveries(open ? w.id : null);
  const echoToken = echoTokenOf(w.url) ?? echoFor(w.id)?.token ?? null;

  const test = async (): Promise<void> => {
    setBusy("test");
    setError(null);
    try {
      const r = await apiPost<{ deliveryId: string }>(`/v1/webhooks/${encodeURIComponent(w.id)}/test`, {});
      setNote(`Test queued: delivery ${r.data.deliveryId}`);
      setOpen(true);
      void qc.invalidateQueries({ queryKey: ["deliveries"] });
      void qc.invalidateQueries({ queryKey: ["echo"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy("delete");
    setError(null);
    try {
      await apiDelete(`/v1/webhooks/${encodeURIComponent(w.id)}`);
      forgetEcho(w.id);
      void qc.invalidateQueries({ queryKey: ["webhooks"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel">
      <div className="row between">
        <h3>
          <Tag tone={w.active ? "live" : "plain"}>{w.active ? "active" : "inactive"}</Tag> <code>{w.url}</code>
        </h3>
        <span className="mute">
          {w.id} · since {formatEt(w.createdAt, { date: true })}
        </span>
      </div>
      <p>
        {w.events.map((e) => (
          <span key={e} className="tag" title={e === "*" ? "every event" : WEBHOOK_EVENT_COPY[e as keyof typeof WEBHOOK_EVENT_COPY]}>
            {e === "*" ? "all events" : e}
          </span>
        ))}{" "}
        {w.description ? <span className="mute">· {w.description}</span> : null}
      </p>
      <p className="mute">
        Last delivery:{" "}
        {w.lastDelivery ? (
          <>
            <Tag tone={deliveryTone(w.lastDelivery.status)}>{w.lastDelivery.status}</Tag> {formatEt(w.lastDelivery.at, { seconds: true })}
            {w.lastDelivery.code !== null ? ` · HTTP ${w.lastDelivery.code}` : ""}
          </>
        ) : (
          "none yet"
        )}
      </p>
      <div className="row">
        {w.active ? (
          <button className="btn small" disabled={busy !== null} onClick={() => void test()}>
            {busy === "test" ? "Sending…" : "Send test"}
          </button>
        ) : null}
        <button className="btn small ghost" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show"} deliveries
        </button>
        {w.active ? (
          <button className="btn small ghost" disabled={busy !== null} onClick={() => void remove()}>
            {busy === "delete" ? "Deleting…" : "Delete"}
          </button>
        ) : (
          <span className="mute">deleted: it receives nothing; its delivery history stays</span>
        )}
        {note ? <span className="live">{note}</span> : null}
        {error ? <span className="coral">{error}</span> : null}
      </div>
      {open ? (
        <>
          {deliveries.error ? <ErrorNote error={deliveries.error} what="Deliveries" /> : null}
          {deliveries.data && deliveries.data.length === 0 ? <p className="mute">No deliveries yet.</p> : null}
          {deliveries.data && deliveries.data.length > 0 ? (
            <table className="ledger inner">
              <thead>
                <tr>
                  <th>Delivery</th>
                  <th>Event</th>
                  <th>Status</th>
                  <th className="num">Attempts</th>
                  <th>Last attempt (ET)</th>
                  <th>Next</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.data.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <code title={`payload ${d.payloadHash}`}>{d.id}</code>
                    </td>
                    <td>{d.type}</td>
                    <td>
                      <Tag tone={deliveryTone(d.status)}>{d.status}</Tag>
                      {d.lastCode !== null ? <span className="mute"> HTTP {d.lastCode}</span> : null}
                      {d.lastError ? <span className="coral small"> {d.lastError}</span> : null}
                    </td>
                    <td className="num">{d.attempts}</td>
                    <td>{d.lastAttemptAt ? formatEt(d.lastAttemptAt, { seconds: true }) : "—"}</td>
                    <td>{d.nextAttemptAt ? formatEt(d.nextAttemptAt, { seconds: true }) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {echoToken ? <EchoPanel webhookId={w.id} token={echoToken} /> : null}
        </>
      ) : null}
    </div>
  );
}

export function Webhooks() {
  const hooks = useWebhooks();
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<EventChoice[]>(["grace", "protect", "hold", "release", "recovery", "settle"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<WebhookCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const errors = url.trim() ? validateWebhookForm({ url, events }) : [];

  const register = async (target: string, desc: string, echoToken: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const r = await apiPost<WebhookCreated>("/v1/webhooks", { url: target, events, ...(desc.trim() ? { description: desc.trim() } : {}) });
      setCreated(r.data);
      if (echoToken) rememberEcho(r.data.id, echoToken, r.data.secret);
      setUrl("");
      setDescription("");
      void qc.invalidateQueries({ queryKey: ["webhooks"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const registerEcho = (): void => {
    const token = newEchoToken();
    void register(echoReceiverUrl(ENV.apiPublicUrl, token), "built-in echo receiver (console demo)", token);
  };

  const copySecret = async (): Promise<void> => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <h1>Webhooks</h1>
      <p className="lede">
        Boundline posts to your server when one of your lines enters grace at the 24/7 price, is protected, is put on hold or released, has collateral recovered, or settles an advance. Every delivery is signed:{" "}
        <code>Boundline-Signature: t=…,v1=HMAC-SHA256(secret, t + "." + body)</code>, retried up to six times with backoff.
      </p>
      {hooks.error ? <ErrorNote error={hooks.error} what="Webhooks" /> : null}

      <div className="panel">
        <h3>Register an endpoint</h3>
        <label className="field">
          <span>HTTPS URL</span>
          <span className="input">
            <input className="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-server.example/boundline" spellCheck={false} />
          </span>
        </label>
        <label className="field">
          <span>Description (optional)</span>
          <span className="input">
            <input className="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="risk desk pager" />
          </span>
        </label>
        <fieldset className="events">
          <legend>Events</legend>
          {EVENT_CHOICES.map((c) => (
            <label key={c} className="field check" title={c === "*" ? "every event, including new ones" : WEBHOOK_EVENT_COPY[c]}>
              <input type="checkbox" checked={events.includes(c)} onChange={() => setEvents((s) => toggleEvent(s, c))} /> <span>{c === "*" ? "all events (*)" : c}</span>
              {c !== "*" ? <span className="mute small"> {WEBHOOK_EVENT_COPY[c]}</span> : null}
            </label>
          ))}
        </fieldset>
        {errors.length > 0 ? (
          <ul className="errors">
            {errors.map((e) => (
              <li key={e} className="coral">
                {e}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="row">
          <button className="btn primary" disabled={busy || !url.trim() || errors.length > 0} onClick={() => void register(url.trim(), description, null)}>
            {busy ? "Registering…" : "Register"}
          </button>
          <button className="btn" disabled={busy || events.length === 0} onClick={registerEcho} title="registers the partner API's own demo receiver with a fresh random token">
            Use the built-in echo receiver
          </button>
        </div>
        {error ? <p className="notice">{error}</p> : null}
      </div>

      {created ? (
        <div className="notice ok">
          <p>
            Registered <code>{created.id}</code> → <code>{created.url}</code>. Its signing secret, shown once (the API keeps only what it needs to sign):
          </p>
          <p className="hashline">
            <code>{created.secret}</code>{" "}
            <button className="btn small" onClick={() => void copySecret()}>
              {copied ? "Copied" : "Copy"}
            </button>
          </p>
          {echoTokenOf(created.url) ? <p>This tab keeps it for the echo receiver below, so it can re-check every echoed signature. Press "Send test" on the endpoint to watch one delivery end to end.</p> : <p>Store it on your server now; verify deliveries with <code>verifyWebhookSignature</code> from <code>@boundline/sdk</code>.</p>}
          <button className="btn small ghost" onClick={() => setCreated(null)}>
            Done
          </button>
        </div>
      ) : null}

      <h2>Endpoints</h2>
      {hooks.isLoading ? <p className="mute">Reading webhooks…</p> : null}
      {hooks.data && hooks.data.length === 0 ? <p className="mute">No endpoints yet.</p> : null}
      {hooks.data?.map((w) => (
        <WebhookCard key={w.id} w={w} />
      ))}

      <h2>Verify a delivery on your server</h2>
      <div className="panel">
        <pre>
          <code>{`import { verifyWebhookSignature } from "@boundline/sdk";

const raw = await request.text(); // the body exactly as received
const check = await verifyWebhookSignature({
  secret: env.BOUNDLINE_WEBHOOK_SECRET,
  header: request.headers.get("Boundline-Signature"),
  rawBody: raw,              // ±300 s tolerance by default
});
if (!check.ok) return new Response(check.reason, { status: 400 });
const event = JSON.parse(raw); // { id, type, createdAt, chainId, partnerId, lineId, data, txHash, decisionHash }`}</code>
        </pre>
      </div>
    </>
  );
}
