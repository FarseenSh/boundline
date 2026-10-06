/**
 * The arithmetic ET resolver must agree with the Intl one everywhere the Observatory can ask: the
 * differential fixture's 5,643 instants, every DST boundary around 2026, and a wide random sweep.
 * With the arithmetic resolver selected, sessions and transitions must still match the fixture.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

import {
  SESSIONS,
  civilFromDays,
  daysFromCivil,
  nextFeedBoundary,
  nextTransition,
  sessionAt,
  setZoneResolver,
  usDaylightWindow,
  zoneFields,
  zoneFieldsArithmetic,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(here, "../../../contracts/test/fixtures/calendar-2026.json"), "utf8")) as {
  t: number[];
  s: number[];
  tt: number[];
  to: number[];
  at: number[];
};

const at = (iso: string): number => Date.parse(iso) / 1000;

describe("civil date arithmetic", () => {
  test("round-trips every day of 1970 to 2100", () => {
    for (let d = 0; d < 365 * 131; d += 1) {
      const c = civilFromDays(d);
      expect(daysFromCivil(c.year, c.month, c.day)).toBe(d);
    }
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(civilFromDays(20_000)).toEqual({ year: 2024, month: 10, day: 4 });
  });

  test("US daylight-saving windows match the published dates", () => {
    expect(usDaylightWindow(2025)).toEqual({ start: at("2025-03-09T07:00:00Z"), end: at("2025-11-02T06:00:00Z") });
    expect(usDaylightWindow(2026)).toEqual({ start: at("2026-03-08T07:00:00Z"), end: at("2026-11-01T06:00:00Z") });
    expect(usDaylightWindow(2027)).toEqual({ start: at("2027-03-14T07:00:00Z"), end: at("2027-11-07T06:00:00Z") });
  });
});

describe("zoneFieldsArithmetic equals zoneFields (Intl)", () => {
  test(`on all ${fixture.t.length} fixture instants`, () => {
    let disagreements = 0;
    for (const t of fixture.t) {
      const a = zoneFieldsArithmetic(t);
      const b = zoneFields(t);
      if (JSON.stringify(a) !== JSON.stringify(b)) disagreements += 1;
    }
    expect(disagreements).toBe(0);
  });

  test("around every DST boundary of 2025 to 2027, to the second", () => {
    const deltas = [-86_400, -3600, -60, -2, -1, 0, 1, 2, 60, 3600, 86_400];
    for (const year of [2025, 2026, 2027]) {
      const w = usDaylightWindow(year);
      for (const boundary of [w.start, w.end]) {
        for (const d of deltas) expect(zoneFieldsArithmetic(boundary + d)).toEqual(zoneFields(boundary + d));
      }
    }
  });

  test("on a deterministic sweep of 30,000 instants across 2024 to 2028", () => {
    let x = 0x2545f491;
    const next = (): number => {
      // xorshift32
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) / 0x1_0000_0000;
    };
    const start = at("2024-01-01T00:00:00Z");
    const span = at("2029-01-01T00:00:00Z") - start;
    let disagreements = 0;
    for (let i = 0; i < 30_000; i += 1) {
      const t = start + Math.floor(next() * span);
      if (JSON.stringify(zoneFieldsArithmetic(t)) !== JSON.stringify(zoneFields(t))) disagreements += 1;
    }
    expect(disagreements).toBe(0);
  });
});

describe("with the arithmetic resolver selected", () => {
  const previous = setZoneResolver("arithmetic");
  afterAll(() => {
    setZoneResolver(previous);
  });

  test("every fixture session matches", () => {
    let disagreements = 0;
    fixture.t.forEach((t, i) => {
      if (sessionAt(t) !== SESSIONS[fixture.s[i] as number]) disagreements += 1;
    });
    expect(disagreements).toBe(0);
  });

  test("every fixture transition matches", () => {
    let disagreements = 0;
    fixture.tt.forEach((t, i) => {
      const n = nextTransition(t);
      if (n.to !== SESSIONS[fixture.to[i] as number] || n.at !== fixture.at[i]) disagreements += 1;
    });
    expect(disagreements).toBe(0);
  });

  test("nextFeedBoundary is the next 20:00 ET, across DST and at the boundary itself", () => {
    expect(nextFeedBoundary(at("2026-10-06T12:00:00Z"))).toBe(at("2026-10-06T20:00:00-04:00"));
    expect(nextFeedBoundary(at("2026-10-09T20:00:00-04:00"))).toBe(at("2026-10-10T20:00:00-04:00"));
    expect(nextFeedBoundary(at("2026-10-09T19:59:59-04:00"))).toBe(at("2026-10-09T20:00:00-04:00"));
    expect(nextFeedBoundary(at("2026-03-07T23:00:00-05:00"))).toBe(at("2026-03-08T20:00:00-04:00"));
    expect(nextFeedBoundary(at("2026-10-31T21:00:00-04:00"))).toBe(at("2026-11-01T20:00:00-05:00"));
    expect(nextFeedBoundary(at("2026-11-01T20:00:00-05:00"))).toBe(at("2026-11-02T20:00:00-05:00"));
    expect(nextFeedBoundary(0)).toBe(0);
    expect(nextFeedBoundary(Number.NaN)).toBe(0);
  });
});
