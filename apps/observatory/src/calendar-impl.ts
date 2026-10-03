import * as cal from "@boundline/calendar";
import type { CalendarPort, Session, Transition } from "./calendar-port.js";

/** The real calendar from @boundline/calendar, adapted to the port. */
export const liveCalendar: CalendarPort = {
  sessionAt: (t) => cal.sessionAt(t) as Session,
  isFeedLive: (t) => cal.isFeedLive(t),
  nextTransition: (t): Transition => {
    const n = cal.nextTransition(t, 14);
    return { to: n.to as Session, at: typeof n.at === "number" && n.at > 0 ? n.at : null };
  },
  source: `${cal.NYSE_2026.source} via @boundline/calendar`,
};
