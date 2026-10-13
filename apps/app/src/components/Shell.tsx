import type { ReactNode } from "react";
import { ENV } from "../env.js";
import { useSessionInfo } from "../hooks.js";
import { Link } from "../router.js";
import { SessionRibbon } from "./SessionRibbon.js";
import { WalletButton } from "./Wallet.jsx";

/** The page frame, as on the landing page: a full-width coral band (the ink tile, the wallet, the pages as tabs), then
 *  the exchange clock and the page on white. One light theme, the landing page's. */
export function Shell({ children }: { children: ReactNode }) {
  const info = useSessionInfo();
  return (
    <>
      <div className="topband">
        <div className="topband-in">
          <header className="top">
            <Link to="/" className="wordmark">
              <img src="/icon-ink.svg" alt="" width="34" height="34" />
              boundline
            </Link>
            <WalletButton />
          </header>
          <nav className="primary" aria-label="Pages">
            <Link to="/">Portfolio</Link>
            <Link to="/borrow">Borrow</Link>
            <Link to="/protect">Protect</Link>
            <Link to="/statements">Statements</Link>
          </nav>
        </div>
      </div>
      <div className="shell">
        <SessionRibbon info={info} />
        <main>{children}</main>
        <footer className="bottom">
          <span>
            Boundline is an authorised manager on your own Morpho position, never a custodian. <a href={ENV.observatoryUrl}>Observatory</a> · <a href="/api/health">API</a>
          </span>
        </footer>
      </div>
    </>
  );
}
