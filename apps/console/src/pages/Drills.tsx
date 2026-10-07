import { formatEt } from "@boundline/sdk";
import { ErrorNote } from "../components/ErrorNote.jsx";
import { Tag } from "../components/Tag.jsx";
import { Timeline, type Step } from "../components/Timeline.jsx";
import { useDrills } from "../hooks.js";
import { Link } from "../router.js";
import { explorerTx, latestRun, outcomeTone } from "../timeline.js";
import type { Drill } from "../types.js";

const RUN_COPY = "runs from the keeper on Thu 8 Oct";

export function Drills() {
  const q = useDrills();
  return (
    <>
      <h1>Drills</h1>
      <p className="lede">The failure modes Boundline is built for, each as a scripted drill on the Sepolia book: pinned state, ordered attempts, the expected refusals and the recorded runs with their hashes.</p>
      {q.error ? <ErrorNote error={q.error} what="Drills" /> : null}
      {q.isLoading ? <p className="mute">Reading the drill registry…</p> : null}
      {q.data ? (
        <div className="cards">
          {q.data.map((d) => {
            const last = latestRun(d);
            return (
              <div className="panel card" key={d.id}>
                <div className="row between">
                  <h3>
                    <Link to={`/drills/${d.id}`}>{d.title}</Link>
                  </h3>
                  <Tag>{d.venue}</Tag>
                </div>
                <p>{d.description}</p>
                <p className="mute">
                  {d.steps.length} step{d.steps.length === 1 ? "" : "s"} · {d.runs.length} recorded run{d.runs.length === 1 ? "" : "s"}
                  {last ? (
                    <>
                      {" "}
                      · last {formatEt(last.ranAt, { date: true })} <Tag tone={outcomeTone(last.outcome)}>{last.outcome}</Tag>
                    </>
                  ) : null}
                </p>
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

function runSteps(d: Drill): Step[] {
  return d.steps.map((s) => ({ state: d.runs.length > 0 ? "done" : "idle", label: `${s.n}. ${s.title}`, detail: s.detail || undefined }));
}

export function DrillPage({ id }: { id: string }) {
  const q = useDrills();
  const d = q.data?.find((x) => x.id === id);
  return (
    <>
      <p className="mute">
        <Link to="/drills">← Drills</Link>
      </p>
      {q.error ? <ErrorNote error={q.error} what="Drill" /> : null}
      {q.data && !d ? <p className="notice">No drill named {id}.</p> : null}
      {d ? (
        <>
          <div className="row between">
            <h1>{d.title}</h1>
            <button className="btn" disabled title={RUN_COPY}>
              {d.runs.length > 0 ? "Re-run" : "Run"}
            </button>
          </div>
          <p className="lede">{d.description}</p>
          <p className="mute">
            <Tag>{d.venue}</Tag> {d.runs.length > 0 ? `Recorded run${d.runs.length === 1 ? "" : "s"} below; re-${RUN_COPY}.` : `No run recorded yet; ${RUN_COPY}.`}
          </p>
          <h2>Steps</h2>
          <div className="panel">
            <Timeline steps={runSteps(d)} />
          </div>
          <h2>Runs</h2>
          {d.runs.length === 0 ? <p className="mute">None yet.</p> : null}
          {[...d.runs]
            .sort((a, b) => b.ranAt - a.ranAt)
            .map((r, i) => (
              <div className="panel" key={`${r.ranAt}-${i}`}>
                <div className="row between">
                  <h3>
                    {formatEt(r.ranAt, { date: true, seconds: true })} · chain {r.chainId}
                  </h3>
                  <Tag tone={outcomeTone(r.outcome)}>{r.outcome}</Tag>
                </div>
                {r.label ? <p>{r.label}</p> : null}
                {r.attempts && r.attempts.length > 0 ? (
                  <Timeline
                    steps={r.attempts.map((a) => ({
                      state: /revert|refus|fail/i.test(a.result) ? ("failed" as const) : ("done" as const),
                      label: a.what,
                      detail: a.result,
                    }))}
                  />
                ) : null}
                {r.txs.length > 0 ? (
                  <Timeline
                    steps={r.txs.map((t) => ({
                      state: "done" as const,
                      label: t.label,
                      detail: (
                        <a href={explorerTx(r.chainId, t.hash)} title={t.hash}>
                          <code>{t.hash.slice(0, 12)}…{t.hash.slice(-6)}</code>
                          {t.block ? ` · block ${t.block.toLocaleString("en-US")}` : ""}
                        </a>
                      ),
                    }))}
                  />
                ) : null}
                {r.evidence && (Array.isArray(r.evidence) ? r.evidence.length > 0 : r.evidence) ? (
                  <p className="mute">
                    Evidence:{" "}
                    {(Array.isArray(r.evidence) ? r.evidence : [r.evidence]).map((e, k) => (
                      <span key={k}>
                        {k > 0 ? " · " : ""}
                        <code>{e}</code>
                      </span>
                    ))}
                  </p>
                ) : null}
              </div>
            ))}
        </>
      ) : null}
    </>
  );
}
