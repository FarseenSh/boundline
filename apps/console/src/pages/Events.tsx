// The partner event log: what the keeper saw off chain (a line entering or leaving grace at the 24/7 price) and what
// the chain recorded (protective repays, holds and releases, recoveries, settlements), the same events the webhooks
// deliver, newest first.
import { formatEt, WEBHOOK_EVENT_COPY, type PartnerEvent } from "@boundline/sdk";
import { ErrorNote } from "../components/ErrorNote.jsx";
import { Tag } from "../components/Tag.jsx";
import { usePartnerEvents } from "../hooks.js";
import { Link } from "../router.js";
import { explorerTx, type Tone } from "../timeline.js";
import { summarizeData } from "../webhooks.js";

function typeTone(type: string): Tone {
  if (type === "grace" || type === "hold") return "warn";
  if (type === "protect" || type === "settle" || type === "grace.cleared" || type === "release") return "live";
  return "plain";
}

function EventRow({ e }: { e: PartnerEvent }) {
  return (
    <tr>
      <td>{formatEt(e.at, { seconds: true })}</td>
      <td>
        <Tag tone={typeTone(e.type)} title={WEBHOOK_EVENT_COPY[e.type as keyof typeof WEBHOOK_EVENT_COPY]}>
          {e.type}
        </Tag>
      </td>
      <td>{e.lineId ? <Link to={`/lines/${e.lineId}`}>#{e.lineId}</Link> : "—"}</td>
      <td className="mute">{e.source}</td>
      <td>{summarizeData(e.data) || "—"}</td>
      <td>
        {e.txHash ? (
          <a href={explorerTx(e.chainId, e.txHash)} title={e.txHash}>
            <code>{e.txHash.slice(0, 10)}…</code>
          </a>
        ) : null}
        {e.decisionHash ? (
          <>
            {e.txHash ? " · " : ""}
            <code className="mute" title={e.decisionHash}>
              {e.decisionHash.slice(0, 10)}…
            </code>
          </>
        ) : null}
        {!e.txHash && !e.decisionHash ? <span className="mute">off chain</span> : null}
      </td>
    </tr>
  );
}

export function Events() {
  const events = usePartnerEvents();
  return (
    <>
      <h1>Events</h1>
      <p className="lede">
        Everything that happened to your lines, in one log: the keeper's grace signals (computed at the 24/7 DEX price, off chain) and the chain's own records of protective repays, holds, releases, recoveries and settlements. The webhooks deliver exactly these.{" "}
        <Link to="/webhooks">Set up a webhook</Link>.
      </p>
      {events.error ? <ErrorNote error={events.error} what="Events" /> : null}
      {events.isLoading ? <p className="mute">Reading the event log…</p> : null}
      {events.data && events.data.length === 0 ? <p className="mute">No events yet for this partner.</p> : null}
      {events.data && events.data.length > 0 ? (
        <div className="panel wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th>When (ET)</th>
                <th>Event</th>
                <th>Line</th>
                <th>Source</th>
                <th>Details</th>
                <th>Tx / decision</th>
              </tr>
            </thead>
            <tbody>
              {events.data.map((e) => (
                <EventRow key={e.id} e={e} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
