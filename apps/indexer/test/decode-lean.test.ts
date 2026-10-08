import { describe, expect, it } from "vitest";
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, type Abi, type AbiEvent, type AbiParameter, type Hex } from "viem";
import { boundlineStackAbi, creditDeskAbi, mainnetOracleRegistryEventsAbi, morphoEventsAbi, answerUpdatedAbi, policyRegistryEventsAbi, sepoliaProtectionAbi } from "../src/abis.js";
import { canonicalJson } from "../src/canonical.js";
import { compileAbi, decodeLog, type RawLog } from "../src/decode.js";
import { aaveSpokeEventsAbi, b20TokenEventsAbi } from "../src/sources.js";

// The lean decoder must produce byte-identical canonical args to viem's decodeEventLog (strict: false), the decoder
// every stored row was written with before 8 Oct 2026, so daily roots and every consumer see the same JSON.

const ABIS: Record<string, Abi> = {
  morpho: morphoEventsAbi as Abi,
  stack: boundlineStackAbi as Abi,
  desk: creditDeskAbi as Abi,
  registry: mainnetOracleRegistryEventsAbi as Abi,
  answer: answerUpdatedAbi as Abi,
  b20: b20TokenEventsAbi,
  aave: aaveSpokeEventsAbi,
  protection: sepoliaProtectionAbi as Abi,
  policyRegistry: policyRegistryEventsAbi as Abi,
};

/** A small deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randHex(r: () => number, bytes: number): Hex {
  let out = "0x";
  for (let i = 0; i < bytes; i += 1) out += Math.floor(r() * 256).toString(16).padStart(2, "0");
  return out as Hex;
}

function randBig(r: () => number, bits: number): bigint {
  let v = 0n;
  for (let i = 0; i < Math.ceil(bits / 32); i += 1) v = (v << 32n) | BigInt(Math.floor(r() * 2 ** 32));
  v &= (1n << BigInt(bits)) - 1n;
  // bias toward edges now and then
  const pick = r();
  if (pick < 0.05) return 0n;
  if (pick < 0.1) return (1n << BigInt(bits)) - 1n;
  return v;
}

const STRINGS = ["", "AAPLc", "NYSE 2026 calendar via https://www.nyse.com", "Thanksgiving — early close ✓", "\u0000\u0000leading nul", "0xABCdef looks like hex", "x".repeat(70)];

function randValue(p: AbiParameter, r: () => number): unknown {
  const t = p.type;
  if (t === "address") return randHex(r, 20);
  if (t === "bool") return r() < 0.5;
  if (t === "string") return STRINGS[Math.floor(r() * STRINGS.length)]!;
  if (t === "bytes") return randHex(r, Math.floor(r() * 70));
  if (t === "tuple") {
    const comps = ("components" in p ? p.components : []) ?? [];
    return Object.fromEntries(comps.map((c) => [c.name!, randValue(c, r)]));
  }
  const arr = /^(.+)\[\]$/.exec(t);
  if (arr) return Array.from({ length: Math.floor(r() * 5) }, () => randValue({ ...p, type: arr[1]! } as AbiParameter, r));
  const u = /^uint(\d*)$/.exec(t);
  if (u) {
    const bits = Number(u[1] || 256);
    const v = randBig(r, bits);
    return bits <= 48 ? Number(v) : v;
  }
  const i = /^int(\d*)$/.exec(t);
  if (i) {
    const bits = Number(i[1] || 256);
    const v = BigInt.asIntN(bits, randBig(r, bits));
    return bits <= 48 ? Number(v) : v;
  }
  const b = /^bytes(\d+)$/.exec(t);
  if (b) return randHex(r, Number(b[1]));
  throw new Error(`no generator for ${t}`);
}

function makeLog(item: AbiEvent, r: () => number): RawLog {
  const indexed = item.inputs.filter((x) => "indexed" in x && x.indexed);
  const plain = item.inputs.filter((x) => !("indexed" in x && x.indexed));
  const args = Object.fromEntries(indexed.map((x) => [x.name!, randValue(x, r)]));
  const topics = encodeEventTopics({ abi: [item], eventName: item.name, args } as never) as Hex[];
  const data = plain.length ? encodeAbiParameters(plain, plain.map((x) => randValue(x, r))) : "0x";
  return { address: randHex(r, 20), topics, data, blockNumber: "0x10", transactionHash: randHex(r, 32), logIndex: "0x1" };
}

function reference(abi: Abi, log: RawLog): { name: string; argsJson: string } {
  try {
    const d = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: false });
    return { name: d.eventName ?? "", argsJson: canonicalJson(d.args ?? {}) };
  } catch {
    const topic0 = (log.topics[0] ?? "0x").toLowerCase();
    return { name: `unknown:${topic0}`, argsJson: canonicalJson({ topics: log.topics, data: log.data }) };
  }
}

describe("lean decoder versus viem decodeEventLog (strict: false)", () => {
  for (const [label, abi] of Object.entries(ABIS)) {
    it(`${label}: every event, 40 random logs each, identical canonical args`, () => {
      const r = rng(label.length * 7919);
      const events = abi.filter((x): x is AbiEvent => x.type === "event");
      expect(events.length).toBeGreaterThan(0);
      for (const item of events) {
        for (let n = 0; n < 40; n += 1) {
          const log = makeLog(item, r);
          const lean = decodeLog(abi, log, 84532, 1);
          const ref = reference(abi, log);
          expect({ name: lean.name, args: lean.argsJson }).toEqual({ name: ref.name, args: ref.argsJson });
        }
      }
    });
  }

  it("compiles every event of every source ABI to the lean path (no viem fallback in production)", () => {
    for (const [label, abi] of Object.entries(ABIS)) {
      for (const spec of compileAbi(abi).values()) expect({ label, name: spec.name, lean: spec.lean }).toEqual({ label, name: spec.name, lean: true });
    }
  });

  it("edge cases match viem: truncated data, bool out of range, missing and extra topics, unknown topic0", () => {
    const r = rng(42);
    const desk = ABIS.desk!;
    const repaid = desk.find((x) => x.type === "event" && x.name === "Repaid") as AbiEvent;
    const base = makeLog(repaid, r);
    const cases: RawLog[] = [
      { ...base, data: base.data.slice(0, 66) as Hex }, // one word of three
      { ...base, data: "0x" },
      { ...base, data: `${base.data.slice(0, 2 + 64)}${"0".repeat(63)}2${base.data.slice(2 + 128)}` as Hex }, // full = 2
      { ...base, topics: base.topics.slice(0, 2) }, // a missing indexed topic
      { ...base, topics: [...base.topics, randHex(r, 32)] }, // one topic too many
      { ...base, topics: [randHex(r, 32), ...base.topics.slice(1)] }, // unknown event
      { ...base, topics: [] },
    ];
    for (const log of cases) {
      const lean = decodeLog(desk, log, 84532, 1);
      const ref = reference(desk, log);
      expect({ name: lean.name, args: lean.argsJson }).toEqual({ name: ref.name, args: ref.argsJson });
    }
  });

  it("a missing indexed topic is decoded from the front of the data, as viem does with strict: false (every ABI)", () => {
    const r = rng(99);
    for (const [label, abi] of Object.entries(ABIS)) {
      for (const item of abi.filter((x): x is AbiEvent => x.type === "event")) {
        if (!item.inputs.some((x) => "indexed" in x && x.indexed)) continue;
        for (let n = 0; n < 5; n += 1) {
          const log = makeLog(item, r);
          const cut = { ...log, topics: log.topics.slice(0, -1) };
          const lean = decodeLog(abi, cut, 84532, 1);
          const ref = reference(abi, cut);
          expect({ label, name: lean.name, args: lean.argsJson }).toEqual({ label, name: ref.name, args: ref.argsJson });
        }
      }
    }
  });

  it("strings with odd offsets and lengths decode like viem (YearLoaded carries a string)", () => {
    const stack = ABIS.stack!;
    const item = stack.find((x) => x.type === "event" && x.name === "YearLoaded") as AbiEvent;
    const r = rng(7);
    for (let n = 0; n < 50; n += 1) {
      const log = makeLog(item, r);
      expect(decodeLog(stack, log, 84532, 1).argsJson).toBe(reference(stack, log).argsJson);
    }
  });
});
