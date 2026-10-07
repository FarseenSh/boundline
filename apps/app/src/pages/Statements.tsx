import { explorer, formatEt, formatLocal, formatShares, formatUsd, price8ToNumber, shortAddress, shortHash } from "@boundline/sdk";
import { useAccount } from "wagmi";
import { cfg } from "../boundline.js";
import { ConnectChoices } from "../components/Wallet.jsx";
import { useDecisions, useLineId, usePayouts, useRoots } from "../hooks.js";

const SHARE_ACTIONS = new Set(["ADD_COLLATERAL", "WITHDRAW_COLLATERAL"]);
const ACTION_WORDS: Record<string, string> = {
  OPEN: "Line opened",
  ADD_COLLATERAL: "Collateral added",
  DRAW: "Drawn",
  REPAY: "Repaid",
  WITHDRAW_COLLATERAL: "Collateral withdrawn",
  CLOSE: "Line closed",
  HOLD: "Put on hold by the keeper",
  RELEASE: "Hold released",
};

export function Statements() {
  const { address, isConnected } = useAccount();
  const lineId = useLineId(address);
  const id = lineId.data && lineId.data > 0n ? lineId.data : undefined;
  const decisions = useDecisions(id);
  const roots = useRoots();
  const payouts = usePayouts(address);
  const localSymbol = (token: string): { symbol: string; decimals: number } => {
    const p = cfg.payout.pools.find((x) => x.token.toLowerCase() === token.toLowerCase());
    return p ? { symbol: p.symbol, decimals: p.decimals } : { symbol: shortAddress(token), decimals: 6 };
  };

  return (
    <>
      <h1>Statement</h1>
      <p className="lede">
        Every action on your line carries a decision hash bound to the chain, the desk and a nonce, indexed with a hash-chained daily root. This is the record a partner reconciles against; it is also yours.
      </p>
      {!isConnected || !address ? (
        <ConnectChoices />
      ) : !id ? (
        <p className="mute">{lineId.data === 0n ? "No line yet, so nothing to show." : "Reading your line…"}</p>
      ) : (
        <div className="panel wrap">
          {decisions.isLoading ? <p className="mute">Reading the indexer…</p> : null}
          {decisions.error ? <p className="coral">The indexer did not answer: {decisions.error.message}</p> : null}
          {decisions.data && decisions.data.length === 0 ? <p className="mute">No decisions indexed for line {id.toString()} yet.</p> : null}
          {decisions.data && decisions.data.length > 0 ? (
            <table className="ledger">
              <thead>
                <tr>
                  <th>When (ET)</th>
                  <th>Action</th>
                  <th className="num">Amount</th>
                  <th className="num">Price</th>
                  <th>Decision</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {decisions.data.map((d) => (
                  <tr key={`${d.txHash}:${d.logIndex}`}>
                    <td>{formatEt(d.blockTime, { seconds: true })}</td>
                    <td>{ACTION_WORDS[d.action] ?? d.action}</td>
                    <td className="num">{d.amount === 0n ? "—" : SHARE_ACTIONS.has(d.action) ? `${formatShares(d.amount)} sh` : formatUsd(d.amount)}</td>
                    <td className="num">{d.price8 === 0n ? "—" : `$${price8ToNumber(d.price8).toFixed(2)}`}</td>
                    <td>
                      <a href={`/api/v1/decisions/${d.decisionHash}`} title={d.decisionHash}>
                        <code>{shortHash(d.decisionHash)}</code>
                      </a>
                    </td>
                    <td>
                      <a href={explorer.tx(cfg, d.txHash)}>
                        <code>{shortHash(d.txHash)}</code>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      )}

      {cfg.payout.router && isConnected && address ? (
        <>
          <h2>Local-money payouts</h2>
          <div className="panel wrap">
            <p>
              The last leg of a borrow batch: drawn USDC swapped into a local stablecoin by the payout router, session-checked and slippage-bounded. The router keeps this record itself; nothing here needs an indexer.
            </p>
            {payouts.isLoading ? <p className="mute">Reading the router…</p> : null}
            {payouts.error ? <p className="coral">The router did not answer: {payouts.error.message}</p> : null}
            {payouts.data && payouts.data.length === 0 ? <p className="mute">No payouts yet. Choose a local stablecoin under "Receive as" when you borrow.</p> : null}
            {payouts.data && payouts.data.length > 0 ? (
              <table className="ledger">
                <thead>
                  <tr>
                    <th>When (ET)</th>
                    <th className="num">Paid</th>
                    <th className="num">Received</th>
                    <th>Pool</th>
                  </tr>
                </thead>
                <tbody>
                  {[...payouts.data].reverse().map((r, i) => {
                    const out = localSymbol(r.tokenOut);
                    return (
                      <tr key={`${r.at}:${i}`}>
                        <td>{formatEt(r.at, { seconds: true })}</td>
                        <td className="num">{formatUsd(r.amountIn)}</td>
                        <td className="num">{formatLocal(r.amountOut, out.symbol, out.decimals)}</td>
                        <td>
                          <a href={explorer.address(cfg, r.pool)}>
                            <code>{shortAddress(r.pool)}</code>
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : null}
          </div>
        </>
      ) : null}

      <h2>Daily roots</h2>
      <div className="panel wrap">
        <p>
          <code>root = keccak256(prev_root ‖ h1 ‖ … ‖ hn)</code> over every indexed event of the day. Anyone can recompute it from the chain.
        </p>
        {roots.data ? (
          <table className="ledger">
            <thead>
              <tr>
                <th>Day (UTC)</th>
                <th className="num">Events</th>
                <th>Root</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{roots.data.today.day} (so far)</td>
                <td className="num">{roots.data.today.eventCount}</td>
                <td>
                  <code>{shortHash(roots.data.today.rootSoFar)}</code>
                </td>
              </tr>
              {roots.data.roots.map((r) => (
                <tr key={r.day}>
                  <td>{r.day}</td>
                  <td className="num">{r.eventCount}</td>
                  <td>
                    <code title={r.root}>{shortHash(r.root)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mute">Reading roots…</p>
        )}
      </div>
    </>
  );
}
