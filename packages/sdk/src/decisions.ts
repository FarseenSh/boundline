// Decision hashes out of a receipt: every desk action emits Decision(lineId, action, decisionHash,
// amount, price8) plus its own event. The app shows the hash and links it to the indexer's record.
import { hexToString, parseEventLogs, type Address, type Hex, type Log } from "viem";
import { creditDeskAbi } from "./abi/creditDesk.js";

export interface DecisionRecord {
  lineId: bigint;
  /** "OPEN", "ADD_COLLATERAL", "DRAW", "REPAY", "WITHDRAW_COLLATERAL", "CLOSE", "HOLD", "RELEASE". */
  action: string;
  decisionHash: Hex;
  amount: bigint;
  price8: bigint;
  transactionHash: Hex | null;
  logIndex: number | null;
}

/** bytes32 action names are right-padded ASCII. */
export function actionName(action: Hex): string {
  return hexToString(action, { size: 32 }).replace(/\0+$/g, "");
}

export function decodeDecisions(logs: readonly Log[], desk?: Address): DecisionRecord[] {
  const mine = desk ? logs.filter((l) => l.address.toLowerCase() === desk.toLowerCase()) : [...logs];
  const parsed = parseEventLogs({ abi: creditDeskAbi, eventName: "Decision", logs: mine, strict: true });
  return parsed.map((p) => ({
    lineId: p.args.lineId,
    action: actionName(p.args.action),
    decisionHash: p.args.decisionHash,
    amount: p.args.amount,
    price8: p.args.price8,
    transactionHash: p.transactionHash ?? null,
    logIndex: p.logIndex ?? null,
  }));
}
