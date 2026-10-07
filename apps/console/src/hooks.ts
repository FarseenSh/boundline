// Data hooks over the proxy. React Query keeps the reads fresh; the pasted key re-runs everything on change.
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { apiGet } from "./api.js";
import { ENV } from "./env.js";
import { getPastedKey, subscribeKey } from "./keystore.js";
import { mockSessions } from "./mock.js";
import type { ConsoleConfig, DecisionsResponse, Drill, EvidenceBundle, LineResponse, ObligationsResponse, ObservatorySessions, PolicyResponse, PolicyVersion, ReconciliationResponse, SourcesResponse } from "./types.js";

export function usePastedKey(): string | null {
  return useSyncExternalStore(subscribeKey, getPastedKey, () => null);
}

/** Every query key starts with the key's presence so a paste or a sign-out refetches as the other partner. */
function scope(): string {
  return getPastedKey() ? "pasted" : "console";
}

export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useConsoleConfig(): UseQueryResult<ConsoleConfig> {
  const key = usePastedKey();
  return useQuery({ queryKey: ["config", key ? "pasted" : "console"], queryFn: async () => (await apiGet<ConsoleConfig>("/config")).data, staleTime: 60_000 });
}

export function useSessions(): UseQueryResult<ObservatorySessions> {
  return useQuery({
    queryKey: ["observatory-sessions"],
    queryFn: async () => {
      if (ENV.mock) return mockSessions;
      // Through the console's own proxy: the Observatory's workers.dev origin sends no CORS headers.
      const res = await fetch(`${ENV.apiBase}/observatory/v1/sessions`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Observatory answered ${res.status}`);
      return (await res.json()) as ObservatorySessions;
    },
    refetchInterval: 60_000,
    retry: 1,
  });
}

export function useObligations(): UseQueryResult<ObligationsResponse> {
  const key = usePastedKey();
  return useQuery({ queryKey: ["obligations", key ? "pasted" : "console"], queryFn: async () => (await apiGet<ObligationsResponse>("/v1/obligations?limit=100")).data, refetchInterval: 30_000 });
}

export function useLine(lineId: string | undefined): UseQueryResult<LineResponse> {
  const key = usePastedKey();
  return useQuery({ queryKey: ["line", key ? "pasted" : "console", lineId], enabled: Boolean(lineId), queryFn: async () => (await apiGet<LineResponse>(`/v1/lines/${lineId}`)).data, refetchInterval: 30_000 });
}

export function useDecisions(lineId: string | undefined): UseQueryResult<DecisionsResponse> {
  const key = usePastedKey();
  return useQuery({ queryKey: ["decisions", key ? "pasted" : "console", lineId], enabled: Boolean(lineId), queryFn: async () => (await apiGet<DecisionsResponse>(`/v1/lines/${lineId}/decisions`)).data, refetchInterval: 30_000 });
}

export function usePolicy(): UseQueryResult<PolicyResponse> {
  const key = usePastedKey();
  return useQuery({ queryKey: ["policy", key ? "pasted" : "console"], queryFn: async () => (await apiGet<PolicyResponse>("/v1/policy")).data, staleTime: 15_000, retry: (n, err) => n < 1 && !(err as { notLive?: boolean }).notLive });
}

export function usePolicyVersions(): UseQueryResult<PolicyVersion[]> {
  const key = usePastedKey();
  return useQuery({
    queryKey: ["policy-versions", key ? "pasted" : "console"],
    queryFn: async () => (await apiGet<{ versions: PolicyVersion[] }>("/v1/policy/versions")).data.versions ?? [],
    staleTime: 10_000,
    retry: (n, err) => n < 1 && !(err as { notLive?: boolean }).notLive,
  });
}

export function useDrills(): UseQueryResult<Drill[]> {
  const key = usePastedKey();
  return useQuery({
    queryKey: ["drills", key ? "pasted" : "console"],
    queryFn: async () => {
      const r = (await apiGet<Drill[] | { drills: Drill[] }>("/v1/drills")).data;
      return Array.isArray(r) ? r : (r.drills ?? []);
    },
    staleTime: 60_000,
    retry: (n, err) => n < 1 && !(err as { notLive?: boolean }).notLive,
  });
}

export function useReconciliation(): UseQueryResult<ReconciliationResponse> {
  const key = usePastedKey();
  return useQuery({ queryKey: ["reconciliation", key ? "pasted" : "console"], queryFn: async () => (await apiGet<ReconciliationResponse>("/v1/reconciliation")).data, refetchInterval: 60_000, retry: (n, err) => n < 1 && !(err as { notLive?: boolean }).notLive });
}

export function useSources(): UseQueryResult<SourcesResponse> {
  return useQuery({ queryKey: ["sources"], queryFn: async () => (await apiGet<SourcesResponse>("/indexer/v1/sources")).data, refetchInterval: 60_000 });
}

export function useEvidence(enabled: boolean): UseQueryResult<EvidenceBundle> {
  const key = usePastedKey();
  return useQuery({ queryKey: ["evidence", key ? "pasted" : "console"], enabled, queryFn: async () => (await apiGet<EvidenceBundle>("/v1/evidence/export")).data, staleTime: 30_000, retry: (n, err) => n < 1 && !(err as { notLive?: boolean }).notLive });
}

/** Call after the key changes so nothing from the other partner lingers. */
export function useForgetAll(): () => void {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries();
}

export { scope };
