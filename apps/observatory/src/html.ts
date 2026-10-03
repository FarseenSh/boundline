import type { LivenessTransition } from "./capture.js";
import { escapeHtml, fmtAge, fmtBps, fmtEt, fmtUsd } from "./format.js";
import type { PositionRow } from "./positions.js";
import type { Snapshot, TokenRow } from "./snapshot.js";
import type { CaptureRunRecord } from "./stores.js";

const CSS = `
:root{color-scheme:dark;--bg:#0b0d10;--panel:#12151a;--line:#232830;--fg:#e6e8eb;--mute:#8b94a1;--accent:#ff6b57;--ok:#4cc38a;--warn:#f5b454;--bad:#ff6b57}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,Roboto,sans-serif;padding:24px}
h1{font-size:20px;margin:0 0 4px;font-weight:600;letter-spacing:-.01em}h1 span{color:var(--accent)}h2{font-size:15px;margin:26px 0 8px;font-weight:600}
.sub{color:var(--mute);margin:0 0 20px}.banner{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);padding:12px 14px;border-radius:6px;margin:0 0 20px}
.banner b{color:var(--fg)}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;background:var(--panel);border:1px solid var(--line);border-radius:6px;overflow:hidden}
th,td{padding:9px 10px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--mute);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
td:first-child,th:first-child{text-align:left}tr:last-child td{border-bottom:0}.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:12px;border:1px solid var(--line);color:var(--mute)}
.tag.ok{color:var(--ok);border-color:#1f4d38}.tag.bad{color:var(--bad);border-color:#5a2a24}.tag.warn{color:var(--warn);border-color:#5a4520}
.neg{color:var(--bad)}.pos{color:var(--ok)}.mute{color:var(--mute)}footer{color:var(--mute);margin-top:18px;font-size:12px}footer a{color:var(--mute)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:12px 14px;margin:0 0 12px}.panel p{margin:0 0 6px}
.wrap{overflow-x:auto}code{font-size:12px;color:var(--mute)}@media(max-width:900px){body{padding:14px}}
`;

export interface PageExtras {
  /** The armed, recording or latest completed capture run. */
  capture: CaptureRunRecord | null;
  /** Next feed liveness transition, for the countdown when idle. */
  nextTransition: LivenessTransition | null;
  /** Latest row per real position, worst shadow health first. */
  positions: PositionRow[] | null;
}

function sessionTag(s: string, live: boolean): string {
  const cls = live ? "ok" : s === "UNKNOWN" ? "warn" : "bad";
  return `<span class="tag ${cls}">${escapeHtml(s)}</span>`;
}

function row(t: TokenRow): string {
  const div = t.divergenceBps;
  const divCls = div === null ? "mute" : div < 0 ? "neg" : div > 0 ? "pos" : "";
  const pause = t.transferPaused ? `<span class="tag bad">paused</span>` : `<span class="tag ok">open</span>`;
  const reg = t.registryPaused ? `<span class="tag bad">paused</span>` : `${t.registryMultiplier.toFixed(6)}`;
  const sched = t.scheduledAction ? ` <span class="tag warn">×${t.scheduledAction.ratio.toFixed(3)} at ${escapeHtml(fmtEt(t.scheduledAction.effectiveAt))}</span>` : "";
  return `<tr>
<td><b>${escapeHtml(t.symbol)}</b>${sched}</td>
<td>${fmtUsd(t.feedPrice)}</td>
<td class="mute">${escapeHtml(fmtEt(t.feedUpdatedAt))}</td>
<td>${t.feedFrozen ? `<span class="tag bad">${fmtAge(t.feedAgeSeconds)}</span>` : fmtAge(t.feedAgeSeconds)}</td>
<td>${sessionTag(t.session, t.feedLive)}</td>
<td>${reg}</td>
<td>${pause}</td>
<td>${t.dexTwap1h === null ? `<span class="mute">no pool</span>` : fmtUsd(t.dexTwap1h)}</td>
<td class="${divCls}">${fmtBps(div)}</td>
</tr>`;
}

function fmtCountdown(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function answerUsd(raw: string | null): string {
  return raw === null ? "—" : fmtUsd(Number(raw) / 1e8);
}

export function capturePanel(now: number, run: CaptureRunRecord | null, next: LivenessTransition | null): string {
  const nextLine = next
    ? `<p>Next feed transition: <b>${escapeHtml(next.from)} → ${escapeHtml(next.to)}</b> at <b>${escapeHtml(fmtEt(next.at))}</b> (${escapeHtml(next.kind)}, in ${escapeHtml(fmtCountdown(next.at - now))}). The capture arms 15 minutes before and records every minute until 90 minutes after.</p>`
    : `<p class="mute">No feed transition inside the calendar horizon.</p>`;
  if (!run) return `<h2>Reopen capture</h2><div class="panel">${nextLine}<p class="mute">No capture recorded yet.</p></div>`;
  const state = run.completedAt ? `<span class="tag ok">complete</span>` : now < run.transitionAt ? `<span class="tag warn">armed</span>` : `<span class="tag warn">recording</span>`;
  const rows = Object.entries(run.summary.perToken)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([symbol, t]) => {
      const f = t.first;
      const gapCls = f?.gapBps === null || f?.gapBps === undefined ? "mute" : f.gapBps < 0 ? "neg" : f.gapBps > 0 ? "pos" : "";
      return `<tr><td><b>${escapeHtml(symbol)}</b></td><td>${answerUsd(t.heldAnswer)}</td><td class="mute">${escapeHtml(fmtEt(t.heldUpdatedAt))}</td><td>${f ? answerUsd(f.answer) : `<span class="mute">not yet</span>`}</td><td class="mute">${f ? escapeHtml(fmtEt(f.feedUpdatedAt, true)) : "—"}</td><td>${f ? fmtAge(Math.max(0, f.lagSeconds)) : "—"}</td><td class="${gapCls}">${f ? fmtBps(f.gapBps) : "—"}</td></tr>`;
    })
    .join("\n");
  const showNext = next && next.at !== run.transitionAt ? nextLine : "";
  return `<h2>Reopen capture</h2><div class="panel">
<p>${state} <b>${escapeHtml(run.fromSession)} → ${escapeHtml(run.toSession)}</b> at <b>${escapeHtml(fmtEt(run.transitionAt))}</b> (${escapeHtml(run.kind)}) · armed ${escapeHtml(fmtEt(run.armedAt, true))} · ${run.summary.ticks} ticks${run.firstUpdateAt ? ` · first feed print ${escapeHtml(fmtEt(run.firstUpdateAt, true))}` : ""}${run.completedAt ? ` · completed ${escapeHtml(fmtEt(run.completedAt, true))}` : ""}</p>
${showNext}
<div class="wrap"><table><thead><tr><th>Token</th><th>Held close</th><th>Held since (ET)</th><th>First print after</th><th>Printed at (ET)</th><th>Lag</th><th>Gap</th></tr></thead><tbody>
${rows}
</tbody></table></div></div>`;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function fmtHf(hf: number | null): string {
  if (hf === null) return `<span class="mute">—</span>`;
  const cls = hf < 1 ? "neg" : hf < 1.1 ? "" : "pos";
  return `<span class="${cls}">${hf.toFixed(3)}</span>`;
}

export function positionsPanel(rows: PositionRow[] | null): string {
  if (rows === null) return `<h2>Real positions</h2><div class="panel"><p class="mute">Position scan not available.</p></div>`;
  if (rows.length === 0) return `<h2>Real positions</h2><div class="panel"><p class="mute">No borrowers discovered yet on the B20 Morpho markets (the scan seeds from Morpho's API and follows Borrow events every minute).</p></div>`;
  const body = rows
    .map((p) => {
      const flag = p.protectionCase ? `<span class="tag bad">shadow &lt; 1, venue says healthy</span>` : p.shadowHf === null ? `<span class="tag">no DEX pool</span>` : `<span class="tag ok">ok</span>`;
      return `<tr><td><b>${escapeHtml(p.collateralSymbol)}</b> <code>${escapeHtml(p.marketId.slice(0, 10))}</code></td><td><code>${escapeHtml(shortAddr(p.address))}</code></td><td>${fmtUsd(Number(p.collateral) / 1e8, 4)}</td><td>${fmtUsd(Number(p.debtAssets) / 1e6)}</td><td>${fmtUsd(p.venuePrice)}</td><td>${p.shadowPrice === null ? `<span class="mute">—</span>` : fmtUsd(p.shadowPrice)}</td><td>${fmtHf(p.venueHf)}</td><td>${fmtHf(p.shadowHf)}</td><td>${flag}</td></tr>`;
    })
    .join("\n");
  const taken = rows.reduce((m, p) => Math.max(m, p.takenAt), 0);
  return `<h2>Real positions</h2><div class="panel"><p class="mute">Every borrower on the B20 Morpho markets, health at the venue's price (held while closed) against the 1h DEX TWAP (24/7). Refreshed every 10 minutes; last ${escapeHtml(fmtEt(taken, true))}.</p>
<div class="wrap"><table><thead><tr><th>Market</th><th>Borrower</th><th>Collateral</th><th>Debt (USDC)</th><th>Venue price</th><th>Shadow price</th><th>Venue HF</th><th>Shadow HF</th><th></th></tr></thead><tbody>
${body}
</tbody></table></div></div>`;
}

export function renderPage(s: Snapshot, extras: PageExtras = { capture: null, nextTransition: null, positions: null }): string {
  const closed = s.session.state === "WEEKEND" || s.session.state === "HOLIDAY";
  const banner = closed
    ? `<div class="banner">Feeds frozen since <b>${escapeHtml(fmtEt(s.session.lastFeedUpdateAt))}</b> · next reopen <b>${escapeHtml(fmtEt(s.session.nextTransition.at))}</b> ET · session <b>${escapeHtml(s.session.state)}</b>. Both live credit venues still price collateral at the held value.</div>`
    : `<div class="banner">Session <b>${escapeHtml(s.session.state)}</b> · next transition <b>${escapeHtml(fmtEt(s.session.nextTransition.at))}</b> ET (${escapeHtml(s.session.nextTransition.to)}).</div>`;
  const rows = s.tokens.map(row).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Boundline Observatory · B20 credit on Base</title><style>${CSS}</style></head>
<body>
<h1><span>Boundline</span> Observatory</h1>
<p class="sub">Every Coinbase tokenized stock on Base: Chainlink feed, Coinbase OracleRegistry, issuer pause, 24/7 Aerodrome price and the gap the feed will print at the reopen. Block ${s.block} · taken ${escapeHtml(fmtEt(s.takenAt, true))}.</p>
${banner}
<div class="wrap"><table>
<thead><tr><th>Token</th><th>Feed (USD)</th><th>Feed updated (ET)</th><th>Age</th><th>Session</th><th>Registry ×</th><th>Transfer</th><th>DEX 1h TWAP</th><th>DEX vs feed</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
${capturePanel(s.takenAt, extras.capture, extras.nextTransition)}
${positionsPanel(extras.positions)}
<footer>Calendar: ${escapeHtml(s.session.calendarSource)} · JSON: <a href="/v1/tokens">/v1/tokens</a> · <a href="/v1/sessions">/v1/sessions</a> · <a href="/v1/captures">/v1/captures</a> · <a href="/v1/positions">/v1/positions</a> · <a href="/v1/venues/morpho/markets">/v1/venues/morpho/markets</a> · <a href="/v1/venues/aave/positions">/v1/venues/aave/positions</a> · MIT, public good.</footer>
</body></html>`;
}
