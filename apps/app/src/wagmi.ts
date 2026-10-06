import { BASE_MAINNET, BASE_SEPOLIA } from "@boundline/sdk";
import { createConfig, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { baseAccount, injected } from "wagmi/connectors";
import { cfg } from "./boundline.js";

/** The app's chain comes first; the other Base network stays registered so a wallet on it can be asked to switch. */
export const appChain = cfg.chainId === 8453 ? base : baseSepolia;

export const wagmiConfig = createConfig({
  chains: [baseSepolia, base],
  connectors: [
    baseAccount({ appName: "Boundline", appLogoUrl: `${window.location.origin}/icon.svg` }),
    injected(),
  ],
  transports: {
    [baseSepolia.id]: http(BASE_SEPOLIA.rpcUrls[0]),
    [base.id]: http(BASE_MAINNET.rpcUrls[0]),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
