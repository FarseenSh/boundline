// Data hooks over the SDK and the proxy. React Query keeps the reads fresh; the clock ticks on its own.
import { actionName, sessionInfo, type ApiEnvelope, type Health, type Line, type PayoutQuote, type PayoutRecord, type Quote, type RouteRequestBody, type RouteResponse, type SessionInfo, type VaultAdvance, type VaultFunding, type VaultTerms } from "@boundline/sdk";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { boundline, cfg, primaryMarket, primaryStock } from "./boundline.js";
import { ENV } from "./env.js";

export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useSessionInfo(): SessionInfo {
  const now = useNow();
  return sessionInfo(now);
}

export function useLineId(address: Address | undefined): UseQueryResult<bigint> {
  return useQuery({
    queryKey: ["lineOf", cfg.chainId, address, primaryMarket?.id],
    enabled: Boolean(address && primaryMarket),
    queryFn: () => boundline.reader.lineOf(address!, primaryMarket!.id),
    staleTime: 10_000,
  });
}

export interface LineView {
  line: Line;
  quote: Quote;
  health: Health;
  lltvWad: bigint;
}

export function useLineHealth(lineId: bigint | undefined): UseQueryResult<LineView> {
  return useQuery({
    queryKey: ["lineHealth", cfg.chainId, lineId?.toString()],
    enabled: Boolean(lineId && lineId > 0n),
    queryFn: () => boundline.lineHealth(lineId!),
    refetchInterval: 20_000,
  });
}

export interface Balances {
  stocks: { symbol: string; token: Address; raw: bigint }[];
  usdc: bigint;
}

export function useBalances(address: Address | undefined): UseQueryResult<Balances> {
  return useQuery({
    queryKey: ["balances", cfg.chainId, address],
    enabled: Boolean(address),
    queryFn: async (): Promise<Balances> => {
      const [stocks, usdc] = await Promise.all([
        Promise.all(cfg.stocks.map(async (s) => ({ symbol: s.symbol, token: s.token, raw: await boundline.reader.balanceOf(s.token, address!) }))),
        boundline.reader.balanceOf(cfg.usdc, address!),
      ]);
      return { stocks, usdc };
    },
    refetchInterval: 30_000,
  });
}

export function useAuthorized(address: Address | undefined, target?: Address): UseQueryResult<boolean> {
  return useQuery({
    queryKey: ["authorized", cfg.chainId, address, target ?? cfg.desk],
    enabled: Boolean(address),
    queryFn: () => boundline.reader.isAuthorized(address!, target),
    staleTime: 10_000,
  });
}

export function useAllowance(address: Address | undefined, token: Address | undefined, spender?: Address): UseQueryResult<bigint> {
  return useQuery({
    queryKey: ["allowance", cfg.chainId, address, token, spender ?? cfg.desk],
    enabled: Boolean(address && token),
    queryFn: () => boundline.reader.allowance(token!, address!, spender),
    staleTime: 10_000,
  });
}

export function useGate(token: Address | undefined) {
  return useQuery({
    queryKey: ["gate", cfg.chainId, token],
    enabled: Boolean(token && cfg.gate),
    queryFn: () => boundline.reader.gateCheck(token!),
    refetchInterval: 30_000,
  });
}

export function useMarketLiquidity(marketId: Hex | undefined) {
  return useQuery({
    queryKey: ["morphoMarket", cfg.chainId, marketId],
    enabled: Boolean(marketId),
    queryFn: async () => {
      const m = await boundline.reader.morphoMarket(marketId!);
      return { ...m, available: m.totalSupplyAssets > m.totalBorrowAssets ? m.totalSupplyAssets - m.totalBorrowAssets : 0n };
    },
    refetchInterval: 30_000,
  });
}

/** A partner-grade quote through the proxy: reason codes, capacity and the quote hash the API signs its answer with. */
export function useApiQuote(lineId: bigint | undefined, draw: bigint | null) {
  return useQuery({
    queryKey: ["apiQuote", cfg.chainId, lineId?.toString(), draw?.toString()],
    enabled: Boolean(lineId && lineId > 0n && draw !== null && boundline.api),
    queryFn: () => boundline.api!.quote({ lineId: lineId!, draw: draw! }),
    staleTime: 15_000,
    retry: false,
  });
}

/** The local-money leg's quote for `amountIn` USDC, from the pool's own state; off while USDC is chosen. */
export function usePayoutQuote(symbol: string | null, amountIn: bigint | null): UseQueryResult<PayoutQuote> {
  return useQuery({
    queryKey: ["payoutQuote", cfg.chainId, symbol, amountIn?.toString()],
    enabled: Boolean(symbol && cfg.payout.router && amountIn !== null && amountIn > 0n),
    queryFn: () => boundline.quotePayout(symbol!, amountIn!),
    refetchInterval: 20_000,
  });
}

/** The router's own record of the user's payouts (oldest first); no indexer involved. */
export function usePayouts(address: Address | undefined): UseQueryResult<PayoutRecord[]> {
  return useQuery({
    queryKey: ["payouts", cfg.chainId, address],
    enabled: Boolean(address && cfg.payout.router),
    queryFn: () => boundline.payouts(address!),
    refetchInterval: 30_000,
  });
}

export interface DecisionRow {
  action: string;
  amount: bigint;
  price8: bigint;
  decisionHash: Hex;
  txHash: Hex;
  blockNumber: number;
  blockTime: number;
  logIndex: number;
}

interface IndexedEvent {
  blockNumber: number;
  blockTime: number;
  txHash: Hex;
  logIndex: number;
  address: string;
  name: string;
  args: Record<string, string>;
}

/** Decision events for one line from the indexer (newest first). */
export function useDecisions(lineId: bigint | undefined): UseQueryResult<DecisionRow[]> {
  return useQuery({
    queryKey: ["decisions", cfg.chainId, lineId?.toString()],
    enabled: Boolean(lineId && lineId > 0n && cfg.desk),
    queryFn: async (): Promise<DecisionRow[]> => {
      const url = `${ENV.apiBase}/indexer/v1/events?name=Decision&address=${cfg.desk}&limit=200`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`indexer answered ${res.status}`);
      const data = (await res.json()) as { events: IndexedEvent[] };
      return data.events
        .filter((e) => e.args.lineId === lineId!.toString())
        .map((e) => ({
          action: actionName(e.args.action as Hex),
          amount: BigInt(e.args.amount ?? "0"),
          price8: BigInt(e.args.price8 ?? "0"),
          decisionHash: e.args.decisionHash as Hex,
          txHash: e.txHash,
          blockNumber: e.blockNumber,
          blockTime: e.blockTime,
          logIndex: e.logIndex,
        }));
    },
    refetchInterval: 30_000,
  });
}

export interface RootRow {
  day: string;
  eventCount: number;
  root: string;
  prevRoot: string;
}

export function useRoots() {
  return useQuery({
    queryKey: ["roots", cfg.chainId],
    queryFn: async () => {
      const res = await fetch(`${ENV.apiBase}/indexer/v1/roots`);
      if (!res.ok) throw new Error(`indexer answered ${res.status}`);
      return (await res.json()) as { roots: RootRow[]; today: { day: string; eventCount: number; rootSoFar: string } };
    },
    staleTime: 60_000,
  });
}

/** One of the user's lines under this partner: the desk allows one open line per market, so at most one per row of cfg.markets. */
export interface UserLine {
  lineId: bigint;
  marketId: Hex;
  symbol: string;
  collateral: Address;
}

export function useUserLines(address: Address | undefined): UseQueryResult<UserLine[]> {
  return useQuery({
    queryKey: ["userLines", cfg.chainId, address],
    enabled: Boolean(address && cfg.desk),
    queryFn: async (): Promise<UserLine[]> => {
      const ids = await Promise.all(cfg.markets.map(async (m) => ({ m, id: await boundline.reader.lineOf(address!, m.id) })));
      return ids.filter((x) => x.id > 0n).map(({ m, id }) => ({ lineId: id, marketId: m.id, symbol: m.symbol, collateral: m.collateral }));
    },
    staleTime: 30_000,
  });
}

export function useVaultTerms(): UseQueryResult<VaultTerms> {
  return useQuery({
    queryKey: ["vaultTerms", cfg.chainId],
    enabled: boundline.vault !== null,
    queryFn: () => boundline.vault!.terms(),
    staleTime: 60_000,
  });
}

export function useVaultBalance(address: Address | undefined): UseQueryResult<bigint> {
  return useQuery({
    queryKey: ["vaultBalance", cfg.chainId, address],
    enabled: Boolean(address && boundline.vault),
    queryFn: () => boundline.vault!.userBalance(address!),
    refetchInterval: 30_000,
  });
}

export interface VaultLineView {
  line: UserLine;
  advance: VaultAdvance;
  /** The line's debt on Morpho with interest, as the vault reads it. */
  debt: bigint;
  /** How a protective repay of the whole debt would be funded right now; null when there is no debt. */
  preview: VaultFunding | null;
}

/** Per line: the advance account, the debt, and the vault's own funding preview for repaying all of it now. */
export function useVaultLines(lines: UserLine[] | undefined): UseQueryResult<VaultLineView[]> {
  return useQuery({
    queryKey: ["vaultLines", cfg.chainId, lines?.map((l) => l.lineId.toString()).join(",")],
    enabled: Boolean(boundline.vault && lines && lines.length > 0),
    queryFn: () =>
      Promise.all(
        lines!.map(async (line): Promise<VaultLineView> => {
          const [advance, debt] = await Promise.all([boundline.vault!.advanceOf(line.lineId), boundline.vault!.debtOf(line.lineId)]);
          const preview = debt > 0n ? await boundline.vault!.previewProtect(line.lineId, debt) : null;
          return { line, advance, debt, preview };
        }),
      ),
    refetchInterval: 30_000,
  });
}

/** The credit router's plan through the proxy; null body = no request (nothing to route). */
export function useRoute(body: RouteRequestBody | null): UseQueryResult<ApiEnvelope<RouteResponse>> {
  return useQuery({
    queryKey: ["route", cfg.chainId, body ? JSON.stringify(body) : null],
    enabled: Boolean(body && boundline.api),
    queryFn: () => boundline.api!.route(body!),
    staleTime: 30_000,
    retry: false,
  });
}

export interface VaultEventRow {
  name: string;
  lineId: string;
  txHash: Hex;
  blockNumber: number;
  blockTime: number;
  logIndex: number;
  args: Record<string, string>;
}

/** The protection vault's events for the user's lines from the indexer, newest first; `indexed` says whether any source covers the vault. */
export function useVaultEvents(lineIds: readonly bigint[] | undefined): UseQueryResult<{ indexed: boolean; rows: VaultEventRow[] }> {
  const vault = cfg.deskProtectionVault;
  return useQuery({
    queryKey: ["vaultEvents", cfg.chainId, vault, lineIds?.map(String).join(",")],
    enabled: Boolean(vault && lineIds && lineIds.length > 0),
    queryFn: async () => {
      const [eventsRes, sourcesRes] = await Promise.all([
        fetch(`${ENV.apiBase}/indexer/v1/events?chainId=${cfg.chainId}&address=${vault}&limit=200`),
        fetch(`${ENV.apiBase}/indexer/v1/sources`),
      ]);
      if (!eventsRes.ok) throw new Error(`indexer answered ${eventsRes.status}`);
      const events = ((await eventsRes.json()) as { events?: IndexedEvent[] }).events ?? [];
      const sources = sourcesRes.ok ? (((await sourcesRes.json()) as { sources?: { addressList?: string[] }[] }).sources ?? []) : [];
      const indexed = sources.some((s) => (s.addressList ?? []).some((a) => a.toLowerCase() === vault!.toLowerCase()));
      const wanted = new Set(lineIds!.map(String));
      const rows = events
        .filter((e) => e.name !== "Decision" && wanted.has(String(e.args.lineId ?? "")))
        .map((e) => ({ name: e.name, lineId: String(e.args.lineId), txHash: e.txHash, blockNumber: e.blockNumber, blockTime: e.blockTime, logIndex: e.logIndex, args: e.args }));
      return { indexed, rows };
    },
    refetchInterval: 60_000,
  });
}

export { primaryMarket, primaryStock };
