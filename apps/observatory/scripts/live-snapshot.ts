// One real snapshot against Base mainnet, printed as JSON. Run from the repo root:
//   pnpm exec tsx apps/observatory/scripts/live-snapshot.ts [SYMBOL]
import type { CalendarPort } from "../src/calendar-port.js";
import { createViemReader } from "../src/reader.js";
import { buildSnapshot } from "../src/snapshot.js";

async function loadCalendar(): Promise<CalendarPort> {
  try {
    const mod = await import("../src/calendar-impl.js");
    return mod.liveCalendar;
  } catch (err) {
    console.error("@boundline/calendar not built; using an UNKNOWN-session stub:", err instanceof Error ? err.message : err);
    return {
      sessionAt: () => "UNKNOWN",
      isFeedLive: () => false,
      nextTransition: () => ({ to: "UNKNOWN", at: null }),
      source: "stub (calendar package not built)",
    };
  }
}

const symbol = process.argv[2] ?? "AAPLc";
const rpc = process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org";
const calendar = await loadCalendar();
const reads = await createViemReader(rpc).read();
const snapshot = buildSnapshot(reads, calendar, Math.floor(Date.now() / 1000));
const row = snapshot.tokens.find((t) => t.symbol === symbol);
console.log(JSON.stringify({ block: snapshot.block, takenAt: snapshot.takenAt, session: snapshot.session, row }, null, 2));
