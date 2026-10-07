import { describe, expect, it } from "vitest";
import { KV_ASSURANCE, fmtAssuranceHf, parseAssurance, readAssurance, type AssuranceRun } from "../src/assurance.js";

export const RUN: AssuranceRun = {
  version: 1,
  ranAt: 1791400000,
  chainId: 8453,
  forkBlock: 52300000,
  forkBlockTime: 1791390000,
  scenarios: [
    {
      id: "gap-8",
      gapBps: -800,
      positions: [
        {
          venue: "aave",
          address: "0x84c47eb3757f739460d04e330389647828a8d980",
          market: "MAG7 spoke",
          collateralSymbol: "NVDAc",
          debtUsdc: "3099.17",
          raw: { hfBefore: "1680896609923236325", hfAtReopen: "0.97", liquidatableSaturday: false, liquidatableAtReopen: true },
          boundline: { action: "pre-repay", actionAt: "saturday", amountUsdc: "400", hfAfter: "1.21", liquidatableAtReopen: false },
        },
      ],
    },
  ],
  summary: { positions: 1, scenarios: 1, rawLiquidatable: 1, boundlineLiquidatable: 0, pass: true },
  evidenceHash: "0xabc",
  artifact: "docs/evidence/assurance/2026-10-07.json",
};

describe("parseAssurance", () => {
  it("reports no run for an empty key, malformed for junk, ok for the harness's shape", () => {
    expect(parseAssurance(null)).toEqual({ status: "no run yet" });
    expect(parseAssurance(undefined)).toEqual({ status: "no run yet" });
    expect(parseAssurance("x")).toEqual({ status: "malformed", detail: "not an object" });
    expect(parseAssurance({ version: 1 })).toEqual({ status: "malformed", detail: "ranAt missing" });
    expect(parseAssurance({ version: 1, ranAt: 1 })).toEqual({ status: "malformed", detail: "scenarios missing" });
    expect(parseAssurance({ version: 1, ranAt: 1, scenarios: [] })).toEqual({ status: "malformed", detail: "summary missing" });
    expect(parseAssurance({ ...RUN, scenarios: [{ id: 1 }] })).toEqual({ status: "malformed", detail: "scenario shape" });
    expect(parseAssurance(RUN)).toEqual({ status: "ok", run: RUN });
  });
});

describe("readAssurance", () => {
  it("reads the KV key and never throws", async () => {
    const kv = { async get(key: string) { return key === KV_ASSURANCE ? RUN : null; } } as unknown as KVNamespace;
    expect(await readAssurance(kv)).toEqual({ status: "ok", run: RUN });
    const broken = { async get() { throw new Error("kv down"); } } as unknown as KVNamespace;
    expect(await readAssurance(broken)).toEqual({ status: "malformed", detail: "kv down" });
  });
});

describe("fmtAssuranceHf", () => {
  it("renders WAD strings, decimal strings and leaves junk alone", () => {
    expect(fmtAssuranceHf("1680896609923236325")).toBe("1.681");
    expect(fmtAssuranceHf("1.21")).toBe("1.210");
    expect(fmtAssuranceHf("97")).toBe("97.000");
    expect(fmtAssuranceHf("n/a")).toBe("n/a");
  });
});
