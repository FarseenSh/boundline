import { encodeAbiParameters, encodeFunctionData, toFunctionSelector, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { predicatesFor } from "../src/protect.js";
import {
  AMOUNT_STEP,
  LADDER_PROBE,
  VAULT_SELECTOR,
  decideVault,
  decodeFunding,
  decodeLine,
  decodeQuote,
  encodeCapacity,
  encodeLine,
  encodePreviewProtect,
  encodeVaultProtect,
  fundFromLadder,
  parseVaultTargets,
  pct,
  sizeVault,
  usdc,
  type DeskLine,
  type DeskQuote,
  type Funding,
} from "../src/vault.js";
import { runVault, type VaultRpc } from "../src/vault-job.js";
import { rearmFees } from "../src/protect.js";
import type { RpcCall, RpcOutcome } from "../src/rpc.js";

const VAULT: Address = "0x87f600279F021ca859b9903DE884d3A7A169f38c";
const DESK: Address = "0x39aBaDc0aAa12D1F7e259b89536Aa1848997399a";
const SHADOW: Address = "0x7a53b459be6e5e9a12324cc3417bb027daf73f65";
const FEED: Address = "0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a";
const BORROWER: Address = "0xB789aD318945B37566E2549F65526Cc269a482Fc";
const AAPLT: Address = "0xB2000000000000000000000E063E65377cA34141";
const MARKET: Hex = "0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047";
const PARTNER: Hex = "0x626f756e646c696e652d61707000000000000000000000000000000000000000";
const E36 = 10n ** 36n;
const WAD = 10n ** 18n;

const lineAbi = [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint32" }, { type: "uint8" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint128" }] as const;
const quoteAbi = [{ type: "uint8" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }] as const;
const fundingAbi = [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }] as const;

// Line 1 as read live on Base Sepolia, 8 Oct 2026 07:16 UTC (after Lane K1 shaped it for the Saturday drill).
const LIVE_LINE: DeskLine = { partnerId: PARTNER, user: BORROWER.toLowerCase() as Address, marketId: MARKET, collateral: AAPLT.toLowerCase() as Address, policyVersion: 2, status: "OPEN", holdReason: `0x${"0".repeat(64)}`, openedAt: 1791044966, drawnPrincipal: 3_220_000n };
const LIVE_QUOTE: DeskQuote = { reason: "NONE", session: "OVERNIGHT", price8: 33_568_300_000n, collateralRaw: 2_000_000n, collateralValue: 6_713_660n, debt: 3_220_175n, maxDebt: 3_356_830n, available: 136_655n, effectiveMaxLtvWad: 5n * 10n ** 17n, corporateActionHaircut: false };
const SHADOW_AT_FEED = 3_356_830_000_000_000_000_000_000_000_000_000_000n; // 335.683 in Morpho's 36-decimal scale

const encLine = (l: DeskLine): Hex =>
  encodeAbiParameters(lineAbi as never, [l.partnerId, l.user, l.marketId, l.collateral, l.policyVersion, ["NONE", "OPEN", "HELD", "CLOSED"].indexOf(l.status), l.holdReason, BigInt(l.openedAt), l.drawnPrincipal] as never);
const REASONS = ["NONE", "DESK_PAUSED", "LINE_NOT_OPEN", "LINE_HELD", "PARTNER_INACTIVE", "MARKET_DISABLED", "MARKET_CLOSED"];
const SESSIONS = ["UNKNOWN", "PRE", "REGULAR", "POST", "OVERNIGHT", "WEEKEND", "HOLIDAY"];
const encQuote = (q: DeskQuote): Hex =>
  encodeAbiParameters(quoteAbi as never, [REASONS.indexOf(q.reason), SESSIONS.indexOf(q.session), q.price8, q.collateralRaw, q.collateralValue, q.debt, q.maxDebt, q.available, q.effectiveMaxLtvWad, q.corporateActionHaircut] as never);
const encFunding = (f: Funding): Hex => encodeAbiParameters(fundingAbi as never, [f.fromUser, f.fromPartner, f.fromAdvance, f.shortfall] as never);

describe("vault codecs", () => {
  it("selectors match the contracts' signatures", () => {
    expect(VAULT_SELECTOR.line).toBe(toFunctionSelector("line(uint256)"));
    expect(VAULT_SELECTOR.capacity).toBe(toFunctionSelector("capacity(uint256)"));
    expect(VAULT_SELECTOR.price).toBe(toFunctionSelector("price()"));
    expect(VAULT_SELECTOR.keeper).toBe(toFunctionSelector("keeper()"));
    expect(VAULT_SELECTOR.paused).toBe(toFunctionSelector("paused()"));
    expect(VAULT_SELECTOR.previewProtect).toBe(toFunctionSelector("previewProtect(uint256,uint256)"));
    expect(VAULT_SELECTOR.protect).toBe(toFunctionSelector("protect(uint256,uint256)"));
  });
  it("calldata equals viem's", () => {
    const abi = [
      { type: "function", name: "protect", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [] },
      { type: "function", name: "previewProtect", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [] },
      { type: "function", name: "line", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [] },
      { type: "function", name: "capacity", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [] },
    ] as const;
    expect(encodeVaultProtect(1n, 520_000n)).toBe(encodeFunctionData({ abi, functionName: "protect", args: [1n, 520_000n] }));
    expect(encodePreviewProtect(4n, LADDER_PROBE)).toBe(encodeFunctionData({ abi, functionName: "previewProtect", args: [4n, LADDER_PROBE] }));
    expect(encodeLine(1n)).toBe(encodeFunctionData({ abi, functionName: "line", args: [1n] }));
    expect(encodeCapacity(1n)).toBe(encodeFunctionData({ abi, functionName: "capacity", args: [1n] }));
  });
  it("decodes the desk's Line, Quote and the vault's Funding through viem's encoder", () => {
    expect(decodeLine(encLine(LIVE_LINE))).toEqual(LIVE_LINE);
    expect(decodeQuote(encQuote(LIVE_QUOTE))).toEqual(LIVE_QUOTE);
    const f = { fromUser: 400_000n, fromPartner: 0n, fromAdvance: 1_000_000n, shortfall: 7n };
    expect(decodeFunding(encFunding(f))).toEqual(f);
    expect(() => decodeLine("0x00")).toThrow(/9 words/);
  });
  it("parses VAULT_TARGETS and refuses nonsense", () => {
    expect(parseVaultTargets(` 1:5200:4500:${SHADOW}:${FEED}:5 ,`)).toEqual([{ lineId: 1n, graceLtvBps: 5200, targetLtvBps: 4500, shadowOracle: SHADOW, feed: FEED, feedSlot: 5n }]);
    expect(parseVaultTargets(undefined)).toEqual([]);
    expect(() => parseVaultTargets(`1:4500:5200:${SHADOW}:${FEED}:5`)).toThrow(/target < grace/);
    expect(() => parseVaultTargets(`0:5200:4500:${SHADOW}:${FEED}:5`)).toThrow(/bad line id/);
    expect(() => parseVaultTargets(`1:5200:4500:0x12:${FEED}:5`)).toThrow(/bad address/);
    expect(() => parseVaultTargets("1:5200:4500")).toThrow(/want lineId/);
  });
});

describe("sizeVault on line 1 as staged for the Saturday drill", () => {
  const t = { graceLtvBps: 5200, targetLtvBps: 4500 };
  it("reads 47.96% at the live feed: below the 52% grace, nothing to do", () => {
    const s = sizeVault(LIVE_LINE, LIVE_QUOTE, SHADOW_AT_FEED, t);
    expect(s.standing).toBe("BELOW_GRACE");
    expect(pct(s.shadowLtvWad)).toBe("47.96");
    expect(pct(s.venueLtvWad)).toBe("47.96");
    expect(s.amount).toBe(0n);
  });
  it("on a Saturday (feed held, venue refuses to price) a 9% lower TWAP puts it in grace and sizes the repay to 45%", () => {
    const weekend: DeskQuote = { ...LIVE_QUOTE, reason: "MARKET_CLOSED", session: "WEEKEND", price8: 0n, collateralValue: 0n };
    const shadow = (SHADOW_AT_FEED * 91n) / 100n;
    const s = sizeVault(LIVE_LINE, weekend, shadow, t);
    expect(s.standing).toBe("IN_GRACE");
    expect(s.venueLtvWad).toBeNull();
    const value = (2_000_000n * shadow) / E36;
    expect(s.shadowValue).toBe(value);
    const exact = 3_220_175n - (value * 45n * 10n ** 16n) / WAD;
    expect(s.amount % AMOUNT_STEP).toBe(0n);
    expect(s.amount).toBeGreaterThanOrEqual(exact);
    expect(s.amount - exact).toBeLessThan(AMOUNT_STEP);
    // after the repay the shadow LTV is at or below the target
    expect(((3_220_175n - s.amount) * WAD) / value).toBeLessThanOrEqual(45n * 10n ** 16n);
  });
  it("never repays more than the debt, and treats collateral worth nothing as fully over grace", () => {
    const s = sizeVault(LIVE_LINE, { ...LIVE_QUOTE, collateralRaw: 0n }, SHADOW_AT_FEED, t);
    expect(s.standing).toBe("IN_GRACE");
    expect(pct(s.shadowLtvWad)).toBe("inf");
    expect(s.amount).toBe(3_220_175n);
  });
  it("stands down without a debt, a shadow price or an open line", () => {
    expect(sizeVault(LIVE_LINE, { ...LIVE_QUOTE, debt: 0n }, SHADOW_AT_FEED, t).standing).toBe("NO_DEBT");
    expect(sizeVault(LIVE_LINE, LIVE_QUOTE, null, t).standing).toBe("NO_SHADOW_PRICE");
    expect(sizeVault({ ...LIVE_LINE, status: "CLOSED" }, LIVE_QUOTE, SHADOW_AT_FEED, t).standing).toBe("LINE_CLOSED");
  });
});

describe("the ladder", () => {
  // The contract's previewProtect, written out the way DeskProtectionVault.sol does it.
  function previewProtect(amount: bigint, user: bigint, partner: bigint, room: bigint): Funding {
    const fromUser = amount < user ? amount : user;
    let rest = amount - fromUser;
    const fromPartner = rest < partner ? rest : partner;
    rest -= fromPartner;
    const fromAdvance = rest < room ? rest : room;
    rest -= fromAdvance;
    return { fromUser, fromPartner, fromAdvance, shortfall: rest };
  }
  it("fundFromLadder equals previewProtect at every amount (randomised)", () => {
    let seed = 7n;
    const rnd = (n: bigint) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      return seed % n;
    };
    for (let i = 0; i < 2000; i += 1) {
      const user = rnd(2_000_000n);
      const partner = rnd(2_000_000n);
      const room = rnd(2_000_000n);
      const amount = rnd(8_000_000n);
      const ladder = previewProtect(LADDER_PROBE, user, partner, room);
      expect(fundFromLadder(amount, ladder)).toEqual(previewProtect(amount, user, partner, room));
    }
  });
  const inGrace = sizeVault(LIVE_LINE, { ...LIVE_QUOTE, collateralValue: 0n }, (SHADOW_AT_FEED * 91n) / 100n, { graceLtvBps: 5200, targetLtvBps: 4500 });
  const ladder: Funding = { fromUser: 400_000n, fromPartner: 0n, fromAdvance: 1_000_000n, shortfall: LADDER_PROBE - 1_400_000n };
  it("funds a repay down the ladder: the user's reserve first, then an advance", () => {
    const d = decideVault(inGrace, ladder, false);
    expect(d.action).toBe("protect");
    if (d.action !== "protect") return;
    expect(d.capped).toBe(false);
    expect(d.funding.fromUser).toBe(400_000n);
    expect(d.funding.fromAdvance).toBe(d.amount - 400_000n);
    expect(d.funding.shortfall).toBe(0n);
  });
  it("caps the repay to what the ladder holds rather than reverting", () => {
    expect(inGrace.amount).toBe(480_000n);
    const d = decideVault(inGrace, { ...ladder, fromAdvance: 50_000n }, false);
    expect(d).toMatchObject({ action: "protect", amount: 450_000n, capped: true, funding: { fromUser: 400_000n, fromAdvance: 50_000n, shortfall: 0n } });
  });
  it("uses the reserves only while the vault is paused, and says why it cannot act", () => {
    const d = decideVault(inGrace, ladder, true);
    expect(d).toMatchObject({ action: "protect", amount: 400_000n, capped: true, funding: { fromAdvance: 0n } });
    expect(decideVault(inGrace, { ...ladder, fromUser: 0n }, true)).toEqual({ action: "none", reason: "paused-needs-advance" });
    expect(decideVault(inGrace, { fromUser: 0n, fromPartner: 0n, fromAdvance: 0n, shortfall: LADDER_PROBE }, false)).toEqual({ action: "none", reason: "unfunded" });
    expect(decideVault(inGrace, null, false)).toEqual({ action: "none", reason: "unfunded" });
  });
  it("formats percentages and USDC", () => {
    expect(pct(null)).toBeNull();
    expect(pct(580_000_000_000_000_000n)).toBe("58.00");
    expect(usdc(1_805_453n)).toBe("1.805453");
  });
});

describe("runVault", () => {
  const key = "0x0000000000000000000000000000000000000000000000000000000000000003" as Hex;
  const account = privateKeyToAccount(key);
  const word = (x: bigint) => x.toString(16).padStart(64, "0");
  const target = { lineId: 1n, graceLtvBps: 5200, targetLtvBps: 4500, shadowOracle: SHADOW, feed: FEED, feedSlot: 5n };
  const HELD = `0x${word(1791401927n)}` as Hex;

  function fake(opts: { keeper?: Address; shadow?: bigint; pending?: number; latest?: number; alreadyKnownFirst?: boolean; failBatch?: boolean; paused?: boolean } = {}) {
    const submissions: { raw: Hex; validity: unknown }[] = [];
    let heads = 0;
    const multicall = (): Hex => {
      const ret = (data: Hex) => ({ success: true, returnData: data });
      const results = [
        ret(`0x${word(BigInt(opts.keeper ?? account.address))}`),
        ret(`0x${word(opts.paused ? 1n : 0n)}`),
        ret(encLine(LIVE_LINE)),
        ret(encQuote({ ...LIVE_QUOTE, reason: "MARKET_CLOSED", session: "WEEKEND", price8: 0n, collateralValue: 0n })),
        opts.shadow === 0n ? { success: false, returnData: "0x" as Hex } : ret(`0x${word(opts.shadow ?? (SHADOW_AT_FEED * 91n) / 100n)}`),
        ret(encFunding({ fromUser: 400_000n, fromPartner: 0n, fromAdvance: 1_000_000n, shortfall: LADDER_PROBE - 1_400_000n })),
      ];
      return encodeAbiParameters([{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }], [results]);
    };
    const one = (c: RpcCall): RpcOutcome => {
      switch (c.method) {
        case "eth_blockNumber":
          return { ok: true, result: `0x${(47_840_000 + heads++ * 40).toString(16)}` };
        case "eth_call":
          return { ok: true, result: multicall() };
        case "eth_getStorageAt":
          return { ok: true, result: HELD };
        case "eth_getTransactionCount":
          return { ok: true, result: `0x${((c.params[1] === "pending" ? opts.pending : opts.latest) ?? 9).toString(16)}` };
        case "eth_gasPrice":
          return { ok: true, result: "0x4c4b40" };
        default:
          return { ok: false, error: `unexpected ${c.method}` };
      }
    };
    const rpc: VaultRpc = {
      async batch(calls) {
        if (opts.failBatch) throw new Error("rpc down");
        return calls.map(one);
      },
      async call<T>(method: string, params: readonly unknown[]) {
        const o = one({ method, params });
        if (!o.ok) throw new Error(o.error);
        return o.result as T;
      },
      async submitValidity(raw, validity) {
        submissions.push({ raw, validity });
        if (opts.alreadyKnownFirst && submissions.length === 1) throw new Error("base_sendRawTransactionValidity: -32000 already known");
        return `0x${submissions.length.toString(16).padStart(64, "0")}` as Hex;
      },
    };
    return { rpc, submissions };
  }
  const deps = (rpc: VaultRpc, extra: Record<string, unknown> = {}) => ({ rpc, vault: VAULT, desk: DESK, targets: [target], account, chainId: 84532, sleep: async () => undefined, ...extra });

  it("arms protect(lineId, amount) with the held predicate, a 30-block bound and the pending nonce", async () => {
    const { rpc, submissions } = fake();
    const r = await runVault(deps(rpc));
    expect(r.keeperIsSigner).toBe(true);
    expect(r.skipped).toBeNull();
    expect(r.targets[0]?.sizing?.standing).toBe("IN_GRACE");
    expect(r.armed).toMatchObject({ lineId: "1", nonce: 9, attempts: 1, alreadyKnown: false, bound: 47_840_030, head: 47_840_000 });
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.validity).toEqual(predicatesFor(FEED, 5n, HELD, 47_840_000n, "held"));
    expect(submissions[0]!.raw.startsWith("0x02")).toBe(true);
    expect(r.armed!.funding.fromUser).toBe(400_000n);
  });
  it("signs byte-identical bytes on a re-arm while nothing has changed", async () => {
    const a = fake();
    const b = fake();
    await runVault(deps(a.rpc));
    await runVault(deps(b.rpc));
    expect(a.submissions[0]!.raw).toBe(b.submissions[0]!.raw);
  });
  it("after 'already known', re-signs a NEW hash two fee steps up rather than re-sending the same bytes", async () => {
    const { rpc, submissions } = fake({ alreadyKnownFirst: true });
    const r = await runVault(deps(rpc));
    expect(submissions).toHaveLength(2);
    expect(submissions[1]!.raw).not.toBe(submissions[0]!.raw);
    expect(r.armed).toMatchObject({ attempts: 2, alreadyKnown: false });
    expect(r.armed!.feeStep).toBeGreaterThanOrEqual(2);
    expect(r.armed!.bound).toBeGreaterThan(47_840_030);
  });
  it("raises the fees on every re-arm of an episode (a new hash each window)", async () => {
    const a = fake();
    const b = fake();
    const first = await runVault(deps(a.rpc));
    const later = await runVault(deps(b.rpc, { episodeHead: () => 47_839_960n }));
    expect(first.armed!.feeStep).toBe(0);
    expect(later.armed!.feeStep).toBe(2); // head 47,840,000 is 40 blocks into the episode: floor(40 / 30) + 1
    expect(a.submissions[0]!.raw).not.toBe(b.submissions[0]!.raw);
  });
  it("watches without signing until the vault's keeper is this signer", async () => {
    const { rpc, submissions } = fake({ keeper: "0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E" });
    const r = await runVault(deps(rpc));
    expect(r).toMatchObject({ skipped: "not-keeper", keeperIsSigner: false });
    expect(r.targets[0]?.decision?.action).toBe("protect");
    expect(submissions).toHaveLength(0);
  });
  it("yields the shared signer to the Protector, and waits while a transaction is in flight", async () => {
    const busy = fake();
    expect((await runVault(deps(busy.rpc, { signerBusy: true }))).skipped).toBe("signer-busy");
    expect(busy.submissions).toHaveLength(0);
    const inflight = fake({ pending: 10, latest: 9 });
    expect((await runVault(deps(inflight.rpc))).skipped).toBe("in-flight");
    expect(inflight.submissions).toHaveLength(0);
  });
  it("never signs in a dry run, without a key, or without a shadow price", async () => {
    const dry = fake();
    expect((await runVault(deps(dry.rpc, { dryRun: true }))).armed).toBeNull();
    expect(dry.submissions).toHaveLength(0);
    const noKey = fake();
    expect((await runVault(deps(noKey.rpc, { account: null }))).skipped).toBe("no-key");
    const noShadow = fake({ shadow: 0n });
    const r = await runVault(deps(noShadow.rpc));
    expect(r.targets[0]?.sizing?.standing).toBe("NO_SHADOW_PRICE");
    expect(r.skipped).toBe("nothing-to-do");
  });
  it("reports the keeper even with no targets (the live view before a line is watched)", async () => {
    const { rpc } = fake({ keeper: "0x2f0d9B1f16CD702259C6cC259e8D5E5455282a4E" });
    const r = await runVault(deps(rpc, { targets: [] }));
    expect(r).toMatchObject({ skipped: "no-targets", keeperIsSigner: false, keeper: "0x2f0d9b1f16cd702259c6cc259e8d5e5455282a4e" });
  });
  it("never throws when the read fails", async () => {
    const { rpc } = fake({ failBatch: true });
    const r = await runVault(deps(rpc));
    expect(r.skipped).toBe("read-failed");
    expect(r.errors[0]).toContain("rpc down");
  });
  it("re-arm fees: a first arming at the base, then +25% on tip and cap per 30-block window (a new hash every re-arm)", () => {
    const first = rearmFees(5_000_000n, null, 47_840_000n);
    expect(first).toEqual({ maxFeePerGas: 21_000_000n, maxPriorityFeePerGas: 1_000_000n, step: 0 });
    expect(rearmFees(9_000_000n, null, 47_840_000n).maxFeePerGas).toBe(31_000_000n); // 27 M rounded up to 30 M, plus the tip
    const sameWindow = rearmFees(5_000_000n, 47_840_000n, 47_840_029n);
    const nextWindow = rearmFees(5_000_000n, 47_840_000n, 47_840_030n);
    expect(sameWindow.step).toBe(1);
    expect(nextWindow.step).toBe(2);
    // each step raises both the tip and the cap by at least 10% (a valid replacement of a live submission)
    for (const [a, b] of [[first, sameWindow], [sameWindow, nextWindow]] as const) {
      expect(b.maxPriorityFeePerGas * 10n).toBeGreaterThanOrEqual(a.maxPriorityFeePerGas * 11n);
      expect(b.maxFeePerGas * 10n).toBeGreaterThanOrEqual(a.maxFeePerGas * 11n);
    }
    expect(rearmFees(5_000_000n, 47_840_000n, 47_840_000n, 2).step).toBe(3);
    expect(rearmFees(5_000_000n, 0n, 10_000_000n).step).toBe(24); // capped
  });
});
