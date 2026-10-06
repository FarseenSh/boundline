import { encodeAbiParameters, encodeEventTopics, stringToHex, type Hex, type Log } from "viem";
import { describe, expect, it } from "vitest";
import { creditDeskAbi } from "../src/abi/creditDesk.js";
import { BASE_SEPOLIA } from "../src/config.js";
import { actionName, decodeDecisions } from "../src/decisions.js";

const desk = BASE_SEPOLIA.desk!;
const hash = `0x${"5e".repeat(32)}` as Hex;

function decisionLog(action: string, amount: bigint, price8: bigint): Log {
  const topics = encodeEventTopics({ abi: creditDeskAbi, eventName: "Decision", args: { lineId: 1n, action: stringToHex(action, { size: 32 }) } });
  return {
    address: desk,
    topics,
    data: encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }], [hash, amount, price8]),
    blockNumber: 1n,
    blockHash: `0x${"1".repeat(64)}`,
    transactionHash: `0x${"2".repeat(64)}`,
    transactionIndex: 0,
    logIndex: 3,
    removed: false,
  } as Log;
}

describe("decisions", () => {
  it("decodes Decision events from a receipt", () => {
    const other = { ...decisionLog("DRAW", 1n, 1n), address: "0x0000000000000000000000000000000000000001" } as Log;
    const out = decodeDecisions([decisionLog("DRAW", 5_000_000n, 33_267_000_000n), other], desk);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ lineId: 1n, action: "DRAW", decisionHash: hash, amount: 5_000_000n, price8: 33_267_000_000n, logIndex: 3 });
  });
  it("actionName strips the padding", () => {
    expect(actionName(stringToHex("ADD_COLLATERAL", { size: 32 }))).toBe("ADD_COLLATERAL");
  });
});
