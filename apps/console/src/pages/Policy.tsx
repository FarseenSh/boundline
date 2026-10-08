// The policy editor: the desk's current partner config and per-ticker policy, an editor whose draft is only
// what changed, the API's prepared calls, the admin's signature, and the version history.
import { formatEt } from "@boundline/sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { apiPost } from "../api.js";
import { useApplyFlow } from "../applyflow.js";
import { ErrorNote } from "../components/ErrorNote.jsx";
import { Tag } from "../components/Tag.jsx";
import { ConnectChoices } from "../components/Wallet.jsx";
import { usePolicy, usePolicyVersions } from "../hooks.js";
import { buildDraftBody, describeChange, formatUsdc, hasChanges, isZeroAddress, localChanges, offChainOnly, versionOf, parseBps, parseFraction, parsePercent, parseUsdc, partnerDraftFrom, percentToWad, SATURDAY_MAX_FRACTION, tickerDraftFrom, validateDraft, wadToPercent, type EditedPolicy } from "../policy.js";
import { explorerTx, statusTone } from "../timeline.js";
import type { PolicyResponse, PolicyVersion } from "../types.js";
import { consoleChain } from "../wagmi.js";

interface TickerText {
  collateral: string;
  allowed: boolean;
  maxLtv: string;
  minDraw: string;
  maxDraw: string;
  exposureCap: string;
}

interface PartnerText {
  signer: string;
  eligibility: string;
  exposureCap: string;
  active: boolean;
}

interface SaturdayText {
  enabled: boolean;
  fraction: string;
  haircut: string;
}

interface PolicyText {
  tickers: TickerText[];
  partner: PartnerText;
  /** Null while the API does not serve Saturday mode. */
  saturday: SaturdayText | null;
}

function textFrom(p: PolicyResponse): PolicyText {
  return {
    tickers: p.tickers.map((t) => ({ collateral: t.collateral, allowed: t.allowed, maxLtv: String(wadToPercent(t.maxLtvWad)), minDraw: formatUsdc(t.minDraw).replace(/,/g, ""), maxDraw: formatUsdc(t.maxDraw).replace(/,/g, ""), exposureCap: formatUsdc(t.exposureCap).replace(/,/g, "") })),
    partner: { signer: p.partner.signer, eligibility: p.partner.eligibility, exposureCap: formatUsdc(p.partner.exposureCap).replace(/,/g, ""), active: p.partner.active },
    saturday: p.saturdayMode ? { enabled: p.saturdayMode.enabled, fraction: String(p.saturdayMode.capacityFraction), haircut: String(p.saturdayMode.haircutBps) } : null,
  };
}

/** Text fields → the draft's base units; null plus a message when a field does not parse. */
function editedFrom(p: PolicyResponse, text: PolicyText): { edited: EditedPolicy | null; errors: string[] } {
  const errors: string[] = [];
  const tickers = text.tickers.map((t) => {
    const cur = p.tickers.find((x) => x.collateral.toLowerCase() === t.collateral.toLowerCase());
    const base = cur ? tickerDraftFrom(cur) : { collateral: t.collateral, allowed: false, maxLtvWad: "0", minDraw: "0", maxDraw: "0", exposureCap: "0" };
    const name = cur?.symbol ?? t.collateral;
    const pct = parsePercent(t.maxLtv);
    if (pct === null) errors.push(`${name}: max LTV must be a percentage like 55 or 57.5`);
    const min = parseUsdc(t.minDraw);
    const max = parseUsdc(t.maxDraw);
    const cap = parseUsdc(t.exposureCap);
    if (min === null) errors.push(`${name}: min draw must be a USDC amount`);
    if (max === null) errors.push(`${name}: max draw must be a USDC amount`);
    if (cap === null) errors.push(`${name}: exposure cap must be a USDC amount`);
    return { ...base, allowed: t.allowed, maxLtvWad: pct === null ? base.maxLtvWad : percentToWad(pct), minDraw: min ?? base.minDraw, maxDraw: max ?? base.maxDraw, exposureCap: cap ?? base.exposureCap };
  });
  const pcap = parseUsdc(text.partner.exposureCap);
  if (pcap === null) errors.push("partner exposure cap must be a USDC amount");
  const partner = { ...partnerDraftFrom(p.partner), signer: text.partner.signer.trim(), eligibility: text.partner.eligibility.trim(), exposureCap: pcap ?? p.partner.exposureCap, active: text.partner.active };
  let saturdayMode: EditedPolicy["saturdayMode"];
  if (p.saturdayMode && text.saturday) {
    const fraction = parseFraction(text.saturday.fraction);
    const haircut = parseBps(text.saturday.haircut);
    if (fraction === null) errors.push(`Saturday mode: capacity fraction must be a number above 0 and at most ${SATURDAY_MAX_FRACTION}`);
    if (haircut === null) errors.push("Saturday mode: haircut must be a whole number of bps from 0 to 5000");
    saturdayMode = { enabled: text.saturday.enabled, capacityFraction: fraction ?? p.saturdayMode.capacityFraction, haircutBps: haircut ?? p.saturdayMode.haircutBps };
  }
  if (errors.length > 0) return { edited: null, errors };
  const edited: EditedPolicy = { tickers, partner, ...(saturdayMode ? { saturdayMode } : {}) };
  return { edited, errors: validateDraft(p, edited) };
}

export function Policy() {
  const policy = usePolicy();
  const versions = usePolicyVersions();
  const qc = useQueryClient();
  const { isConnected, address } = useAccount();
  const apply = useApplyFlow();
  const [text, setText] = useState<PolicyText | null>(null);
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<PolicyVersion | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);

  useEffect(() => {
    if (policy.data && text === null) setText(textFrom(policy.data));
  }, [policy.data, text]);

  const parsed = useMemo(() => (policy.data && text ? editedFrom(policy.data, text) : { edited: null, errors: [] }), [policy.data, text]);
  const body = useMemo(() => (policy.data && parsed.edited ? buildDraftBody(policy.data, parsed.edited, note) : null), [policy.data, parsed.edited, note]);
  const changes = useMemo(() => (policy.data && parsed.edited ? localChanges(policy.data, parsed.edited) : []), [policy.data, parsed.edited]);
  const symbolOf = (collateral: string): string => policy.data?.tickers.find((t) => t.collateral.toLowerCase() === collateral.toLowerCase())?.symbol ?? `${collateral.slice(0, 6)}…`;
  const isAdmin = Boolean(address && policy.data && address.toLowerCase() === policy.data.partner.admin.toLowerCase());

  const prepare = async (): Promise<void> => {
    if (!body) return;
    setPreparing(true);
    setError(null);
    try {
      const r = await apiPost<unknown>("/v1/policy/versions", body);
      setDraft(versionOf(r.data));
      // A routing-only version comes back applied: the live policy (Saturday mode) changed already.
      void qc.invalidateQueries({ queryKey: ["policy"] });
      void qc.invalidateQueries({ queryKey: ["policy-versions"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreparing(false);
    }
  };

  const signAndApply = async (v: PolicyVersion): Promise<void> => {
    setApplying(v.id);
    setError(null);
    const hashes = await apply.run(v.calls);
    if (!hashes || hashes.length === 0) {
      setApplying(null);
      return;
    }
    try {
      const r = await apiPost<unknown>(`/v1/policy/versions/${v.id}/applied`, { txHash: hashes[hashes.length - 1] });
      const applied = versionOf(r.data);
      setDraft(applied.id === draft?.id ? applied : draft);
      setText(null);
      void qc.invalidateQueries({ queryKey: ["policy"] });
      void qc.invalidateQueries({ queryKey: ["policy-versions"] });
    } catch (err) {
      setError(`Signed and sent (${hashes.map((h) => h.slice(0, 10)).join(", ")}), but recording it failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setApplying(null);
    }
  };

  /** An off-chain-only version (Saturday mode) has no desk call to sign: the partner records it as applied. */
  const recordApplied = async (v: PolicyVersion): Promise<void> => {
    setApplying(v.id);
    setError(null);
    try {
      const r = await apiPost<unknown>(`/v1/policy/versions/${v.id}/applied`, {});
      const applied = versionOf(r.data);
      setDraft(applied.id === draft?.id ? applied : draft);
      setText(null);
      void qc.invalidateQueries({ queryKey: ["policy"] });
      void qc.invalidateQueries({ queryKey: ["policy-versions"] });
    } catch (err) {
      setError(`Recording ${v.id} as applied failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setApplying(null);
    }
  };

  const setSaturday = (patch: Partial<SaturdayText>): void => setText((t) => (t && t.saturday ? { ...t, saturday: { ...t.saturday, ...patch } } : t));
  const setTicker = (i: number, patch: Partial<TickerText>): void => setText((t) => (t ? { ...t, tickers: t.tickers.map((x, j) => (j === i ? { ...x, ...patch } : x)) } : t));
  const setPartner = (patch: Partial<PartnerText>): void => setText((t) => (t ? { ...t, partner: { ...t.partner, ...patch } } : t));

  return (
    <>
      <h1>Policy</h1>
      <p className="lede">The partner policy the desk enforces on every quote: which tickers, how far below the venue's LLTV, draw bounds and exposure caps. Edits become a prepared version; the partner admin signs it; the desk bumps the policy version.</p>
      {policy.error ? <ErrorNote error={policy.error} what="Policy" /> : null}
      {policy.isLoading ? <p className="mute">Reading the desk…</p> : null}
      {policy.data && text ? (
        <>
          <div className="panel">
            <div className="row between">
              <h3>
                {policy.data.name} · policy version {policy.data.policyVersion}
              </h3>
              <span className="mute">
                admin <code>{policy.data.partner.admin.slice(0, 6)}…{policy.data.partner.admin.slice(-4)}</code> · exposure ${formatUsdc(policy.data.partner.exposure)} of {BigInt(policy.data.partner.exposureCap) === 0n ? "no cap" : `$${formatUsdc(policy.data.partner.exposureCap)}`}
              </span>
            </div>
            <div className="grid">
              <label className="field">
                <span>Signer (zero address = open access)</span>
                <span className="input">
                  <input className="text" value={text.partner.signer} onChange={(e) => setPartner({ signer: e.target.value })} spellCheck={false} />
                </span>
              </label>
              <label className="field">
                <span>Eligibility hook (zero address = none)</span>
                <span className="input">
                  <input className="text" value={text.partner.eligibility} onChange={(e) => setPartner({ eligibility: e.target.value })} spellCheck={false} />
                </span>
              </label>
              <label className="field">
                <span>Partner exposure cap</span>
                <span className="input">
                  <input className="text" value={text.partner.exposureCap} onChange={(e) => setPartner({ exposureCap: e.target.value })} inputMode="decimal" />
                  <span className="unit">USDC</span>
                </span>
              </label>
              <label className="field check">
                <input type="checkbox" checked={text.partner.active} onChange={(e) => setPartner({ active: e.target.checked })} /> <span>Partner active</span>
              </label>
            </div>
          </div>

          <div className="panel wrap">
            <table className="ledger editor">
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Allowed</th>
                  <th className="num">Max LTV</th>
                  <th className="num">Market LLTV</th>
                  <th className="num">Min draw</th>
                  <th className="num">Max draw</th>
                  <th className="num">Exposure cap</th>
                  <th className="num">Used</th>
                </tr>
              </thead>
              <tbody>
                {policy.data.tickers.map((t, i) => {
                  const row = text.tickers[i];
                  if (!row) return null;
                  return (
                    <tr key={t.collateral}>
                      <td title={t.collateral}>
                        <b>{t.symbol}</b>
                        <br />
                        <code className="mute">{t.marketId.slice(0, 10)}…</code>
                      </td>
                      <td>
                        <input type="checkbox" checked={row.allowed} onChange={(e) => setTicker(i, { allowed: e.target.checked })} aria-label={`${t.symbol} allowed`} />
                      </td>
                      <td className="num">
                        <input className="cell" value={row.maxLtv} onChange={(e) => setTicker(i, { maxLtv: e.target.value })} inputMode="decimal" aria-label={`${t.symbol} max LTV percent`} />%
                      </td>
                      <td className="num">{wadToPercent(t.marketLltvWad)}%</td>
                      <td className="num">
                        <input className="cell" value={row.minDraw} onChange={(e) => setTicker(i, { minDraw: e.target.value })} inputMode="decimal" aria-label={`${t.symbol} min draw`} />
                      </td>
                      <td className="num">
                        <input className="cell" value={row.maxDraw} onChange={(e) => setTicker(i, { maxDraw: e.target.value })} inputMode="decimal" aria-label={`${t.symbol} max draw`} />
                      </td>
                      <td className="num">
                        <input className="cell" value={row.exposureCap} onChange={(e) => setTicker(i, { exposureCap: e.target.value })} inputMode="decimal" aria-label={`${t.symbol} exposure cap`} />
                      </td>
                      <td className="num">${formatUsdc(t.exposure)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mute">USDC amounts; 0 max draw or 0 cap means none. The desk clamps max LTV to the market LLTV at quote time and refuses anything at or above it.</p>
          </div>

          <div className="panel">
            <h3>Saturday mode (routing policy)</h3>
            <p>
              Off by default. On venues that keep pricing at the held feed while Wall Street is closed (Aave V4), the credit router may route weekend draws at a fraction of normal capacity, priced at the lower of the held feed and the DEX TWAP less a haircut. Boundline's own session-safe Morpho markets never draw while the feed is held, whatever this says. Off-chain policy: versioned here, applied by the router, no desk call to sign.
            </p>
            {text.saturday ? (
              <div className="grid">
                <label className="field check">
                  <input type="checkbox" checked={text.saturday.enabled} onChange={(e) => setSaturday({ enabled: e.target.checked })} /> <span>Allow weekend draws on around-the-clock venues</span>
                </label>
                <span />
                <label className="field">
                  <span>Share of normal capacity (at most {SATURDAY_MAX_FRACTION})</span>
                  <span className="input">
                    <input className="text" value={text.saturday.fraction} onChange={(e) => setSaturday({ fraction: e.target.value })} inputMode="decimal" aria-label="Saturday capacity fraction" />
                  </span>
                </label>
                <label className="field">
                  <span>Haircut on min(held feed, TWAP)</span>
                  <span className="input">
                    <input className="text" value={text.saturday.haircut} onChange={(e) => setSaturday({ haircut: e.target.value })} inputMode="numeric" aria-label="Saturday haircut bps" />
                    <span className="unit">bps</span>
                  </span>
                </label>
              </div>
            ) : (
              <p className="mute">The partner API does not serve Saturday mode yet; this panel turns on as soon as <code>GET /v1/policy</code> carries it.</p>
            )}
          </div>

          <div className="panel">
            <h3>Draft</h3>
            {parsed.errors.length > 0 ? (
              <ul className="errors">
                {parsed.errors.map((e) => (
                  <li key={e} className="coral">
                    {e}
                  </li>
                ))}
              </ul>
            ) : null}
            {changes.length === 0 ? <p className="mute">No changes yet; edit a field above.</p> : null}
            {body && offChainOnly(body) ? <p className="mute">Routing policy only: the version needs no signature on the desk, it is recorded as applied.</p> : null}
            {changes.length > 0 ? (
              <ul className="changes">
                {changes.map((c, i) => (
                  <li key={i}>{describeChange(c, symbolOf)}</li>
                ))}
              </ul>
            ) : null}
            <label className="field">
              <span>Note for the version history</span>
              <span className="input">
                <input className="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this change" />
              </span>
            </label>
            <div className="row">
              <button className="btn primary" disabled={!body || !hasChanges(body) || parsed.errors.length > 0 || note.trim().length === 0 || preparing} onClick={() => void prepare()}>
                {preparing ? "Preparing…" : "Prepare version"}
              </button>
              <button className="btn ghost" onClick={() => setText(policy.data ? textFrom(policy.data) : null)}>
                Reset
              </button>
            </div>
            {error ? <p className="notice">{error}</p> : null}
          </div>

          {draft ? <VersionCard v={draft} symbolOf={symbolOf} chainId={consoleChain.id} canSign={isConnected && isAdmin} connected={isConnected} applying={applying === draft.id} onSign={() => void signAndApply(draft)} onRecord={() => void recordApplied(draft)} stage={applying === draft.id ? apply.stage : null} /> : null}
          {!isConnected ? (
            <div className="panel">
              <h3>Partner admin wallet</h3>
              <p>Prepared versions are signed by the partner admin ({policy.data.partner.admin.slice(0, 6)}…{policy.data.partner.admin.slice(-4)}). Connect it to apply a version.</p>
              <ConnectChoices />
            </div>
          ) : !isAdmin ? (
            <p className="notice warn">The connected wallet is not this partner's admin on the desk, so it cannot apply a version. Prepared versions still carry the calls for the admin to sign elsewhere.</p>
          ) : null}
        </>
      ) : null}

      <h2>Version history</h2>
      {versions.error ? <ErrorNote error={versions.error} what="Policy versions" /> : null}
      {versions.data && versions.data.length === 0 ? <p className="mute">No prepared versions yet.</p> : null}
      {versions.data?.map((v) => (
        <VersionCard key={v.id} v={v} symbolOf={symbolOf} chainId={consoleChain.id} canSign={isConnected && isAdmin && v.status === "prepared"} connected={isConnected} applying={applying === v.id} onSign={() => void signAndApply(v)} onRecord={() => void recordApplied(v)} stage={applying === v.id ? apply.stage : null} compact />
      ))}
    </>
  );
}

function VersionCard({ v, symbolOf, chainId, canSign, connected, applying, onSign, onRecord, stage, compact = false }: { v: PolicyVersion; symbolOf: (c: string) => string; chainId: number; canSign: boolean; connected: boolean; applying: boolean; onSign: () => void; onRecord: () => void; stage: ReturnType<typeof useApplyFlow>["stage"] | null; compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  return (
    <div className="panel version">
      <div className="row between">
        <h3>
          <Tag tone={statusTone(v.status)}>{v.status}</Tag> {v.note || "(no note)"}
        </h3>
        <span className="mute">
          {v.id} · {formatEt(v.createdAt, { date: true })} · v{v.policyVersionBefore} → {v.policyVersionAfter ?? "?"}
        </span>
      </div>
      {compact ? (
        <button className="btn small ghost" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show"} {v.changes.length} change{v.changes.length === 1 ? "" : "s"}, {v.calls.length} call{v.calls.length === 1 ? "" : "s"}
        </button>
      ) : null}
      {open ? (
        <>
          <ul className="changes">
            {v.changes.map((c, i) => (
              <li key={i}>{describeChange(c, symbolOf)}</li>
            ))}
          </ul>
          <table className="ledger calls">
            <thead>
              <tr>
                <th>Call</th>
                <th>To</th>
                <th>Calldata</th>
              </tr>
            </thead>
            <tbody>
              {v.calls.map((c, i) => (
                <tr key={i}>
                  <td>{c.description}</td>
                  <td>
                    <code title={c.to}>{c.to.slice(0, 8)}…</code>
                  </td>
                  <td>
                    <code title={c.data}>
                      {c.data.slice(0, 10)}… ({(c.data.length - 2) / 2} bytes)
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {v.txHash ? (
            <p className="mute">
              Applied{v.appliedAt ? ` ${formatEt(v.appliedAt, { date: true })}` : ""} in{" "}
              <a href={explorerTx(chainId, v.txHash)}>
                <code>{v.txHash.slice(0, 12)}…</code>
              </a>
            </p>
          ) : null}
          {v.status === "prepared" && v.calls.length === 0 ? (
            <div className="row">
              <button className="btn primary" disabled={applying} onClick={onRecord}>
                {applying ? "Recording…" : "Record as applied"}
              </button>
              <span className="mute">No desk call: an off-chain routing change.</span>
            </div>
          ) : null}
          {v.status === "prepared" && v.calls.length > 0 ? (
            <div className="row">
              <button className="btn primary" disabled={!canSign || applying} onClick={onSign} title={!connected ? "connect the partner admin wallet" : !canSign ? "the connected wallet is not the partner admin" : undefined}>
                {applying ? "Signing…" : "Sign and apply"}
              </button>
              {stage && stage.kind === "sent" ? (
                <span className="mute">
                  {stage.mode === "batch" ? "Sent as one batch (wallet_sendCalls)" : `Sent ${stage.hashes.length} of ${stage.total}`}; waiting for the block…
                </span>
              ) : null}
              {stage && stage.kind === "failed" ? <span className="coral">{stage.error}</span> : null}
              {stage && stage.kind === "confirmed" ? <span className="live">Confirmed; recording the version…</span> : null}
            </div>
          ) : null}
        </>
      ) : null}
      {v.calls.length > 0 && isZeroAddress(v.calls[0]?.to) ? <p className="notice warn">This version's calls have no target; the API could not prepare them.</p> : null}
    </div>
  );
}
