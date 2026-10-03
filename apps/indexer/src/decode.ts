import { decodeEventLog, type Abi, type Address, type Hex } from "viem";
import { canonicalJson } from "./canonical.js";

/** One `eth_getLogs` entry as the RPC returns it (viem may give numbers for the quantities). */
export interface RawLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex | bigint | number;
  transactionHash: Hex;
  logIndex: Hex | bigint | number;
}

export interface EventRow {
  chainId: number;
  blockNumber: number;
  blockTime: number;
  txHash: Hex;
  logIndex: number;
  address: Address;
  topic0: Hex;
  name: string;
  argsJson: string;
}

export function quantity(value: Hex | bigint | number): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number.parseInt(value, 16);
}

/** Decodes a log with `abi`; a topic the ABI does not know is kept as `unknown:<topic0>` with its raw topics and data. */
export function decodeLog(abi: Abi, log: RawLog, chainId: number, blockTime: number): EventRow {
  const topic0 = (log.topics[0] ?? "0x").toLowerCase() as Hex;
  const base = {
    chainId,
    blockNumber: quantity(log.blockNumber),
    blockTime,
    txHash: log.transactionHash.toLowerCase() as Hex,
    logIndex: quantity(log.logIndex),
    address: log.address.toLowerCase() as Address,
    topic0,
  };
  try {
    const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: false });
    const name = decoded.eventName ?? `unknown:${topic0}`;
    return { ...base, name, argsJson: canonicalJson(decoded.args ?? {}) };
  } catch {
    return { ...base, name: `unknown:${topic0}`, argsJson: canonicalJson({ topics: log.topics, data: log.data }) };
  }
}
