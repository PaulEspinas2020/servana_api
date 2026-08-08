/**
 * The operational timezone, and the only sanctioned way to read a calendar
 * date, weekday or wall-clock time out of an instant.
 *
 * Command 22 §5. Production runs `Etc/UTC` with `TZ` unset — measured on the
 * host, not assumed. Anything using `Date.getDay()`, `Date.getHours()` or
 * `toISOString().slice(0, 10)` to decide "which day is this booking on" or
 * "what time does it start" was therefore answering in UTC while providers
 * enter their schedules in Manila local time, an eight-hour shift.
 *
 * That shift is wrong in BOTH directions, which is why it was not obvious:
 *
 *   09:00 Manila -> 01:00 UTC -> outside an 08:00–17:00 rule -> provider
 *                                excluded during their own working hours
 *   19:00 Manila -> 11:00 UTC -> inside  an 08:00–17:00 rule -> provider
 *                                assigned work they never offered
 *
 * ── Why not just set TZ=Asia/Manila on the host ──────────────────────────────
 * It would fix today's symptom and leave the cause. Availability, bookings and
 * payouts would silently depend on an environment variable on one Linode box,
 * a restart away from changing, and untestable in CI. The timezone is business
 * policy, so it belongs in code where a test can pin it.
 *
 * ── Daylight saving ─────────────────────────────────────────────────────────
 * The Philippines does not observe it, so nothing here depends on the offset
 * being constant. `Intl` carries the IANA rules, so a region that does observe
 * DST works by passing its zone rather than by rewriting this file. That is the
 * §5 "future daylight-saving readiness" requirement: the arithmetic never
 * assumes a fixed offset.
 */

/**
 * Philippine operations. Deliberately a constant rather than an env var: an
 * environment that can be misconfigured is not a policy.
 */
export const OPERATIONAL_TIMEZONE = "Asia/Manila";

const WEEKDAY_INDEX: Readonly<Record<string, number>> = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
});

/**
 * `hourCycle: 'h23'` rather than `hour12: false` — the latter renders midnight
 * as "24" on some ICU builds, which would push a 00:30 booking to "24:30" and
 * sort after every other slot.
 */
const formatterFor = (timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

/** Formatters are expensive to build and immutable once built. */
const cache = new Map<string, Intl.DateTimeFormat>();
const cachedFormatter = (timeZone: string) => {
  let f = cache.get(timeZone);
  if (!f) {
    f = formatterFor(timeZone);
    cache.set(timeZone, f);
  }
  return f;
};

export interface ZonedParts {
  /** 0 = Sunday, matching `Date.getDay()` and the engine's `dayOfWeek`. */
  dayOfWeek: number;
  /** `YYYY-MM-DD` in the operational timezone. */
  ymd: string;
  /** `HH:mm`, 24-hour, in the operational timezone. */
  hhmm: string;
}

/**
 * Reads an instant as it appears on a wall clock in `timeZone`.
 *
 * Accepts anything `new Date()` accepts. An unparseable input throws rather
 * than returning a plausible-looking wrong day: silently defaulting would put a
 * booking on the epoch and mark a provider unavailable for reasons no one could
 * trace.
 */
export const zonedParts = (
  instant: string | number | Date,
  timeZone: string = OPERATIONAL_TIMEZONE
): ZonedParts => {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`zonedParts: unparseable instant ${String(instant)}`);
  }

  const parts = cachedFormatter(timeZone).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  const weekday = get("weekday");
  const dayOfWeek = WEEKDAY_INDEX[weekday];
  if (dayOfWeek === undefined) {
    throw new Error(`zonedParts: unrecognised weekday ${weekday}`);
  }

  return {
    dayOfWeek,
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    hhmm: `${get("hour")}:${get("minute")}`,
  };
};

/**
 * The calendar date an instant falls on, operationally.
 *
 * Replaces `toISOString().slice(0, 10)` wherever that was used to match a DATE
 * column. In Manila that expression is a day early for anything before 08:00,
 * so time off booked for the correct day did not block the booking, and time
 * off on the previous day did.
 */
export const operationalDate = (
  instant: string | number | Date,
  timeZone: string = OPERATIONAL_TIMEZONE
): string => zonedParts(instant, timeZone).ymd;

/** Convert a wall-clock date/time in an IANA zone into its UTC instant. */
export const zonedDateTimeToUtc = (
  ymd: string,
  hhmm: string,
  timeZone: string = OPERATIONAL_TIMEZONE,
): Date => {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  const time = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!date || !time) throw new Error('A valid local date and time are required');

  const desired = Date.UTC(
    Number(date[1]), Number(date[2]) - 1, Number(date[3]),
    Number(time[1]), Number(time[2]), 0, 0,
  );
  let guess = desired;
  for (let i = 0; i < 3; i++) {
    const actual = zonedParts(guess, timeZone);
    const [year, month, day] = actual.ymd.split('-').map(Number);
    const [hour, minute] = actual.hhmm.split(':').map(Number);
    const actualAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const delta = desired - actualAsUtc;
    guess += delta;
    if (delta === 0) break;
  }

  const result = new Date(guess);
  const rendered = zonedParts(result, timeZone);
  if (rendered.ymd !== ymd || rendered.hhmm !== hhmm) {
    throw new Error('The local schedule time does not exist in the configured timezone');
  }
  return result;
};
