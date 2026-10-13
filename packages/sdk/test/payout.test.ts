import { custom, encodeFunctionData, encodeFunctionResult, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { localPayoutRouterAbi } from "../src/abi/localPayoutRouter.js";
import { erc20MinimalAbi, payoutPoolMinimalAbi } from "../src/abi/minimal.js";
import { borrowBatch } from "../src/calls.js";
import { BASE_MAINNET, BASE_SEPOLIA } from "../src/config.js";
import { createBoundline } from "../src/index.js";
import {
  DEFAULT_PAYOUT_SLIPPAGE_BPS,
  POOL_KIND,
  clOutFromSqrtPrice,
  formatLocal,
  minOutWithSlippage,
  outFromPrice36,
  payoutDeadline,
  payoutPoolOf,
  preparePayout,
  quotePayout,
  readPayouts,
} from "../src/payout.js";

const cfg = BASE_SEPOLIA;
const router = cfg.payout.router!;
const eurct = cfg.payout.pools[0]!;
const user = getAddress("0xB789aD318945B37566E2549F65526Cc269a482Fc");
const aapl = cfg.markets[0]!.collateral;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

describe("payout pools", () => {
  it("resolves by symbol or address, case-insensitively", () => {
    expect(payoutPoolOf(cfg, "EURCt")).toBe(eurct);
    expect(payoutPoolOf(cfg, "eurct")).toBe(eurct);
    expect(payoutPoolOf(cfg, eurct.token.toLowerCase())).toBe(eurct);
    expect(() => payoutPoolOf(cfg, "cNGN")).toThrow(/no local-money pool/);
  });
  it("mainnet routes on the Aerodrome EURC/USDC pool; a chain without a router refuses", () => {
    const eurc = payoutPoolOf(BASE_MAINNET, "EURC");
    expect(eurc.pool).toBe("0xE846373C1a92B167b4E9cd5d8E4d6B1Db9E90EC7");
    expect(eurc.kind).toBe("cl");
    expect(eurc.quoteSource).toBe("slot0");
    expect(preparePayout(BASE_MAINNET, { token: "EURC", amountIn: 1n, minOut: 0n, to: user, deadline: 1n }).to).toBe("0xFC18E12929a3763476c13463fb05106F6F226112");
    const noRouter = { ...BASE_MAINNET, payout: { ...BASE_MAINNET.payout, router: null } };
    expect(() => preparePayout(noRouter, { token: "EURC", amountIn: 1n, minOut: 0n, to: user, deadline: 1n })).toThrow(/no LocalPayoutRouter/);
  });
});

describe("preparePayout", () => {
  it("encodes LocalPayoutRouter.payout with the pool kind, the pair and the gate token", () => {
    const c = preparePayout(cfg, { token: "EURCt", amountIn: 500_000n, minOut: 450_000n, to: user, deadline: 1_791_382_000n, gateToken: aapl });
    expect(c.to).toBe(router);
    expect(c.value).toBe(0n);
    expect(c.data).toBe(
      encodeFunctionData({
        abi: localPayoutRouterAbi,
        functionName: "payout",
        args: [{ kind: POOL_KIND.cl, pool: eurct.pool, tokenIn: cfg.usdc, tokenOut: eurct.token, amountIn: 500_000n, minOut: 450_000n, to: user, deadline: 1_791_382_000n, gateToken: aapl }],
      }),
    );
    // the selector is payout((uint8,address,address,address,uint256,uint256,address,uint256,address))
    expect(c.data.slice(0, 10)).toBe(encodeFunctionData({ abi: localPayoutRouterAbi, functionName: "payout", args: [{ kind: 0, pool: ZERO, tokenIn: ZERO, tokenOut: ZERO, amountIn: 1n, minOut: 0n, to: user, deadline: 0n, gateToken: ZERO }] }).slice(0, 10));
  });
  it("omits the gate check when no gate token is given", () => {
    const c = preparePayout(cfg, { token: "EURCt", amountIn: 1n, minOut: 0n, to: user, deadline: 2n });
    expect(c.data.endsWith(ZERO.slice(2).padStart(64, "0"))).toBe(true);
  });
  it("refuses a zero amount", () => {
    expect(() => preparePayout(cfg, { token: "EURCt", amountIn: 0n, minOut: 0n, to: user, deadline: 2n })).toThrow(/positive/);
  });
});

describe("borrowBatch with the local-money leg", () => {
  it("appends approve(USDC → router) and payout after the draw", () => {
    const calls = borrowBatch(cfg, { lineId: 1n, draw: 10_000_000n, needsAuthorization: false, payout: { token: "EURCt", minOut: 9_154_000n, to: user, deadline: 99n, gateToken: aapl } });
    expect(calls).toHaveLength(3);
    expect(calls[1]!.to).toBe(cfg.usdc);
    expect(calls[1]!.data).toBe(encodeFunctionData({ abi: erc20MinimalAbi, functionName: "approve", args: [router, 10_000_000n] }));
    expect(calls[2]).toEqual(preparePayout(cfg, { token: "EURCt", amountIn: 10_000_000n, minOut: 9_154_000n, to: user, deadline: 99n, gateToken: aapl }));
  });
  it("can pay out part of the draw, never more than it", () => {
    const calls = borrowBatch(cfg, { lineId: 1n, draw: 10_000_000n, needsAuthorization: true, payout: { token: "EURCt", amountIn: 4_000_000n, minOut: 0n, to: user, deadline: 99n } });
    expect(calls).toHaveLength(4);
    expect(calls[2]!.data).toBe(encodeFunctionData({ abi: erc20MinimalAbi, functionName: "approve", args: [router, 4_000_000n] }));
    expect(() => borrowBatch(cfg, { lineId: 1n, draw: 1_000_000n, needsAuthorization: false, payout: { token: "EURCt", amountIn: 2_000_000n, minOut: 0n, to: user, deadline: 99n } })).toThrow(/exceed/);
    expect(() => borrowBatch(cfg, { lineId: 1n, draw: 0n, needsAuthorization: false, addCollateral: { token: aapl, amount: 1n }, payout: { token: "EURCt", minOut: 0n, to: user, deadline: 99n } })).toThrow(/needs a draw/);
  });
  it("is unchanged without a payout", () => {
    expect(borrowBatch(cfg, { lineId: 1n, draw: 1_000_000n, needsAuthorization: false })).toHaveLength(1);
  });
});

describe("quote math", () => {
  it("fixed price36: 0.92 EURCt per USDC when the local token is token0", () => {
    expect(outFromPrice36(10_000_000n, 920_000_000_000_000_000_000_000_000_000_000_000n, true)).toBe(9_200_000n);
    expect(outFromPrice36(10_000_000n, 920_000_000_000_000_000_000_000_000_000_000_000n, false)).toBe(10_869_565n);
  });
  it("slot0: the mainnet EURC/USDC pool at sqrtP 8.3776e28 pays about 0.894 EURC per USDC, less the fee", () => {
    const sqrtP = 83_776_504_574_181_462_672_400_188_615n; // read on 7 Oct 2026
    const gross = clOutFromSqrtPrice(10_000_000n, sqrtP, true);
    expect(gross).toBeGreaterThan(8_900_000n);
    expect(gross).toBeLessThan(8_990_000n);
    const net = clOutFromSqrtPrice(10_000_000n, sqrtP, true, 76n);
    expect(gross - net).toBeGreaterThan(600n); // 76 pips of 8.94 EURC is about 680 units
    expect(gross - net).toBeLessThan(800n);
    // the other orientation is the reciprocal
    const back = clOutFromSqrtPrice(gross, sqrtP, false);
    expect(back).toBeGreaterThanOrEqual(9_999_990n);
    expect(back).toBeLessThanOrEqual(10_000_000n);
  });
  it("slippage floors and deadlines", () => {
    expect(minOutWithSlippage(9_200_000n, 50)).toBe(9_154_000n);
    expect(minOutWithSlippage(9_200_000n)).toBe(minOutWithSlippage(9_200_000n, DEFAULT_PAYOUT_SLIPPAGE_BPS));
    expect(minOutWithSlippage(9_200_000n, 0)).toBe(9_200_000n);
    expect(() => minOutWithSlippage(1n, 10_001)).toThrow();
    expect(payoutDeadline(1_791_380_000)).toBe(1_791_380_600n);
    expect(payoutDeadline(1_791_380_000, 60)).toBe(1_791_380_060n);
  });
});

describe("formatLocal", () => {
  it("uses the currency sign for known local stablecoins and rounds down to the cent", () => {
    expect(formatLocal(9_154_000n, "EURCt")).toBe("€9.15");
    expect(formatLocal(9_159_999n, "EURC")).toBe("€9.15");
    expect(formatLocal(1_234_567_890n, "cNGN")).toBe("₦1,234.56");
    expect(formatLocal(460_000n, "EURCt")).toBe("€0.46");
    expect(formatLocal(0n, "EURC")).toBe("€0.00");
    expect(formatLocal(-5_000_000n, "EURC")).toBe("-€5.00");
    expect(formatLocal(5_000_000n, "XYZ")).toBe("5.00 XYZ");
    expect(formatLocal(5_000_000_000_000_000_000n, "WETH", 18)).toBe("5.00 WETH");
  });
});

describe("quotePayout and readPayouts over a fake RPC", () => {
  type Handler = { to: string; selector: string; result: Hex };
  const sel = (data: Hex): string => data.slice(0, 10).toLowerCase();
  const handlers: Handler[] = [
    { to: eurct.pool, selector: sel(encodeFunctionData({ abi: payoutPoolMinimalAbi, functionName: "price36" })), result: encodeFunctionResult({ abi: payoutPoolMinimalAbi, functionName: "price36", result: 920_000_000_000_000_000_000_000_000_000_000_000n }) },
    {
      to: router,
      selector: sel(encodeFunctionData({ abi: localPayoutRouterAbi, functionName: "payouts", args: [user, 0n, 50n] })),
      result: encodeFunctionResult({
        abi: localPayoutRouterAbi,
        functionName: "payouts",
        result: [{ at: 1_791_381_138n, tokenIn: cfg.usdc, tokenOut: eurct.token, amountIn: 500_000n, amountOut: 460_000n, pool: eurct.pool, to: user }],
      }),
    },
  ];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const call = (params as [{ to: string; data: Hex }])[0];
      const h = handlers.find((x) => x.to.toLowerCase() === call.to.toLowerCase() && x.selector === sel(call.data));
      if (!h) throw new Error(`no handler for ${call.to} ${sel(call.data)}`);
      return h.result;
    },
  });
  const b = createBoundline({ chainId: 84532, transport });

  it("quotes the Sepolia mock from its fixed price", async () => {
    const q = await quotePayout(b.client, cfg, "EURCt", 500_000n);
    expect(q.amountOut).toBe(460_000n);
    expect(q.rate).toBe(0.92);
    expect(q.source).toBe("price36");
    expect(q.feePips).toBeNull();
    expect(q.pool).toBe(eurct);
    expect((await b.quotePayout("EURCt", 0n)).amountOut).toBe(0n);
    await expect(quotePayout(b.client, cfg, "EURCt", -1n)).rejects.toThrow();
  });
  it("reads the router's records", async () => {
    const rows = await readPayouts(b.client, cfg, user);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ at: 1_791_381_138, tokenIn: cfg.usdc, tokenOut: eurct.token, amountIn: 500_000n, amountOut: 460_000n, pool: eurct.pool, to: user });
    expect(await b.payouts(user)).toEqual(rows);
  });
  it("the facade prepares a payout too", () => {
    expect(b.prepare.payout({ token: "EURCt", amountIn: 1n, minOut: 0n, to: user, deadline: 5n })).toEqual(preparePayout(cfg, { token: "EURCt", amountIn: 1n, minOut: 0n, to: user, deadline: 5n }));
  });
});
