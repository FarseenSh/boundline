import type { Hex } from "viem";
import { ZERO_ROOT, chainRoot, dayEnd, dayOf, dayStart, eventHash, nextDay, rootFromHashes } from "./roots.js";
import { INTERNAL_CURSORS, type CursorRow, type DailyRootRow, type Store } from "./store.js";

/**
 * Roots every complete UTC day that has none yet. A day is complete when every source cursor of the chain has
 * passed its end (the cursor block's timestamp is at or beyond the next midnight). Days are rooted in order,
 * each chained to the previous day's root, starting from the day of the earliest stored event.
 */
export async function computeDailyRoots(store: Store, chainId: number, now: number, maxDays = Number.POSITIVE_INFINITY, known?: readonly CursorRow[]): Promise<DailyRootRow[]> {
  // the tick passes the cursors it already holds (one D1 round trip less); scripts and routes read them
  const cursors = (known ?? (await store.listCursors())).filter((c) => c.chainId === chainId && !INTERNAL_CURSORS.has(c.source));
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
  while (day !== null && day < today && dayEnd(day) <= minCursorTime && made.length < maxDays) {
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

export interface RootProgress {
  made: DailyRootRow[];
  /** Events hashed this call. */
  hashed: number;
  /** True when more work may be waiting (a full hashing budget was used, or a day was rooted and the next may be ready). */
  pending: boolean;
}

/**
 * The tick's root step, a little at a time: hash up to `hashBudget` stored events that have no hash yet, oldest first,
 * from the first unrooted day on (today's included, so a day closes with its hashes ready); then root the next day if
 * every cursor of the chain has passed its end and every one of its events has a hash: one keccak over the stored
 * hashes. Same scheme and values as computeDailyRoots; a heavy day costs a few ms per tick instead of one 45 ms tick.
 */
export async function advanceRoots(store: Store, chainId: number, now: number, known: readonly CursorRow[], hashBudget: number): Promise<RootProgress> {
  const cursors = known.filter((c) => c.chainId === chainId && !INTERNAL_CURSORS.has(c.source));
  if (cursors.length === 0) return { made: [], hashed: 0, pending: false };
  const minCursorTime = Math.min(...cursors.map((c) => c.lastBlockTime));
  const latest = await store.latestRoot(chainId);
  let day: string | null;
  if (latest) day = nextDay(latest.day);
  else {
    const earliest = await store.earliestEventTime(chainId);
    day = earliest === null ? null : dayOf(earliest);
  }
  if (day === null) return { made: [], hashed: 0, pending: false };
  const todo = hashBudget > 0 ? await store.unhashedEvents(chainId, dayStart(day), hashBudget) : [];
  if (todo.length > 0) {
    await store.putEventHashes(todo.map((e) => ({ chainId, txHash: e.txHash, logIndex: e.logIndex, day: dayOf(e.blockTime), blockNumber: e.blockNumber, hash: eventHash(e) })));
  }
  const made: DailyRootRow[] = [];
  if (day < dayOf(now) && dayEnd(day) <= minCursorTime) {
    const dh = await store.dayHashes(chainId, dayStart(day), dayEnd(day));
    if (dh.hashes.every((h) => h !== null)) {
      const prevRoot = latest?.root ?? ZERO_ROOT;
      const row: DailyRootRow = {
        chainId,
        day,
        firstBlock: dh.firstBlock,
        lastBlock: dh.lastBlock,
        eventCount: dh.events,
        prevRoot,
        root: rootFromHashes(prevRoot, dh.hashes as Hex[]),
        computedAt: now,
      };
      await store.putRoot(row);
      made.push(row);
    }
  }
  return { made, hashed: todo.length, pending: todo.length === hashBudget || made.length > 0 };
}

export interface RollingRoot {
  day: string;
  eventCount: number;
  firstBlock: number | null;
  lastBlock: number | null;
  prevRoot: string;
  /** Null while too many of today's events are unhashed to finish on a request (the tick hashes them a few a minute). */
  rootSoFar: string | null;
  hashed: number;
  complete: false;
  /** Complete days between the last stored root and today that are not rooted yet (their cursors have not closed them). */
  pendingDays: string[];
}

/** Events a request may hash itself to finish today's provisional root (each costs ~0.2 ms of CPU on Workers). */
export const ROLLING_HASH_LIMIT = 24;

/** The provisional root of the current UTC day over the events stored so far, from the stored hashes. */
export async function rollingRoot(store: Store, chainId: number, now: number): Promise<RollingRoot> {
  const today = dayOf(now);
  const [latest, dh] = await Promise.all([store.latestRoot(chainId), store.dayHashes(chainId, dayStart(today), dayEnd(today))]);
  const prevRoot = latest?.root ?? ZERO_ROOT;
  const pendingDays: string[] = [];
  if (latest) {
    for (let d = nextDay(latest.day); d < today; d = nextDay(d)) pendingDays.push(d);
  }
  const missing = dh.hashes.filter((h) => h === null).length;
  let hashes = dh.hashes;
  if (missing > 0 && missing <= ROLLING_HASH_LIMIT) {
    const todo = await store.unhashedEvents(chainId, dayStart(today), missing);
    const byKey = new Map(todo.map((e) => [`${e.txHash}:${e.logIndex}`, eventHash(e)]));
    hashes = dh.hashes.map((h, i) => h ?? byKey.get(dh.keys[i]!) ?? null);
  }
  const complete = hashes.every((h) => h !== null);
  return {
    day: today,
    eventCount: dh.events,
    firstBlock: dh.firstBlock,
    lastBlock: dh.lastBlock,
    prevRoot,
    rootSoFar: complete ? rootFromHashes(prevRoot, hashes as Hex[]) : null,
    hashed: hashes.filter((h) => h !== null).length,
    complete: false,
    pendingDays,
  };
}
