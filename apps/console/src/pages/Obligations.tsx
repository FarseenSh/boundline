import { formatEt } from "@boundline/sdk";
import { ErrorNote } from "../components/ErrorNote.jsx";
import { Tag } from "../components/Tag.jsx";
import { useObligations } from "../hooks.js";
import { formatUsdc } from "../policy.js";
import { Link } from "../router.js";
import { explorerAddress, explorerTx, statusTone } from "../timeline.js";

const MARKET_WORDS: Record<string, string> = {
  "0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047": "AAPLt/USDC",
  "0x7cb7fcc828a7296f8ea18256e0f5763a5588cfe22df9c943088021c762e58cc9": "NVDAt/USDC",
  "0xb0e8d25d1c9b822cc718c89666b887698922a7b49fdb00dbdecd70dd4ed9e2f1": "TSLAt/USDC",
};

export function marketName(id: string): string {
  return MARKET_WORDS[id.toLowerCase()] ?? `${id.slice(0, 10)}…`;
}

const ZERO32 = "0x" + "00".repeat(32);

function holdWords(reason: string | null): string {
  if (!reason || reason === ZERO32) return "—";
  try {
    const bytes = reason.slice(2).match(/.{2}/g) ?? [];
    const text = String.fromCharCode(...bytes.map((b) => parseInt(b, 16))).replace(/\0+$/, "");
    return /^[\x20-\x7e]+$/.test(text) ? text : reason.slice(0, 10);
  } catch {
    return reason.slice(0, 10);
  }
}

export function Obligations() {
  const q = useObligations();
  return (
    <>
      <h1>Obligations</h1>
      <p className="lede">Every line this partner has opened on the desk, its status read live, and the hash-bound decision timeline behind each one.</p>
      {q.error ? <ErrorNote error={q.error} what="Obligations" /> : null}
      {q.isLoading ? <p className="mute">Reading the desk and the indexer…</p> : null}
      {q.data ? (
        <>
          <p className="mute">
            {q.data.count} line{q.data.count === 1 ? "" : "s"} · policy version {q.data.policyVersion} · source: {q.data.source} ({q.data.sourceNote})
          </p>
          <div className="panel wrap">
            {q.data.obligations.length === 0 ? <p className="mute">No lines yet.</p> : null}
            {q.data.obligations.length > 0 ? (
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>User</th>
                    <th>Market</th>
                    <th className="num">Drawn</th>
                    <th>Line</th>
                    <th>Obligation</th>
                    <th>Hold</th>
                    <th>Opened (ET)</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.obligations.map((o) => (
                    <tr key={o.lineId}>
                      <td>
                        <Link to={`/lines/${o.lineId}`}>#{o.lineId}</Link>
                      </td>
                      <td>
                        <a href={explorerAddress(q.data.chainId, o.user)} title={o.user}>
                          <code>{o.user.slice(0, 6)}…{o.user.slice(-4)}</code>
                        </a>
                      </td>
                      <td title={o.marketId}>{marketName(o.marketId)}</td>
                      <td className="num">{o.drawnPrincipal ? `$${formatUsdc(o.drawnPrincipal.baseUnits)}` : "—"}</td>
                      <td>
                        <Tag tone={statusTone(o.lineStatus)}>{o.lineStatus}</Tag>
                      </td>
                      <td>
                        <Tag tone={statusTone(o.obligationStatus)}>{o.obligationStatus}</Tag>
                      </td>
                      <td>{holdWords(o.holdReason)}</td>
                      <td>
                        {o.openedAt ? formatEt(o.openedAt, { date: true }) : "—"}
                        {o.openTx ? (
                          <>
                            {" "}
                            <a href={explorerTx(q.data.chainId, o.openTx)} title={o.openTx}>
                              <code>tx</code>
                            </a>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}
