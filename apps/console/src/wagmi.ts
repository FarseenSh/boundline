import { createConfig, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { baseAccount, injected } from "wagmi/connectors";
import { ENV } from "./env.js";

/** The console's chain comes first; the other Base network stays registered so a wallet on it can be asked to switch. */
export const consoleChain = ENV.chainId === 8453 ? base : baseSepolia;

export const wagmiConfig = createConfig({
  chains: [baseSepolia, base],
  connectors: [baseAccount({ appName: "Boundline Console", appLogoUrl: `${window.location.origin}/icon.svg` }), injected()],
  transports: {
    [baseSepolia.id]: http("https://sepolia.base.org"),
    [base.id]: http("https://mainnet.base.org"),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
