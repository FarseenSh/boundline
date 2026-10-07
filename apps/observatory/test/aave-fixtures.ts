// Live values read from the Aave V4 MAG7 spoke on Base mainnet, Wed 7 Oct 2026 ~13:45 UTC (borrower 0x84c4…d980,
// the spoke's most active USDC borrower in the indexer's scan). The spoke answered healthFactor 1.680896609923236325
// for exactly these inputs, which pins the health model in aave-positions.ts.
import type { Address } from "viem";
import { AAVE_SELECTOR, AAVE_SPOKE, type AaveMeta } from "../src/aave-positions.js";
import { encodeAggregate3Result, decodeAggregate3Calldata, wordAddress, wordUint, type Call } from "../src/encoding.js";
import type { EthCall } from "../src/rpc.js";

export const BORROWER: Address = "0x84c47eb3757f739460d04e330389647828a8d980";
export const ORACLE: Address = "0xaBaf048fD7675Ea34a84332371ffd5D55E322A47";

export const ACCOUNT_WORDS = [0n, 727519603599993545n, 1680896609923236325n, 715939056077970462310000000000n, 309870158107693127123825489764366918090819704000000000000n, 6n, 1n] as const;
export const DEBT_USDC = 3099171323n;
export const SUPPLIED: Readonly<Record<number, bigint>> = { 0: 0n, 1: 368173255n, 2: 260999797n, 3: 234718459n, 4: 448339807n, 5: 420066094n, 6: 65878599n };
export const PRICES: Readonly<Record<number, bigint>> = { 0: 33400500000n, 1: 25373000000n, 2: 34552625528n, 3: 72769327289n, 4: 52740500000n, 5: 23815304306n, 6: 38010000000n, 7: 99984843n };
export const FACTORS_BPS: Readonly<Record<number, number>> = { 0: 7800, 1: 7300, 2: 7600, 3: 6500, 4: 7900, 5: 7000, 6: 6500, 7: 0 };
export const UNDERLYING: Readonly<Record<number, Address>> = {
  0: "0xb200000000000000000000C2e324d24d7eEcd1fb",
  1: "0xb200000000000000000000d9192b6B456483C2E8",
  2: "0xb2000000000000000000002D0BA3164cc74f58B7",
  3: "0xb2000000000000000000008bC8786B856E61707C",
  4: "0xB200000000000000000000Ab99cFa739E253872B",
  5: "0xb20000000000000000000078ee7ce2fE4908108C",
  6: "0xb2000000000000000000001e800a7f5189430cD0",
  7: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
const SYMBOLS: Readonly<Record<number, string>> = { 0: "AAPLc", 1: "AMZNc", 2: "GOOGLc", 3: "METAc", 4: "MSFTc", 5: "NVDAc", 6: "TSLAc", 7: "USDC" };

export const META: AaveMeta = {
  readAt: 1791380000,
  oracle: ORACLE,
  reserves: [0, 1, 2, 3, 4, 5, 6, 7].map((id) => ({
    reserveId: id,
    symbol: SYMBOLS[id] as string,
    underlying: UNDERLYING[id] as Address,
    decimals: id === 7 ? 6 : 8,
    collateralFactorBps: FACTORS_BPS[id] as number,
    paused: false,
    frozen: false,
    borrowable: id === 7,
  })),
};

/** The spoke's healthFactor for the fixture, as a number. */
export const LIVE_HF = Number(ACCOUNT_WORDS[2]) / 1e18;

export function words(...values: readonly bigint[]): string {
  return values.map((v) => wordUint(v)).join("");
}

function selectorOf(c: Call): string {
  return c.callData.slice(0, 10);
}

function argWord(c: Call, index: number): string {
  return c.callData.slice(10 + index * 64, 10 + (index + 1) * 64);
}

/**
 * An EthCall that answers aggregate3 calldata the way the live spoke and oracle do for the fixture, per
 * borrower: `accounts` maps a lowercase address to its account words, debt and supplied map; unknown
 * borrowers answer an empty position. `fail` makes a selector's calls fail.
 */
export function fakeSpokeCall(
  accounts: ReadonlyMap<string, { account: readonly bigint[]; debt: bigint; supplied: Readonly<Record<number, bigint>> }>,
  opts: { fail?: ReadonlySet<string>; prices?: Readonly<Record<number, bigint>>; onCall?: (calls: Call[]) => void } = {},
): EthCall {
  const prices = opts.prices ?? PRICES;
  return async (_to, data) => {
    const calls = decodeAggregate3Calldata(data);
    opts.onCall?.(calls);
    return encodeAggregate3Result(
      calls.map((c) => {
        const sel = selectorOf(c);
        if (opts.fail?.has(sel)) return { success: false, data: "" };
        switch (sel) {
          case AAVE_SELECTOR.getReserve: {
            const id = Number(BigInt(`0x${argWord(c, 0)}`));
            return { success: true, data: wordAddress(UNDERLYING[id] as Address) + wordAddress("0xa4d5947Eb727A052bae69C593FfC84247EC9864E") + words(0n, BigInt(id === 7 ? 6 : 8), 0n, 8n, 0n) };
          }
          case AAVE_SELECTOR.oracle:
            return { success: true, data: wordAddress(ORACLE) };
          case AAVE_SELECTOR.getDynamicReserveConfig: {
            const id = Number(BigInt(`0x${argWord(c, 0)}`));
            return { success: true, data: words(BigInt(FACTORS_BPS[id] as number), 10550n, 1000n) };
          }
          case AAVE_SELECTOR.getReserveConfig: {
            const id = Number(BigInt(`0x${argWord(c, 0)}`));
            return { success: true, data: words(0n, 0n, 0n, id === 7 ? 1n : 0n, 0n) };
          }
          case AAVE_SELECTOR.getReservePrice: {
            const id = Number(BigInt(`0x${argWord(c, 0)}`));
            const p = prices[id];
            return p === undefined ? { success: false, data: "" } : { success: true, data: words(p) };
          }
          case AAVE_SELECTOR.getUserAccountData: {
            const user = `0x${argWord(c, 0).slice(24)}`;
            const a = accounts.get(user);
            return { success: true, data: a ? words(...a.account) : words(0n, 0n, (1n << 256n) - 1n, 0n, 0n, 0n, 0n) };
          }
          case AAVE_SELECTOR.getUserTotalDebt: {
            const user = `0x${argWord(c, 1).slice(24)}`;
            return { success: true, data: words(accounts.get(user)?.debt ?? 0n) };
          }
          case AAVE_SELECTOR.getUserSuppliedAssets: {
            const id = Number(BigInt(`0x${argWord(c, 0)}`));
            const user = `0x${argWord(c, 1).slice(24)}`;
            return { success: true, data: words(accounts.get(user)?.supplied[id] ?? 0n) };
          }
          default:
            return { success: false, data: "" };
        }
      }),
    );
  };
}

export const LIVE_ACCOUNTS = new Map([[BORROWER, { account: ACCOUNT_WORDS, debt: DEBT_USDC, supplied: SUPPLIED }]]);

export { AAVE_SPOKE };
