import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { canonicalJson, toCanonicalValue } from "../src/canonical.js";
import { ZERO_ROOT, chainRoot, dayEnd, dayOf, dayStart, eventHash, nextDay } from "../src/roots.js";
import { MARKET, row, txHash } from "./fixtures.js";

describe("canonical JSON", () => {
  it("sorts keys recursively, writes bigints as decimal strings and lowercases hex", () => {
    const value = { z: 1n, a: { y: "0xABCDEF", x: [3n, "Hello"] }, m: true, n: null };
    expect(canonicalJson(value)).toBe('{"a":{"x":["3","Hello"],"y":"0xabcdef"},"m":true,"n":null,"z":"1"}');
  });
  it("is insensitive to key order", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
  });
  it("keeps numbers and plain strings", () => {
    expect(toCanonicalValue({ n: 7, s: "0x is not hex", t: "text" })).toEqual({ n: 7, s: "0x is not hex", t: "text" });
  });
});

describe("event hash and chained root", () => {
  const a = row({ blockNumber: 10, logIndex: 0, txHash: txHash(10) });
  const b = row({ blockNumber: 10, logIndex: 1, txHash: txHash(10), name: "SupplyCollateral" });
  const c = row({ blockNumber: 12, logIndex: 0, txHash: txHash(12) });

  it("hashes deterministically and changes with any field", () => {
    expect(eventHash(a)).toBe(eventHash({ ...a }));
    expect(eventHash(a)).not.toBe(eventHash({ ...a, argsJson: a.argsJson.replace("1000000", "1000001") }));
    expect(eventHash(a)).not.toBe(eventHash({ ...a, logIndex: 1 }));
    expect(eventHash(a)).not.toBe(eventHash({ ...a, chainId: 8453 }));
  });
  it("gives the same root whatever the insertion order", () => {
    expect(chainRoot(ZERO_ROOT, [c, a, b])).toBe(chainRoot(ZERO_ROOT, [a, b, c]));
  });
  it("changes when one argument changes or the previous root differs", () => {
    const base = chainRoot(ZERO_ROOT, [a, b, c]);
    expect(chainRoot(ZERO_ROOT, [a, { ...b, argsJson: '{"changed":true}' }, c])).not.toBe(base);
    expect(chainRoot(keccak256("0x01"), [a, b, c])).not.toBe(base);
  });
  it("roots an empty day as keccak256(prev_root)", () => {
    expect(chainRoot(ZERO_ROOT, [])).toBe(keccak256(ZERO_ROOT));
  });
  it("uses the market id in args", () => {
    expect(a.argsJson).toContain(MARKET);
  });
});

describe("UTC day helpers", () => {
  it("maps timestamps to days and back", () => {
    expect(dayOf(1_791_038_000)).toBe("2026-10-03");
    expect(dayStart("2026-10-03")).toBe(1_790_985_600);
    expect(dayEnd("2026-10-03")).toBe(1_791_072_000);
    expect(nextDay("2026-10-31")).toBe("2026-11-01");
  });
});
