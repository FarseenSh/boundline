import type { Address, Hex } from "viem";
import type { MirrorChain, ReadResult, Receipt, SideReads } from "../src/chain.js";
import type { MirrorPair } from "../src/config.js";
import type { RegistryParams, Round, RoundArgs } from "../src/plan.js";

export const PAIR_A: MirrorPair = {
  symbol: "AAPLt",
  source: "AAPLc",
  mainnetToken: "0xb200000000000000000000C2e324d24d7eEcd1fb",
  mainnetFeed: "0x787f13dEa48Db0897CbCDD985de77809D837F988",
  sepoliaToken: "0xB2000000000000000000000E063E65377cA34141",
  sepoliaFeed: "0xa652b75CA90084FA16D4F18Fd96B5dd7069ee52a",
};
export const PAIR_N: MirrorPair = {
  symbol: "NVDAt",
  source: "NVDAc",
  mainnetToken: "0xb20000000000000000000078ee7ce2fE4908108C",
  mainnetFeed: "0x04689a41629776563E6822F76f2e57D148d28513",
  sepoliaToken: "0xB200000000000000000000AEd76Eae58870E2ae6",
  sepoliaFeed: "0x097dCec820dCF11b5e8d0fA698b86714f96dB0e2",
};
export const PAIRS2 = [PAIR_A, PAIR_N] as const;

export const KEEPER: Address = "0x28A50Eb7C2Db2B04638D3b226c724A1Cfe999894";

export function round(roundId: bigint, answer: bigint, updatedAt: bigint, startedAt = updatedAt, answeredInRound = roundId): Round {
  return { roundId, answer, startedAt, updatedAt, answeredInRound };
}
export const ok = <T>(value: T): ReadResult<T> => ({ ok: true, value });
export const fail = <T>(error: string): ReadResult<T> => ({ ok: false, error });

export interface SideSpec {
  block?: bigint;
  rounds?: Record<string, ReadResult<Round>>;
  registry?: Record<string, ReadResult<RegistryParams>>;
}

export function side(chainId: number, spec: SideSpec): SideReads {
  return {
    chainId,
    block: spec.block ?? 1n,
    rounds: new Map(Object.entries(spec.rounds ?? {})),
    registry: new Map(Object.entries(spec.registry ?? {})),
  };
}

export interface SentCall {
  kind: "feed" | "registry";
  to: Address;
  args: readonly unknown[];
  nonce: bigint;
  hash: Hex;
}

export interface FakeOptions {
  keeper?: Address | null;
  mainnet: SideReads;
  sepolia: SideReads;
  nonces?: { latest: bigint; pending: bigint };
  balance?: bigint;
  /** Throw on the n-th send (0-based). */
  failSendAt?: number;
  /** Receipt per hash: default success; "timeout" → null; "reverted" → reverted. */
  receipts?: Record<string, "success" | "reverted" | "timeout">;
  readThrows?: boolean;
}

export function fakeChain(o: FakeOptions): MirrorChain & { sent: SentCall[]; waited: Hex[] } {
  const sent: SentCall[] = [];
  const waited: Hex[] = [];
  let n = 0;
  const hashOf = (i: number): Hex => `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex;
  const send = (kind: SentCall["kind"], to: Address, args: readonly unknown[], nonce: bigint): Promise<Hex> => {
    const i = n++;
    if (o.failSendAt === i) return Promise.reject(new Error(`send ${i} rejected by rpc`));
    const hash = hashOf(i);
    sent.push({ kind, to, args, nonce, hash });
    return Promise.resolve(hash);
  };
  return {
    sent,
    waited,
    keeper: o.keeper === undefined ? KEEPER : o.keeper,
    readMainnet: () => (o.readThrows ? Promise.reject(new Error("mainnet rpc down")) : Promise.resolve(o.mainnet)),
    readSepolia: () => Promise.resolve(o.sepolia),
    nonces: () => Promise.resolve(o.nonces ?? { latest: 5n, pending: 5n }),
    balance: () => Promise.resolve(o.balance ?? 10n ** 16n),
    setRoundData: (feed: Address, args: RoundArgs, nonce: bigint) => send("feed", feed, args, nonce),
    setOracleParams: (token: Address, multiplier: bigint, paused: boolean, nonce: bigint) => send("registry", token, [multiplier, paused], nonce),
    waitForReceipt: (hash: Hex): Promise<Receipt | null> => {
      waited.push(hash);
      const mode = o.receipts?.[hash] ?? "success";
      if (mode === "timeout") return Promise.resolve(null);
      return Promise.resolve({ blockNumber: 100n, status: mode, gasUsed: 50_000n });
    },
  };
}
