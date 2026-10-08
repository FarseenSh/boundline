import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatRateWad, formatWadPercent, PROTECTION_COPY, ROUTE_NOTE_COPY, ROUTE_REJECT_COPY, venueName } from "../src/route.js";

const routerSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../router/src/index.ts"), "utf8");

/** The members of a string-literal union declared in the router's source, so this test notices a new reason. */
function unionMembers(name: string): string[] {
  const m = new RegExp(`export type ${name} =([^;]+);`).exec(routerSource);
  if (!m) throw new Error(`no ${name} in packages/router/src/index.ts`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

describe("route display helpers", () => {
  it("formats APRs and LTVs from WADs, rounding down", () => {
    expect(formatRateWad(55_300_000_000_000_000n)).toBe("5.53");
    expect(formatRateWad("55399999999999999")).toBe("5.53");
    expect(formatRateWad(0n)).toBe("0.00");
    expect(formatRateWad(1_000_000_000_000_000_000n)).toBe("100.00");
    expect(formatWadPercent("476691700205254000")).toBe("47.6");
    expect(formatWadPercent(580_000_000_000_000_000n)).toBe("58.0");
  });

  it("has words for every rejection reason and protection mode the router can emit", () => {
    for (const r of unionMembers("RejectReason")) expect(ROUTE_REJECT_COPY[r], r).toBeTruthy();
    for (const p of unionMembers("ProtectionMode")) expect(PROTECTION_COPY[p as keyof typeof PROTECTION_COPY], p).toBeTruthy();
  });

  it("explains the notes the router attaches to a leg", () => {
    for (const note of [...routerSource.matchAll(/notes\.push\("([A-Z_]+)"\)/g)].map((x) => x[1]!)) expect(ROUTE_NOTE_COPY[note], note).toBeTruthy();
  });

  it("names the venues", () => {
    expect(venueName("morpho")).toBe("Morpho");
    expect(venueName("aave")).toBe("Aave V4");
  });
});
