import { explorer, formatShares, formatUsd, price8ToNumber } from "@boundline/sdk";
import { useAccount } from "wagmi";
import { cfg, primaryStock } from "../boundline.js";
import { ConnectChoices } from "../components/Wallet.jsx";
import { HealthBar } from "../components/HealthBar.jsx";
import { useBalances, useLineHealth, useLineId } from "../hooks.js";
import { Link } from "../router.js";

export function Portfolio() {
  const { address, isConnected } = useAccount();
  const lineId = useLineId(address);
  const view = useLineHealth(lineId.data && lineId.data > 0n ? lineId.data : undefined);
  const balances = useBalances(address);

  if (!isConnected || !address) {
    return (
      <>
        <h1>Borrow against your stocks. Never liquidated while Wall Street is closed.</h1>
        <p className="lede">
          A USDC credit line on your own Morpho position, with Boundline enforcing the clock: no draws and no liquidations while the price feed is held, repay and add collateral at any hour.
        </p>
        <ConnectChoices />
        <p className="mute">Test network: {cfg.name}. The shares here are Boundline's test stocks; the mechanics are the mainnet ones.</p>
      </>
    );
  }

  const h = view.data?.health;
  const q = view.data?.quote;
  return (
    <>
      {h && q ? (
        <section className="hero">
          <p className="label">{h.state === "no_debt" || h.state === "healthy" || h.state === "watch" ? "You can borrow up to" : "Available to draw"}</p>
          <div className={`figure ${h.gateOpen ? "" : "closed"}`}>{formatUsd(q.available)}</div>
          <p className="sub">
            {h.headline}. Against {formatShares(q.collateralRaw)} {primaryStock?.symbol ?? "shares"} worth {formatUsd(q.collateralValue)}
            {q.price8 > 0n ? ` at $${price8ToNumber(q.price8).toFixed(2)}` : ""}; debt {formatUsd(q.debt)}.
          </p>
          <HealthBar health={h} />
          <p className="ink2">{h.copy}</p>
          <p>
            <Link to="/borrow" className="btn primary">
              Borrow
            </Link>
          </p>
        </section>
      ) : lineId.data === 0n ? (
        <section className="hero">
          <p className="label">No line yet</p>
          <div className="figure">Open one.</div>
          <p className="sub">A line is your own Morpho position under the Boundline policy. Opening it costs one transaction and moves nothing.</p>
          <p>
            <Link to="/borrow" className="btn primary">
              Open a line
            </Link>
          </p>
        </section>
      ) : (
        <p className="mute">Reading your line…</p>
      )}

      <h2>Holdings</h2>
      <div className="panel">
        {balances.data ? (
          <>
            {balances.data.stocks.map((s) => (
              <div className="kv" key={s.symbol}>
                <span>{s.symbol}</span>
                <span>{formatShares(s.raw)} shares</span>
              </div>
            ))}
            <div className="kv">
              <span>USDC</span>
              <span>{formatUsd(balances.data.usdc)}</span>
            </div>
          </>
        ) : (
          <p className="mute">Reading balances…</p>
        )}
      </div>

      {view.data ? (
        <>
          <h2>Line {view.data.line.lineId.toString()}</h2>
          <div className="panel">
            <div className="kv">
              <span>Status</span>
              <span>
                <span className={`tag ${view.data.line.status === "OPEN" ? "live" : "bad"}`}>{view.data.line.status}</span>
              </span>
            </div>
            <div className="kv">
              <span>Policy version</span>
              <span>{view.data.line.policyVersion}</span>
            </div>
            <div className="kv">
              <span>Session</span>
              <span>{view.data.quote.session}</span>
            </div>
            <div className="kv">
              <span>Gate</span>
              <span>{view.data.quote.reason === "NONE" ? "open" : view.data.quote.reason}</span>
            </div>
            <div className="kv">
              <span>Desk</span>
              <span>
                <a href={explorer.address(cfg, cfg.desk!)}>
                  <code>{cfg.desk}</code>
                </a>
              </span>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
