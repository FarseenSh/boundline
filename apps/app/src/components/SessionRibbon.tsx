// The exchange clock: one ET day as a band, the live sessions tinted, the closed days hatched, the
// present moment marked. The product's whole promise hangs on this clock, so it leads every page.
import { describe } from "@boundline/calendar";
import { SESSION_LABEL, countdown, formatEt, type SessionInfo } from "@boundline/sdk";

interface Segment {
  cls: string;
  from: number;
  to: number;
}

function segmentsFor(earlyClose: boolean, closedDay: boolean): Segment[] {
  if (closedDay) return [{ cls: "closed", from: 0, to: 1440 }];
  const regularClose = earlyClose ? 13 * 60 : 16 * 60;
  const postEnd = earlyClose ? 17 * 60 : 20 * 60;
  return [
    { cls: "overnight", from: 0, to: 240 },
    { cls: "pre", from: 240, to: 570 },
    { cls: "regular", from: 570, to: regularClose },
    { cls: "post", from: regularClose, to: postEnd },
    { cls: "overnight", from: postEnd, to: 1440 },
  ];
}

export function SessionRibbon({ info }: { info: SessionInfo }) {
  const d = describe(info.now);
  const closedDay = info.session === "WEEKEND" || info.session === "HOLIDAY";
  const segs = segmentsFor(d.earlyClose, closedDay);
  const pct = (m: number): string => `${(m / 1440) * 100}%`;
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", day: "numeric", month: "short" }).format(new Date(info.now * 1000));

  let line: string;
  if (closedDay) {
    line = info.closedUntil ? `${SESSION_LABEL[info.session]}. Feeds held; reopens ${formatEt(info.closedUntil)}, in ${countdown(info.closedUntil - info.now)}.` : `${SESSION_LABEL[info.session]}. Feeds held.`;
  } else if (info.nextTransition.at !== null) {
    const at = info.nextTransition.at;
    const to = info.nextTransition.to;
    const nextLabel = to === "WEEKEND" || to === "HOLIDAY" ? "feeds stop" : SESSION_LABEL[to].toLowerCase();
    line = `${SESSION_LABEL[info.session]} now, feeds live. Next: ${nextLabel} at ${formatEt(at, { date: at - info.now > 20 * 3600 })}, in ${countdown(at - info.now)}.`;
  } else {
    line = `${SESSION_LABEL[info.session]} now.`;
  }

  return (
    <section className="ribbon" aria-label="Wall Street session clock">
      <span className="day">{day} · New York</span>
      <div className="band" role="img" aria-label={line}>
        {segs.map((s, i) => (
          <div key={i} className={`seg ${s.cls}`} style={{ width: pct(s.to - s.from) }} />
        ))}
        <div className="now" style={{ left: pct(d.minutesOfDay) }} />
      </div>
      <div className="marks" aria-hidden="true">
        <span style={{ left: 0 }}>00:00</span>
        <span style={{ left: pct(240) }}>04:00</span>
        <span style={{ left: pct(570) }}>09:30</span>
        <span style={{ left: pct(d.earlyClose ? 780 : 960) }}>{d.earlyClose ? "13:00" : "16:00"}</span>
        <span style={{ left: pct(1200) }}>20:00</span>
        <span style={{ left: "100%" }}>ET</span>
      </div>
      <p>
        {closedDay ? <b className="coral">Closed. </b> : <b className="live">Open. </b>}
        {line}
      </p>
    </section>
  );
}
