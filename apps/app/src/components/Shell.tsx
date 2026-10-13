import { useEffect, useState, type ReactNode } from "react";
import { ENV } from "../env.js";
import { useSessionInfo } from "../hooks.js";
import { Link } from "../router.js";
import { SessionRibbon } from "./SessionRibbon.js";
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
  const info = useSessionInfo();
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
      <SessionRibbon info={info} />
      <main>{children}</main>
      <footer className="bottom">
        <span>
          Boundline is an authorised manager on your own Morpho position, never a custodian. <a href={ENV.observatoryUrl}>Observatory</a> · <a href="/api/health">API</a>
        </span>
        <button onClick={() => setTheme(nextTheme)}>Theme: {theme}</button>
      </footer>
    </div>
  );
}
