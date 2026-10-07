import { formatEt } from "@boundline/sdk";
import { useMemo, useState } from "react";
import { downloadJson } from "../api.js";
import { ErrorNote } from "../components/ErrorNote.jsx";
import { Tag } from "../components/Tag.jsx";
import { bundleCounts, rehashBundle } from "../hashing.js";
import { useEvidence } from "../hooks.js";

export function Evidence() {
  const [wanted, setWanted] = useState(false);
  const q = useEvidence(wanted);
  const [copied, setCopied] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const local = useMemo(() => (q.data ? rehashBundle(q.data as unknown as Record<string, unknown>) : null), [q.data]);
  const counts = useMemo(() => (q.data ? bundleCounts(q.data as unknown as Record<string, unknown>) : null), [q.data]);
  const matches = q.data && local ? local.toLowerCase() === String(q.data.hash).toLowerCase() : null;

  const copy = async (): Promise<void> => {
    if (!q.data) return;
    try {
      await navigator.clipboard.writeText(q.data.hash);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const download = async (): Promise<void> => {
    setDownloadError(null);
    try {
      await downloadJson("/v1/evidence/export?format=download", `boundline-evidence-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <h1>Evidence</h1>
      <p className="lede">One JSON bundle of this partner's policy, lines, obligations, decision timelines, daily roots, reconciliation and drill records, with a hash so anyone can check it was not edited after export.</p>
      <div className="panel">
        <p>
          <code>hash = keccak256(utf8(JSON.stringify(bundle without hash and correlationId, keys sorted recursively)))</code>. The console recomputes it in your browser from the bytes it received.
        </p>
        <div className="row">
          <button className="btn primary" onClick={() => setWanted(true)} disabled={q.isFetching}>
            {q.isFetching ? "Building…" : q.data ? "Rebuild bundle" : "Build bundle"}
          </button>
          <button className="btn" onClick={() => void download()} disabled={!wanted}>
            Download JSON
          </button>
        </div>
        {downloadError ? <p className="notice">{downloadError}</p> : null}
      </div>
      {q.error ? <ErrorNote error={q.error} what="Evidence export" /> : null}
      {q.data && counts ? (
        <div className="panel">
          <div className="row between">
            <h3>Bundle</h3>
            <span className="mute">
              generated {formatEt(q.data.generatedAt, { date: true, seconds: true })} · partner <code>{String(q.data.partnerId).slice(0, 14)}…</code>
              {typeof q.data.schema === "string" ? ` · ${q.data.schema}` : ""} · {(counts.bytes / 1024).toFixed(1)} KB
            </span>
          </div>
          <div className="grid">
            <div className="kv">
              <span>Lines</span>
              <span>{counts.lines}</span>
            </div>
            <div className="kv">
              <span>Obligations</span>
              <span>{counts.obligations}</span>
            </div>
            <div className="kv">
              <span>Decisions</span>
              <span>{counts.decisions}</span>
            </div>
            <div className="kv">
              <span>Daily roots</span>
              <span>{counts.roots}</span>
            </div>
            <div className="kv">
              <span>Drills</span>
              <span>{counts.drills}</span>
            </div>
            <div className="kv">
              <span>Recomputed here</span>
              <span>{matches === null ? "—" : matches ? <Tag tone="live">matches</Tag> : <Tag tone="bad">differs</Tag>}</span>
            </div>
          </div>
          <p className="hashline">
            <code title={q.data.hash}>{q.data.hash}</code>
            <button className="btn small" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy"}
            </button>
          </p>
          {matches === false && local ? (
            <p className="notice warn">
              The browser's recomputation gives <code>{local}</code>. Either the bundle changed in transit or the API canonicalises differently; compare with the method above.
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
