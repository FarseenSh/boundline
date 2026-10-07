// Sends a prepared policy version's calls from the partner admin's wallet: one wallet_sendCalls batch when the
// wallet supports EIP-5792, one transaction after another when it does not. Returns the hashes so the page can
// tell the API the version was applied.
import { useCallback, useState } from "react";
import type { Hex } from "viem";
import { useConfig, usePublicClient, useSendCalls, useSendTransaction } from "wagmi";
import { getCallsStatus } from "wagmi/actions";
import type { PreparedCall } from "./types.js";
import { consoleChain } from "./wagmi.js";

export type ApplyStage =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "sent"; mode: "batch" | "sequential"; hashes: Hex[]; total: number; batchId?: string }
  | { kind: "confirmed"; hashes: Hex[] }
  | { kind: "failed"; error: string };

function describeError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { shortMessage?: string; message?: string };
    return (e.shortMessage ?? e.message ?? String(err)).split("\n")[0] ?? String(err);
  }
  return String(err);
}

/** Wallets without EIP-5792 answer with a method-not-found or unsupported error; everything else is a real failure. */
export function isUnsupportedBatch(err: unknown): boolean {
  const text = `${(err as { name?: string })?.name ?? ""} ${describeError(err)} ${(err as { details?: string })?.details ?? ""}`;
  return /not support|unsupported|method not found|does not exist|is not available|4200|-32601|atomic/i.test(text);
}

export function useApplyFlow() {
  const sendCalls = useSendCalls();
  const sendTx = useSendTransaction();
  const client = usePublicClient({ chainId: consoleChain.id });
  const config = useConfig();
  const [stage, setStage] = useState<ApplyStage>({ kind: "idle" });

  const run = useCallback(
    async (calls: PreparedCall[]): Promise<Hex[] | null> => {
      if (calls.length === 0) return null;
      setStage({ kind: "signing" });
      const prepared = calls.map((c) => ({ to: c.to as Hex, data: c.data as Hex, value: 0n }));
      try {
        const res = await sendCalls.mutateAsync({ calls: prepared, chainId: consoleChain.id, forceAtomic: true });
        setStage({ kind: "sent", mode: "batch", hashes: [], total: calls.length, batchId: res.id });
        // Poll the batch until the wallet reports receipts (wallet_getCallsStatus), up to three minutes.
        const deadline = Date.now() + 180_000;
        for (;;) {
          const status = await getCallsStatus(config, { id: res.id });
          if (status.status === "success") {
            const hashes = (status.receipts ?? []).map((r: { transactionHash: Hex }) => r.transactionHash);
            setStage({ kind: "confirmed", hashes });
            return hashes;
          }
          if (status.status === "failure") throw new Error("the wallet reported the batch as failed");
          if (Date.now() > deadline) throw new Error("the batch was not confirmed in three minutes");
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (err) {
        if (!isUnsupportedBatch(err)) {
          setStage({ kind: "failed", error: describeError(err) });
          return null;
        }
      }
      const hashes: Hex[] = [];
      try {
        for (const c of prepared) {
          const hash = await sendTx.mutateAsync({ to: c.to, data: c.data, value: 0n, chainId: consoleChain.id });
          hashes.push(hash);
          setStage({ kind: "sent", mode: "sequential", hashes: [...hashes], total: calls.length });
          if (!client) throw new Error("no public client for the console's chain");
          const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
          if (receipt.status !== "success") throw new Error(`transaction ${hash.slice(0, 10)}… reverted`);
        }
        setStage({ kind: "confirmed", hashes });
        return hashes;
      } catch (err) {
        setStage({ kind: "failed", error: describeError(err) });
        return null;
      }
    },
    [sendCalls, sendTx, client, config],
  );

  const reset = useCallback(() => setStage({ kind: "idle" }), []);
  const busy = stage.kind === "signing" || stage.kind === "sent";
  return { stage, run, reset, busy };
}
