import { decodeEventLog, type Abi, type AbiEvent, type AbiParameter, type Address, type Hex } from "viem";
import { canonicalJson } from "./canonical.js";
import { topic0Of } from "./topics.js";

// Event decoding without viem on the hot path. On a cold Workers isolate every function compiled while a tick runs is
// paid out of the Free plan's 10 ms of CPU, and viem's `decodeEventLog` re-hashes every event signature of the ABI for
// each log. Here each ABI is compiled once (module scope, see sources.ts) into a topic0 → spec map, and a log is decoded
// by slicing its hex. The values match viem's exactly (the differential test in test/decode-lean.test.ts holds it to
// that; topic0s come precomputed from src/topics.ts): addresses lowercased, uint/int up to 48 bits as numbers and wider as bigints (two's complement over 256 bits),
// bytesN as the first N bytes, strings as plain UTF-8, a data section that does not decode leaves only the indexed
// arguments, and a missing indexed topic is decoded from the front of the data (viem 2.57 with `strict: false`).

/** One `eth_getLogs` entry as the RPC returns it (viem may give numbers for the quantities). */
export interface RawLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex | bigint | number;
  transactionHash: Hex;
  logIndex: Hex | bigint | number;
  /** Returned by every Base RPC we use (8 Oct 2026); saves a block-header read per log when present. */
  blockTimestamp?: Hex | bigint | number;
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

type Kind =
  | { k: "address" }
  | { k: "bool" }
  | { k: "uint"; bits: number }
  | { k: "int"; bits: number }
  | { k: "fixedBytes"; size: number }
  | { k: "string" }
  | { k: "bytes" }
  | { k: "array"; of: Kind }
  | { k: "tuple"; fields: { name: string; kind: Kind }[]; words: number };

interface InputSpec {
  name: string;
  indexed: boolean;
  kind: Kind;
}

export interface EventSpec {
  name: string;
  topic0: Hex;
  inputs: InputSpec[];
  /** False when an input type is outside what the lean decoder handles; such logs go through viem. */
  lean: boolean;
  abiItem: AbiEvent;
}

class Unsupported extends Error {}

function isStatic(k: Kind): boolean {
  return k.k !== "string" && k.k !== "bytes" && k.k !== "array";
}

function kindOf(p: AbiParameter): Kind {
  const t = p.type;
  if (t === "address") return { k: "address" };
  if (t === "bool") return { k: "bool" };
  if (t === "string") return { k: "string" };
  if (t === "bytes") return { k: "bytes" };
  if (t === "tuple") {
    const comps = ("components" in p ? p.components : undefined) ?? [];
    const fields = comps.map((c, i) => ({ name: c.name ?? String(i), kind: kindOf(c) }));
    if (!fields.every((f) => isStatic(f.kind)) || comps.some((c) => !c.name)) throw new Unsupported(t);
    const words = fields.reduce((n, f) => n + (f.kind.k === "tuple" ? f.kind.words : 1), 0);
    return { k: "tuple", fields, words };
  }
  const arr = /^(.+)\[\]$/.exec(t);
  if (arr) {
    const of = kindOf({ ...p, type: arr[1]! } as AbiParameter);
    if (!isStatic(of) || of.k === "tuple") throw new Unsupported(t);
    return { k: "array", of };
  }
  const u = /^uint(\d*)$/.exec(t);
  if (u) return { k: "uint", bits: Number(u[1] || 256) };
  const i = /^int(\d*)$/.exec(t);
  if (i) return { k: "int", bits: Number(i[1] || 256) };
  const b = /^bytes(\d+)$/.exec(t);
  if (b) return { k: "fixedBytes", size: Number(b[1]) };
  throw new Unsupported(t);
}

const compiled = new WeakMap<Abi, Map<string, EventSpec>>();

/** topic0 → event spec for every event of `abi` (first match wins, as in viem). Cached per ABI object. */
export function compileAbi(abi: Abi): Map<string, EventSpec> {
  const hit = compiled.get(abi);
  if (hit) return hit;
  const map = new Map<string, EventSpec>();
  for (const item of abi) {
    if (item.type !== "event") continue;
    const topic0 = topic0Of(item).toLowerCase() as Hex;
    if (map.has(topic0)) continue;
    let lean = !item.anonymous && item.inputs.every((x) => typeof x.name === "string" && x.name.length > 0);
    let inputs: InputSpec[] = [];
    try {
      inputs = item.inputs.map((x) => ({ name: x.name ?? "", indexed: Boolean("indexed" in x && x.indexed), kind: kindOf(x) }));
    } catch (err) {
      if (!(err instanceof Unsupported)) throw err;
      lean = false;
    }
    map.set(topic0, { name: item.name, topic0, inputs, lean, abiItem: item });
  }
  compiled.set(abi, map);
  return map;
}

// ---------------------------------------------------------------- word decoding (hex without 0x, 64 chars a word)

class DecodeError extends Error {}

function word(hex: string, at: number): string {
  if (at < 0 || at + 64 > hex.length) throw new DecodeError("out of bounds");
  return hex.slice(at, at + 64);
}

function toNumberish(w: string, bits: number, signed: boolean): number | bigint {
  let v = BigInt(`0x${w}`);
  if (signed) v = BigInt.asIntN(256, v);
  return bits > 48 ? v : Number(v);
}

/** A static value from one 32-byte word. */
function staticWord(k: Kind, w: string): unknown {
  switch (k.k) {
    case "address":
      return `0x${w.slice(24).toLowerCase()}`;
    case "bool": {
      const v = BigInt(`0x${w}`);
      if (v > 1n) throw new DecodeError("bool out of range");
      return v === 1n;
    }
    case "uint":
      return toNumberish(w, k.bits, false);
    case "int":
      return toNumberish(w, k.bits, true);
    case "fixedBytes":
      return `0x${w.slice(0, k.size * 2).toLowerCase()}`;
    default:
      throw new DecodeError(`not a one-word type: ${k.k}`);
  }
}

const utf8 = new TextDecoder();

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Decodes the value whose head word sits at `at` (hex offset) inside the tuple that starts at `base`. */
function decodeAt(k: Kind, hex: string, at: number, base: number): unknown {
  if (k.k === "tuple") {
    const out: Record<string, unknown> = {};
    let pos = at;
    for (const f of k.fields) {
      out[f.name] = decodeAt(f.kind, hex, pos, base);
      pos += (f.kind.k === "tuple" ? f.kind.words : 1) * 64;
    }
    return out;
  }
  if (isStatic(k)) return staticWord(k, word(hex, at));
  const offset = Number(BigInt(`0x${word(hex, at)}`));
  const start = base + offset * 2;
  const length = Number(BigInt(`0x${word(hex, start)}`));
  if (k.k === "array") {
    const items: unknown[] = [];
    for (let i = 0; i < length; i += 1) items.push(staticWord(k.of, word(hex, start + 64 + i * 64)));
    return items;
  }
  if (length === 0) return k.k === "string" ? "" : "0x";
  const dataHex = hex.slice(start + 64, start + 64 + length * 2);
  if (dataHex.length !== length * 2) throw new DecodeError("out of bounds");
  if (k.k === "bytes") return `0x${dataHex.toLowerCase()}`;
  return utf8.decode(hexToBytes(dataHex));
}

/** The args of a log under `spec`, as viem's decodeEventLog with `strict: false` gives them. */
export function decodeArgs(spec: EventSpec, topics: readonly Hex[], data: Hex): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const missing: InputSpec[] = [];
  let t = 1;
  for (const input of spec.inputs) {
    if (!input.indexed) continue;
    const topic = topics[t];
    t += 1;
    if (!topic) {
      // viem (strict: false) decodes a missing indexed argument from the front of the data instead
      missing.push(input);
      continue;
    }
    const k = input.kind;
    args[input.name] = isStatic(k) && k.k !== "tuple" ? staticWord(k, topic.slice(2)) : topic;
  }
  const dataInputs = [...missing, ...spec.inputs.filter((x) => !x.indexed)];
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (dataInputs.length > 0 && hex.length > 0) {
    try {
      const decoded: Record<string, unknown> = {};
      let pos = 0;
      for (const input of dataInputs) {
        decoded[input.name] = decodeAt(input.kind, hex, pos, 0);
        pos += (input.kind.k === "tuple" ? input.kind.words : 1) * 64;
      }
      Object.assign(args, decoded);
    } catch (err) {
      if (!(err instanceof DecodeError) && !(err instanceof RangeError) && !(err instanceof SyntaxError)) throw err;
      // strict: false: the indexed arguments stand alone
    }
  }
  return args;
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
  const unknown = (): EventRow => ({ ...base, name: `unknown:${topic0}`, argsJson: canonicalJson({ topics: log.topics, data: log.data }) });
  const spec = compileAbi(abi).get(topic0);
  if (!spec) return unknown();
  if (!spec.lean) {
    try {
      const decoded = decodeEventLog({ abi: [spec.abiItem], data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: false });
      return { ...base, name: decoded.eventName ?? spec.name, argsJson: canonicalJson(decoded.args ?? {}) };
    } catch {
      return unknown();
    }
  }
  try {
    return { ...base, name: spec.name, argsJson: canonicalJson(decodeArgs(spec, log.topics, log.data)) };
  } catch {
    return unknown();
  }
}
