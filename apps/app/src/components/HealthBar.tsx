import { formatEt, type Health } from "@boundline/sdk";

/** Loan against collateral on a 0..LLTV scale: the policy limit is a mark, the venue's threshold the end. */
export function HealthBar({ health }: { health: Health }) {
  const lltv = health.lltv > 0 ? health.lltv : 1;
  const ltv = health.ltv ?? 0;
  const fillPct = Math.max(0, Math.min(100, (ltv / lltv) * 100));
  const policyPct = Math.max(0, Math.min(100, (health.policyMaxLtv / lltv) * 100));
  const fillCls = health.state === "over_policy" || health.state === "liquidatable" ? "bad" : health.state === "near_limit" || health.state === "watch" ? "watch" : "";
  const pct = (x: number): string => `${Math.round(x * 1000) / 10}%`;
  return (
    <div className="bar" aria-label={`Loan to value ${pct(ltv)}, policy limit ${pct(health.policyMaxLtv)}, liquidation above ${pct(health.lltv)}`}>
      <div className="track">
        <div className={`fill ${fillCls}`} style={{ width: `${fillPct}%` }} />
        {!health.gateOpen ? <div className="held" title="No draws and no liquidations while the gate is closed" /> : null}
        <div className="mark" style={{ left: `${policyPct}%` }} title={`Policy limit ${pct(health.policyMaxLtv)}`} />
        <div className="mark lltv" style={{ left: "100%" }} title={`Venue liquidates above ${pct(health.lltv)}`} />
      </div>
      <div className="legend">
        <span>
          <b>{health.ltv === null ? "—" : pct(ltv)}</b> borrowed
        </span>
        <span>
          your limit <b>{pct(health.policyMaxLtv)}</b>
        </span>
        <span>
          venue liquidates <b className="coral">{pct(health.lltv)}</b>
        </span>
      </div>
      {!health.gateOpen && health.closedUntil ? (
        <div className="legend">
          <span className="coral">Held until {formatEt(health.closedUntil)}: no draws, no liquidations.</span>
        </div>
      ) : null}
    </div>
  );
}
