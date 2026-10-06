// One place that sends a batch: wallet_sendCalls with the paymaster and the Builder Code when the wallet
// supports it, one transaction after another when it does not. Either way the page sees the same steps:
// sent → preconfirmed (Flashblocks, ~200 ms) → confirmed, and the decision hashes from the receipts.
import { appendDataSuffix, builderCodeSuffix, decodeDecisions, explorer, shortHash, type Call, type DecisionRecord } from "@boundline/sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Hex, Log } from "viem";
import { useCallsStatus, useSendCalls, useSendTransaction } from "wagmi";
import { boundline, cfg } from "./boundline.js";
import type { Step } from "./components/TxTimeline.jsx";
import { ENV } from "./env.js";

export type FlowStage =
  | { kind: "idle" }
  | { kind: "signing"; label: string }
  | { kind: "sent"; label: string; mode: "batch" | "sequential"; hashes: Hex[]; total: number }
  | { kind: "preconfirmed"; label: string; hashes: Hex[]; elapsedMs: number; total: number }
  | { kind: "confirmed"; label: string; hashes: Hex[]; decisions: DecisionRecord[] }
  | { kind: "failed"; label: string; error: string };

function describeError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { shortMessage?: string; message?: string; details?: string };
    return (e.shortMessage ?? e.message ?? String(err)).split("\n")[0] ?? String(err);
  }
  return String(err);
}

/** Wallets without EIP-5792 answer with a method-not-found or unsupported error; everything else is a real failure. */
export function isUnsupportedBatch(err: unknown): boolean {
  const text = `${(err as { name?: string })?.name ?? ""} ${describeError(err)} ${(err as { details?: string })?.details ?? ""}`;
  return /not support|unsupported|method not found|does not exist|is not available|4200|-32601|atomic/i.test(text);
}

export function useSendFlow() {
  const sendCalls = useSendCalls();
  const sendTx = useSendTransaction();
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<FlowStage>({ kind: "idle" });
  const [callsId, setCallsId] = useState<string | undefined>(undefined);
  const [pendingLabel, setPendingLabel] = useState("");

  const status = useCallsStatus({
    id: callsId ?? "",
    query: {
      enabled: Boolean(callsId),
      refetchInterval: (q) => (q.state.data?.status === "success" || q.state.data?.status === "failure" ? false : 800),
    },
  });

  useEffect(() => {
    const data = status.data;
    if (!callsId || !data) return;
    if (data.status === "success") {
      const receipts = data.receipts ?? [];
      const hashes = receipts.map((r) => r.transactionHash);
      const logs = receipts.flatMap((r) => r.logs as unknown as Log[]);
      const decisions = cfg.desk ? decodeDecisions(logs, cfg.desk) : [];
      setStage({ kind: "confirmed", label: pendingLabel, hashes, decisions });
      setCallsId(undefined);
      void queryClient.invalidateQueries();
    } else if (data.status === "failure") {
      setStage({ kind: "failed", label: pendingLabel, error: "The wallet reported the batch as failed." });
      setCallsId(undefined);
    }
  }, [status.data, callsId, pendingLabel, queryClient]);

  const run = useCallback(
    async (calls: Call[], label: string): Promise<void> => {
      setPendingLabel(label);
      setStage({ kind: "signing", label });
      const prepared = boundline.buildSendCalls(calls, {
        ...(ENV.paymasterUrl ? { paymasterUrl: ENV.paymasterUrl } : {}),
        ...(ENV.builderCode ? { builderCode: ENV.builderCode } : {}),
      });
      try {
        const res = await sendCalls.mutateAsync({
          calls: prepared.calls,
          chainId: cfg.chainId,
          forceAtomic: prepared.forceAtomic,
          ...(prepared.capabilities ? { capabilities: prepared.capabilities } : {}),
        });
        setCallsId(res.id);
        setStage({ kind: "sent", label, mode: "batch", hashes: [], total: calls.length });
        return;
      } catch (err) {
        if (!isUnsupportedBatch(err)) {
          setStage({ kind: "failed", label, error: describeError(err) });
          return;
        }
      }
      // Sequential fallback for wallets without wallet_sendCalls: each call waits for its block before the next.
      const suffix = ENV.builderCode ? builderCodeSuffix(ENV.builderCode) : null;
      const hashes: Hex[] = [];
      try {
        for (const c of calls) {
          const hash = await sendTx.mutateAsync({ to: c.to, data: suffix ? appendDataSuffix(c.data, suffix) : c.data, value: c.value, chainId: cfg.chainId });
          hashes.push(hash);
          setStage({ kind: "sent", label, mode: "sequential", hashes: [...hashes], total: calls.length });
          const pre = await boundline.waitForPreconfirmation(hash, { intervalMs: 200, timeoutMs: 120_000 });
          if (pre.status === "preconfirmed") setStage({ kind: "preconfirmed", label, hashes: [...hashes], elapsedMs: pre.elapsedMs, total: calls.length });
          const done = pre.status === "confirmed" ? pre : await boundline.waitForPreconfirmation(hash, { intervalMs: 500, timeoutMs: 180_000, untilConfirmed: true });
          if (done.status !== "confirmed") throw new Error(`transaction ${shortHash(hash)} was not confirmed in time`);
          if (done.reverted) throw new Error(`transaction ${shortHash(hash)} reverted`);
        }
        const receipts = await Promise.all(hashes.map((h) => boundline.client.getTransactionReceipt({ hash: h })));
        const decisions = cfg.desk ? decodeDecisions(receipts.flatMap((r) => r.logs), cfg.desk) : [];
        setStage({ kind: "confirmed", label, hashes, decisions });
        void queryClient.invalidateQueries();
      } catch (err) {
        setStage({ kind: "failed", label, error: describeError(err) });
      }
    },
    [sendCalls, sendTx, queryClient],
  );

  const steps = useMemo((): Step[] => stepsFor(stage), [stage]);
  const busy = stage.kind === "signing" || stage.kind === "sent" || stage.kind === "preconfirmed";
  const error = stage.kind === "failed" ? stage.error : null;
  const reset = useCallback(() => setStage({ kind: "idle" }), []);
  return { stage, steps, busy, error, run, reset };
}

function txLinks(hashes: Hex[]) {
  return hashes.map((h, i) => (
    <a key={h} href={explorer.tx(cfg, h)} style={{ marginRight: 8 }}>
      {i > 0 ? " " : ""}
      {shortHash(h)}
    </a>
  ));
}

export function stepsFor(stage: FlowStage): Step[] {
  if (stage.kind === "idle") return [];
  const signing: Step = { label: `${stage.label}: approve in your wallet`, state: stage.kind === "signing" ? "active" : stage.kind === "failed" && !("hashes" in stage) ? "failed" : "done" };
  if (stage.kind === "signing") return [signing];
  if (stage.kind === "failed") return [signing, { label: "Failed", state: "failed", detail: stage.error }];
  const sent: Step = {
    label: stage.kind === "sent" && stage.mode === "batch" ? "Sent as one batch (wallet_sendCalls)" : `Sent ${stage.hashes.length} of ${"total" in stage ? stage.total : stage.hashes.length}`,
    state: stage.kind === "sent" ? "active" : "done",
    detail: stage.hashes.length ? txLinks(stage.hashes) : "waiting for the wallet's batch id",
  };
  const pre: Step = {
    label: "Preconfirmed by Flashblocks",
    state: stage.kind === "preconfirmed" ? "active" : stage.kind === "confirmed" ? "done" : "idle",
    detail: stage.kind === "preconfirmed" ? `after ${stage.elapsedMs} ms` : stage.kind === "confirmed" ? undefined : "polling the receipt every 200 ms",
  };
  const confirmed: Step = {
    label: "Confirmed in a block",
    state: stage.kind === "confirmed" ? "done" : "idle",
    detail:
      stage.kind === "confirmed" && stage.decisions.length ? `decision ${stage.decisions.map((d) => `${d.action} ${shortHash(d.decisionHash)}`).join(", ")}` : undefined,
  };
  return [signing, sent, pre, confirmed];
}
