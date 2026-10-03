import { concatHex, encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from "viem";

/** The fields of an event row that enter its hash. */
export interface RootEvent {
  chainId: number;
  blockNumber: number;
  txHash: Hex;
  logIndex: number;
  address: Address;
  topic0: Hex;
  argsJson: string;
}

export const ZERO_ROOT: Hex = `0x${"00".repeat(32)}`;

/**
 * h = keccak256(abi.encode(uint256 chainId, bytes32 txHash, uint256 logIndex, address emitter, bytes32 topic0,
 *                          bytes32 keccak256(bytes(args_json))))
 * with args_json the canonical JSON stored in D1 (see canonical.ts).
 */
export function eventHash(e: RootEvent): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
      [BigInt(e.chainId), e.txHash, BigInt(e.logIndex), e.address, e.topic0, keccak256(stringToHex(e.argsJson))],
    ),
  );
}

export function sortForRoot<T extends { blockNumber: number; logIndex: number }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

/**
 * root = keccak256(prev_root ‖ h1 ‖ h2 ‖ … ‖ hn) over the events sorted by (block_number, log_index).
 * A day with no events has root = keccak256(prev_root), so the chain stays contiguous by calendar day.
 */
export function chainRoot(prevRoot: Hex, events: readonly RootEvent[]): Hex {
  const hashes = sortForRoot(events).map(eventHash);
  return keccak256(concatHex([prevRoot, ...hashes]));
}

/** YYYY-MM-DD of a unix timestamp in UTC. */
export function dayOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function dayStart(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
}

export function dayEnd(day: string): number {
  return dayStart(day) + 86_400;
}

export function nextDay(day: string): string {
  return dayOf(dayEnd(day));
}
