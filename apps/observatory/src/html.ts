import type { AavePositionRow } from "./aave-positions.js";
import { fmtAssuranceHf, type AssuranceStatus } from "./assurance.js";
import type { LivenessTransition } from "./capture.js";
import { escapeHtml, fmtAge, fmtBps, fmtEt, fmtUsd } from "./format.js";
import type { GapsPanel, WeekendGap } from "./gaps.js";
import type { PositionRow } from "./positions.js";
import type { SeizeWatchBody } from "./seize.js";
import type { Snapshot, TokenRow } from "./snapshot.js";
import type { CaptureRunRecord } from "./stores.js";

// The brand (docs/brand): coral #FF6B57, ink #15171C, paper #F4F5F7, Archivo wide and heavy for display. The Observatory
// keeps a dark ground, the brand's ink; "held" (a frozen feed, a closed session) wears the same diagonal hatch as the site.
const CSS = `
:root{color-scheme:dark;--bg:#15171C;--panel:#1B1E25;--panel-2:#22262F;--line:#2D323C;--fg:#F4F5F7;--fg-2:#C8CDD6;--mute:#8F97A4;
--coral:#FF6B57;--ok:#5BD69B;--ok-line:rgba(91,214,155,.38);--ok-bg:rgba(91,214,155,.10);--warn:#F5B454;--warn-line:rgba(245,180,84,.4);--warn-bg:rgba(245,180,84,.10);
--bad:#FF8A7A;--bad-line:rgba(255,107,87,.5);
--display:"Archivo","Helvetica Neue",Arial,sans-serif;--ui:"Archivo","Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14.5px/1.5 var(--ui);font-stretch:100%;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
a{color:var(--fg)}a:hover{color:var(--coral)}:focus-visible{outline:2px solid var(--coral);outline-offset:2px;border-radius:4px}
.shell{max-width:1240px;margin:0 auto;padding:22px 28px 72px}
.top{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding-bottom:22px;border-bottom:1px solid var(--line)}
.brand{display:inline-flex;align-items:center;gap:10px;text-decoration:none;color:var(--fg)}
.brand svg{width:34px;height:34px;flex:none}.brand .word{font-family:var(--display);font-stretch:125%;font-weight:800;font-size:25px;letter-spacing:-.012em;line-height:1}
.product{font-family:var(--display);font-stretch:112%;font-weight:700;font-size:15px;color:var(--fg-2);padding:4px 10px;border:1px solid var(--line);border-radius:999px}
.top nav{margin-left:auto;display:flex;gap:18px;flex-wrap:wrap;font-size:14px}.top nav a{color:var(--fg-2);text-decoration:none}.top nav a:hover{color:var(--fg)}
h1{font-family:var(--display);font-stretch:118%;font-weight:800;font-size:clamp(30px,4.4vw,52px);line-height:1.02;letter-spacing:-.025em;margin:40px 0 14px;max-width:18ch;text-wrap:balance}
h2{font-family:var(--display);font-stretch:116%;font-weight:800;font-size:clamp(21px,2.4vw,27px);line-height:1.1;letter-spacing:-.018em;margin:52px 0 14px}
.sub{color:var(--fg-2);margin:0 0 26px;max-width:82ch;font-size:15.5px;overflow-wrap:anywhere}
.banner{position:relative;display:block;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px 20px 16px 24px;margin:0 0 22px;font-size:15.5px;overflow:hidden}
.banner::before{content:"";position:absolute;left:0;top:0;bottom:0;width:6px;background:var(--ok)}
.banner.held::before{width:14px;background:repeating-linear-gradient(135deg,var(--coral) 0 4px,transparent 4px 9px)}.banner.held{padding-left:32px}
.banner b{color:var(--fg);font-weight:700}
table{width:100%;border-collapse:separate;border-spacing:0;background:var(--panel);border:1px solid var(--line);border-radius:16px;overflow:hidden}
th,td{padding:12px 14px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--mute);font-weight:600;font-size:12.5px;letter-spacing:0;background:var(--panel-2)}
td{font-size:14.5px}td b{font-family:var(--display);font-stretch:110%;font-weight:700}
td:first-child,th:first-child{text-align:left}tr:last-child td{border-bottom:0}tbody tr:hover td{background:rgba(255,255,255,.025)}
.tag{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;line-height:1.5;border:1px solid var(--line);color:var(--fg-2)}
.tag.ok{color:var(--ok);border-color:var(--ok-line);background:var(--ok-bg)}
.tag.warn{color:var(--warn);border-color:var(--warn-line);background:var(--warn-bg)}
.tag.bad{color:#FFD3CC;border-color:var(--bad-line);background:repeating-linear-gradient(135deg,rgba(255,107,87,.30) 0 3px,rgba(255,107,87,.10) 3px 7px)}
.neg{color:var(--bad)}.pos{color:var(--ok)}.mute{color:var(--mute)}
footer{color:var(--mute);margin-top:56px;padding-top:20px;border-top:1px solid var(--line);font-size:13px;line-height:1.9;overflow-wrap:anywhere}footer a{color:var(--fg-2)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin:0 0 14px;min-width:0}.panel p{margin:0 0 10px;max-width:110ch;overflow-wrap:anywhere}
.panel table{background:var(--bg);border-radius:12px;margin-top:6px}.panel th{background:transparent}
.panel .wrap + p{margin-top:26px}.panel .wrap + p + p{margin-top:0}
.wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}code{font-family:var(--mono);font-size:12.5px;color:var(--mute)}
@media(max-width:760px){.shell{padding:16px 16px 56px}.top nav{margin-left:0;width:100%}h1{margin-top:28px}th,td{padding:10px 12px}.banner{font-size:14.5px}}
`;

// The brand tile (docs/brand/svg/boundline-tile.svg), its clip ids namespaced for this page.
const TILE = `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><clipPath id="obs-tc"><rect width="64" height="64" rx="14"/></clipPath><g clip-path="url(#obs-tc)"><rect width="64" height="64" fill="#FF6B57"/><path d="M13.41 14.3 V39.7" stroke="#15171C" stroke-width="8.6" stroke-linecap="round" fill="none"/><circle cx="23.41" cy="39.7" r="10" stroke="#15171C" stroke-width="8.6" fill="none"/><path d="M45.71 14.3 V49.7" stroke="#15171C" stroke-width="8.6" stroke-linecap="round" fill="none"/><clipPath id="obs-tb"><rect x="50.01" y="0" width="13.99" height="64"/></clipPath><path clip-path="url(#obs-tb)" d="M-13.99 64 L50.01 0 M-6.19 64 L57.81 0 M1.61 64 L65.61 0 M9.41 64 L73.41 0 M17.21 64 L81.21 0 M25.01 64 L89.01 0 M32.81 64 L96.81 0 M40.61 64 L104.61 0 M48.41 64 L112.41 0 M56.21 64 L120.21 0 M64.01 64 L128.01 0" stroke="#15171C" stroke-width="3.5" fill="none"/></g></svg>`;

export interface PageExtras {
  /** The armed, recording or latest completed capture run. */
  capture: CaptureRunRecord | null;
  /** Next feed liveness transition, for the countdown when idle. */
  nextTransition: LivenessTransition | null;
  /** Latest row per real position, worst shadow health first. */
  positions: PositionRow[] | null;
  /** Latest row per Aave V4 MAG7 borrower, protection cases first. */
  aave?: AavePositionRow[] | null;
  /** The weekend-gap panel (cached in KV). */
  gaps?: GapsPanel | null;
  /** The latest assurance replay from KV, or the reason there is none to show. */
  assurance?: AssuranceStatus | null;
  /** The seize watch from the indexer (cached in KV). */
  seize?: SeizeWatchBody | null;
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
    ? `<div class="banner held">Feeds frozen since <b>${escapeHtml(fmtEt(s.session.lastFeedUpdateAt))}</b> · next reopen <b>${escapeHtml(fmtEt(s.session.nextTransition.at))}</b> · session <b>${escapeHtml(s.session.state)}</b>. Both live credit venues still price collateral at the held value.</div>`
    : `<div class="banner">Session <b>${escapeHtml(s.session.state)}</b> · next transition <b>${escapeHtml(fmtEt(s.session.nextTransition.at))}</b> (${escapeHtml(s.session.nextTransition.to)}).</div>`;
  const rows = s.tokens.map(row).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Boundline Observatory · B20 credit on Base</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3CclipPath id='tc'%3E%3Crect width='64' height='64' rx='14'/%3E%3C/clipPath%3E%3Cg clip-path='url%28%23tc%29'%3E%3Crect width='64' height='64' fill='%23FF6B57'/%3E%3Cpath d='M11.71 14.2 V39.6' stroke='%2315171C' stroke-width='10.4' stroke-linecap='round' fill='none'/%3E%3Ccircle cx='21.91' cy='39.6' r='10.2' stroke='%2315171C' stroke-width='10.4' fill='none'/%3E%3Cpath d='M45.71 14.2 V49.8' stroke='%2315171C' stroke-width='10.4' stroke-linecap='round' fill='none'/%3E%3CclipPath id='tb'%3E%3Crect x='50.91' y='0' width='13.09' height='64'/%3E%3C/clipPath%3E%3Cpath clip-path='url%28%23tb%29' d='M-11.59 64 L52.41 0 M-1.39 64 L62.61 0 M8.81 64 L72.81 0 M19.01 64 L83.01 0 M29.21 64 L93.21 0 M39.41 64 L103.41 0 M49.61 64 L113.61 0 M59.81 64 L123.81 0 M70.01 64 L134.01 0' stroke='%2315171C' stroke-width='4.6' fill='none'/%3E%3C/g%3E%3C/svg%3E"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,400..800&display=swap" rel="stylesheet"><style>${CSS}</style></head>
<body><div class="shell">
<header class="top"><a class="brand" href="https://boundline.xyz" aria-label="Boundline home">${TILE}<span class="word">boundline</span></a><span class="product">Observatory</span>
<nav aria-label="Boundline"><a href="https://boundline.xyz">Site</a><a href="https://app.boundline.xyz">App</a><a href="https://console.boundline.xyz">Console</a><a href="/v1/tokens">JSON</a></nav></header>
<h1>Tokenized-stock credit on Base, live.</h1>
<p class="sub">Every Coinbase tokenized stock on Base: Chainlink feed, Coinbase OracleRegistry, issuer pause, 24/7 Aerodrome price and the gap the feed will print at the reopen. Block ${s.block} · taken ${escapeHtml(fmtEt(s.takenAt, true))}.</p>
${banner}
<div class="wrap"><table>
<thead><tr><th>Token</th><th>Feed (USD)</th><th>Feed updated (ET)</th><th>Age</th><th>Session</th><th>Registry ×</th><th>Transfer</th><th>DEX 1h TWAP</th><th>DEX vs feed</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
${capturePanel(s.takenAt, extras.capture, extras.nextTransition)}
${gapsPanel(extras.gaps ?? null)}
${positionsPanel(extras.positions)}
${aavePanel(extras.aave ?? null)}
${assurancePanel(extras.assurance ?? null)}
${seizePanel(extras.seize ?? null)}
<footer>Calendar: ${escapeHtml(s.session.calendarSource)} · JSON: <a href="/v1/tokens">/v1/tokens</a> · <a href="/v1/sessions">/v1/sessions</a> · <a href="/v1/captures">/v1/captures</a> · <a href="/v1/gaps">/v1/gaps</a> · <a href="/v1/positions">/v1/positions</a> · <a href="/v1/venues/morpho/markets">/v1/venues/morpho/markets</a> · <a href="/v1/venues/aave/positions">/v1/venues/aave/positions</a> · <a href="/v1/assurance">/v1/assurance</a> · <a href="/v1/seize-watch">/v1/seize-watch</a> · MIT, public good.</footer>
</div></body></html>`;
}

// ---------------------------------------------------------------- Aave V4 positions

function legsCell(p: AavePositionRow): string {
  if (p.collateral.length === 0) return `<span class="mute">none</span>`;
  return p.collateral
    .map((l) => `${fmtUsd(l.amount, l.amount < 1 ? 4 : 2)} ${escapeHtml(l.symbol)}${l.shadowPrice === null ? `<span class="mute">*</span>` : ""}`)
    .join(" · ");
}

export function aavePanel(rows: AavePositionRow[] | null): string {
  const head = `<h2>Aave V4 positions</h2>`;
  if (rows === null) return `${head}<div class="panel"><p class="mute">Aave scan not available.</p></div>`;
  if (rows.length === 0) return `${head}<div class="panel"><p class="mute">No MAG7 spoke borrowers read yet (the indexer's Borrow-event scan seeds the list; positions follow in rotating batches every five minutes).</p></div>`;
  const body = rows
    .map((p) => {
      const flag = p.protectionCase ? `<span class="tag bad">shadow HF &lt; 1.05</span>` : p.shadowHf === null ? `<span class="tag">no debt</span>` : `<span class="tag ok">ok</span>`;
      const coverage = p.collateral.length === 0 ? "—" : `${Math.round(p.shadowCoverage * 100)}%`;
      return `<tr><td><code>${escapeHtml(shortAddr(p.address))}</code></td><td>${legsCell(p)}</td><td>${fmtUsd(p.collateralValueUsd)}</td><td>${fmtUsd(Number(p.debtUsdc) / 1e6)}</td><td>${fmtHf(p.venueHf)}</td><td>${fmtHf(p.shadowHf)}</td><td>${coverage}</td><td>${flag}</td></tr>`;
    })
    .join("\n");
  const taken = rows.reduce((m, p) => Math.max(m, p.takenAt), 0);
  const cases = rows.filter((p) => p.protectionCase).length;
  return `${head}<div class="panel"><p class="mute">Real borrowers on the Aave V4 MAG7 spoke (USDC against Coinbase stocks). Venue HF is the spoke's own figure at its oracle's price, held while closed; shadow HF applies the 1h Aerodrome TWAP to every reserve that has a pool (AAPLc, NVDAc; <span class="mute">*</span> marks collateral priced at the held feed). ${rows.length} positions, ${cases} protection case${cases === 1 ? "" : "s"}, last read ${escapeHtml(fmtEt(taken, true))}.</p>
<div class="wrap"><table><thead><tr><th>Borrower</th><th>Collateral</th><th>Value (venue)</th><th>Debt (USDC)</th><th>Venue HF</th><th>Shadow HF</th><th>24/7 priced</th><th></th></tr></thead><tbody>
${body}
</tbody></table></div></div>`;
}

// ---------------------------------------------------------------- weekend gaps

function weekendBlock(w: WeekendGap): string {
  const rows = w.feeds
    .map((f) => {
      const gapCls = f.gapBps === null ? "mute" : f.gapBps < 0 ? "neg" : f.gapBps > 0 ? "pos" : "";
      return `<tr><td><b>${escapeHtml(f.symbol)}</b></td><td>${answerUsd(f.heldAnswer)}</td><td class="mute">${escapeHtml(fmtEt(f.heldUpdatedAt))}</td><td>${f.firstAnswer === null ? `<span class="mute">not yet</span>` : answerUsd(f.firstAnswer)}</td><td class="mute">${f.firstUpdatedAt === null ? "—" : escapeHtml(fmtEt(f.firstUpdatedAt, true))}</td><td>${f.lagSeconds === null ? "—" : fmtAge(Math.max(0, f.lagSeconds))}</td><td class="${gapCls}">${fmtBps(f.gapBps)}</td><td>${f.roundsWhileClosed === null ? `<span class="mute">—</span>` : f.roundsWhileClosed}</td><td class="mute">${escapeHtml(f.source)}</td></tr>`;
    })
    .join("\n");
  const dex = w.dex
    ? `<p class="mute">DEX in the last block before the reopen: ${Object.entries(w.dex)
        .map(([s, d]) => `${escapeHtml(s)} spot ${fmtBps(d.spotVsHeldBps)} and 1h TWAP ${fmtBps(d.twapVsHeldBps)} versus the held feed`)
        .join("; ")}.</p>`
    : "";
  const range = w.summary.minGapBps === null ? "" : ` · gaps ${fmtBps(w.summary.minGapBps)} to ${fmtBps(w.summary.maxGapBps)}`;
  const lag = w.summary.minLagSeconds === null ? "" : ` · first prints ${fmtAge(Math.max(0, w.summary.minLagSeconds))} to ${fmtAge(Math.max(0, w.summary.maxLagSeconds ?? 0))} after the reopen`;
  return `<p>Reopen <b>${escapeHtml(fmtEt(w.reopenAt))}</b>${w.closeAt === null ? "" : ` · closed since <b>${escapeHtml(fmtEt(w.closeAt))}</b>`} · ${w.summary.feeds} feed${w.summary.feeds === 1 ? "" : "s"}${range}${lag} · source ${escapeHtml(w.sources.join(", "))}</p>
${dex}
<div class="wrap"><table><thead><tr><th>Token</th><th>Held close</th><th>Held since (ET)</th><th>First print after</th><th>Printed at (ET)</th><th>Lag</th><th>Gap</th><th>Rounds while closed</th><th>Source</th></tr></thead><tbody>
${rows}
</tbody></table></div>`;
}

export function gapsPanel(panel: GapsPanel | null, maxWeekends = 3): string {
  const head = `<h2>Weekend gaps</h2>`;
  if (panel === null) return `${head}<div class="panel"><p class="mute">Gap history not available.</p></div>`;
  if (panel.weekends.length === 0) return `${head}<div class="panel"><p class="mute">No closure recorded yet.</p></div>`;
  const blocks = panel.weekends.slice(0, maxWeekends).map(weekendBlock).join("\n");
  const more = panel.weekends.length > maxWeekends ? `<p class="mute">${panel.weekends.length - maxWeekends} earlier closure${panel.weekends.length - maxWeekends === 1 ? "" : "s"} in <a href="/v1/gaps">/v1/gaps</a>.</p>` : "";
  const through = panel.indexer.through === null ? "no round history from the indexer yet" : `indexer rounds through ${escapeHtml(fmtEt(panel.indexer.through))}`;
  return `${head}<div class="panel"><p class="mute">What the feeds printed around each closure: the held close, the first print after the reopen, its lag and the gap. ${through}; computed ${escapeHtml(fmtEt(panel.computedAt, true))}.</p>
${blocks}
${more}</div>`;
}

// ---------------------------------------------------------------- assurance replay

export function assurancePanel(a: AssuranceStatus | null): string {
  const head = `<h2>Assurance replay</h2>`;
  if (a === null || a.status === "no run yet") return `${head}<div class="panel"><p class="mute">No run yet. The replay harness forks Base at the latest block, takes every real Aave and Morpho stock position through Friday close, a feed gap and the Sunday reopen, raw venue against Boundline, and publishes the result here with its evidence hash.</p></div>`;
  if (a.status === "malformed") return `${head}<div class="panel"><p class="mute">The last run could not be read: ${escapeHtml(a.detail)}.</p></div>`;
  const r = a.run;
  const verdict = r.summary.pass ? `<span class="tag ok">pass</span>` : `<span class="tag bad">fail</span>`;
  const rows = r.scenarios
    .flatMap((s) =>
      s.positions.map((p) => {
        const rawTag = p.raw.liquidatableAtReopen ? `<span class="tag bad">liquidatable</span>` : `<span class="tag ok">safe</span>`;
        const blTag = p.boundline.liquidatableAtReopen ? `<span class="tag bad">liquidatable</span>` : `<span class="tag ok">safe</span>`;
        const action = p.boundline.action === "none" ? `<span class="mute">none</span>` : `${escapeHtml(p.boundline.action)} ${escapeHtml(p.boundline.actionAt)} · ${fmtUsd(Number(p.boundline.amountUsdc))} USDC`;
        return `<tr><td><b>${escapeHtml(s.id)}</b> <span class="mute">${fmtBps(s.gapBps)}</span></td><td>${escapeHtml(p.venue)}</td><td><code>${escapeHtml(shortAddr(p.address))}</code></td><td>${escapeHtml(p.collateralSymbol)}</td><td>${fmtUsd(Number(p.debtUsdc))}</td><td>${escapeHtml(fmtAssuranceHf(p.raw.hfAtReopen))}</td><td>${p.raw.liquidatableSaturday ? `<span class="tag bad">Sat</span> ` : ""}${rawTag}</td><td>${action}</td><td>${escapeHtml(fmtAssuranceHf(p.boundline.hfAfter))}</td><td>${blTag}</td></tr>`;
      }),
    )
    .join("\n");
  return `${head}<div class="panel"><p>${verdict} ran ${escapeHtml(fmtEt(r.ranAt, true))} · fork block ${r.forkBlock} (${escapeHtml(fmtEt(r.forkBlockTime))}) · ${r.summary.positions} position${r.summary.positions === 1 ? "" : "s"} × ${r.summary.scenarios} scenario${r.summary.scenarios === 1 ? "" : "s"} · raw venue liquidatable in ${r.summary.rawLiquidatable}, with Boundline ${r.summary.boundlineLiquidatable}.</p>
<p class="mute">Evidence <code>${escapeHtml(r.evidenceHash)}</code> · ${escapeHtml(r.artifact)}</p>
<p class="mute">Rows that share an address are one real position replayed twice: as it stood, and staged near its limit before the gap (the evidence file labels each row). The harness is scheduled to run nightly in CI once the repository is public.</p>
<div class="wrap"><table><thead><tr><th>Scenario</th><th>Venue</th><th>Position</th><th>Collateral</th><th>Debt (USDC)</th><th>Raw HF at reopen</th><th>Raw venue</th><th>Boundline action</th><th>HF after</th><th>With Boundline</th></tr></thead><tbody>
${rows}
</tbody></table></div></div>`;
}

// ---------------------------------------------------------------- seize watch

function verdictTag(v: string): string {
  if (v === "NO_SEIZE_ROLE") return `<span class="tag ok">no seize role</span>`;
  if (v === "SEIZE_ROLE_REVOKED") return `<span class="tag warn">role revoked</span>`;
  return `<span class="tag bad">${escapeHtml(v.toLowerCase().replaceAll("_", " "))}</span>`;
}

export function seizePanel(w: SeizeWatchBody | null): string {
  const head = `<h2>Seize watch</h2>`;
  if (w === null) return `${head}<div class="panel"><p class="mute">Seize watch not available yet (the indexer answers it; refreshed every 30 minutes).</p></div>`;
  const rows = w.tokens
    .map((t) => {
      const venues = t.venues === null ? `<span class="mute">not read</span>` : t.venues.every((v) => v.exempt === true) ? `<span class="tag ok">all ${t.venues.length} exempt</span>` : t.venues.filter((v) => v.exempt === false).map((v) => `<span class="tag bad">${escapeHtml(v.name)} seizable</span>`).join(" ") || `<span class="mute">unknown</span>`;
      const last = t.seizeExemptPolicy.updates[t.seizeExemptPolicy.updates.length - 1];
      const since = last ? `${escapeHtml(fmtEt(last.time))} <span class="mute">(${last.old} → ${last.new})</span>` : `<span class="mute">unset</span>`;
      return `<tr><td><b>${escapeHtml(t.symbol)}</b></td><td>${verdictTag(t.verdict)}</td><td>${t.seizeRole.holders.length}</td><td>${t.seizeExemptPolicy.live === null ? "—" : t.seizeExemptPolicy.live}</td><td class="mute">${since}</td><td>${t.seizeReceiverPolicy.live === null ? "—" : t.seizeReceiverPolicy.live === 0 ? `<span class="mute">0 (any)</span>` : t.seizeReceiverPolicy.live}</td><td>${t.seized}</td><td>${venues}</td></tr>`;
    })
    .join("\n");
  const changes = w.policyChanges.length
    ? `<p class="mute">Exemption-policy changes: ${w.policyChanges.map((c) => `policy ${c.policyId} ${escapeHtml(c.event)} ${c.accounts.length} account${c.accounts.length === 1 ? "" : "s"} at block ${c.block} (${escapeHtml(fmtEt(c.time))})`).join("; ")}.</p>`
    : "";
  const live = w.live.block === null ? `live read unavailable (${escapeHtml(w.live.error ?? "unknown")})` : `live at block ${w.live.block}`;
  return `${head}<div class="panel"><p>${escapeHtml(w.summary.statement)}</p>
<p class="mute">A B20 issuer with SEIZE_ROLE can move tokens out of any account its SEIZE_EXEMPT_POLICY does not authorise; a seize from a venue pool would take every borrower's collateral at once. History scanned from each stock's creation (block ${w.coverage.baseline.from}) through block ${w.coverage.baseline.to}${w.coverage.tokenEvents ? `, indexed events through block ${w.coverage.tokenEvents.to}` : ""}; ${live}.</p>
${changes}
<div class="wrap"><table><thead><tr><th>Token</th><th>Verdict</th><th>Seize role holders</th><th>Exemption policy</th><th>Set (ET)</th><th>Seize receiver policy</th><th>Seized</th><th>Venue pools</th></tr></thead><tbody>
${rows}
</tbody></table></div></div>`;
}
