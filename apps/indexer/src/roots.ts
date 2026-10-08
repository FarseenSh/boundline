import { keccak256, type Address, type Hex } from "viem";

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

// The hashes are computed on bytes, word by word, rather than through viem's `encodeAbiParameters` and hex strings:
// the scheme is unchanged (test/roots-lean.test.ts checks it against the abi.encode reference), the CPU is a fraction.

const utf8 = new TextEncoder();
const HEX_PAIRS = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function bytesToHex(b: Uint8Array): Hex {
  let out = "0x";
  for (let i = 0; i < b.length; i += 1) out += HEX_PAIRS[b[i]!];
  return out as Hex;
}

/** Writes `hex` (0x + exactly `bytes` bytes) right-aligned into `out` at word `slot`; throws on a size mismatch. */
function putHex(out: Uint8Array, slot: number, hex: string, bytes: number): void {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length !== bytes * 2) throw new Error(`expected ${bytes} bytes, got ${body.length / 2}: ${hex.slice(0, 20)}…`);
  const at = slot * 32 + (32 - bytes);
  for (let i = 0; i < bytes; i += 1) out[at + i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
}

function putUint(out: Uint8Array, slot: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`not a uint: ${value}`);
  let v = value;
  for (let i = 31; i >= 0 && v > 0; i -= 1) {
    out[slot * 32 + i] = v % 256;
    v = Math.floor(v / 256);
  }
}

function eventHashBytes(e: RootEvent): Uint8Array {
  const buf = new Uint8Array(192);
  putUint(buf, 0, e.chainId);
  putHex(buf, 1, e.txHash, 32);
  putUint(buf, 2, e.logIndex);
  putHex(buf, 3, e.address, 20);
  putHex(buf, 4, e.topic0, 32);
  buf.set(keccak256(utf8.encode(e.argsJson), "bytes"), 160);
  return keccak256(buf, "bytes");
}

/**
 * h = keccak256(abi.encode(uint256 chainId, bytes32 txHash, uint256 logIndex, address emitter, bytes32 topic0,
 *                          bytes32 keccak256(bytes(args_json))))
 * with args_json the canonical JSON stored in D1 (see canonical.ts).
 */
export function eventHash(e: RootEvent): Hex {
  return bytesToHex(eventHashBytes(e));
}

export function sortForRoot<T extends { blockNumber: number; logIndex: number }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

/**
 * root = keccak256(prev_root ‖ h1 ‖ h2 ‖ … ‖ hn) over the events sorted by (block_number, log_index).
 * A day with no events has root = keccak256(prev_root), so the chain stays contiguous by calendar day.
 */
export function chainRoot(prevRoot: Hex, events: readonly RootEvent[]): Hex {
  const sorted = sortForRoot(events);
  // prev_root enters as the bytes it holds (always 32 in production; concatHex took any length, so this does too)
  const prev = prevRoot.startsWith("0x") ? prevRoot.slice(2) : prevRoot;
  const head = prev.length / 2;
  const buf = new Uint8Array(head + 32 * sorted.length);
  for (let i = 0; i < head; i += 1) buf[i] = Number.parseInt(prev.slice(i * 2, i * 2 + 2), 16);
  for (let i = 0; i < sorted.length; i += 1) buf.set(eventHashBytes(sorted[i]!), head + 32 * i);
  return keccak256(buf);
}

/** The same root from stored event hashes, already in (block_number, log_index) order: keccak256(prev_root ‖ h1 ‖ … ‖ hn). */
export function rootFromHashes(prevRoot: Hex, hashes: readonly Hex[]): Hex {
  const prev = prevRoot.startsWith("0x") ? prevRoot.slice(2) : prevRoot;
  const head = prev.length / 2;
  const buf = new Uint8Array(head + 32 * hashes.length);
  for (let i = 0; i < head; i += 1) buf[i] = Number.parseInt(prev.slice(i * 2, i * 2 + 2), 16);
  hashes.forEach((h, i) => {
    const body = h.startsWith("0x") ? h.slice(2) : h;
    if (body.length !== 64) throw new Error(`event hash must be 32 bytes: ${h}`);
    for (let j = 0; j < 32; j += 1) buf[head + 32 * i + j] = Number.parseInt(body.slice(j * 2, j * 2 + 2), 16);
  });
  return keccak256(buf);
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
