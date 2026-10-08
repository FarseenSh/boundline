import { explorer, formatEt, formatLocal, formatShares, formatUsd, price8ToNumber, shortAddress, shortHash } from "@boundline/sdk";
import { useAccount } from "wagmi";
import { cfg } from "../boundline.js";
import { ConnectChoices } from "../components/Wallet.jsx";
import { useDecisions, useLineId, usePayouts, useRoots, useUserLines, useVaultEvents, type VaultEventRow } from "../hooks.js";

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

/** One vault event in words: what the protection ladder did for the line. */
function vaultWords(e: VaultEventRow): { what: string; amount: string } {
  const a = e.args;
  const usd = (k: string): string => formatUsd(BigInt(a[k] ?? "0"));
  switch (e.name) {
    case "Protected":
      return { what: `Protective repay: ${usd("fromUser")} from your reserve, ${usd("fromPartner")} from the partner, ${usd("fromAdvance")} advanced; debt ${usd("debtBefore")} → ${usd("debtAfter")}`, amount: usd("repaid") };
    case "AdvanceSettled":
      return { what: `Advance settled by ${shortAddress(a.payer ?? "")}: ${usd("principal")} principal + ${usd("fee")} fee; ${usd("outstandingAfter")} still owed`, amount: formatUsd(BigInt(a.principal ?? "0") + BigInt(a.fee ?? "0")) };
    case "CollateralRecovered":
      return { what: `Collateral recovered in an open session at $${price8ToNumber(BigInt(a.price8 ?? "0")).toFixed(2)}`, amount: `${formatShares(BigInt(a.amount ?? "0"))} sh` };
    case "CollateralReturned":
      return { what: "Recovered collateral returned to you", amount: `${formatShares(BigInt(a.amount ?? "0"))} sh` };
    default:
      return { what: e.name, amount: "—" };
  }
}

export function Statements() {
  const { address, isConnected } = useAccount();
  const lineId = useLineId(address);
  const id = lineId.data && lineId.data > 0n ? lineId.data : undefined;
  const decisions = useDecisions(id);
  const lines = useUserLines(address);
  const vaultEvents = useVaultEvents(lines.data?.map((l) => l.lineId));
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

      {cfg.deskProtectionVault && isConnected && address && lines.data && lines.data.length > 0 ? (
        <>
          <h2>Protection vault</h2>
          <div className="panel wrap">
            <p>What the protection ladder did for your lines: repays the keeper made at any hour from your reserve, the partner's reserve or a Boundline Reserve advance, and how each advance was settled.</p>
            {vaultEvents.isLoading ? <p className="mute">Reading the indexer…</p> : null}
            {vaultEvents.error ? <p className="coral">The indexer did not answer: {vaultEvents.error.message}</p> : null}
            {vaultEvents.data && !vaultEvents.data.indexed ? <p className="mute">The indexer does not carry the vault's events yet; your reserve and any advance owed are read live from the vault on the Protect page.</p> : null}
            {vaultEvents.data && vaultEvents.data.indexed && vaultEvents.data.rows.length === 0 ? <p className="mute">The vault has not acted on your lines.</p> : null}
            {vaultEvents.data && vaultEvents.data.rows.length > 0 ? (
              <table className="ledger">
                <thead>
                  <tr>
                    <th>When (ET)</th>
                    <th>Line</th>
                    <th>What</th>
                    <th className="num">Amount</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {vaultEvents.data.rows.map((e) => {
                    const w = vaultWords(e);
                    return (
                      <tr key={`${e.txHash}:${e.logIndex}`}>
                        <td>{formatEt(e.blockTime, { seconds: true })}</td>
                        <td>#{e.lineId}</td>
                        <td>
                          {w.what}
                          {e.args.decisionHash ? (
                            <>
                              {" "}
                              <code className="mute" title={e.args.decisionHash}>
                                {shortHash(e.args.decisionHash)}
                              </code>
                            </>
                          ) : null}
                        </td>
                        <td className="num">{w.amount}</td>
                        <td>
                          <a href={explorer.tx(cfg, e.txHash)}>
                            <code>{shortHash(e.txHash)}</code>
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
