/**
 * @boundline/calendar
 *
 * US equity session calendar in America/New_York, modelled on the window the Chainlink
 * Coinbase tokenized-stock feeds publish in: Sunday 20:00 ET to Friday 20:00 ET, minus
 * NYSE full-day closures. Instants at or after 20:00 ET belong to the next exchange
 * date's session.
 *
 * This is the reference implementation that the onchain `MarketCalendar.sol` is
 * differentially tested against, so by default it is written independently of that
 * contract's arithmetic: every ET conversion goes through `Intl.DateTimeFormat` and the
 * host tz database. An arithmetic twin (`zoneFieldsArithmetic`: the US daylight-saving
 * rule plus Hinnant civil-date math, no ICU) is differentially tested against the Intl
 * path and can be selected with `setZoneResolver("arithmetic")` where the first
 * `Intl.DateTimeFormat` costs too much, such as a Cloudflare Worker on a 10 ms CPU budget.
 *
 * `UNKNOWN` is the fail-closed answer for any instant whose session date falls in a
 * year the calendar has no verified data for. Callers must treat it as "not open".
 */

export type Session = "UNKNOWN" | "PRE" | "REGULAR" | "POST" | "OVERNIGHT" | "WEEKEND" | "HOLIDAY";

/** Sessions in the order of the Solidity `IMarketCalendar.Session` enum. */
export const SESSIONS = ["UNKNOWN", "PRE", "REGULAR", "POST", "OVERNIGHT", "WEEKEND", "HOLIDAY"] as const;

/** Numeric code of each session, matching the Solidity enum (`UNKNOWN` = 0 ... `HOLIDAY` = 6). */
export const SESSION_CODE: Record<Session, number> = Object.freeze({
  UNKNOWN: 0,
  PRE: 1,
  REGULAR: 2,
  POST: 3,
  OVERNIGHT: 4,
  WEEKEND: 5,
  HOLIDAY: 6,
});

/** Sessions in which the feed publishes. */
export const LIVE_SESSIONS: ReadonlySet<Session> = new Set<Session>(["PRE", "REGULAR", "POST", "OVERNIGHT"]);

export const EXCHANGE_TIME_ZONE = "America/New_York";

/** Session boundaries in ET minutes since midnight. */
export const PRE_START = 4 * 60;
export const REGULAR_OPEN = 9 * 60 + 30;
export const REGULAR_CLOSE = 16 * 60;
export const EARLY_CLOSE = 13 * 60;
export const POST_END = 20 * 60;
export const EARLY_POST_END = 17 * 60;
/** Instants at or after this minute belong to the next exchange date's session. */
export const NEXT_SESSION_START = 20 * 60;
/** Every minute at which a session can change on some exchange date. */
export const BOUNDARY_MARKS = [PRE_START, REGULAR_OPEN, EARLY_CLOSE, REGULAR_CLOSE, EARLY_POST_END, POST_END] as const;

export interface MarketCalendarData {
  /** Years with verified holiday data. Any other year resolves to `UNKNOWN`. */
  readonly years: readonly number[];
  /** Full-day closures as yyyymmdd keys. */
  readonly holidays: readonly number[];
  /** 13:00 ET early closes as yyyymmdd keys. */
  readonly earlyCloses: readonly number[];
  readonly source: string;
}

/** The 2026 NYSE scheduled calendar, identical to `contracts/src/calendar/Nyse2026.sol`. */
export const NYSE_2026: MarketCalendarData = Object.freeze({
  years: Object.freeze([2026]),
  holidays: Object.freeze([
    20260101, // New Year's Day (Thu)
    20260119, // Martin Luther King, Jr. Day
    20260216, // Washington's Birthday
    20260403, // Good Friday
    20260525, // Memorial Day
    20260619, // Juneteenth (Fri)
    20260703, // Independence Day observed (4 July is a Saturday)
    20260907, // Labor Day
    20261126, // Thanksgiving Day
    20261225, // Christmas Day (Fri)
  ]),
  earlyCloses: Object.freeze([20261127, 20261224]),
  source: "https://www.nyse.com/markets/hours-calendars (2026 scheduled calendar)",
});

export interface Fields {
  session: Session;
  /** yyyymmdd of the ET wall clock at the instant (not the session date). */
  exchangeDate: number;
  /** yyyymmdd of the exchange date the session belongs to. */
  sessionDate: number;
  /** ET minutes since midnight at the instant. */
  minutesOfDay: number;
  /** 0 = Sunday ... 6 = Saturday, of `exchangeDate`. */
  weekday: number;
  /** America/New_York is on daylight time at the instant. */
  dst: boolean;
  /** `sessionDate` closes at 13:00 ET. */
  earlyClose: boolean;
  /** Holiday data is loaded for `sessionDate`'s year. */
  covered: boolean;
}

export interface Transition {
  /** Session in force from `at`; `UNKNOWN` with `at === 0` when none was found. */
  to: Session;
  /** UTC epoch seconds of the transition, 0 when none. */
  at: number;
}

export interface ZoneFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  minutesOfDay: number;
  dateKey: number;
  /** ET minus UTC in seconds at the instant: -18000 on standard time, -14400 on daylight time. */
  offsetSeconds: number;
}

const UNKNOWN_FIELDS: Readonly<Fields> = Object.freeze({
  session: "UNKNOWN",
  exchangeDate: 0,
  sessionDate: 0,
  minutesOfDay: 0,
  weekday: 0,
  dst: false,
  earlyClose: false,
  covered: false,
});

const NO_TRANSITION: Readonly<Transition> = Object.freeze({ to: "UNKNOWN", at: 0 });

/** Earliest instant with a defined ET date on every platform; mirrors the contract's guard. */
const MIN_EPOCH_SECONDS = 5 * 3600;

const WEEKDAY_INDEX: Readonly<Record<string, number>> = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
});

let formatter: Intl.DateTimeFormat | undefined;

function zoneFormatter(): Intl.DateTimeFormat {
  formatter ??= new Intl.DateTimeFormat("en-US", {
    timeZone: EXCHANGE_TIME_ZONE,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return formatter;
}

function dateKey(year: number, month: number, day: number): number {
  return year * 10_000 + month * 100 + day;
}

/** Project a UTC instant onto exchange-local wall-clock fields through the tz database. */
export function zoneFields(epochSeconds: number): ZoneFields {
  const whole = Math.floor(epochSeconds);
  const lookup: Record<string, string> = {};
  for (const part of zoneFormatter().formatToParts(new Date(whole * 1000))) {
    if (part.type !== "literal") lookup[part.type] = part.value;
  }
  const year = Number(lookup["year"]);
  const month = Number(lookup["month"]);
  const day = Number(lookup["day"]);
  const hour = Number(lookup["hour"]) % 24;
  const minute = Number(lookup["minute"]);
  const second = Number(lookup["second"]);
  const weekday = WEEKDAY_INDEX[lookup["weekday"] ?? ""] ?? 0;
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday,
    minutesOfDay: hour * 60 + minute,
    dateKey: dateKey(year, month, day),
    offsetSeconds: asUtc - whole,
  };
}

// ---------------------------------------------------------------- arithmetic twin

const DAY_SECONDS = 86_400;
const STANDARD_OFFSET_SECONDS = -5 * 3600;
const DAYLIGHT_OFFSET_SECONDS = -4 * 3600;

/** Days since 1970-01-01 of a proleptic Gregorian civil date (Howard Hinnant's `days_from_civil`). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = month > 2 ? month - 3 : month + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** Civil date of a day count since 1970-01-01 (Hinnant's `civil_from_days`). */
export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/** 0 = Sunday ... 6 = Saturday of a day count since 1970-01-01 (a Thursday). */
function weekdayOfDays(days: number): number {
  return (((days + 4) % 7) + 7) % 7;
}

/** Day of the month of the n-th Sunday (1-based) of `month`. */
function nthSunday(year: number, month: number, n: number): number {
  const first = weekdayOfDays(daysFromCivil(year, month, 1));
  return 1 + ((7 - first) % 7) + (n - 1) * 7;
}

/**
 * US daylight-saving window of `year` as UTC epoch seconds, under the rule in force since 2007:
 * from the second Sunday of March 02:00 EST (07:00 UTC) until the first Sunday of November 02:00 EDT (06:00 UTC).
 */
export function usDaylightWindow(year: number): { start: number; end: number } {
  return {
    start: daysFromCivil(year, 3, nthSunday(year, 3, 2)) * DAY_SECONDS + 7 * 3600,
    end: daysFromCivil(year, 11, nthSunday(year, 11, 1)) * DAY_SECONDS + 6 * 3600,
  };
}

/**
 * Arithmetic twin of `zoneFields`: the same fields from the US daylight-saving rule (2007 onward) and
 * Hinnant date math, with no tz database. `test/zone-arithmetic.test.ts` proves it equal to the Intl
 * path on the 5,643-instant differential fixture and around every DST boundary.
 */
export function zoneFieldsArithmetic(epochSeconds: number): ZoneFields {
  const whole = Math.floor(epochSeconds);
  // The DST window belongs to the year of the instant's standard-time date; DST never spans New Year.
  const { year: standardYear } = civilFromDays(Math.floor((whole + STANDARD_OFFSET_SECONDS) / DAY_SECONDS));
  const window = usDaylightWindow(standardYear);
  const offsetSeconds = whole >= window.start && whole < window.end ? DAYLIGHT_OFFSET_SECONDS : STANDARD_OFFSET_SECONDS;
  const local = whole + offsetSeconds;
  const days = Math.floor(local / DAY_SECONDS);
  const secondOfDay = local - days * DAY_SECONDS;
  const { year, month, day } = civilFromDays(days);
  const hour = Math.floor(secondOfDay / 3600);
  const minute = Math.floor((secondOfDay % 3600) / 60);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second: secondOfDay % 60,
    weekday: weekdayOfDays(days),
    minutesOfDay: hour * 60 + minute,
    dateKey: dateKey(year, month, day),
    offsetSeconds,
  };
}

export type ZoneResolver = (epochSeconds: number) => ZoneFields;

let resolver: ZoneResolver = zoneFields;

/**
 * Selects how every function in this module projects instants onto ET: `"intl"` (the default: the host tz
 * database through `Intl.DateTimeFormat`) or `"arithmetic"` (`zoneFieldsArithmetic`, no ICU), or any
 * resolver. Returns the previous resolver so a caller can restore it.
 */
export function setZoneResolver(choice: "intl" | "arithmetic" | ZoneResolver): ZoneResolver {
  const previous = resolver;
  resolver = choice === "intl" ? zoneFields : choice === "arithmetic" ? zoneFieldsArithmetic : choice;
  return previous;
}

/** The resolver currently in force. */
export function currentZoneResolver(): ZoneResolver {
  return resolver;
}

function zone(epochSeconds: number): ZoneFields {
  return resolver(epochSeconds);
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
  weekday: number;
  key: number;
}

/** The civil date `days` days after (year, month, day), by UTC date arithmetic. */
function addDays(year: number, month: number, day: number, days: number): CivilDate {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  return { year: y, month: m, day: dd, weekday: d.getUTCDay(), key: dateKey(y, m, dd) };
}

/** UTC epoch seconds of an ET wall-clock minute on a civil date. Two-pass offset resolution. */
export function wallClockToEpoch(year: number, month: number, day: number, minutesOfDay: number): number {
  const naive = Date.UTC(year, month - 1, day) / 1000 + minutesOfDay * 60;
  let instant = naive;
  for (let pass = 0; pass < 3; pass += 1) {
    const corrected = naive - zone(instant).offsetSeconds;
    if (corrected === instant) return instant;
    instant = corrected;
  }
  return instant;
}

const holidayCache = new WeakMap<MarketCalendarData, ReadonlySet<number>>();
const earlyCloseCache = new WeakMap<MarketCalendarData, ReadonlySet<number>>();

function holidaySet(calendar: MarketCalendarData): ReadonlySet<number> {
  let set = holidayCache.get(calendar);
  if (set === undefined) {
    set = new Set(calendar.holidays);
    holidayCache.set(calendar, set);
  }
  return set;
}

function earlyCloseSet(calendar: MarketCalendarData): ReadonlySet<number> {
  let set = earlyCloseCache.get(calendar);
  if (set === undefined) {
    set = new Set(calendar.earlyCloses);
    earlyCloseCache.set(calendar, set);
  }
  return set;
}

export function isYearLoaded(year: number, calendar: MarketCalendarData = NYSE_2026): boolean {
  return calendar.years.includes(year);
}

export function isHoliday(key: number, calendar: MarketCalendarData = NYSE_2026): boolean {
  return holidaySet(calendar).has(key);
}

export function isEarlyClose(key: number, calendar: MarketCalendarData = NYSE_2026): boolean {
  return earlyCloseSet(calendar).has(key);
}

/** yyyymmdd of a UTC instant's ET wall clock; 0 for instants the calendar refuses to place. */
export function dateKeyOf(epochSeconds: number): number {
  if (!Number.isFinite(epochSeconds) || epochSeconds < MIN_EPOCH_SECONDS) return 0;
  return zone(epochSeconds).dateKey;
}

/** Session plus the fields an operator needs to explain it. */
export function describe(epochSeconds: number, calendar: MarketCalendarData = NYSE_2026): Fields {
  if (!Number.isFinite(epochSeconds) || epochSeconds < MIN_EPOCH_SECONDS) return { ...UNKNOWN_FIELDS };
  const z = zone(epochSeconds);
  const dst = z.offsetSeconds === -4 * 3600;
  const intoNextDate = z.minutesOfDay >= NEXT_SESSION_START;
  const sessionDate = intoNextDate
    ? addDays(z.year, z.month, z.day, 1)
    : { year: z.year, month: z.month, day: z.day, weekday: z.weekday, key: z.dateKey };
  const covered = isYearLoaded(sessionDate.year, calendar);
  const earlyClose = earlyCloseSet(calendar).has(sessionDate.key);

  let session: Session;
  if (!covered) {
    session = "UNKNOWN";
  } else if (sessionDate.weekday === 0 || sessionDate.weekday === 6) {
    session = "WEEKEND";
  } else if (holidaySet(calendar).has(sessionDate.key)) {
    session = "HOLIDAY";
  } else if (intoNextDate || z.minutesOfDay < PRE_START) {
    session = "OVERNIGHT";
  } else if (z.minutesOfDay < REGULAR_OPEN) {
    session = "PRE";
  } else if (z.minutesOfDay < (earlyClose ? EARLY_CLOSE : REGULAR_CLOSE)) {
    session = "REGULAR";
  } else if (z.minutesOfDay < (earlyClose ? EARLY_POST_END : POST_END)) {
    session = "POST";
  } else {
    session = "OVERNIGHT"; // 17:00 to 20:00 ET after an early close
  }

  return {
    session,
    exchangeDate: z.dateKey,
    sessionDate: sessionDate.key,
    minutesOfDay: z.minutesOfDay,
    weekday: z.weekday,
    dst,
    earlyClose,
    covered,
  };
}

/** Session the feed is in at `epochSeconds`. */
export function sessionAt(epochSeconds: number, calendar: MarketCalendarData = NYSE_2026): Session {
  return describe(epochSeconds, calendar).session;
}

/** True when the feed publishes at `epochSeconds`: PRE, REGULAR, POST or OVERNIGHT. */
export function isFeedLive(epochSeconds: number, calendar: MarketCalendarData = NYSE_2026): boolean {
  return LIVE_SESSIONS.has(sessionAt(epochSeconds, calendar));
}

/**
 * First instant after `epochSeconds` at which the session changes, within `horizonDays`
 * exchange-local days. Walks the candidate boundaries of each day in order, so the
 * answer is the earliest change and never a later one.
 */
export function nextTransition(
  epochSeconds: number,
  horizonDays = 14,
  calendar: MarketCalendarData = NYSE_2026,
): Transition {
  if (!Number.isFinite(epochSeconds) || epochSeconds < MIN_EPOCH_SECONDS) return { ...NO_TRANSITION };
  const now = Math.floor(epochSeconds);
  const from = sessionAt(now, calendar);
  if (from === "UNKNOWN") return { ...NO_TRANSITION };
  const start = zone(now);
  for (let offset = 0; offset <= horizonDays; offset += 1) {
    const date = addDays(start.year, start.month, start.day, offset);
    for (const mark of BOUNDARY_MARKS) {
      const candidate = wallClockToEpoch(date.year, date.month, date.day, mark);
      if (candidate <= now) continue;
      const to = sessionAt(candidate, calendar);
      if (to === "UNKNOWN") return { ...NO_TRANSITION };
      if (to !== from) return { to, at: candidate };
    }
  }
  return { ...NO_TRANSITION };
}

/**
 * First 20:00 ET instant strictly after `epochSeconds`: the only wall-clock mark at which the feeds'
 * liveness can change (Friday close, Sunday reopen, holiday eve close, holiday-day reopen, end of
 * coverage). 0 for instants the calendar refuses to place.
 */
export function nextFeedBoundary(epochSeconds: number): number {
  if (!Number.isFinite(epochSeconds) || epochSeconds < MIN_EPOCH_SECONDS) return 0;
  const now = Math.floor(epochSeconds);
  const z = zone(now);
  const today = wallClockToEpoch(z.year, z.month, z.day, POST_END);
  if (today > now) return today;
  const next = addDays(z.year, z.month, z.day, 1);
  return wallClockToEpoch(next.year, next.month, next.day, POST_END);
}
