import { describe, expect, it } from "vitest";
import { planRanges } from "../src/cursor.js";

describe("planRanges", () => {
  it("plans contiguous ranges of the given width up to head minus confirmations", () => {
    expect(planRanges(99, 10_000, { range: 2000, maxRanges: 5 })).toEqual([
      { from: 100, to: 2099 },
      { from: 2100, to: 4099 },
      { from: 4100, to: 6099 },
      { from: 6100, to: 8099 },
      { from: 8100, to: 9999 },
    ]);
  });
  it("caps the number of ranges", () => {
    expect(planRanges(0, 100_000, { range: 2000, maxRanges: 2 })).toHaveLength(2);
  });
  it("is empty when the head is not far enough", () => {
    expect(planRanges(500, 501, { range: 2000, maxRanges: 5 })).toEqual([]);
    expect(planRanges(500, 500, { range: 2000, maxRanges: 5 })).toEqual([]);
    expect(planRanges(500, 502, { range: 2000, maxRanges: 5 })).toEqual([{ from: 501, to: 501 }]);
  });
  it("honours confirmations", () => {
    expect(planRanges(10, 20, { range: 100, maxRanges: 1, confirmations: 5 })).toEqual([{ from: 11, to: 15 }]);
  });
});
