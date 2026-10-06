import * as cal from "@boundline/calendar";
import type { CalendarPort, Session, Transition } from "./calendar-port.js";

// The Worker lives on the Workers Free plan's 10 ms CPU budget per invocation. The first
// `Intl.DateTimeFormat` for America/New_York costs several milliseconds on a cold isolate, so the
// arithmetic resolver (proven equal to the Intl path in the calendar package's differential test)
// does the ET projection here. Selected at module evaluation, which has its own startup budget.
cal.setZoneResolver("arithmetic");

/** The real calendar from @boundline/calendar, adapted to the port. */
export const liveCalendar: CalendarPort = {
  sessionAt: (t) => cal.sessionAt(t) as Session,
  isFeedLive: (t) => cal.isFeedLive(t),
  nextTransition: (t): Transition => {
    const n = cal.nextTransition(t, 14);
    return { to: n.to as Session, at: typeof n.at === "number" && n.at > 0 ? n.at : null };
  },
  feedBoundaryAfter: (t) => {
    const b = cal.nextFeedBoundary(t);
    return b > 0 ? b : null;
  },
  source: `${cal.NYSE_2026.source} via @boundline/calendar`,
};

// Warm the code paths with a fixed 2026 instant while the module evaluates (the clock is not read at global scope).
liveCalendar.nextTransition(1_791_000_000);
liveCalendar.feedBoundaryAfter(1_791_000_000);
