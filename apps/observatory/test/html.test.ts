import { describe, expect, it } from "vitest";
import { renderPage } from "../src/html.js";
import { buildSnapshot } from "../src/snapshot.js";
import { NOW, calendar, pool, reads, token } from "./fixtures.js";

describe("renderPage", () => {
  it("shows the frozen banner with the last print and the reopen on a weekend", () => {
    const html = renderPage(buildSnapshot(reads([token()], [pool()]), calendar("WEEKEND"), NOW));
    expect(html).toContain("Feeds frozen since");
    expect(html).toContain("next reopen");
    expect(html).toContain("AAPLc");
    expect(html).toContain("333.66");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("tabular-nums");
  });

  it("shows the session banner when live", () => {
    const html = renderPage(buildSnapshot(reads([token({ feedUpdatedAt: BigInt(NOW - 60) })], []), calendar("REGULAR"), NOW));
    expect(html).toContain("Session <b>REGULAR</b>");
    expect(html).not.toContain("Feeds frozen since");
    expect(html).toContain("no pool");
  });

  it("escapes untrusted strings", () => {
    const html = renderPage(buildSnapshot(reads([token({ symbol: "<img onerror=x>" })], []), calendar("WEEKEND"), NOW));
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;img onerror=x&gt;");
  });
});
