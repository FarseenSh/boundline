import { encodeAbiParameters, encodeFunctionData, toFunctionSelector, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { PROTECT_SELECTOR, STANDING, decideProtection, decodeSizing, encodeProtect, encodeSizing, isAlreadyKnown, parseTargets, predicatesFor, type Sizing } from "../src/protect.js";
import { runProtect, type ProtectRpc } from "../src/protect-job.js";
import { decodeAggregate3 } from "../src/raw.js";
import { privateKeyToAccount } from "viem/accounts";

const PRELIQ: Address = "0xdcae709341aab652144e8afcb47479fe49e133a1";
const BORROWER: Address = "0xB789aD318945B37566E2549F65526Cc269a482Fc";
const PROTECTOR: Address = "0x5c546946c909718040dd686f63df6cb5e4df442c";
const FEED: Address = "0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a";

const sizingTuple = [
  { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" },
  { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
  { type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" },
] as const;

function encodeSizingReturn(s: Sizing): Hex {
  return encodeAbiParameters(sizingTuple as never, [
    STANDING.indexOf(s.standing), s.collateral, s.borrowShares, s.debtAssets, s.shadowPrice36, s.venuePrice36, s.venueOracleLive,
    s.shadowLtvWad, s.venueLtvWad, s.preLifWad, s.preLcfWad, s.targetLtvWad, s.maxSeizedAssets, s.maxRepaidShares, s.maxRepaidAssets,
    s.fullCloseAllowed, s.fullCloseSeizedAssets, s.fullCloseRepaidAssets,
  ] as never);
}

const inBand: Sizing = {
  standing: "IN_BAND", collateral: 1_000_000n, borrowShares: 2_000_000_000_000n, debtAssets: 2_000_100n, shadowPrice36: 3_326_700_000_000_000_000_000_000_000_000_000_000n,
  venuePrice36: 3_326_700_000_000_000_000_000_000_000_000_000_000n, venueOracleLive: true, shadowLtvWad: 601_000_000_000_000_000n, venueLtvWad: 601_000_000_000_000_000n,
  preLifWad: 1_014_000_000_000_000_000n, preLcfWad: 10n ** 18n, targetLtvWad: 580_000_000_000_000_000n, maxSeizedAssets: 60_000n, maxRepaidShares: 190_000_000_000n,
  maxRepaidAssets: 190_100n, fullCloseAllowed: true, fullCloseSeizedAssets: 609_000n, fullCloseRepaidAssets: 2_000_100n,
};

describe("selectors and calldata", () => {
  it("match the Protector's signatures", () => {
    expect(PROTECT_SELECTOR.sizing).toBe(toFunctionSelector("sizing(address,address,uint256)"));
    expect(PROTECT_SELECTOR.protect).toBe(toFunctionSelector("protect(address,address,uint256,uint256,uint256,uint256)"));
  });
  it("sizing calldata equals viem's", () => {
    const abi = [{ type: "function", name: "sizing", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }], outputs: [] }] as const;
    expect(encodeSizing(PRELIQ, BORROWER, 0n).toLowerCase()).toBe(encodeFunctionData({ abi, functionName: "sizing", args: [PRELIQ, BORROWER, 0n] }).toLowerCase());
  });
  it("protect calldata equals viem's", () => {
    const abi = [{ type: "function", name: "protect", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [] }] as const;
    expect(encodeProtect(PRELIQ, BORROWER, 60_000n, 0n, 0n, 1_791_300_000n).toLowerCase()).toBe(
      encodeFunctionData({ abi, functionName: "protect", args: [PRELIQ, BORROWER, 60_000n, 0n, 0n, 1_791_300_000n] }).toLowerCase(),
    );
  });
});

describe("decodeSizing", () => {
  it("round-trips through viem's encoder", () => {
    expect(decodeSizing(encodeSizingReturn(inBand))).toEqual(inBand);
    const below: Sizing = { ...inBand, standing: "BELOW_BAND", maxSeizedAssets: 0n, fullCloseAllowed: false };
    expect(decodeSizing(encodeSizingReturn(below))).toEqual(below);
  });
  it("rejects short data and unknown standings", () => {
    expect(() => decodeSizing("0x1234")).toThrow(/18 words/);
    expect(() => decodeSizing(`0x${"7".padStart(64, "0")}${"0".repeat(64 * 17)}`)).toThrow(/unknown standing/);
  });
});

describe("decideProtection", () => {
  it("prefers the partial the contract allows", () => {
    expect(decideProtection(inBand)).toEqual({ action: "partial", seizedAssets: 60_000n, repaidShares: 0n, expectedRepaid: 190_100n });
  });
  it("closes out only when no partial can run (SessionGuard market while closed)", () => {
    const closedMarket: Sizing = { ...inBand, venueOracleLive: false, maxSeizedAssets: 0n, maxRepaidShares: 0n, maxRepaidAssets: 0n };
    expect(decideProtection(closedMarket)).toEqual({ action: "close", seizedAssets: 0n, repaidShares: inBand.borrowShares, expectedRepaid: 2_000_100n });
  });
  it("does nothing outside the band or without a price", () => {
    expect(decideProtection({ ...inBand, standing: "BELOW_BAND" })).toEqual({ action: "none", reason: "below-band" });
    expect(decideProtection({ ...inBand, standing: "ABOVE_LLTV" })).toEqual({ action: "none", reason: "above-lltv" });
    expect(decideProtection({ ...inBand, standing: "NO_SHADOW_PRICE" })).toEqual({ action: "none", reason: "no-shadow-price" });
    expect(decideProtection({ ...inBand, standing: "NO_POSITION" })).toEqual({ action: "none", reason: "no-position" });
    expect(decideProtection({ ...inBand, maxSeizedAssets: 0n, fullCloseAllowed: false })).toEqual({ action: "none", reason: "nothing-feasible" });
  });
});

describe("predicates and targets", () => {
  it("builds the held and changed predicates with a short bound", () => {
    const held = predicatesFor(FEED, 5n, `0x${"6ac3e55b".padStart(64, "0")}` as Hex, 47_760_039n, "held");
    expect(held).toEqual([
      { type: "storage", params: { address: FEED, slot: "0x5", op: "=", value: `0x${"6ac3e55b".padStart(64, "0")}` } },
      { type: "block_number", params: { op: "<=", value: `0x${(47_760_069n).toString(16)}` } },
    ]);
    expect(predicatesFor(FEED, 5n, "0x00" as Hex, 1n, "changed")[0]).toMatchObject({ params: { op: "!=" } });
  });
  it("recognises the sequencer's duplicate answer", () => {
    expect(isAlreadyKnown("base_sendRawTransactionValidity: -32000 already known")).toBe(true);
    expect(isAlreadyKnown("nonce too low")).toBe(false);
  });
  it("parses PROTECT_TARGETS", () => {
    expect(parseTargets(` ${PRELIQ}:${BORROWER}:${FEED}:5 ,`)).toEqual([{ preLiq: PRELIQ, borrower: BORROWER, feed: FEED, feedSlot: 5n }]);
    expect(parseTargets(undefined)).toEqual([]);
    expect(() => parseTargets("0x1:0x2:0x3:5")).toThrow(/bad address/);
    expect(() => parseTargets(`${PRELIQ}:${BORROWER}`)).toThrow(/bad PROTECT_TARGETS/);
  });
});

describe("runProtect", () => {
  const key = "0x0000000000000000000000000000000000000000000000000000000000000002" as Hex;
  const account = privateKeyToAccount(key);
  function fakeRpc(sizings: Sizing[], opts: { alreadyKnownFirst?: boolean } = {}) {
    const submissions: { raw: Hex; validity: unknown }[] = [];
    let heads = 0;
    const rpc: ProtectRpc = {
      async read(method, params) {
        if (method === "eth_blockNumber") return `0x${(47_760_039 + heads++ * 40).toString(16)}`;
        if (method === "eth_call") {
          // aggregate3 result: one success per sizing
          const results = sizings.map((s) => ({ success: true, returnData: encodeSizingReturn(s) }));
          return encodeAbiParameters([{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }], [results]);
        }
        if (method === "eth_getStorageAt") return `0x${"6ac3e55b".padStart(64, "0")}`;
        if (method === "eth_getTransactionCount") return "0x3";
        if (method === "eth_gasPrice") return "0x5b8d80";
        throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
      },
      async submitValidity(raw, validity) {
        submissions.push({ raw, validity });
        if (opts.alreadyKnownFirst && submissions.length === 1) throw new Error("base_sendRawTransactionValidity: -32000 already known");
        return `0x${submissions.length.toString(16).padStart(64, "0")}` as Hex;
      },
    };
    return { rpc, submissions };
  }
  const target = { preLiq: PRELIQ, borrower: BORROWER, feed: FEED, feedSlot: 5n };

  it("arms a partial action with the held predicate and a 30-block bound", async () => {
    const { rpc, submissions } = fakeRpc([inBand]);
    const r = await runProtect({ rpc, protector: PROTECTOR, targets: [target], account, chainId: 84532, sleep: async () => undefined });
    expect(r.skipped).toBeNull();
    expect(r.targets[0]?.decision).toMatchObject({ action: "partial" });
    expect(r.armed).toMatchObject({ action: "partial", nonce: 3, attempts: 1, alreadyKnown: false, bound: 47_760_069 });
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.validity).toEqual(predicatesFor(FEED, 5n, `0x${"6ac3e55b".padStart(64, "0")}` as Hex, 47_760_039n, "held"));
    // the signed payload calls protect(preLiq, borrower, 60000, 0, 0, deadline) on the Protector
    expect(submissions[0]?.raw.startsWith("0x02")).toBe(true);
  });
  it("re-arms once after an 'already known' answer, with a fresh bound", async () => {
    const { rpc, submissions } = fakeRpc([inBand], { alreadyKnownFirst: true });
    const r = await runProtect({ rpc, protector: PROTECTOR, targets: [target], account, chainId: 84532, sleep: async () => undefined });
    expect(submissions).toHaveLength(2);
    expect(r.armed).toMatchObject({ attempts: 2, alreadyKnown: false });
    expect(r.armed!.bound).toBeGreaterThan(47_760_069);
  });
  it("plans only without a key, and does nothing below the band", async () => {
    const noKey = await runProtect({ rpc: fakeRpc([inBand]).rpc, protector: PROTECTOR, targets: [target], account: null, chainId: 84532 });
    expect(noKey.skipped).toBe("no-key");
    const below = await runProtect({ rpc: fakeRpc([{ ...inBand, standing: "BELOW_BAND" }]).rpc, protector: PROTECTOR, targets: [target], account, chainId: 84532 });
    expect(below.skipped).toBe("nothing-to-do");
    expect(below.targets[0]?.decision).toEqual({ action: "none", reason: "below-band" });
  });
  it("never throws when the reads fail", async () => {
    const rpc: ProtectRpc = { read: async () => { throw new Error("rpc down"); }, submitValidity: async () => "0x" as Hex };
    const r = await runProtect({ rpc, protector: PROTECTOR, targets: [target], account, chainId: 84532 });
    expect(r.skipped).toBe("read-failed");
    expect(r.errors[0]).toContain("rpc down");
  });
  it("decodes a per-target revert without losing the others", async () => {
    const { rpc } = fakeRpc([inBand]);
    const broken: ProtectRpc = {
      ...rpc,
      async read(method, params) {
        if (method !== "eth_call") return rpc.read(method, params);
        const results = [{ success: false, returnData: "0x08c379a0" as Hex }, { success: true, returnData: encodeSizingReturn({ ...inBand, standing: "BELOW_BAND" }) }];
        return encodeAbiParameters([{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }], [results]);
      },
    };
    const r = await runProtect({ rpc: broken, protector: PROTECTOR, targets: [target, { ...target, borrower: PROTECTOR }], account, chainId: 84532 });
    expect(r.targets[0]?.error).toContain("reverted 0x08c379a0");
    expect(r.targets[1]?.decision).toEqual({ action: "none", reason: "below-band" });
    expect(decodeAggregate3).toBeTypeOf("function");
  });
});
