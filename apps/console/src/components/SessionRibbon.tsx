// The exchange clock from the Observatory's /v1/sessions: the state now, the next session boundary and the next
// feed transition (Friday close or Sunday reopen). Falls back to the SDK's calendar when the Observatory is down.
import { SESSION_LABEL, countdown, formatEt, sessionInfo } from "@boundline/sdk";
import { useNow, useSessions } from "../hooks.js";
import type { ObservatorySessions } from "../types.js";

const LIVE = new Set(["PRE", "REGULAR", "POST", "OVERNIGHT"]);

function labelOf(state: string): string {
  const s = SESSION_LABEL as Record<string, string>;
  return s[state] ?? state;
}

function fromObservatory(s: ObservatorySessions, now: number): { closed: boolean; line: string } {
  const closed = !LIVE.has(s.state) || !s.isFeedLive;
  const parts: string[] = [];
  if (closed) {
    parts.push(`${labelOf(s.state)}. Feeds held`);
    if (s.nextFeedTransition && s.nextFeedTransition.kind === "reopen") parts.push(`; reopen ${formatEt(s.nextFeedTransition.at, { date: true })}, in ${countdown(s.nextFeedTransition.at - now)}`);
    parts.push(".");
  } else {
    parts.push(`${labelOf(s.state)} now, feeds live`);
    if (s.nextTransition) parts.push(`; ${labelOf(s.nextTransition.to).toLowerCase()} at ${formatEt(s.nextTransition.at)}, in ${countdown(s.nextTransition.at - now)}`);
    if (s.nextFeedTransition) parts.push(`; feeds ${s.nextFeedTransition.kind === "close" ? "stop" : "resume"} ${formatEt(s.nextFeedTransition.at, { date: true })}`);
    parts.push(".");
  }
  if (s.lastFeedUpdateAt) parts.push(` Last feed print ${countdown(now - s.lastFeedUpdateAt)} ago.`);
  return { closed, line: parts.join("") };
}

export function SessionRibbon() {
  const now = useNow();
  const q = useSessions();
  let closed: boolean;
  let line: string;
  let source: string;
  if (q.data) {
    ({ closed, line } = fromObservatory(q.data, now));
    source = `Observatory, snapshot ${countdown(now - q.data.takenAt)} ago`;
  } else {
    const info = sessionInfo(now);
    closed = !info.feedLive;
    line = closed ? `${SESSION_LABEL[info.session]}. Feeds held${info.closedUntil ? `; reopens ${formatEt(info.closedUntil, { date: true })}` : ""}.` : `${SESSION_LABEL[info.session]} now, feeds live.`;
    source = q.isLoading ? "reading the Observatory…" : "calendar only; the Observatory did not answer";
  }
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", day: "numeric", month: "short" }).format(new Date(now * 1000));
  return (
    <section className="ribbon" aria-label="Wall Street session clock">
      <span className="day">{day} · New York</span>
      <p>
        {closed ? <b className="coral">Closed. </b> : <b className="live">Open. </b>}
        {line}
      </p>
      <span className="source mute">{source}</span>
    </section>
  );
}
