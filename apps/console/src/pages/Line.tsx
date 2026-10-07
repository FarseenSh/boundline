import { formatEt } from "@boundline/sdk";
import { ErrorNote } from "../components/ErrorNote.jsx";
import { Tag } from "../components/Tag.jsx";
import { Timeline, type Step } from "../components/Timeline.jsx";
import { useDecisions, useLine } from "../hooks.js";
import { formatUsdc } from "../policy.js";
import { Link } from "../router.js";
import { buildLineTimeline, explorerTx, statusTone } from "../timeline.js";
import { marketName } from "./Obligations.jsx";

function quoteLine(quote: Record<string, unknown>): string {
  const reason = typeof quote.reason === "string" ? quote.reason : "UNKNOWN";
  const session = typeof quote.session === "string" ? quote.session : null;
  const availableRaw = quote.available && typeof quote.available === "object" ? (quote.available as { baseUnits?: string }).baseUnits : null;
  const available = availableRaw && /^\d+$/.test(availableRaw) ? formatUsdc(availableRaw) : null;
  const parts = [`reason ${reason}`];
  if (session) parts.push(`session ${session}`);
  if (available) parts.push(`available $${available}`);
  if (typeof quote.detail === "string") parts.push(quote.detail);
  return parts.join(" · ");
}

export function LinePage({ lineId }: { lineId: string }) {
  const line = useLine(lineId);
  const decisions = useDecisions(lineId);
  const steps: Step[] =
    decisions.data
      ? buildLineTimeline(decisions.data).map((r) => ({
          state: r.kind === "decision" ? "done" : "idle",
          when: formatEt(r.blockTime, { date: true, seconds: true }),
          label: r.kind === "decision" ? r.label : <span className="ink2">{r.label}</span>,
          detail: (
            <>
              {r.detail ? <span>{r.detail} · </span> : null}
              {r.hash ? (
                <a href={`/api/v1/decisions/${r.hash}`} title={r.hash}>
                  <code>decision {r.hash.slice(0, 10)}…</code>
                </a>
              ) : null}{" "}
              <a href={explorerTx(decisions.data!.chainId, r.txHash)} title={r.txHash}>
                <code>tx {r.txHash.slice(0, 10)}…</code>
              </a>
            </>
          ),
        }))
      : [];
  return (
    <>
      <p className="mute">
        <Link to="/">← Obligations</Link>
      </p>
      <h1>Line #{lineId}</h1>
      {line.error ? <ErrorNote error={line.error} what="Line" /> : null}
      {line.data ? (
        <div className="panel">
          <div className="grid">
            <div className="kv">
              <span>Status</span>
              <span>
                <Tag tone={statusTone(line.data.line.status)}>{line.data.line.status}</Tag> <Tag tone={statusTone(line.data.obligationStatus)}>{line.data.obligationStatus}</Tag>
              </span>
            </div>
            <div className="kv">
              <span>Market</span>
              <span title={line.data.line.marketId}>{marketName(line.data.line.marketId)}</span>
            </div>
            <div className="kv">
              <span>User</span>
              <span>
                <code>{line.data.line.user}</code>
              </span>
            </div>
            <div className="kv">
              <span>Drawn principal</span>
              <span>${formatUsdc(line.data.line.drawnPrincipal.baseUnits)}</span>
            </div>
            <div className="kv">
              <span>Policy version</span>
              <span>{line.data.line.policyVersion}</span>
            </div>
            <div className="kv">
              <span>Opened</span>
              <span>{formatEt(line.data.line.openedAt, { date: true })}</span>
            </div>
          </div>
          <p className="mute">Quote now: {quoteLine(line.data.quote)} · read at {formatEt(line.data.readAt, { seconds: true })}</p>
        </div>
      ) : null}
      <h2>Decision timeline</h2>
      <div className="panel">
        {decisions.error ? <ErrorNote error={decisions.error} what="Decisions" /> : null}
        {decisions.isLoading ? <p className="mute">Reading the indexer…</p> : null}
        {decisions.data && steps.length === 0 ? <p className="mute">No events indexed for this line yet.</p> : null}
        {steps.length > 0 ? <Timeline steps={steps} /> : null}
        {decisions.data ? (
          <p className="mute">
            {decisions.data.count} decision{decisions.data.count === 1 ? "" : "s"} · desk <code>{decisions.data.desk}</code> · each hash binds chain, desk and a nonce; the indexer's daily root covers them all.
          </p>
        ) : null}
      </div>
    </>
  );
}
