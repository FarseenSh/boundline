import type { ReactNode } from "react";
import { ENV } from "../env.js";
import { Link } from "../router.js";
import { KeyPanel } from "./KeyPanel.jsx";
import { SessionRibbon } from "./SessionRibbon.jsx";
import { WalletButton } from "./Wallet.jsx";

/** The page frame, as on the landing page: a full-width coral band (the ink tile, the admin wallet, the pages as tabs),
 *  then the exchange clock, the key panel and the page on white. One light theme, the landing page's. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="topband">
        <div className="topband-in">
          <header className="top">
            <Link to="/" className="wordmark">
              <img src="/icon-ink.svg" alt="" width="34" height="34" />
              boundline <span className="product">Console</span>
            </Link>
            <WalletButton />
          </header>
          <nav className="primary" aria-label="Pages">
            <Link to="/">Obligations</Link>
            <Link to="/policy">Policy</Link>
            <Link to="/events">Events</Link>
            <Link to="/webhooks">Webhooks</Link>
            <Link to="/drills">Drills</Link>
            <Link to="/reconciliation">Reconciliation</Link>
            <Link to="/evidence">Evidence</Link>
          </nav>
        </div>
      </div>
      <div className="shell">
        <SessionRibbon />
        <KeyPanel />
        <main>{children}</main>
        <footer className="bottom">
          <span>
            Partner console for Boundline credit lines on Base. Self-custody: the console prepares calls, the partner admin signs them. <a href={ENV.observatoryUrl}>Observatory</a> · <a href={ENV.appUrl}>App</a> · <a href="/api/health">API</a>
            {ENV.mock ? " · fixtures mode" : ""}
          </span>
        </footer>
      </div>
    </>
  );
}
