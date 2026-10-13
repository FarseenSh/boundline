import type { AavePositionRow } from "./aave-positions.js";
import { fmtAssuranceHf, type AssuranceStatus } from "./assurance.js";
import type { LivenessTransition } from "./capture.js";
import { escapeHtml, fmtAge, fmtBps, fmtEt, fmtUsd } from "./format.js";
import type { GapsPanel, WeekendGap } from "./gaps.js";
import type { PositionRow } from "./positions.js";
import type { SeizeWatchBody } from "./seize.js";
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
    ? `<div class="banner">Feeds frozen since <b>${escapeHtml(fmtEt(s.session.lastFeedUpdateAt))}</b> · next reopen <b>${escapeHtml(fmtEt(s.session.nextTransition.at))}</b> ET · session <b>${escapeHtml(s.session.state)}</b>. Both live credit venues still price collateral at the held value.</div>`
    : `<div class="banner">Session <b>${escapeHtml(s.session.state)}</b> · next transition <b>${escapeHtml(fmtEt(s.session.nextTransition.at))}</b> ET (${escapeHtml(s.session.nextTransition.to)}).</div>`;
  const rows = s.tokens.map(row).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Boundline Observatory · B20 credit on Base</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3CclipPath id='tc'%3E%3Crect width='64' height='64' rx='14'/%3E%3C/clipPath%3E%3Cg clip-path='url%28%23tc%29'%3E%3Crect width='64' height='64' fill='%23FF6B57'/%3E%3Cpath d='M11.71 14.2 V39.6' stroke='%2315171C' stroke-width='10.4' stroke-linecap='round' fill='none'/%3E%3Ccircle cx='21.91' cy='39.6' r='10.2' stroke='%2315171C' stroke-width='10.4' fill='none'/%3E%3Cpath d='M45.71 14.2 V49.8' stroke='%2315171C' stroke-width='10.4' stroke-linecap='round' fill='none'/%3E%3CclipPath id='tb'%3E%3Crect x='50.91' y='0' width='13.09' height='64'/%3E%3C/clipPath%3E%3Cpath clip-path='url%28%23tb%29' d='M-11.59 64 L52.41 0 M-1.39 64 L62.61 0 M8.81 64 L72.81 0 M19.01 64 L83.01 0 M29.21 64 L93.21 0 M39.41 64 L103.41 0 M49.61 64 L113.61 0 M59.81 64 L123.81 0 M70.01 64 L134.01 0' stroke='%2315171C' stroke-width='4.6' fill='none'/%3E%3C/g%3E%3C/svg%3E"><style>${CSS}</style></head>
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
${gapsPanel(extras.gaps ?? null)}
${positionsPanel(extras.positions)}
${aavePanel(extras.aave ?? null)}
${assurancePanel(extras.assurance ?? null)}
${seizePanel(extras.seize ?? null)}
<footer>Calendar: ${escapeHtml(s.session.calendarSource)} · JSON: <a href="/v1/tokens">/v1/tokens</a> · <a href="/v1/sessions">/v1/sessions</a> · <a href="/v1/captures">/v1/captures</a> · <a href="/v1/gaps">/v1/gaps</a> · <a href="/v1/positions">/v1/positions</a> · <a href="/v1/venues/morpho/markets">/v1/venues/morpho/markets</a> · <a href="/v1/venues/aave/positions">/v1/venues/aave/positions</a> · <a href="/v1/assurance">/v1/assurance</a> · <a href="/v1/seize-watch">/v1/seize-watch</a> · MIT, public good.</footer>
</body></html>`;
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
