// Ladder step 1 on the Morpho desk: the user's own USDC reserve in the DeskProtectionVault, which the keeper spends
// on a protective repay (at any hour) before touching the partner's reserve or a Boundline Reserve advance. This panel
// shows the live terms, the reserve with deposit and withdraw, and per line: the debt, the vault's own preview of
// how repaying all of it would be funded right now, and any advance still owed, with a button to settle it.
import { advanceDue, explorer, formatUnits, formatUsd, hasAdvance, parseUsdc, shortAddress } from "@boundline/sdk";
import { useState } from "react";
import type { Address } from "viem";
import { boundline, cfg } from "../boundline.js";
import { useBalances, useUserLines, useVaultBalance, useVaultLines, useVaultTerms } from "../hooks.js";
import { useSendFlow } from "../sendflow.jsx";
import { TxTimeline } from "./TxTimeline.jsx";

function bps(n: number): string {
  return `${(n / 100).toFixed(2)}%`;
}

export function ProtectionReserve({ address }: { address: Address }) {
  const terms = useVaultTerms();
  const reserve = useVaultBalance(address);
  const balances = useBalances(address);
  const lines = useUserLines(address);
  const views = useVaultLines(lines.data);
  const flow = useSendFlow();
  const [depositText, setDepositText] = useState("");
  const [withdrawText, setWithdrawText] = useState("");

  if (!boundline.vault || !cfg.deskProtectionVault) return null;
  const vault = cfg.deskProtectionVault;
  const usdc = balances.data?.usdc ?? 0n;
  const mine = reserve.data ?? 0n;
  const deposit = depositText.trim() === "" ? null : parseUsdc(depositText);
  const withdraw = withdrawText.trim() === "" ? null : parseUsdc(withdrawText);
  const depositProblem = deposit === null ? null : deposit === 0n ? "Enter an amount above zero." : deposit > usdc ? `You hold ${formatUsd(usdc)} USDC.` : null;
  const withdrawProblem = withdraw === null ? null : withdraw === 0n ? "Enter an amount above zero." : withdraw > mine ? `Your reserve holds ${formatUsd(mine)}.` : null;

  async function doDeposit(): Promise<void> {
    if (!deposit || depositProblem) return;
    await flow.run(boundline.prepare.vaultDeposit(deposit), `Put ${formatUsd(deposit)} in your protection reserve`);
    setDepositText("");
  }

  async function doWithdraw(): Promise<void> {
    if (!withdraw || withdrawProblem) return;
    await flow.run([boundline.prepare.vaultWithdraw(withdraw)], `Take ${formatUsd(withdraw)} back from your protection reserve`);
    setWithdrawText("");
  }

  async function settle(lineId: bigint, due: bigint): Promise<void> {
    await flow.run(boundline.prepare.repayAdvance(lineId, due), `Settle line ${lineId}'s advance (${formatUsd(due)} with the fee)`);
  }

  const t = terms.data;
  return (
    <>
      <h2>Your protection reserve</h2>
      <div className="panel">
        <p>
          When the 24/7 price says a line drifted past the grace line, the keeper repays part of it on your behalf, at any hour, and pays for it in this order: <b>1.</b> your reserve here, <b>2.</b> your partner's reserve, <b>3.</b> a bounded advance from the Boundline Reserve, settled later with its fee. Nothing else can spend your reserve, and you can take it back whenever you like.
        </p>
        <div className="kv">
          <span>Your reserve</span>
          <span>{reserve.isLoading ? "…" : formatUsd(mine)}</span>
        </div>
        <div className="kv">
          <span>Advance terms</span>
          <span>{t ? `fee ${bps(t.advanceFeeBps)} · cap ${t.advanceCapPerLine === 0n ? "none" : formatUsd(t.advanceCapPerLine)} per line · ${formatUsd(t.advanceLiquidity)} available from the Reserve` : "…"}</span>
        </div>
        <div className="kv">
          <span>Keeper allowed to protect</span>
          <span>{t ? <code title={t.keeper}>{shortAddress(t.keeper)}</code> : "…"}</span>
        </div>
        {t?.paused ? <div className="notice warn">The vault is paused: advances are off; repays from reserves still run.</div> : null}
        <div className="row wrap-row">
          <div className="field">
            <label htmlFor="reserve-deposit">Add to the reserve (USDC)</label>
            <div className="input">
              <input id="reserve-deposit" inputMode="decimal" placeholder="0.00" value={depositText} onChange={(e) => setDepositText(e.target.value)} />
              <span className="unit">USDC</span>
            </div>
            <span className="hint">
              You hold {formatUsd(usdc)} · approve and deposit in one batch{depositProblem ? ` · ${depositProblem}` : ""}
            </span>
            <button className="btn primary" disabled={flow.busy || !deposit || Boolean(depositProblem)} onClick={() => void doDeposit()}>
              Deposit
            </button>
          </div>
          <div className="field">
            <label htmlFor="reserve-withdraw">Take back (USDC)</label>
            <div className="input">
              <input id="reserve-withdraw" inputMode="decimal" placeholder="0.00" value={withdrawText} onChange={(e) => setWithdrawText(e.target.value)} />
              <span className="unit">USDC</span>
            </div>
            <span className="hint">
              At any hour{withdrawProblem ? ` · ${withdrawProblem}` : ""} · <button onClick={() => setWithdrawText(formatUnits(mine, 6))}>all</button>
            </span>
            <button className="btn" disabled={flow.busy || !withdraw || Boolean(withdrawProblem)} onClick={() => void doWithdraw()}>
              Withdraw
            </button>
          </div>
        </div>
        {flow.steps.length ? <TxTimeline steps={flow.steps} /> : null}
        {flow.error ? <div className="notice">{flow.error}</div> : null}
        <p className="mute small">
          Vault{" "}
          <a href={explorer.address(cfg, vault)}>
            <code>{vault}</code>
          </a>
          {cfg.reserve ? (
            <>
              , advances funded by the Boundline Reserve{" "}
              <a href={explorer.address(cfg, cfg.reserve)}>
                <code>{shortAddress(cfg.reserve)}</code>
              </a>
            </>
          ) : null}
          .
        </p>
      </div>

      <h3>Your lines in the vault</h3>
      <div className="panel wrap">
        {lines.isLoading || views.isLoading ? <p className="mute">Reading the vault…</p> : null}
        {lines.data && lines.data.length === 0 ? <p className="mute">No lines yet, so nothing to protect.</p> : null}
        {views.error ? <p className="coral">The vault did not answer: {views.error.message}</p> : null}
        {views.data && views.data.length > 0 ? (
          <table className="ledger">
            <thead>
              <tr>
                <th>Line</th>
                <th className="num">Debt</th>
                <th>If the keeper repaid all of it now</th>
                <th className="num">Advance owed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {views.data.map((v) => {
                const due = advanceDue(v.advance);
                return (
                  <tr key={v.line.lineId.toString()}>
                    <td>
                      #{v.line.lineId.toString()} · {v.line.symbol}
                    </td>
                    <td className="num">{formatUsd(v.debt)}</td>
                    <td>
                      {v.preview ? (
                        <>
                          {formatUsd(v.preview.fromUser)} from your reserve · {formatUsd(v.preview.fromPartner)} from the partner · {formatUsd(v.preview.fromAdvance)} advanced
                          {v.preview.shortfall > 0n ? <span className="coral"> · {formatUsd(v.preview.shortfall)} not covered</span> : null}
                        </>
                      ) : (
                        <span className="mute">no debt</span>
                      )}
                    </td>
                    <td className="num">{hasAdvance(v.advance) ? `${formatUsd(v.advance.outstanding)} + ${formatUsd(v.advance.feeOutstanding)} fee` : "—"}</td>
                    <td>
                      {hasAdvance(v.advance) ? (
                        <button className="btn small" disabled={flow.busy || usdc < due} title={usdc < due ? `needs ${formatUsd(due)} USDC` : undefined} onClick={() => void settle(v.line.lineId, due)}>
                          Settle {formatUsd(due)}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
        <p className="mute small">
          The preview is the vault's own <code>previewProtect</code> for the line's whole debt; the keeper repays only what returns the line to its target, and only past the grace line.
        </p>
      </div>
    </>
  );
}
