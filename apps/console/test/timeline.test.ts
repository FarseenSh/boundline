import { describe, expect, it } from "vitest";
import { buildLineTimeline, decisionDetail, explorerAddress, explorerTx, latestRun, outcomeTone, statusTone } from "../src/timeline.js";

describe("line timeline", () => {
  it("merges decisions and events in block then log order with readable labels", () => {
    const rows = buildLineTimeline({
      decisions: [
        { action: "DRAW", hash: "0x" + "d5".repeat(32), amount: "5000000", price8: "25512000000", blockNumber: 200, blockTime: 2000, txHash: "0x" + "a5".repeat(32), logIndex: 2 },
        { action: "OPEN", hash: "0x" + "d1".repeat(32), amount: "0", price8: "0", blockNumber: 100, blockTime: 1000, txHash: "0x" + "a1".repeat(32), logIndex: 3 },
        { action: "ADD_COLLATERAL", hash: "0x" + "d4".repeat(32), amount: "1000000000", price8: "0", blockNumber: 100, blockTime: 1000, txHash: "0x" + "a1".repeat(32), logIndex: 5 },
      ],
      timeline: [{ event: "LineOpened", hash: "0x" + "d1".repeat(32), blockNumber: 100, blockTime: 1000, txHash: "0x" + "a1".repeat(32), logIndex: 2, args: { lineId: "1", user: "0x" + "ab".repeat(20), decisionHash: "0x" + "d1".repeat(32), policyVersion: "2" } }],
    });
    expect(rows.map((r) => `${r.blockNumber}:${r.logIndex}:${r.label}`)).toEqual(["100:2:LineOpened", "100:3:Line opened", "100:5:Collateral added", "200:2:Drawn"]);
    expect(rows[0]?.kind).toBe("event");
    expect(rows[0]?.detail).toBe("user=0xabababab…ababab policyVersion=2");
    expect(rows[2]?.detail).toBe("10 sh");
    expect(rows[3]?.detail).toBe("$5.00 at $255.12");
  });
  it("prints decision details for USDC, shares and prices", () => {
    expect(decisionDetail({ action: "REPAY", hash: "", amount: "2100000", price8: "0", blockNumber: 0, blockTime: 0, txHash: "0x", logIndex: 0 })).toBe("$2.10");
    expect(decisionDetail({ action: "WITHDRAW_COLLATERAL", hash: "", amount: "12345678", price8: "33628499999", blockNumber: 0, blockTime: 0, txHash: "0x", logIndex: 0 })).toBe("0.1234 sh at $336.28");
    expect(decisionDetail({ action: "OPEN", hash: "", amount: "0", price8: "0", blockNumber: 0, blockTime: 0, txHash: "0x", logIndex: 0 })).toBe("");
  });
});

describe("explorer links, runs and tones", () => {
  it("links Sepolia and mainnet explorers by chain id", () => {
    expect(explorerTx(84532, "0xabc")).toBe("https://sepolia.basescan.org/tx/0xabc");
    expect(explorerTx(8453, "0xabc")).toBe("https://basescan.org/tx/0xabc");
    expect(explorerAddress(84532, "0xdef")).toBe("https://sepolia.basescan.org/address/0xdef");
  });
  it("finds the newest run", () => {
    expect(latestRun({ runs: [] })).toBeNull();
    const runs = [
      { ranAt: 10, chainId: 84532, txs: [], outcome: "a", evidence: "" },
      { ranAt: 30, chainId: 84532, txs: [], outcome: "b", evidence: "" },
      { ranAt: 20, chainId: 84532, txs: [], outcome: "c", evidence: "" },
    ];
    expect(latestRun({ runs })?.outcome).toBe("b");
  });
  it("reads outcomes and statuses into tones", () => {
    expect(outcomeTone("Executed: shadow LTV 60.12% → 58.00%")).toBe("live");
    expect(outcomeTone("Refused as designed; reopen captured")).toBe("live");
    expect(outcomeTone("Included after a 15-minute delay; seven re-arms not included")).toBe("warn");
    expect(outcomeTone("Reverted: MarketClosed")).toBe("bad");
    expect(outcomeTone("something else")).toBe("plain");
    expect(statusTone("OPEN")).toBe("live");
    expect(statusTone("HOLD_SESSION")).toBe("warn");
    expect(statusTone("prepared")).toBe("warn");
    expect(statusTone("applied")).toBe("live");
    expect(statusTone("FAIL")).toBe("bad");
    expect(statusTone("UNKNOWN")).toBe("plain");
  });
});
