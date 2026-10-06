import { custom, encodeFunctionData, encodeFunctionResult, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { creditDeskAbi } from "../src/abi/creditDesk.js";
import { erc20MinimalAbi, morphoMinimalAbi } from "../src/abi/minimal.js";
import { sessionGateAbi } from "../src/abi/sessionGate.js";
import { BASE_SEPOLIA } from "../src/config.js";
import { createBoundline } from "../src/index.js";

const cfg = BASE_SEPOLIA;
const desk = cfg.desk!;
const gate = cfg.gate!;
const user = getAddress("0xB789aD318945B37566E2549F65526Cc269a482Fc");
const market = cfg.markets[0]!;
const aapl = market.collateral;

type Handler = { to: string; selector: string; result: Hex };
const sel = (data: Hex): string => data.slice(0, 10).toLowerCase();

const handlers: Handler[] = [
  {
    to: desk,
    selector: sel(encodeFunctionData({ abi: creditDeskAbi, functionName: "line", args: [1n] })),
    result: encodeFunctionResult({
      abi: creditDeskAbi,
      functionName: "line",
      result: { partnerId: cfg.partnerId, user, marketId: market.id, collateral: aapl, policyVersion: 1, status: 1, holdReason: `0x${"0".repeat(64)}`, openedAt: 1791165000n, drawnPrincipal: 0n },
    }),
  },
  {
    to: desk,
    selector: sel(encodeFunctionData({ abi: creditDeskAbi, functionName: "capacity", args: [1n] })),
    result: encodeFunctionResult({
      abi: creditDeskAbi,
      functionName: "capacity",
      result: { reason: 0, session: 1, price8: 33_267_000_000n, collateralRaw: 1_000_000_000n, collateralValue: 3_326_700_000n, debt: 0n, maxDebt: 1_663_350_000n, available: 1_663_350_000n, effectiveMaxLtvWad: 500_000_000_000_000_000n, corporateActionHaircut: false },
    }),
  },
  {
    to: desk,
    selector: sel(encodeFunctionData({ abi: creditDeskAbi, functionName: "quote", args: [1n, 1n] })),
    result: encodeFunctionResult({
      abi: creditDeskAbi,
      functionName: "quote",
      result: { reason: 6, session: 5, price8: 0n, collateralRaw: 1_000_000_000n, collateralValue: 0n, debt: 0n, maxDebt: 0n, available: 0n, effectiveMaxLtvWad: 500_000_000_000_000_000n, corporateActionHaircut: false },
    }),
  },
  { to: desk, selector: sel(encodeFunctionData({ abi: creditDeskAbi, functionName: "obligationStatus", args: [1n] })), result: encodeFunctionResult({ abi: creditDeskAbi, functionName: "obligationStatus", result: 2 }) },
  { to: desk, selector: sel(encodeFunctionData({ abi: creditDeskAbi, functionName: "lineOf", args: [cfg.partnerId, user, market.id] })), result: encodeFunctionResult({ abi: creditDeskAbi, functionName: "lineOf", result: 1n }) },
  {
    to: desk,
    selector: sel(encodeFunctionData({ abi: creditDeskAbi, functionName: "market", args: [market.id] })),
    result: encodeFunctionResult({ abi: creditDeskAbi, functionName: "market", result: { params: { loanToken: cfg.usdc, collateralToken: aapl, oracle: market.oracle, irm: "0x46415998764C29aB2a25CbeA6254146D50D22687", lltv: market.lltvWad }, collateralDecimals: 8, loanDecimals: 6, enabled: true } }),
  },
  {
    to: desk,
    selector: sel(encodeFunctionData({ abi: creditDeskAbi, functionName: "tickerPolicy", args: [cfg.partnerId, aapl] })),
    result: encodeFunctionResult({ abi: creditDeskAbi, functionName: "tickerPolicy", result: { allowed: true, maxLtvWad: 500_000_000_000_000_000n, minDraw: 1_000_000n, maxDraw: 100_000_000n, exposureCap: 500_000_000n, exposure: 0n } }),
  },
  {
    to: gate,
    selector: sel(encodeFunctionData({ abi: sessionGateAbi, functionName: "check", args: [aapl] })),
    result: encodeFunctionResult({ abi: sessionGateAbi, functionName: "check", result: { state: 0, session: 1, answer: 33_267_000_000n, updatedAt: 1791223131n, multiplier: 10n ** 18n, registryPaused: false, transferPaused: false } }),
  },
  { to: cfg.morpho, selector: sel(encodeFunctionData({ abi: morphoMinimalAbi, functionName: "isAuthorized", args: [user, desk] })), result: encodeFunctionResult({ abi: morphoMinimalAbi, functionName: "isAuthorized", result: true }) },
  { to: cfg.morpho, selector: sel(encodeFunctionData({ abi: morphoMinimalAbi, functionName: "position", args: [market.id, user] })), result: encodeFunctionResult({ abi: morphoMinimalAbi, functionName: "position", result: [0n, 0n, 1_000_000_000n] }) },
  { to: cfg.morpho, selector: sel(encodeFunctionData({ abi: morphoMinimalAbi, functionName: "market", args: [market.id] })), result: encodeFunctionResult({ abi: morphoMinimalAbi, functionName: "market", result: [10_000_000n, 10_000_000_000_000n, 0n, 0n, 1791270000n, 0n] }) },
  { to: aapl, selector: sel(encodeFunctionData({ abi: erc20MinimalAbi, functionName: "allowance", args: [user, desk] })), result: encodeFunctionResult({ abi: erc20MinimalAbi, functionName: "allowance", result: 0n }) },
  { to: aapl, selector: sel(encodeFunctionData({ abi: erc20MinimalAbi, functionName: "balanceOf", args: [user] })), result: encodeFunctionResult({ abi: erc20MinimalAbi, functionName: "balanceOf", result: 99_000_000_000n }) },
];

const seen: { to: string; data: string }[] = [];
const transport = custom({
  async request({ method, params }: { method: string; params?: unknown }) {
    if (method === "eth_chainId") return "0x14a34";
    if (method !== "eth_call") throw new Error(`unexpected ${method}`);
    const [tx] = params as [{ to: string; data: Hex }];
    seen.push({ to: tx.to, data: tx.data });
    const h = handlers.find((x) => x.to.toLowerCase() === tx.to.toLowerCase() && x.selector === sel(tx.data));
    if (!h) throw new Error(`no handler for ${tx.to} ${sel(tx.data)}`);
    return h.result;
  },
});

const b = createBoundline({ chainId: 84532, transport });

describe("reads decode into named fields and words", () => {
  it("getLine", async () => {
    const l = await b.reader.getLine(1n);
    expect(l).toMatchObject({ lineId: 1n, user, marketId: market.id, collateral: aapl, policyVersion: 1, status: "OPEN", statusCode: 1, openedAt: 1791165000, drawnPrincipal: 0n });
  });
  it("capacity and quote", async () => {
    const c = await b.reader.capacity(1n);
    expect(c.reason).toBe("NONE");
    expect(c.session).toBe("PRE");
    expect(c.available).toBe(1_663_350_000n);
    const q = await b.reader.quote(1n, 1n);
    expect(q.reason).toBe("MARKET_CLOSED");
    expect(q.session).toBe("WEEKEND");
    expect(q.price8).toBe(0n);
  });
  it("obligation status, lineOf, market, ticker policy", async () => {
    expect(await b.reader.obligationStatus(1n)).toBe("HOLD_SESSION");
    expect(await b.reader.lineOf(user, market.id)).toBe(1n);
    const m = await b.reader.market(market.id);
    expect(m.lltvWad).toBe(market.lltvWad);
    expect(m.collateralDecimals).toBe(8);
    expect(m.enabled).toBe(true);
    const t = await b.reader.tickerPolicy(aapl);
    expect(t).toEqual({ allowed: true, maxLtvWad: 500_000_000_000_000_000n, minDraw: 1_000_000n, maxDraw: 100_000_000n, exposureCap: 500_000_000n, exposure: 0n });
  });
  it("gate verdict", async () => {
    const v = await b.reader.gateCheck(aapl);
    expect(v.state).toBe("OPEN");
    expect(v.session).toBe("PRE");
    expect(v.answer).toBe(33_267_000_000n);
    expect(v.updatedAt).toBe(1791223131);
  });
  it("Morpho and token reads", async () => {
    expect(await b.reader.isAuthorized(user)).toBe(true);
    expect(await b.reader.morphoPosition(market.id, user)).toEqual({ supplyShares: 0n, borrowShares: 0n, collateral: 1_000_000_000n });
    expect((await b.reader.morphoMarket(market.id)).totalSupplyAssets).toBe(10_000_000n);
    expect(await b.reader.allowance(aapl, user)).toBe(0n);
    expect(await b.reader.balanceOf(aapl, user)).toBe(99_000_000_000n);
  });
  it("lineHealth composes line, quote and the words", async () => {
    const h = await b.lineHealth(1n);
    expect(h.line.lineId).toBe(1n);
    expect(h.lltvWad).toBe(market.lltvWad);
    expect(h.health.state).toBe("no_debt");
    expect(h.health.headline).toBe("Borrow up to $1,663.35");
  });
  it("bound prepare helpers use this chain's desk", () => {
    expect(b.prepare.draw(1n, 5n).to).toBe(desk);
    expect(b.buildSendCalls([b.prepare.draw(1n, 5n)]).chainId).toBe(84532);
    expect(b.session(1791285705).session).toBe("PRE");
  });
});
