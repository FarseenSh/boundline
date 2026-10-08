import { describe, expect, it } from "vitest";
import { versionOf } from "../src/policy.js";
import { buildDraftBody, describeChange, formatFieldValue, formatUsdc, hasChanges, localChanges, offChainOnly, parseBps, parseFraction, parsePercent, parseUsdc, partnerDraftFrom, percentToWad, SATURDAY_DEFAULT, tickerDraftFrom, validateDraft, wadToPercent, type EditedPolicy } from "../src/policy.js";
import type { PolicyResponse } from "../src/types.js";

const AAPLT = "0xb200000000000000000000000000000000000001";
const NVDAT = "0xb200000000000000000000000000000000000002";

const policy: PolicyResponse = {
  partnerId: "0x" + "ab".repeat(32),
  name: "boundline-app",
  policyVersion: 4,
  partner: { admin: "0x" + "11".repeat(20), signer: "0x" + "00".repeat(20), eligibility: "0x" + "00".repeat(20), active: true, exposureCap: "1000000000", exposure: "2800000" },
  tickers: [
    { symbol: "AAPLt", collateral: AAPLT, marketId: "0x" + "aa".repeat(32), allowed: true, maxLtvWad: "580000000000000000", minDraw: "1000000", maxDraw: "100000000", exposureCap: "500000000", exposure: "2800000", marketLltvWad: "625000000000000000" },
    { symbol: "NVDAt", collateral: NVDAT, marketId: "0x" + "bb".repeat(32), allowed: true, maxLtvWad: "550000000000000000", minDraw: "1000000", maxDraw: "0", exposureCap: "0", exposure: "0", marketLltvWad: "625000000000000000" },
  ],
};

function unchanged(): EditedPolicy {
  return { tickers: policy.tickers.map(tickerDraftFrom), partner: partnerDraftFrom(policy.partner) };
}

describe("units", () => {
  it("converts 1e18 ratios to percent and back exactly", () => {
    expect(wadToPercent("580000000000000000")).toBe(58);
    expect(wadToPercent("625000000000000000")).toBe(62.5);
    expect(wadToPercent("1")).toBe(0);
    expect(percentToWad(58)).toBe("580000000000000000");
    expect(percentToWad(57.25)).toBe("572500000000000000");
    expect(wadToPercent(percentToWad(12.3456))).toBe(12.3456);
    expect(() => percentToWad(-1)).toThrow();
  });
  it("formats and parses USDC base units", () => {
    expect(formatUsdc("2800000")).toBe("2.80");
    expect(formatUsdc("0")).toBe("0.00");
    expect(formatUsdc("1234567890")).toBe("1,234.56789");
    expect(formatUsdc("100000000")).toBe("100.00");
    expect(parseUsdc("2.5")).toBe("2500000");
    expect(parseUsdc("1,000")).toBe("1000000000");
    expect(parseUsdc("")).toBe("0");
    expect(parseUsdc("0.1234567")).toBeNull();
    expect(parseUsdc("abc")).toBeNull();
    expect(parsePercent("57.5%")).toBe(57.5);
    expect(parsePercent("x")).toBeNull();
  });
});

describe("drafts", () => {
  it("builds an empty body when nothing changed", () => {
    const body = buildDraftBody(policy, unchanged(), "nothing");
    expect(body).toEqual({ note: "nothing" });
    expect(hasChanges(body)).toBe(false);
    expect(localChanges(policy, unchanged())).toEqual([]);
  });
  it("carries only the tickers and partner fields that differ", () => {
    const edited = unchanged();
    edited.tickers[0] = { ...edited.tickers[0]!, maxLtvWad: percentToWad(55) };
    edited.partner.exposureCap = "2000000000";
    const body = buildDraftBody(policy, edited, "  trim AAPLt ");
    expect(body.note).toBe("trim AAPLt");
    expect(body.tickers).toHaveLength(1);
    expect(body.tickers?.[0]?.collateral).toBe(AAPLT);
    expect(body.tickers?.[0]?.maxLtvWad).toBe("550000000000000000");
    expect(body.partner?.exposureCap).toBe("2000000000");
    expect(body.partner?.active).toBe(true);
    const changes = localChanges(policy, edited);
    expect(changes).toEqual([
      { scope: "partner", field: "exposureCap", before: "1000000000", after: "2000000000" },
      { scope: "ticker", collateral: AAPLT, field: "maxLtvWad", before: "580000000000000000", after: "550000000000000000" },
    ]);
    expect(describeChange(changes[1]!, (c) => (c === AAPLT ? "AAPLt" : c))).toBe("AAPLt max LTV 58% → 55%");
    expect(describeChange(changes[0]!)).toBe("partner exposure cap 1,000.00 USDC → 2,000.00 USDC");
  });
  it("treats numeric strings by value and addresses case-insensitively", () => {
    const edited = unchanged();
    edited.tickers[1] = { ...edited.tickers[1]!, minDraw: "01000000" };
    edited.partner.signer = edited.partner.signer.toUpperCase().replace("0X", "0x");
    expect(hasChanges(buildDraftBody(policy, edited, "n"))).toBe(false);
  });
  it("describes booleans and zero caps in words", () => {
    expect(describeChange({ scope: "ticker", collateral: NVDAT, field: "allowed", before: true, after: false }, () => "NVDAt")).toBe("NVDAt allowed yes → no");
    expect(describeChange({ scope: "ticker", collateral: NVDAT, field: "maxDraw", before: "0", after: "50000000" }, () => "NVDAt")).toBe("NVDAt max draw 0 (no cap) → 50.00 USDC");
    expect(describeChange({ scope: "partner", field: "signer", before: "0x" + "00".repeat(20), after: "0x" + "12".repeat(20) })).toBe("partner signer none → 0x1212…1212");
  });
});

describe("validation", () => {
  it("refuses an LTV at or above the market LLTV, a zero LTV, min above max, and bad addresses", () => {
    const edited = unchanged();
    edited.tickers[0] = { ...edited.tickers[0]!, maxLtvWad: "625000000000000000" };
    edited.tickers[1] = { ...edited.tickers[1]!, minDraw: "2000000", maxDraw: "1000000" };
    edited.partner.signer = "nope";
    const errors = validateDraft(policy, edited);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/AAPLt: max LTV 62.5% is not below the market LLTV 62.5%/);
    expect(errors[1]).toMatch(/NVDAt: min draw 2.00 is above max draw 1.00/);
    expect(errors[2]).toMatch(/signer/);
    const zero = unchanged();
    zero.tickers[0] = { ...zero.tickers[0]!, maxLtvWad: "0" };
    expect(validateDraft(policy, zero)[0]).toMatch(/above 0%/);
  });
  it("accepts the unchanged policy and a max draw of zero (no cap)", () => {
    expect(validateDraft(policy, unchanged())).toEqual([]);
  });
});

describe("Saturday mode (routing policy, off chain)", () => {
  const withSat: PolicyResponse = { ...policy, saturdayMode: { enabled: false, capacityFraction: 0.5, haircutBps: 300 } };
  const editedSat = (patch: Partial<NonNullable<PolicyResponse["saturdayMode"]>>): EditedPolicy => ({ ...unchanged(), saturdayMode: { ...withSat.saturdayMode!, ...patch } });

  it("diffs and drafts only what changed, as a routing change", () => {
    expect(localChanges(withSat, editedSat({}))).toEqual([]);
    const changes = localChanges(withSat, editedSat({ enabled: true, haircutBps: 400 }));
    expect(changes).toEqual([
      { scope: "routing", field: "saturdayMode.enabled", before: false, after: true },
      { scope: "routing", field: "saturdayMode.haircutBps", before: 300, after: 400 },
    ]);
    expect(changes.map((c) => describeChange(c))).toEqual(["routing Saturday mode off → on", "routing Saturday haircut 300 bps → 400 bps"]);
    const body = buildDraftBody(withSat, editedSat({ enabled: true }), "  weekend pilot ");
    expect(body).toEqual({ note: "weekend pilot", saturdayMode: { enabled: true, capacityFraction: 0.5, haircutBps: 300 } });
    expect(hasChanges(body)).toBe(true);
    expect(offChainOnly(body)).toBe(true);
    expect(buildDraftBody(withSat, editedSat({}), "n").saturdayMode).toBeUndefined();
  });

  it("is ignored entirely while the API does not serve it", () => {
    expect(localChanges(policy, editedSat({ enabled: true }))).toEqual([]);
    expect(buildDraftBody(policy, editedSat({ enabled: true }), "n").saturdayMode).toBeUndefined();
  });

  it("a draft that also touches the desk is not off-chain-only", () => {
    const e = editedSat({ enabled: true });
    e.tickers[0] = { ...e.tickers[0]!, maxLtvWad: percentToWad(55) };
    const body = buildDraftBody(withSat, e, "n");
    expect(body.tickers).toHaveLength(1);
    expect(offChainOnly(body)).toBe(false);
  });

  it("validates the fraction (≤ 0.5) and the haircut (whole bps ≤ 5000)", () => {
    expect(validateDraft(withSat, editedSat({ capacityFraction: 0.6 }))).toContain("Saturday mode: capacity fraction must be above 0 and at most 0.5");
    expect(validateDraft(withSat, editedSat({ capacityFraction: 0 }))).toContain("Saturday mode: capacity fraction must be above 0 and at most 0.5");
    expect(validateDraft(withSat, editedSat({ haircutBps: 12.5 }))).toContain("Saturday mode: haircut must be a whole number of bps from 0 to 5000");
    expect(validateDraft(withSat, editedSat({ capacityFraction: 0.25, haircutBps: 5000 }))).toEqual([]);
    expect(parseFraction("0.5")).toBe(0.5);
    expect(parseFraction(".25")).toBe(0.25);
    expect(parseFraction("0.51")).toBeNull();
    expect(parseFraction("0")).toBeNull();
    expect(parseFraction("1")).toBeNull();
    expect(parseFraction("0.12345")).toBeNull();
    expect(parseBps("300")).toBe(300);
    expect(parseBps("5001")).toBeNull();
    expect(parseBps("3.5")).toBeNull();
    expect(SATURDAY_DEFAULT).toEqual({ enabled: false, capacityFraction: 0.5, haircutBps: 300 });
    expect(formatFieldValue("saturdayMode.capacityFraction", 0.25)).toBe("25% of capacity");
  });
});

describe("reading a version out of the API's answers", () => {
  const v = { id: "pv_1", status: "prepared", createdAt: 1, note: "n", changes: [{ scope: "ticker", field: "allowed", before: false, after: true }], calls: [], policyVersionBefore: 4 };
  it("unwraps { policyVersion, version } (the live API) and accepts a bare version", () => {
    expect(versionOf({ policyVersion: 4, chainId: 84532, version: v, selfCustody: "…" })).toEqual(v);
    expect(versionOf(v)).toEqual(v);
  });
  it("fills missing arrays so a card can always render, and refuses an answer without a version", () => {
    expect(versionOf({ version: { id: "pv_2", status: "applied" } }).calls).toEqual([]);
    expect(() => versionOf({ policyVersion: 4 })).toThrow(/no policy version/);
    expect(() => versionOf(null)).toThrow();
  });
});
