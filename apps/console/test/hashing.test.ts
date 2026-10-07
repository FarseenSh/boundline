import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { bundleCounts, canonicalJson, canonicalize, hashOf, rehashBundle } from "../src/hashing.js";

describe("canonical JSON", () => {
  it("sorts keys recursively, keeps array order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { z: [3, { y: 2, x: 1 }], c: undefined } })).toBe('{"a":{"z":[3,{"x":1,"y":2}]},"b":1}');
    expect(canonicalize([{ b: 1, a: 2 }])).toEqual([{ a: 2, b: 1 }]);
    expect(canonicalJson("s")).toBe('"s"');
    expect(canonicalJson(null)).toBe("null");
  });
  it("hashes the UTF-8 of the canonical text with keccak256", () => {
    const value = { partnerId: "0xab", lines: [{ lineId: "1" }], generatedAt: 1 };
    expect(hashOf(value)).toBe(keccak256(stringToBytes('{"generatedAt":1,"lines":[{"lineId":"1"}],"partnerId":"0xab"}')));
    expect(hashOf({ note: "é" })).toBe(keccak256(stringToBytes('{"note":"é"}')));
  });
  it("recomputes a bundle's hash without the hash and correlation id, whatever key order it arrived in", () => {
    const body = { generatedAt: 7, partnerId: "0x01", obligations: [{ lineId: "1" }], decisions: [], reconciliation: { roots: { roots: [{ day: "2026-10-06" }] } }, drills: [] };
    const hash = hashOf(body);
    const arrived = { hash, correlationId: "per-request", drills: body.drills, decisions: body.decisions, obligations: body.obligations, partnerId: body.partnerId, generatedAt: body.generatedAt, reconciliation: body.reconciliation };
    expect(rehashBundle(arrived)).toBe(hash);
    expect(rehashBundle({ ...arrived, correlationId: "another" })).toBe(hash);
    expect(rehashBundle({ ...arrived, generatedAt: 8 })).not.toBe(hash);
  });
  it("counts the bundle's sections and bytes as the API lays them out", () => {
    const c = bundleCounts({
      obligations: [{ lineId: "1" }, { lineId: "2" }, { lineId: "3" }],
      decisions: [{ lineId: "1", decisions: [1, 2, 3] }, { lineId: "2", decisions: [] }],
      reconciliation: { reconcile: { status: "PASS" }, roots: { roots: [1, 2, 3, 4] } },
      drills: [{}, {}],
      hash: "0x",
      correlationId: "x",
    });
    expect(c).toMatchObject({ lines: 3, obligations: 3, decisions: 3, roots: 4, drills: 2 });
    expect(c.bytes).toBeGreaterThan(50);
    expect(bundleCounts({ lines: [1], roots: [1, 2] })).toMatchObject({ lines: 1, roots: 2, obligations: 0, decisions: 0, drills: 0 });
    expect(bundleCounts({ obligations: { source: "indexer", count: 2, rows: [{ lineId: "7" }, { lineId: "8" }] }, decisions: [{ action: "OPEN" }, { action: "DRAW" }] })).toMatchObject({ lines: 2, obligations: 2, decisions: 2 });
  });
});
