import { useEffect, useState, type ReactNode } from "react";
import { ENV } from "../env.js";
import { Link } from "../router.js";
import { KeyPanel } from "./KeyPanel.jsx";
import { SessionRibbon } from "./SessionRibbon.jsx";
import { WalletButton } from "./Wallet.jsx";

type Theme = "auto" | "light" | "dark";

function readTheme(): Theme {
  try {
    const t = window.localStorage.getItem("boundline-theme");
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

export function Shell({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      if (theme === "auto") window.localStorage.removeItem("boundline-theme");
      else window.localStorage.setItem("boundline-theme", theme);
    } catch {
      /* storage can be blocked; the page still renders */
    }
  }, [theme]);
  const nextTheme: Theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
  return (
    <div className="shell">
      <header className="top">
        <Link to="/" className="wordmark">
          <img src="/icon.svg" alt="" width="30" height="30" />
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
      <SessionRibbon />
      <KeyPanel />
      <main>{children}</main>
      <footer className="bottom">
        <span>
          Partner console for Boundline credit lines on Base. Self-custody: the console prepares calls, the partner admin signs them. <a href={ENV.observatoryUrl}>Observatory</a> · <a href={ENV.appUrl}>App</a> · <a href="/api/health">API</a>
          {ENV.mock ? " · fixtures mode" : ""}
        </span>
        <button onClick={() => setTheme(nextTheme)}>Theme: {theme}</button>
      </footer>
    </div>
  );
}
