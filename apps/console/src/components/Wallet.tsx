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

/** The partner admin signs policy calls from Base Account first, any injected wallet second. */
export function ConnectChoices() {
  const connectors = useConnectors();
  const connect = useConnect();
  const seen = new Set<string>();
  const list = connectors.filter((c) => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });
  return (
    <div>
      <div className="connectors">
        {list.map((c) => (
          <button key={c.uid} className={`btn ${c.id === "baseAccount" ? "primary" : ""}`} disabled={connect.isPending} onClick={() => connect.mutate({ connector: c })}>
            {c.id === "baseAccount" ? "Sign in with Base" : c.name === "Injected" ? "Connect a browser wallet" : `Connect ${c.name}`}
          </button>
        ))}
      </div>
      {connect.error ? <p className="coral">{connect.error.message.split("\n")[0]}</p> : null}
    </div>
  );
}
