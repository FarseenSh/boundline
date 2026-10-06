import { shortAddress } from "@boundline/sdk";
import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { appChain } from "../wagmi.js";

export function WalletButton() {
  const { address, isConnected, chainId } = useAccount();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  if (!isConnected || !address) return <span className="mute">No wallet connected</span>;
  const wrong = chainId !== appChain.id;
  return (
    <span className="wallet">
      <span className="addr" title={address}>
        {shortAddress(address)}
      </span>
      {wrong ? (
        <button className="btn small primary" onClick={() => switchChain.mutate({ chainId: appChain.id })}>
          Switch to {appChain.name}
        </button>
      ) : null}
      <button className="btn small ghost" onClick={() => disconnect.mutate()}>
        Disconnect
      </button>
    </span>
  );
}

/** The sign-in choice: Base Account first (passkey, batched calls, sponsored gas when a paymaster is set), then any injected wallet. */
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
