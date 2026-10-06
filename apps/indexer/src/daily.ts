import { ZERO_ROOT, chainRoot, dayEnd, dayOf, dayStart, nextDay } from "./roots.js";
import { INTERNAL_CURSORS, type DailyRootRow, type Store } from "./store.js";

/**
 * Roots every complete UTC day that has none yet. A day is complete when every source cursor of the chain has
 * passed its end (the cursor block's timestamp is at or beyond the next midnight). Days are rooted in order,
 * each chained to the previous day's root, starting from the day of the earliest stored event.
 */
export async function computeDailyRoots(store: Store, chainId: number, now: number): Promise<DailyRootRow[]> {
  const cursors = (await store.listCursors()).filter((c) => c.chainId === chainId && !INTERNAL_CURSORS.has(c.source));
  if (cursors.length === 0) return [];
  const minCursorTime = Math.min(...cursors.map((c) => c.lastBlockTime));
  let latest = await store.latestRoot(chainId);
  let day: string | null;
  if (latest) {
    day = nextDay(latest.day);
  } else {
    const earliest = await store.earliestEventTime(chainId);
    day = earliest === null ? null : dayOf(earliest);
  }
  const today = dayOf(now);
  const made: DailyRootRow[] = [];
  while (day !== null && day < today && dayEnd(day) <= minCursorTime) {
    const events = await store.eventsBetween(chainId, dayStart(day), dayEnd(day));
    const prevRoot = latest?.root ?? ZERO_ROOT;
    const row: DailyRootRow = {
      chainId,
      day,
      firstBlock: events[0]?.blockNumber ?? null,
      lastBlock: events[events.length - 1]?.blockNumber ?? null,
      eventCount: events.length,
      prevRoot,
      root: chainRoot(prevRoot, events),
      computedAt: now,
    };
    await store.putRoot(row);
    made.push(row);
    latest = row;
    day = nextDay(day);
  }
  return made;
}

export interface RollingRoot {
  day: string;
  eventCount: number;
  firstBlock: number | null;
  lastBlock: number | null;
  prevRoot: string;
  rootSoFar: string;
  complete: false;
  /** Complete days between the last stored root and today that are not rooted yet (their cursors have not closed them). */
  pendingDays: string[];
}

/** The provisional root of the current UTC day over the events stored so far. */
export async function rollingRoot(store: Store, chainId: number, now: number): Promise<RollingRoot> {
  const today = dayOf(now);
  const latest = await store.latestRoot(chainId);
  const events = await store.eventsBetween(chainId, dayStart(today), dayEnd(today));
  const prevRoot = latest?.root ?? ZERO_ROOT;
  const pendingDays: string[] = [];
  if (latest) {
    for (let d = nextDay(latest.day); d < today; d = nextDay(d)) pendingDays.push(d);
  }
  return {
    day: today,
    eventCount: events.length,
    firstBlock: events[0]?.blockNumber ?? null,
    lastBlock: events[events.length - 1]?.blockNumber ?? null,
    prevRoot,
    rootSoFar: chainRoot(prevRoot, events),
    complete: false,
    pendingDays,
  };
}
