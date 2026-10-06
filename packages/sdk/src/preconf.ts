// Flashblocks preconfirmations: sepolia.base.org answers eth_getTransactionReceipt for a preconfirmed
// transaction with an all-zero blockHash about 200 ms after submission, long before the block lands.
// Poll fast, show "preconfirmed" at the first zero-hash receipt, "confirmed" at the first real one.
import type { Hex } from "viem";

export const ZERO_BLOCK_HASH: Hex = `0x${"0".repeat(64)}`;

export interface RpcReceiptLite {
  transactionHash: Hex;
  blockHash: Hex | null;
  blockNumber: Hex | null;
  status: Hex | null;
  gasUsed?: Hex;
  logs?: unknown[];
}

export interface ReceiptRequester {
  request(args: { method: "eth_getTransactionReceipt"; params: [Hex] }): Promise<unknown>;
}

export type PreconfStatus = "preconfirmed" | "confirmed" | "timeout";

export interface PreconfResult {
  status: PreconfStatus;
  receipt: RpcReceiptLite | null;
  /** Milliseconds from the first poll to the status returned. */
  elapsedMs: number;
  polls: number;
  /** When the transaction reverted (status 0x0) in the receipt returned. */
  reverted: boolean;
}

export interface PreconfOptions {
  intervalMs?: number;
  /** Give up waiting for any receipt after this long. */
  timeoutMs?: number;
  /** Keep polling past the preconfirmation until a real block hash arrives (default false: return at the first receipt). */
  untilConfirmed?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function isPreconfirmedReceipt(r: RpcReceiptLite): boolean {
  return r.blockHash === null || r.blockHash === undefined || r.blockHash.toLowerCase() === ZERO_BLOCK_HASH;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForPreconfirmation(client: ReceiptRequester, hash: Hex, opts: PreconfOptions = {}): Promise<PreconfResult> {
  const interval = opts.intervalMs ?? 200;
  const timeout = opts.timeoutMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());
  const started = now();
  let polls = 0;
  let preconfirmed: RpcReceiptLite | null = null;
  for (;;) {
    polls += 1;
    const r = (await client.request({ method: "eth_getTransactionReceipt", params: [hash] })) as RpcReceiptLite | null;
    if (r) {
      const reverted = r.status !== null && r.status !== undefined && BigInt(r.status) === 0n;
      if (!isPreconfirmedReceipt(r)) return { status: "confirmed", receipt: r, elapsedMs: now() - started, polls, reverted };
      preconfirmed = r;
      if (!opts.untilConfirmed) return { status: "preconfirmed", receipt: r, elapsedMs: now() - started, polls, reverted };
    }
    if (now() - started >= timeout) {
      return preconfirmed
        ? { status: "preconfirmed", receipt: preconfirmed, elapsedMs: now() - started, polls, reverted: false }
        : { status: "timeout", receipt: null, elapsedMs: now() - started, polls, reverted: false };
    }
    await sleep(interval);
  }
}
