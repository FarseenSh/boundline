import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GATE_STATES, LINE_STATUSES, OBLIGATION_STATUSES, REASONS, SESSIONS, enumName } from "../src/names.js";

const contracts = resolve(import.meta.dirname, "../../../contracts/src");

/** Reads `enum Name { A, B, // comment ... }` out of a Solidity file, in declaration order. */
function solidityEnum(file: string, name: string): string[] {
  const src = readFileSync(resolve(contracts, file), "utf8");
  const m = src.match(new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`enum ${name} not found in ${file}`);
  return m[1]!
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .join("")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe("enum names mirror the Solidity sources in order", () => {
  it("CreditDesk.Reason", () => expect([...REASONS]).toEqual(solidityEnum("desk/CreditDesk.sol", "Reason")));
  it("CreditDesk.LineStatus", () => expect([...LINE_STATUSES]).toEqual(solidityEnum("desk/CreditDesk.sol", "LineStatus")));
  it("CreditDesk.ObligationStatus", () => expect([...OBLIGATION_STATUSES]).toEqual(solidityEnum("desk/CreditDesk.sol", "ObligationStatus")));
  it("IMarketCalendar.Session", () => expect([...SESSIONS]).toEqual(solidityEnum("interfaces/IMarketCalendar.sol", "Session")));
  it("IPriceGate.GateState", () => expect([...GATE_STATES]).toEqual(solidityEnum("interfaces/IPriceGate.sol", "GateState")));
  it("enumName is total", () => {
    expect(enumName(REASONS, 6)).toBe("MARKET_CLOSED");
    expect(enumName(REASONS, 6n)).toBe("MARKET_CLOSED");
    expect(enumName(REASONS, 99)).toBe("UNKNOWN");
    expect(enumName(REASONS, -1)).toBe("UNKNOWN");
    expect(enumName(SESSIONS, 5)).toBe("WEEKEND");
  });
});
