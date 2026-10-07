import { formatEt } from "@boundline/sdk";
import { ErrorNote } from "../components/ErrorNote.jsx";
import { Tag } from "../components/Tag.jsx";
import { useReconciliation, useSources } from "../hooks.js";
import { statusTone } from "../timeline.js";
import type { ApiError, ReconcileCheck, ReconcileLatest, RootsResponse } from "../types.js";
import { marketName } from "./Obligations.jsx";

function isError(v: unknown): v is ApiError {
  return Boolean(v && typeof v === "object" && "error" in (v as Record<string, unknown>));
}

function subjectWords(subject: string): string {
  const [kind, ...rest] = subject.split(":");
  if (kind === "market" && rest[0]) return `market ${marketName(rest[0])}`;
  if (kind === "position" && rest[0] && rest[1]) return `position ${rest[1].slice(0, 6)}…${rest[1].slice(-4)} on ${marketName(rest[0])}`;
  return subject;
}

function CheckRow({ c }: { c: ReconcileCheck }) {
  const keys = [...new Set([...Object.keys(c.expected ?? {}), ...Object.keys(c.actual ?? {})])];
  return (
    <tr>
      <td>
        <Tag tone={statusTone(c.status)}>{c.status}</Tag>
      </td>
      <td title={c.subject}>{subjectWords(c.subject)}</td>
      <td>
        <table className="inner">
          <tbody>
            {keys.map((k) => {
              const same = (c.expected?.[k] ?? "") === (c.actual?.[k] ?? "");
              return (
                <tr key={k} className={same ? "" : "coral"}>
                  <td>{k}</td>
                  <td className="num">
                    <code>{c.expected?.[k] ?? "—"}</code>
                  </td>
                  <td className="num">
                    <code>{c.actual?.[k] ?? "—"}</code>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </td>
    </tr>
  );
}

export function Reconciliation() {
  const q = useReconciliation();
  const sources = useSources();
  const reconcile: ReconcileLatest | null = q.data && q.data.reconcile && !isError(q.data.reconcile) ? q.data.reconcile : null;
  const roots: RootsResponse | null = q.data && q.data.roots && !isError(q.data.roots) ? q.data.roots : null;
  return (
    <>
      <h1>Reconciliation</h1>
      <p className="lede">The indexer's own books against the chain: every market and position it tracks is re-read live and compared, and every day's events fold into a hash-chained root anyone can recompute.</p>
      {q.error ? <ErrorNote error={q.error} what="Reconciliation" /> : null}
      {q.isLoading ? <p className="mute">Reading the indexer…</p> : null}
      {q.data && isError(q.data.reconcile) ? <p className="notice">Reconcile: {q.data.reconcile.error}</p> : null}
      {reconcile ? (
        <div className="panel wrap">
          <div className="row between">
            <h3>
              Latest run <Tag tone={statusTone(reconcile.status)}>{reconcile.status}</Tag>
            </h3>
            <span className="mute">
              {formatEt(reconcile.checkedAt, { date: true, seconds: true })} · block {reconcile.blockNumber.toLocaleString("en-US")} · chain {reconcile.chainId} · {reconcile.checks.length} check{reconcile.checks.length === 1 ? "" : "s"}
            </span>
          </div>
          <table className="ledger">
            <thead>
              <tr>
                <th>Result</th>
                <th>Subject</th>
                <th>Expected vs actual</th>
              </tr>
            </thead>
            <tbody>
              {reconcile.checks.map((c, i) => (
                <CheckRow key={c.id ?? i} c={c} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <h2>Daily roots</h2>
      {q.data && isError(q.data.roots) ? <p className="notice">Roots: {q.data.roots.error}</p> : null}
      {roots ? (
        <div className="panel wrap">
          {roots.scheme ? (
            <p>
              <code>{roots.scheme}</code>
            </p>
          ) : null}
          <table className="ledger">
            <thead>
              <tr>
                <th>Day (UTC)</th>
                <th className="num">Events</th>
                <th className="num">Blocks</th>
                <th>Root</th>
                <th>Previous</th>
              </tr>
            </thead>
            <tbody>
              {roots.today ? (
                <tr>
                  <td>{roots.today.day} (so far)</td>
                  <td className="num">{roots.today.eventCount}</td>
                  <td className="num">—</td>
                  <td>
                    <code title={roots.today.rootSoFar}>{roots.today.rootSoFar.slice(0, 14)}…</code>
                  </td>
                  <td>—</td>
                </tr>
              ) : null}
              {roots.roots.map((r) => (
                <tr key={r.day}>
                  <td>{r.day}</td>
                  <td className="num">{r.eventCount}</td>
                  <td className="num">{r.firstBlock !== null && r.lastBlock !== null ? `${r.firstBlock.toLocaleString("en-US")}–${r.lastBlock.toLocaleString("en-US")}` : "—"}</td>
                  <td>
                    <code title={r.root}>{r.root.slice(0, 14)}…{r.root.slice(-6)}</code>
                  </td>
                  <td>
                    <code title={r.prevRoot}>{r.prevRoot.slice(0, 10)}…</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <h2>Indexer sources</h2>
      {sources.error ? <ErrorNote error={sources.error} what="Sources" /> : null}
      {sources.data ? (
        <div className="panel wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th>Source</th>
                <th className="num">Chain</th>
                <th className="num">Addresses</th>
                <th className="num">Cursor block</th>
                <th>Cursor time</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {sources.data.sources.map((s) => (
                <tr key={s.id}>
                  <td>
                    <code>{s.id}</code>
                  </td>
                  <td className="num">{s.chainId}</td>
                  <td className="num">{s.addresses}</td>
                  <td className="num">{s.cursor ? s.cursor.lastBlock.toLocaleString("en-US") : "—"}</td>
                  <td>{s.cursor ? formatEt(s.cursor.lastBlockTime, { date: true, seconds: true }) : "—"}</td>
                  <td>{s.cursor ? formatEt(s.cursor.updatedAt, { seconds: true }) : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
