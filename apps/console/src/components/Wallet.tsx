import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { consoleChain } from "../wagmi.js";

function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function WalletButton() {
  const { address, isConnected, chainId } = useAccount();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  if (!isConnected || !address) return <span className="mute">No admin wallet connected</span>;
  const wrong = chainId !== consoleChain.id;
  return (
    <span className="wallet">
      <span className="addr" title={address}>
        {shortAddress(address)}
      </span>
      {wrong ? (
        <button className="btn small primary" onClick={() => switchChain.mutate({ chainId: consoleChain.id })}>
          Switch to {consoleChain.name}
        </button>
      ) : null}
      <button className="btn small ghost" onClick={() => disconnect.mutate()}>
        Disconnect
      </button>
    </span>
  );
}

/** The sign-in choice: Base Account first (passkey, batched calls, sponsored gas when a paymaster is set), then one
 *  "Connect a browser wallet" button. A browser can announce many wallets (EIP-6963: Rabby, Coinbase Wallet, OKX…), so
 *  with more than one the button opens a short list to pick from instead of rendering a button per wallet. */
export function ConnectChoices() {
  const connectors = useConnectors();
  const connect = useConnect();
  const [open, setOpen] = useState(false);
  const firstOption = useRef<HTMLButtonElement | null>(null);
  const seen = new Set<string>();
  const list = connectors.filter((c) => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });
  const base = list.find((c) => c.id === "baseAccount");
  const injected = list.filter((c) => c.id !== "baseAccount");
  // Wallets that announced themselves by name win over wagmi's generic "Injected" connector, which stays the fallback.
  const named = injected.filter((c) => c.name !== "Injected");
  const wallets = named.length > 0 ? named : injected;
  useEffect(() => {
    if (open) firstOption.current?.focus();
  }, [open]);
  const pick = (c: (typeof wallets)[number]) => {
    setOpen(false);
    connect.mutate({ connector: c });
  };
  return (
    <div onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <div className="connectors">
        {base ? (
          <button className="btn primary" disabled={connect.isPending} onClick={() => connect.mutate({ connector: base })}>
            Sign in with Base
          </button>
        ) : null}
        {wallets.length === 1 ? (
          <button className="btn" disabled={connect.isPending} onClick={() => pick(wallets[0]!)}>
            Connect a browser wallet
          </button>
        ) : wallets.length > 1 ? (
          <button className="btn" disabled={connect.isPending} aria-expanded={open} aria-controls="wallet-list" onClick={() => setOpen((o) => !o)}>
            Connect a browser wallet
          </button>
        ) : null}
      </div>
      {open && wallets.length > 1 ? (
        <ul className="wallet-list" id="wallet-list" aria-label="Wallets in this browser">
          {wallets.map((c, i) => (
            <li key={c.uid}>
              <button className="wallet-option" ref={i === 0 ? firstOption : undefined} disabled={connect.isPending} onClick={() => pick(c)}>
                {c.icon ? <img src={c.icon} alt="" width={22} height={22} /> : <span className="glyph" aria-hidden="true" />}
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {connect.error ? <p className="coral">{connect.error.message.split("\n")[0]}</p> : null}
    </div>
  );
}
