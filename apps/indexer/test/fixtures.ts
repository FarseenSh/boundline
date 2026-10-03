import { encodeAbiParameters, encodeEventTopics, getAbiItem, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import type { EventRow, RawLog } from "../src/decode.js";

export const CHAIN = 84532;
export const MORPHO: Address = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
export const MARKET: Hex = "0x4a03b124a170a913931f00ab87f7966d388370cf457c0a3c4fb6fcf4fbb88047";
export const BORROWER: Address = "0xb789ad318945b37566e2549f65526cc269a482fc";
export const DEPLOYER: Address = "0x2f0d9b1f16cd702259c6cc259e8d5e5455282a4e";
export const FEED: Address = "0xa652b75ca90084fa16d4f18fd96b5dd7069ee52a";

export function txHash(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

/** Builds an `eth_getLogs` entry for `eventName` the way the EVM would emit it: indexed args in topics, the rest ABI-encoded in data. */
export function makeLog(opts: {
  abi: Abi;
  eventName: string;
  args: Record<string, unknown>;
  address: Address;
  blockNumber: number;
  logIndex: number;
  txHash?: Hex;
}): RawLog {
  const item = getAbiItem({ abi: opts.abi, name: opts.eventName }) as AbiEvent;
  const topics = encodeEventTopics({ abi: opts.abi, eventName: opts.eventName, args: opts.args } as never) as Hex[];
  const nonIndexed = item.inputs.filter((i) => !i.indexed);
  const data = nonIndexed.length === 0 ? "0x" : encodeAbiParameters(nonIndexed, nonIndexed.map((i) => opts.args[i.name as string]) as never);
  return {
    address: opts.address,
    topics,
    data,
    blockNumber: `0x${opts.blockNumber.toString(16)}`,
    transactionHash: opts.txHash ?? txHash(opts.blockNumber * 1000 + opts.logIndex),
    logIndex: `0x${opts.logIndex.toString(16)}`,
  };
}

export function row(overrides: Partial<EventRow> = {}): EventRow {
  return {
    chainId: CHAIN,
    blockNumber: 100,
    blockTime: 1_791_038_000,
    txHash: txHash(1),
    logIndex: 0,
    address: MORPHO,
    topic0: "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43",
    name: "Borrow",
    argsJson: JSON.stringify({ assets: "1000000", caller: BORROWER, id: MARKET, onBehalf: BORROWER, receiver: BORROWER, shares: "1000000000000" }),
    ...overrides,
  };
}
