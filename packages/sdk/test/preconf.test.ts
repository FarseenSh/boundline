import { describe, expect, it } from "vitest";
import { ZERO_BLOCK_HASH, isPreconfirmedReceipt, waitForPreconfirmation, type RpcReceiptLite } from "../src/preconf.js";

const hash = `0x${"ab".repeat(32)}` as const;
const pre: RpcReceiptLite = { transactionHash: hash, blockHash: ZERO_BLOCK_HASH, blockNumber: "0x0", status: "0x1" };
const real: RpcReceiptLite = { transactionHash: hash, blockHash: `0x${"11".repeat(32)}`, blockNumber: "0x2d8f4a1", status: "0x1" };

function requester(sequence: (RpcReceiptLite | null)[]) {
  let i = 0;
  const calls: number[] = [];
  return {
    calls,
    request: async (): Promise<unknown> => {
      calls.push(i);
      const v = sequence[Math.min(i, sequence.length - 1)];
      i += 1;
      return v ?? null;
    },
  };
}

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("waitForPreconfirmation", () => {
  it("returns at the first zero-hash receipt", async () => {
    const r = requester([null, null, pre, real]);
    const c = clock();
    const out = await waitForPreconfirmation(r, hash, { intervalMs: 200, ...c });
    expect(out.status).toBe("preconfirmed");
    expect(out.polls).toBe(3);
    expect(out.elapsedMs).toBe(400);
    expect(out.reverted).toBe(false);
  });
  it("keeps polling until a real block hash when asked", async () => {
    const r = requester([null, pre, pre, real]);
    const c = clock();
    const out = await waitForPreconfirmation(r, hash, { intervalMs: 200, untilConfirmed: true, ...c });
    expect(out.status).toBe("confirmed");
    expect(out.receipt?.blockHash).toBe(real.blockHash);
    expect(out.polls).toBe(4);
  });
  it("a receipt that is already in a block is confirmed at once", async () => {
    const out = await waitForPreconfirmation(requester([real]), hash, { intervalMs: 1, ...clock() });
    expect(out.status).toBe("confirmed");
    expect(out.polls).toBe(1);
  });
  it("times out without any receipt, and reports a preconfirmation it did see", async () => {
    const c = clock();
    const none = await waitForPreconfirmation(requester([null]), hash, { intervalMs: 500, timeoutMs: 2_000, ...c });
    expect(none.status).toBe("timeout");
    expect(none.receipt).toBeNull();
    const c2 = clock();
    const seen = await waitForPreconfirmation(requester([pre]), hash, { intervalMs: 500, timeoutMs: 1_000, untilConfirmed: true, ...c2 });
    expect(seen.status).toBe("preconfirmed");
  });
  it("flags a reverted receipt", async () => {
    const out = await waitForPreconfirmation(requester([{ ...real, status: "0x0" }]), hash, { intervalMs: 1, ...clock() });
    expect(out.reverted).toBe(true);
  });
  it("isPreconfirmedReceipt", () => {
    expect(isPreconfirmedReceipt(pre)).toBe(true);
    expect(isPreconfirmedReceipt({ ...pre, blockHash: null })).toBe(true);
    expect(isPreconfirmedReceipt(real)).toBe(false);
  });
});
