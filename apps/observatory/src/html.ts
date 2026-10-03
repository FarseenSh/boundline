import { escapeHtml, fmtAge, fmtBps, fmtEt, fmtUsd } from "./format.js";
import type { Snapshot, TokenRow } from "./snapshot.js";

const CSS = `
:root{color-scheme:dark;--bg:#0b0d10;--panel:#12151a;--line:#232830;--fg:#e6e8eb;--mute:#8b94a1;--accent:#ff6b57;--ok:#4cc38a;--warn:#f5b454;--bad:#ff6b57}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,Roboto,sans-serif;padding:24px}
h1{font-size:20px;margin:0 0 4px;font-weight:600;letter-spacing:-.01em}h1 span{color:var(--accent)}
.sub{color:var(--mute);margin:0 0 20px}.banner{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);padding:12px 14px;border-radius:6px;margin:0 0 20px}
.banner b{color:var(--fg)}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;background:var(--panel);border:1px solid var(--line);border-radius:6px;overflow:hidden}
th,td{padding:9px 10px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--mute);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
td:first-child,th:first-child{text-align:left}tr:last-child td{border-bottom:0}.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:12px;border:1px solid var(--line);color:var(--mute)}
.tag.ok{color:var(--ok);border-color:#1f4d38}.tag.bad{color:var(--bad);border-color:#5a2a24}.tag.warn{color:var(--warn);border-color:#5a4520}
.neg{color:var(--bad)}.pos{color:var(--ok)}.mute{color:var(--mute)}footer{color:var(--mute);margin-top:18px;font-size:12px}footer a{color:var(--mute)}
.wrap{overflow-x:auto}@media(max-width:900px){body{padding:14px}}
`;

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

export function renderPage(s: Snapshot): string {
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
<footer>Calendar: ${escapeHtml(s.session.calendarSource)} · JSON: <a href="/v1/tokens">/v1/tokens</a> · <a href="/v1/sessions">/v1/sessions</a> · <a href="/v1/venues/morpho/markets">/v1/venues/morpho/markets</a> · <a href="/v1/venues/aave/positions">/v1/venues/aave/positions</a> · MIT, public good.</footer>
</body></html>`;
}
