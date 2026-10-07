// A path router small enough to read: pushState + popstate, no dependency.
import { createContext, useContext, useEffect, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";

const PathContext = createContext<string>("/");

export function Router({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return <PathContext.Provider value={path}>{children}</PathContext.Provider>;
}

export function usePath(): string {
  return useContext(PathContext);
}

export function navigate(to: string): void {
  if (window.location.pathname === to) return;
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0 });
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode };

export function Link({ to, children, onClick, ...rest }: LinkProps) {
  const path = usePath();
  const handle = (e: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={handle} aria-current={path === to ? "page" : undefined} {...rest}>
      {children}
    </a>
  );
}
