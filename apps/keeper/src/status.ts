// The status page: both sides of every pair, sync state, keeper funding. Pure `buildStatus` over side reads.
import type { Address } from "viem";
import type { MirrorChain, ReadResult, SideReads } from "./chain.js";
import { CHAINS, MAINNET_REGISTRY, SEPOLIA_REGISTRY, type MirrorPair } from "./config.js";
import { lagSeconds, planFeedMirror, planRegistryMirror, type RegistryParams, type Round } from "./plan.js";
import { NO_HOLD, type MirrorHold } from "./tick.js";

export interface RoundView {
  roundId: string;
  answer: string;
  /** answer / 1e8 for humans. */
  price: number;
  startedAt: number;
  updatedAt: number;
  answeredInRound: string;
  ageSeconds: number;
}

export interface SideView<T> {
  address: Address;
  value: T | null;
  error: string | null;
}

export interface PairStatus {
  symbol: string;
  source: string;
  feed: { mainnet: SideView<RoundView>; sepolia: SideView<RoundView>; inSync: boolean | null; lagSeconds: number | null; plan: string };
  registry: {
    mainnet: SideView<{ multiplier: string; paused: boolean }>;
    sepolia: SideView<{ multiplier: string; paused: boolean }>;
    inSync: boolean | null;
    plan: string;
  };
}

export interface KeeperStatus {
  service: "boundline-keeper";
  takenAt: number;
  keeper: { address: Address; balanceWei: string; balanceEth: number } | null;
  chains: { mainnet: { chainId: number; block: string; registry: Address }; sepolia: { chainId: number; block: string; registry: Address } };
  pairs: PairStatus[];
  summary: { pairs: number; feedsInSync: number; registriesInSync: number; readErrors: number };
}

function roundView(r: Round, now: number): RoundView {
  return {
    roundId: r.roundId.toString(),
    answer: r.answer.toString(),
    price: Number(r.answer) / 1e8,
    startedAt: Number(r.startedAt),
    updatedAt: Number(r.updatedAt),
    answeredInRound: r.answeredInRound.toString(),
    ageSeconds: Math.max(0, now - Number(r.updatedAt)),
  };
}

function side<T, V>(address: Address, read: ReadResult<T> | undefined, view: (t: T) => V): SideView<V> {
  if (!read) return { address, value: null, error: "missing" };
  return read.ok ? { address, value: view(read.value), error: null } : { address, value: null, error: read.error };
}

function regView(p: RegistryParams) {
  return { multiplier: p.multiplier.toString(), paused: p.paused };
}

export function buildStatus(
  pairs: readonly MirrorPair[],
  mainnet: SideReads,
  sepolia: SideReads,
  keeper: { address: Address; balanceWei: bigint } | null,
  now: number,
  hold: MirrorHold = NO_HOLD,
): KeeperStatus {
  let feedsInSync = 0;
  let registriesInSync = 0;
  let readErrors = 0;
  const rows: PairStatus[] = pairs.map((p) => {
    const mr = mainnet.rounds.get(p.symbol);
    const sr = sepolia.rounds.get(p.symbol);
    const mg = mainnet.registry.get(p.symbol);
    const sg = sepolia.registry.get(p.symbol);
    for (const x of [mr, sr, mg, sg]) if (!x || !x.ok) readErrors += 1;

    let feedInSync: boolean | null = null;
    let lag: number | null = null;
    let feedPlan = "unknown";
    if (mr?.ok) {
      const plan = planFeedMirror(mr.value, sr?.ok ? sr.value : null);
      feedPlan = plan.action === "skip" ? plan.reason : `setRoundData (${plan.reason})`;
      if (hold.feed.has(p.symbol)) feedPlan = `held (feed hold); unheld: ${feedPlan}`;
      feedInSync = plan.action === "skip" && plan.reason === "in-sync";
      lag = lagSeconds(mr.value, sr?.ok ? sr.value : null);
      if (feedInSync) feedsInSync += 1;
    }
    let regInSync: boolean | null = null;
    let regPlan = "unknown";
    if (mg?.ok) {
      const plan = planRegistryMirror(mg.value, sg?.ok ? sg.value : null);
      regPlan = plan.action === "skip" ? plan.reason : `setOracleParams (${plan.reason})`;
      if (hold.registry.has(p.symbol)) regPlan = `held (registry hold); unheld: ${regPlan}`;
      regInSync = plan.action === "skip";
      if (regInSync) registriesInSync += 1;
    }
    return {
      symbol: p.symbol,
      source: p.source,
      feed: {
        mainnet: side(p.mainnetFeed, mr, (r) => roundView(r, now)),
        sepolia: side(p.sepoliaFeed, sr, (r) => roundView(r, now)),
        inSync: feedInSync,
        lagSeconds: lag,
        plan: feedPlan,
      },
      registry: {
        mainnet: side(p.mainnetToken, mg, regView),
        sepolia: side(p.sepoliaToken, sg, regView),
        inSync: regInSync,
        plan: regPlan,
      },
    };
  });
  return {
    service: "boundline-keeper",
    takenAt: now,
    keeper: keeper ? { address: keeper.address, balanceWei: keeper.balanceWei.toString(), balanceEth: Number(keeper.balanceWei) / 1e18 } : null,
    chains: {
      mainnet: { chainId: CHAINS.mainnet, block: mainnet.block.toString(), registry: MAINNET_REGISTRY },
      sepolia: { chainId: CHAINS.sepolia, block: sepolia.block.toString(), registry: SEPOLIA_REGISTRY },
    },
    pairs: rows,
    summary: { pairs: rows.length, feedsInSync, registriesInSync, readErrors },
  };
}

/** Reads both chains and the keeper balance, then builds the status. */
export async function collectStatus(chain: MirrorChain, pairs: readonly MirrorPair[], now: number, hold: MirrorHold = NO_HOLD): Promise<KeeperStatus> {
  const [mainnet, sepolia, balanceWei] = await Promise.all([chain.readMainnet(pairs), chain.readSepolia(pairs), chain.keeper ? chain.balance() : Promise.resolve(0n)]);
  return buildStatus(pairs, mainnet, sepolia, chain.keeper ? { address: chain.keeper, balanceWei } : null, now, hold);
}
