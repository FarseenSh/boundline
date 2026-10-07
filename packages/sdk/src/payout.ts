// The local-money leg: the USDC a user draws is swapped into a local stablecoin by Boundline's
// LocalPayoutRouter at the end of the borrow batch, with a slippage bound, a deadline and the session check
// on the stock the user borrowed against. This file prepares that call, quotes it off-chain from the pool's
// own state, formats local amounts for the widget and reads the router's per-sender payout records.
import { encodeFunctionData, getAddress, type Address, type PublicClient } from "viem";
import { localPayoutRouterAbi } from "./abi/localPayoutRouter.js";
import { payoutPoolMinimalAbi } from "./abi/minimal.js";
import type { Call } from "./calls.js";
import type { BoundlineChainConfig, PayoutPoolConfig } from "./config.js";
import { formatUnits } from "./format.js";

/** LocalPayoutRouter.PoolKind: 0 = Slipstream / Uniswap v3 shape (swap + callback), 1 = Aerodrome v2 shape. */
export const POOL_KIND = { cl: 0, v2: 1 } as const;
export type PoolKind = keyof typeof POOL_KIND;
/** Where the off-chain quote comes from: a Slipstream pool's `slot0` and `fee`, the Sepolia mock's `price36`, a v2 pool's `getAmountOut`. */
export type QuoteSource = "slot0" | "price36" | "getAmountOut";

/** Half a percent: the bound the app passes unless the partner sets another. */
export const DEFAULT_PAYOUT_SLIPPAGE_BPS = 50;
/** Ten minutes from signing: a payout batch that waits longer than that is stale. */
export const DEFAULT_PAYOUT_DEADLINE_SECONDS = 600;

const Q192 = 1n << 192n;
const PIPS = 1_000_000n;

export interface PayoutRequest {
  /** Local token symbol ("EURCt", "EURC") or address from the chain config's payout pools. */
  token: string | Address;
  /** USDC base units to swap. */
  amountIn: bigint;
  /** Least local units acceptable, from `quotePayout` and `minOutWithSlippage`. */
  minOut: bigint;
  /** Who receives the local money: the borrower. */
  to: Address;
  /** Unix seconds; the router refuses after it. */
  deadline: bigint;
  /** The stock the user borrowed against: the router asks the gate for its verdict and refuses unless OPEN. Omit to skip the check. */
  gateToken?: Address;
}

export function payoutPoolOf(cfg: BoundlineChainConfig, tokenOrSymbol: string | Address): PayoutPoolConfig {
  const key = tokenOrSymbol.toLowerCase();
  const pool = cfg.payout.pools.find((p) => p.symbol.toLowerCase() === key || p.token.toLowerCase() === key);
  if (!pool) throw new Error(`no local-money pool for ${tokenOrSymbol} on ${cfg.name}`);
  return pool;
}

export function payoutRouterOf(cfg: BoundlineChainConfig): Address {
  if (!cfg.payout.router) throw new Error(`no LocalPayoutRouter on ${cfg.name}`);
  return cfg.payout.router;
}

/** LocalPayoutRouter.payout(params): pulls `amountIn` USDC from the caller (approve the router first), pays `to` in local money. */
export function preparePayout(cfg: BoundlineChainConfig, req: PayoutRequest): Call {
  if (req.amountIn <= 0n) throw new Error("payout amount must be positive");
  const pool = payoutPoolOf(cfg, req.token);
  const router = payoutRouterOf(cfg);
  const data = encodeFunctionData({
    abi: localPayoutRouterAbi,
    functionName: "payout",
    args: [
      {
        kind: POOL_KIND[pool.kind],
        pool: pool.pool,
        tokenIn: cfg.usdc,
        tokenOut: pool.token,
        amountIn: req.amountIn,
        minOut: req.minOut,
        to: getAddress(req.to),
        deadline: req.deadline,
        gateToken: req.gateToken ? getAddress(req.gateToken) : "0x0000000000000000000000000000000000000000",
      },
    ],
  });
  return { to: router, data, value: 0n };
}

/** `amountOut` less `slippageBps` (rounded down), the floor the router enforces. */
export function minOutWithSlippage(amountOut: bigint, slippageBps: number = DEFAULT_PAYOUT_SLIPPAGE_BPS): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new Error(`slippage must be 0 to 10000 bps, got ${slippageBps}`);
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

export function payoutDeadline(now: number = Math.floor(Date.now() / 1000), seconds: number = DEFAULT_PAYOUT_DEADLINE_SECONDS): bigint {
  return BigInt(now + seconds);
}

export interface PayoutQuote {
  pool: PayoutPoolConfig;
  amountIn: bigint;
  /** Local base units the pool pays at its current state, fee included, before the slippage bound. */
  amountOut: bigint;
  /** Local units per one USDC at the current state (fee included). */
  rate: number;
  source: QuoteSource;
  /** Pool fee in pips (1e-6), when the source exposes it. */
  feePips: number | null;
}

/** Local units `amountIn` USDC buy at a Slipstream pool's spot price: token1 per token0 is (sqrtP / 2^96)^2. */
export function clOutFromSqrtPrice(amountIn: bigint, sqrtPriceX96: bigint, localIsToken0: boolean, feePips = 0n): bigint {
  if (sqrtPriceX96 <= 0n) throw new Error("sqrtPriceX96 must be positive");
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  const gross = localIsToken0 ? (amountIn * Q192) / p2 : (amountIn * p2) / Q192;
  return (gross * (PIPS - feePips)) / PIPS;
}

/** Local units `amountIn` USDC buy at the Sepolia mock's fixed `price36` (token0 raw per token1 raw, times 1e36). */
export function outFromPrice36(amountIn: bigint, price36: bigint, localIsToken0: boolean): bigint {
  if (price36 <= 0n) throw new Error("price36 must be positive");
  return localIsToken0 ? (amountIn * price36) / 10n ** 36n : (amountIn * 10n ** 36n) / price36;
}

/** Quote the local-money leg from the pool's own state; no router call, no simulation. */
export async function quotePayout(client: PublicClient, cfg: BoundlineChainConfig, tokenOrSymbol: string | Address, amountIn: bigint): Promise<PayoutQuote> {
  if (amountIn < 0n) throw new Error("amountIn must not be negative");
  const pool = payoutPoolOf(cfg, tokenOrSymbol);
  const unit = 10n ** BigInt(cfg.usdcDecimals);
  let outFor: (x: bigint) => bigint;
  let feePips: number | null = null;
  if (pool.quoteSource === "slot0") {
    const [slot0, fee] = await Promise.all([
      client.readContract({ address: pool.pool, abi: payoutPoolMinimalAbi, functionName: "slot0" }),
      client.readContract({ address: pool.pool, abi: payoutPoolMinimalAbi, functionName: "fee" }),
    ]);
    const sqrtP = BigInt(slot0[0]);
    feePips = Number(fee);
    outFor = (x) => clOutFromSqrtPrice(x, sqrtP, pool.tokenIsToken0, BigInt(fee));
  } else if (pool.quoteSource === "price36") {
    const price36 = await client.readContract({ address: pool.pool, abi: payoutPoolMinimalAbi, functionName: "price36" });
    outFor = (x) => outFromPrice36(x, price36, pool.tokenIsToken0);
  } else {
    const [forAmount, forUnit] = await Promise.all([
      amountIn === 0n ? Promise.resolve(0n) : client.readContract({ address: pool.pool, abi: payoutPoolMinimalAbi, functionName: "getAmountOut", args: [amountIn, cfg.usdc] }),
      client.readContract({ address: pool.pool, abi: payoutPoolMinimalAbi, functionName: "getAmountOut", args: [unit, cfg.usdc] }),
    ]);
    outFor = (x) => (x === amountIn ? forAmount : x === unit ? forUnit : (forUnit * x) / unit);
  }
  const amountOut = outFor(amountIn);
  const rate = Number(formatUnits(outFor(unit), pool.decimals));
  return { pool, amountIn, amountOut, rate, source: pool.quoteSource, feePips };
}

const CURRENCY_SIGNS: Readonly<Record<string, string>> = { EUR: "€", NGN: "₦", BRL: "R$", IDR: "Rp", ZAR: "R", USD: "$" };
const SYMBOL_CURRENCY: Readonly<Record<string, string>> = { EURC: "EUR", EURCT: "EUR", CNGN: "NGN", BRZ: "BRL", IDRX: "IDR", ZARP: "ZAR", USDC: "USD" };

/** "€9.15" for 9_154_000n EURC: the currency sign when the token is a known local stablecoin, "9.15 XYZ" otherwise. Rounds down to the cent. */
export function formatLocal(amount: bigint, symbol: string, decimals = 6): string {
  const currency = SYMBOL_CURRENCY[symbol.toUpperCase()];
  const sign = currency ? CURRENCY_SIGNS[currency] : undefined;
  const text = formatUnits(amount, decimals);
  const [w = "0", f = ""] = text.replace("-", "").split(".");
  const whole = w.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = `${f}00`.slice(0, 2);
  const body = `${whole}.${cents}`;
  const neg = amount < 0n ? "-" : "";
  return sign ? `${neg}${sign}${body}` : `${neg}${body} ${symbol}`;
}

export interface PayoutRecord {
  at: number;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  pool: Address;
  to: Address;
}

/** The router's own record of a sender's payouts, oldest first: a statement line without an indexer. */
export async function readPayouts(client: PublicClient, cfg: BoundlineChainConfig, sender: Address, offset = 0n, limit = 50n): Promise<PayoutRecord[]> {
  const router = payoutRouterOf(cfg);
  const rows = await client.readContract({ address: router, abi: localPayoutRouterAbi, functionName: "payouts", args: [sender, offset, limit] });
  return rows.map((r) => ({ at: Number(r.at), tokenIn: r.tokenIn, tokenOut: r.tokenOut, amountIn: r.amountIn, amountOut: r.amountOut, pool: r.pool, to: r.to }));
}
