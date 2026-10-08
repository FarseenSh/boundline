// The credit router's answer for the draw being typed: which venue and market, at what rate, how much capacity,
// whether the market is protected, and why every other market was passed over. Read from the partner API through
// the app Worker's proxy. The plan is EIP-712 typed data ("Boundline Router" v1) that the API signs once its route
// signer is configured; until then it is shown as unsigned.
import { formatEt, formatRateWad, formatUnits, formatUsd, formatWadPercent, marketById, price8ToNumber, PROTECTION_COPY, ROUTE_NOTE_COPY, ROUTE_REJECT_COPY, shortAddress, shortHash, venueName, type RouteLegWire, type RouteRequestBody } from "@boundline/sdk";
import { useMemo } from "react";
import type { Address } from "viem";
import { cfg } from "../boundline.js";
import { useRoute } from "../hooks.js";

function marketLabel(leg: { venue: string; marketId: string }): string {
  if (leg.venue === "morpho" && leg.marketId.startsWith("0x")) {
    const m = marketById(cfg, leg.marketId as `0x${string}`);
    return m ? `${m.symbol}/USDC` : shortHash(leg.marketId);
  }
  return leg.venue === "aave" ? `reserve ${leg.marketId}` : leg.marketId;
}

/** The router's request units: USDC and shares as exact decimal strings ("3.000000", "0.02000000"). */
const usdcText = (x: bigint): string => formatUnits(x, 6);
const sharesText = (x: bigint): string => formatUnits(x, 8);

function Leg({ leg, chosen }: { leg: RouteLegWire; chosen: boolean }) {
  return (
    <div className={chosen ? "route-leg chosen" : "route-leg"}>
      <div className="row between">
        <b>
          {venueName(leg.venue)} · {marketLabel(leg)}
        </b>
        <span className={`tag ${leg.protection === "none" ? "" : "live"}`}>{leg.protection === "none" ? "unprotected" : leg.protection}</span>
      </div>
      <div className="kv">
        <span>Lends</span>
        <span>
          {formatUsd(BigInt(leg.amount))} of {formatUsd(BigInt(leg.capacity))} capacity
        </span>
      </div>
      <div className="kv">
        <span>Borrow rate</span>
        <span>{formatRateWad(leg.expectedRateWad)}% APR</span>
      </div>
      <div className="kv">
        <span>LTV after the draw</span>
        <span>
          {formatWadPercent(leg.ltvWad)}% (sized at {formatWadPercent(leg.maxLtvWad)}%)
        </span>
      </div>
      <div className="kv">
        <span>Priced at</span>
        <span>
          ${price8ToNumber(BigInt(leg.price8)).toFixed(2)} · {leg.priceSource === "feed" ? "the live feed" : "min(held feed, TWAP) less the haircut"}
          {leg.session === "saturday" ? " · Saturday mode" : ""}
        </span>
      </div>
      {leg.notes.length > 0 ? <p className="mute small">{leg.notes.map((n) => ROUTE_NOTE_COPY[n] ?? n).join("; ")}.</p> : null}
      {chosen ? <p className="mute small">{PROTECTION_COPY[leg.protection]}</p> : null}
    </div>
  );
}

export interface RouteCardProps {
  /** USDC base units the user typed; null or 0 = nothing typed. */
  draw: bigint | null;
  /** Shares on the line plus any being added in this batch, 8 decimals. */
  collateralRaw: bigint;
  lineId: bigint | undefined;
  borrower: Address | undefined;
  /** Feeds live (any session but WEEKEND/HOLIDAY): draws possible on session-safe markets. */
  feedLive: boolean;
}

export function RouteCard({ draw, collateralRaw, lineId, borrower, feedLive }: RouteCardProps) {
  const symbol = cfg.markets[0]?.symbol;
  // While the feeds are held nobody can type a draw (the input is disabled), so the card asks the router about a
  // 1 USDC probe instead: its rejections say, with live data, why no market lends right now.
  const probe = !feedLive;
  const amount = probe ? 1_000_000n : draw;
  const body = useMemo((): RouteRequestBody | null => {
    if (!symbol || amount === null || amount <= 0n || collateralRaw <= 0n) return null;
    return {
      chainId: cfg.chainId,
      ...(borrower ? { borrower } : {}),
      collateral: [{ symbol, amount: sharesText(collateralRaw) }],
      amountUsdc: usdcText(amount),
      preferProtection: true,
      ...(lineId && !probe ? { lineId: lineId.toString() } : {}),
    };
  }, [symbol, amount, collateralRaw, borrower, lineId, probe]);
  const route = useRoute(body);

  if (!body) {
    return (
      <div className="route">
        <h3>Route</h3>
        <p className="mute">{collateralRaw <= 0n ? "Add collateral to see where a draw would go." : "Type an amount: the credit router picks the venue and market and says why."}</p>
      </div>
    );
  }

  const r = route.data;
  const notLive = r && (r.status === 404 || r.status === 501);
  const failed = route.error || (r && !r.ok && !notLive);
  const plan = r?.ok ? r.data.plan : null;

  return (
    <div className="route" aria-live="polite">
      <div className="row between">
        <h3>Route{probe ? " (1 USDC probe while the feeds are held)" : ""}</h3>
        {plan ? <span className="mute small">{plan.reasonCodes.join(" · ")}</span> : null}
      </div>
      {route.isLoading ? <p className="mute">Asking the router…</p> : null}
      {notLive ? <p className="mute">Route planning is not live on the partner API yet; the desk's own quote above still applies.</p> : null}
      {failed ? (
        <p className="coral">
          The router did not answer: {route.error ? route.error.message : `${r?.status} ${String((r?.data as unknown as { error?: string })?.error ?? "")}`}
        </p>
      ) : null}
      {plan ? (
        <>
          {plan.chosen ? <Leg leg={plan.chosen} chosen /> : <p className="notice warn">No market can lend {formatUsd(BigInt(plan.requested))} against this collateral right now.</p>}
          {plan.alternatives.length > 0 ? (
            <details>
              <summary>
                {plan.alternatives.length} other market{plan.alternatives.length === 1 ? "" : "s"} could lend, ranked lower
              </summary>
              {plan.alternatives.map((leg) => (
                <Leg key={`${leg.venue}:${leg.marketId}`} leg={leg} chosen={false} />
              ))}
            </details>
          ) : null}
          {plan.rejected.length > 0 ? (
            <ul className="rejections">
              {plan.rejected.map((x) => (
                <li key={`${x.venue}:${x.marketId}:${x.reason}`}>
                  <span className="mute">
                    {venueName(x.venue)} · {marketLabel(x)}:
                  </span>{" "}
                  {ROUTE_REJECT_COPY[x.reason] ?? x.reason}
                  {x.detail ? <span className="mute"> ({x.detail})</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {!feedLive ? (
            <p className="mute small">
              Saturday mode is a partner policy, off by default: on venues that price around the clock at the held feed (Aave V4) it allows weekend draws at half capacity, at the lower of the held feed and the DEX TWAP less a haircut. Boundline's own session-safe Morpho markets never draw while the feed is held.
            </p>
          ) : null}
          {r!.data.notes && r!.data.notes.length > 0 ? (
            <ul className="rejections">
              {r!.data.notes.map((n) => (
                <li key={n} className="mute">
                  {n}
                </li>
              ))}
            </ul>
          ) : null}
          {r!.data.saturdayMode?.applied ? <p className="notice warn">Saturday mode shaped this plan: {Math.round(r!.data.saturdayMode.capacityFraction * 100)}% of normal capacity at the lower of the held feed and the TWAP, less {r!.data.saturdayMode.haircutBps} bps.</p> : null}
          <p className="mute small">
            {r!.data.authoritative ? `${r!.data.authoritative.charAt(0).toUpperCase()}${r!.data.authoritative.slice(1)}. ` : ""}
            Plan <code title={r!.data.planHash}>{shortHash(r!.data.planHash)}</code>
            {r!.data.signature && r!.data.signer ? (
              <>
                {" "}
                · signed by <code title={r!.data.signer}>{shortAddress(r!.data.signer)}</code> (EIP-712 "Boundline Router" v1)
              </>
            ) : (
              " · unsigned: the API's route signer is pending"
            )}{" "}
            · valid until {formatEt(plan.validUntil, { date: false, seconds: true })}
            {typeof r!.data.policyVersion === "number" ? ` · policy v${r!.data.policyVersion}` : ""}
          </p>
        </>
      ) : null}
    </div>
  );
}
