/**
 * Writes contracts/test/fixtures/calendar-2026.json, the differential fixture that
 * MarketCalendarDifferential.t.sol replays against the onchain calendar.
 *
 * Flat parallel arrays, so forge-std's stdJson can read them in two calls:
 *   t  / s   instants (UTC epoch seconds) and their session codes
 *   tt / to / at   instants, the session their next transition leads to, and when
 *
 * Run: pnpm --filter @boundline/calendar fixture
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EARLY_CLOSE,
  EARLY_POST_END,
  NYSE_2026,
  POST_END,
  PRE_START,
  REGULAR_CLOSE,
  REGULAR_OPEN,
  SESSION_CODE,
  isEarlyClose,
  nextTransition,
  sessionAt,
  wallClockToEpoch,
  zoneFields,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../../../contracts/test/fixtures/calendar-2026.json");

const YEAR = 2026;
const SPAN_START = Date.UTC(YEAR, 0, 1, 5, 0, 0) / 1000; // 2026-01-01 05:00 UTC
const SPAN_END = Date.UTC(YEAR, 11, 31, 23, 59, 0) / 1000; // 2026-12-31 23:59 UTC
const SAMPLE_SIZE = 1200;
const TRANSITION_SAMPLES = 300;

const instants = new Set<number>();
const add = (t: number): void => {
  instants.add(t);
};

// 1. Every session boundary of every exchange date in 2026, at -1s, 0, +1s and +60s.
for (let day = 0; day < 366; day += 1) {
  const d = new Date(Date.UTC(YEAR, 0, 1 + day));
  if (d.getUTCFullYear() !== YEAR) break;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  const weekday = d.getUTCDay();
  const key = y * 10_000 + m * 100 + dd;
  let marks: number[];
  if (weekday === 6) marks = [];
  else if (weekday === 0) marks = [POST_END];
  else marks = isEarlyClose(key) ? [PRE_START, REGULAR_OPEN, EARLY_CLOSE, EARLY_POST_END, POST_END] : [PRE_START, REGULAR_OPEN, REGULAR_CLOSE, POST_END];
  for (const mark of marks) {
    const base = wallClockToEpoch(y, m, dd, mark);
    for (const delta of [-1, 0, 1, 60]) add(base + delta);
  }
}

// 2. Both DST transitions, found by scanning the tz database hour by hour, at +-1h and +-1s.
let previousOffset = zoneFields(SPAN_START).offsetSeconds;
for (let t = SPAN_START; t <= SPAN_END; t += 3600) {
  const offset = zoneFields(t).offsetSeconds;
  if (offset !== previousOffset) {
    for (const delta of [-3600, -1, 0, 1, 3600]) add(t + delta);
    previousOffset = offset;
  }
}

// 3. Each holiday at 00:00, 12:00, 19:59 and 20:00 ET, and its eve at 19:59 and 20:00 ET.
for (const key of NYSE_2026.holidays) {
  const y = Math.floor(key / 10_000);
  const m = Math.floor(key / 100) % 100;
  const dd = key % 100;
  for (const mark of [0, 12 * 60, 19 * 60 + 59, 20 * 60]) add(wallClockToEpoch(y, m, dd, mark));
  for (const mark of [19 * 60 + 59, 20 * 60]) add(wallClockToEpoch(y, m, dd - 1, mark));
}

// 4. A deterministic LCG sample across the year (Numerical Recipes constants, seed 20261003).
let state = 20_261_003 >>> 0;
for (let i = 0; i < SAMPLE_SIZE; i += 1) {
  state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
  add(SPAN_START + Math.floor((state / 2 ** 32) * (SPAN_END - SPAN_START)));
}

const t = [...instants].sort((a, b) => a - b);
const s = t.map((x) => SESSION_CODE[sessionAt(x)]);

// Transitions: an even spread of instants whose next transition exists and stays inside 2026.
const tt: number[] = [];
const to: number[] = [];
const at: number[] = [];
const stride = Math.max(1, Math.floor(t.length / TRANSITION_SAMPLES));
for (let i = 0; i < t.length && tt.length < TRANSITION_SAMPLES; i += stride) {
  const x = t[i];
  if (x === undefined) break;
  const next = nextTransition(x, 14);
  if (next.at === 0) continue;
  if (zoneFields(next.at).year !== YEAR) continue;
  tt.push(x);
  to.push(SESSION_CODE[next.to]);
  at.push(next.at);
}

const histogram: Record<string, number> = {};
for (const x of t) {
  const name = sessionAt(x);
  histogram[name] = (histogram[name] ?? 0) + 1;
}

mkdirSync(dirname(OUT), { recursive: true });
const json = JSON.stringify({ t, s, tt, to, at });
writeFileSync(OUT, `${json}\n`);
console.log(`wrote ${OUT}`);
console.log(`${t.length} instants, ${tt.length} transitions, ${(json.length / 1024).toFixed(1)} KB`);
console.log(histogram);
