import { REPAY_ALL, countdown, explorer, formatEt, formatShares, formatUsd, parseUnits, parseUsdc, price8ToNumber, roundDownToCents, REASON_COPY } from "@boundline/sdk";
import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { boundline, cfg, primaryMarket, primaryStock } from "../boundline.js";
import { HealthBar } from "../components/HealthBar.jsx";
import { TxTimeline } from "../components/TxTimeline.jsx";
import { ConnectChoices } from "../components/Wallet.jsx";
import { ENV } from "../env.js";
import { useAllowance, useApiQuote, useAuthorized, useBalances, useLineHealth, useLineId, useMarketLiquidity, useSessionInfo } from "../hooks.js";
import { useSendFlow } from "../sendflow.jsx";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function Borrow() {
  const { address, isConnected } = useAccount();
  const info = useSessionInfo();
  const lineId = useLineId(address);
  const id = lineId.data && lineId.data > 0n ? lineId.data : undefined;
  const view = useLineHealth(id);
  const balances = useBalances(address);
  const authorized = useAuthorized(address);
  const allowance = useAllowance(address, primaryMarket?.collateral);
  const liquidity = useMarketLiquidity(primaryMarket?.id);
  const flow = useSendFlow();

  const [drawText, setDrawText] = useState("");
  const [sharesText, setSharesText] = useState("");
  const [repayText, setRepayText] = useState("");
  const [repayAll, setRepayAll] = useState(true);

  const draw = drawText.trim() === "" ? 0n : parseUsdc(drawText);
  const shares = sharesText.trim() === "" ? 0n : parseUnits(sharesText, 8);
  const debouncedDraw = useDebounced(draw, 400);
  const apiQuote = useApiQuote(id, debouncedDraw !== null && debouncedDraw > 0n ? debouncedDraw : null);

  const q = view.data?.quote;
  const h = view.data?.health;
  const stockBalance = balances.data?.stocks.find((s) => s.token.toLowerCase() === primaryMarket?.collateral.toLowerCase())?.raw ?? 0n;
  const usdcBalance = balances.data?.usdc ?? 0n;

  const problems = useMemo((): string[] => {
    const out: string[] = [];
    if (draw === null) out.push("The amount must be a number with at most 6 decimals.");
    if (shares === null) out.push("The share count must be a number with at most 8 decimals.");
    if (draw !== null && shares !== null && draw === 0n && shares === 0n) out.push("Enter an amount to borrow, or shares to add.");
    if (shares !== null && shares > stockBalance) out.push(`You hold ${formatShares(stockBalance)} ${primaryStock?.symbol ?? "shares"}.`);
    if (draw !== null && draw > 0n && q && shares === 0n && draw > q.available) out.push(`Capacity is ${formatUsd(q.available)} right now.`);
    if (draw !== null && draw > 0n && liquidity.data && draw > liquidity.data.available) out.push(`The market only has ${formatUsd(liquidity.data.available)} of USDC to lend at the moment.`);
    if (draw !== null && draw > 0n && q && q.reason !== "NONE" && q.reason !== "INSUFFICIENT_CAPACITY") out.push(REASON_COPY[q.reason]);
    return out;
  }, [draw, shares, stockBalance, q, liquidity.data]);

  const canSend = isConnected && id !== undefined && problems.length === 0 && !flow.busy && authorized.data !== undefined;

  async function borrow(): Promise<void> {
    if (!id || !primaryMarket || draw === null || shares === null) return;
    const calls = boundline.prepare.borrowBatch({
      lineId: id,
      draw,
      needsAuthorization: authorized.data === false,
      ...(shares > 0n ? { addCollateral: { token: primaryMarket.collateral, amount: shares }, needsApproval: (allowance.data ?? 0n) < shares } : {}),
    });
    const label = draw > 0n && shares > 0n ? `Add ${formatShares(shares)} shares and borrow ${formatUsd(draw)}` : draw > 0n ? `Borrow ${formatUsd(draw)}` : `Add ${formatShares(shares)} shares`;
    await flow.run(calls, label);
    setDrawText("");
    setSharesText("");
  }

  async function openLine(): Promise<void> {
    if (!primaryMarket) return;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    await flow.run([boundline.prepare.openLine({ marketId: primaryMarket.id, deadline })], "Open your line");
    void lineId.refetch();
  }

  async function repay(): Promise<void> {
    if (!id || !q) return;
    const amount = repayAll ? REPAY_ALL : parseUsdc(repayText);
    if (amount === null || amount === 0n) return;
    // REPAY_ALL pulls exactly the debt at inclusion time; approve the debt plus 1% for the interest that accrues meanwhile.
    const approve = repayAll ? q.debt + q.debt / 100n + 10_000n : amount;
    await flow.run(boundline.prepare.repayBatch({ lineId: id, amount, approve }), repayAll ? `Repay everything (${formatUsd(q.debt)})` : `Repay ${formatUsd(amount)}`);
    setRepayText("");
  }

  if (!isConnected || !address) {
    return (
      <>
        <h1>Borrow</h1>
        <p className="lede">Sign in to see what your shares can borrow. The quote comes from the desk itself, with the session, the feed and the policy already applied.</p>
        <ConnectChoices />
      </>
    );
  }

  if (!primaryMarket || !cfg.desk) {
    return (
      <>
        <h1>Borrow</h1>
        <p className="lede">No market is configured on {cfg.name} yet.</p>
      </>
    );
  }

  if (lineId.data === 0n) {
    return (
      <>
        <h1>Open your line</h1>
        <p className="lede">
          A line is your own Morpho position under Boundline's partner policy: up to 50% of your {primaryStock?.symbol} value in USDC, draws of $1 to $100 on this test network, no draws and no liquidations while the feed is held. Opening it moves nothing.
        </p>
        <p>
          <button className="btn primary" disabled={flow.busy} onClick={() => void openLine()}>
            Open a line on {primaryStock?.symbol}/USDC
          </button>
        </p>
        {flow.steps.length ? <TxTimeline steps={flow.steps} /> : null}
        {flow.error ? <div className="notice">{flow.error}</div> : null}
      </>
    );
  }

  return (
    <>
      {q && h ? (
        <section className="hero">
          <p className="label">{h.gateOpen ? "Borrow up to" : "Draws paused, available at the reopen"}</p>
          <div className={`figure ${h.gateOpen ? "" : "closed"}`}>{formatUsd(h.gateOpen ? q.available : q.maxDebt > q.debt ? roundDownToCents(q.maxDebt - q.debt) : 0n)}</div>
          <p className="sub">
            against {formatShares(q.collateralRaw)} {primaryStock?.symbol} worth {formatUsd(q.collateralValue)}
            {q.price8 > 0n ? ` at $${price8ToNumber(q.price8).toFixed(2)}` : ""}; debt {formatUsd(q.debt)}; policy limit {Math.round(h.policyMaxLtv * 1000) / 10}% of value.
          </p>
          <HealthBar health={h} />
          <p className="ink2">{h.copy}</p>
        </section>
      ) : (
        <p className="mute">Reading your line…</p>
      )}

      {!info.feedLive ? (
        <div className="notice">
          Wall Street is closed until {formatEt(info.closedUntil)} ({countdown((info.closedUntil ?? info.now) - info.now)}). You can add collateral and repay now; the draw button comes back at the reopen.
        </div>
      ) : null}

      <h2>Borrow</h2>
      <div className="panel">
        <div className="field">
          <label htmlFor="draw">Amount to borrow (USDC)</label>
          <div className="input">
            <input id="draw" inputMode="decimal" placeholder="0.00" value={drawText} onChange={(e) => setDrawText(e.target.value)} disabled={!info.feedLive} />
            <span className="unit">USDC</span>
          </div>
          <span className="hint">
            {q ? (
              <>
                Capacity {formatUsd(q.available)} · <button onClick={() => setDrawText((Number(roundDownToCents(q.available)) / 1e6).toFixed(2))}>use all</button> · draws of $1 to $100 on this network
              </>
            ) : null}
          </span>
        </div>
        <div className="field">
          <label htmlFor="shares">Add shares as collateral first (optional)</label>
          <div className="input">
            <input id="shares" inputMode="decimal" placeholder="0" value={sharesText} onChange={(e) => setSharesText(e.target.value)} />
            <span className="unit">{primaryStock?.symbol}</span>
          </div>
          <span className="hint">
            You hold {formatShares(stockBalance)} · <button onClick={() => setSharesText(formatShares(stockBalance, 8, 8))}>add all</button>. Collateral lands on your own Morpho position; adding works at any hour.
          </span>
        </div>

        {apiQuote.data ? (
          <p className="mute">
            Partner quote: {String((apiQuote.data.data as Record<string, unknown>).reason ?? "—")}
            {typeof (apiQuote.data.data as Record<string, unknown>).available === "string" ? `, available ${formatUsd(BigInt((apiQuote.data.data as Record<string, unknown>).available as string))}` : ""}
            {apiQuote.data.quoteHash ? (
              <>
                {" "}
                · quote <code title={apiQuote.data.quoteHash}>{apiQuote.data.quoteHash.slice(0, 10)}…</code>
              </>
            ) : null}
            {apiQuote.data.policyVersion !== null ? ` · policy v${apiQuote.data.policyVersion}` : ""}
          </p>
        ) : null}

        {problems.length && (drawText || sharesText) ? (
          <div className="notice warn">
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        ) : null}

        <div className="row">
          <button className="btn primary" disabled={!canSend} onClick={() => void borrow()}>
            {draw && draw > 0n ? `Borrow ${formatUsd(draw)}` : shares && shares > 0n ? "Add collateral" : "Borrow"}
          </button>
          <span className="mute">
            {authorized.data === false ? "First the desk gets your one-time Morpho authorisation, then " : ""}
            {shares && shares > 0n ? "approve, add collateral" : ""}
            {shares && shares > 0n && draw && draw > 0n ? ", then " : ""}
            {draw && draw > 0n ? "draw" : ""}
            {ENV.paymasterUrl ? " · gas sponsored" : " · you pay gas"}
            {ENV.builderCode ? ` · Builder Code ${ENV.builderCode}` : ""}
          </span>
        </div>
        {flow.steps.length ? <TxTimeline steps={flow.steps} /> : null}
        {flow.error ? <div className="notice">{flow.error}</div> : null}
      </div>

      <h2>Repay</h2>
      <div className="panel">
        {q && q.debt === 0n ? <p>Nothing to repay.</p> : null}
        {q && q.debt > 0n ? (
          <>
            <p>
              Debt {formatUsd(q.debt)} including interest. You hold {formatUsd(usdcBalance)} USDC. Repaying works at any hour: Morpho's repay never reads the oracle.
            </p>
            <div className="row">
              <label className="row">
                <input type="radio" checked={repayAll} onChange={() => setRepayAll(true)} /> everything
              </label>
              <label className="row">
                <input type="radio" checked={!repayAll} onChange={() => setRepayAll(false)} /> an amount
              </label>
            </div>
            {!repayAll ? (
              <div className="field">
                <label htmlFor="repay">Amount (USDC)</label>
                <div className="input">
                  <input id="repay" inputMode="decimal" placeholder="0.00" value={repayText} onChange={(e) => setRepayText(e.target.value)} />
                  <span className="unit">USDC</span>
                </div>
              </div>
            ) : null}
            <p>
              <button className="btn" disabled={flow.busy || (repayAll ? usdcBalance < q.debt : (parseUsdc(repayText) ?? 0n) === 0n)} onClick={() => void repay()}>
                {repayAll ? `Repay ${formatUsd(q.debt)}` : "Repay"}
              </button>
            </p>
          </>
        ) : null}
      </div>

      <p className="mute">
        Desk <a href={explorer.address(cfg, cfg.desk)}><code>{cfg.desk}</code></a> · market <code>{primaryMarket.id.slice(0, 10)}…</code> · you sign every call; Boundline never holds your shares or your USDC.
      </p>
    </>
  );
}
