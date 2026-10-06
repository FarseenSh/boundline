import { createBoundline, marketById, stockByToken, type MarketConfig, type StockConfig } from "@boundline/sdk";
import { ENV } from "./env.js";

export const boundline = createBoundline({
  chainId: ENV.chainId,
  ...(ENV.rpcUrl ? { rpcUrl: ENV.rpcUrl } : {}),
  api: { baseUrl: ENV.apiBase },
});

export const cfg = boundline.config;

/** The first market is the one the app borrows against (AAPLt/USDC on Sepolia). */
export const primaryMarket: MarketConfig | null = cfg.markets[0] ?? null;
export const primaryStock: StockConfig | null = primaryMarket ? (stockByToken(cfg, primaryMarket.collateral) ?? null) : null;

export function marketLltv(id: `0x${string}`): bigint {
  return marketById(cfg, id)?.lltvWad ?? 625_000_000_000_000_000n;
}
