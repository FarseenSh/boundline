import { explorer, formatEt } from "@boundline/sdk";
import type { Address } from "viem";
import { useAccount } from "wagmi";
import { boundline, cfg } from "../boundline.js";
import { ConnectChoices } from "../components/Wallet.jsx";
import { ENV } from "../env.js";
import { useAuthorized, useSessionInfo } from "../hooks.js";
import { useSendFlow } from "../sendflow.js";
import { TxTimeline } from "../components/TxTimeline.jsx";

export function Protect() {
  const { address, isConnected } = useAccount();
  const info = useSessionInfo();
  const deskAuth = useAuthorized(address);
  const preLiq = (ENV.preLiquidation ?? cfg.preLiquidation ?? undefined) as Address | undefined;
  const preLiqAuth = useAuthorized(preLiq ? address : undefined, preLiq);
  const flow = useSendFlow();

  return (
    <>
      <h1>Protected mode</h1>
      <p className="lede">
        Three gates, in this order. Repaying is always open: it can only help you, so Boundline repays on your behalf at any hour when the 24/7 price says your loan is drifting. A gentle, partial pre-liquidation at the live DEX price is open at any hour too, through Morpho's audited pre-liquidation contract. Any other sale of collateral waits for an open session and a fresh feed.
      </p>

      <div className="panel">
        <h3>Right now</h3>
        <p>
          {info.feedLive ? (
            <>Feeds are live; the venue prices your position normally. The next close is {formatEt(info.nextClose)}.</>
          ) : (
            <>Feeds are held until {formatEt(info.closedUntil)}. On Boundline's market nothing can liquidate you until then; repay and add collateral still work.</>
          )}
        </p>
      </div>

      {!isConnected || !address ? (
        <ConnectChoices />
      ) : (
        <>
          <h2>Your authorisations on Morpho</h2>
          <div className="panel">
            <div className="kv">
              <span>Boundline desk (draws under the policy)</span>
              <span>{deskAuth.data === undefined ? "…" : deskAuth.data ? <span className="tag live">authorised</span> : <span className="tag">not yet</span>}</span>
            </div>
            <div className="kv">
              <span>Pre-liquidation contract (shadow protection)</span>
              <span>{!preLiq ? <span className="tag warn">not deployed yet</span> : preLiqAuth.data === undefined ? "…" : preLiqAuth.data ? <span className="tag live">opted in</span> : <span className="tag">not yet</span>}</span>
            </div>
          </div>
          {deskAuth.data === false ? (
            <p>
              <button className="btn primary" disabled={flow.busy} onClick={() => flow.run([boundline.prepare.authorizeDesk()], "Authorise the desk")}>
                Authorise the desk on Morpho
              </button>
            </p>
          ) : null}
          {preLiq && preLiqAuth.data === false ? (
            <p>
              <button className="btn primary" disabled={flow.busy} onClick={() => flow.run([boundline.prepare.authorize(preLiq, true)], "Opt in to protected mode")}>
                Opt in to protected mode
              </button>
            </p>
          ) : null}
          {preLiq ? (
            <p className="mute">
              Pre-liquidation contract <a href={explorer.address(cfg, preLiq)}><code>{preLiq}</code></a>. You authorise Morpho's audited contract, not Boundline's; revoke it any time with the same call.
            </p>
          ) : (
            <p className="mute">The pre-liquidation contract for this market is being deployed today; this page gains the opt-in button as soon as its address is configured.</p>
          )}
          {flow.steps.length > 0 ? <TxTimeline steps={flow.steps} /> : null}
          {flow.error ? <div className="notice">{flow.error}</div> : null}
        </>
      )}

      <h2>What a weekend looks like</h2>
      <div className="panel">
        <p>Friday 20:00 ET: the Chainlink feed prints its last round and holds. Venues that read it keep pricing your shares at Friday's close all weekend.</p>
        <p>Saturday: the DEX keeps trading. Boundline watches the 1-hour TWAP. If your loan drifts toward the limit at that price, the keeper repays a slice on your behalf, or pre-liquidates a small part at the live price, so Sunday night finds you healthy.</p>
        <p>Sunday 20:00 ET: the feed reopens with the gap. On Boundline's market no liquidation could run while it was held; on the raw venues the first block after the reopen is when liquidators act.</p>
      </div>
    </>
  );
}

