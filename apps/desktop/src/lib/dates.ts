const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar date as `YYYY-MM-DD`. */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** `Oct 5` for a `YYYY-MM-DD` date (no timezone math: it is already local). */
export function monthDay(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/**
 * Card date label: `Today` when `createdAt` falls on today's local date, else
 * `MM·DD` (zero-padded, U+00B7). Any UTC offset in `createdAt` is converted to
 * local time first. Empty for an unparseable time.
 */
export function dateLabel(createdAt: string, now: Date = new Date()): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "";
  if (localDate(d) === localDate(now)) return "Today";
  return `${pad(d.getMonth() + 1)}·${pad(d.getDate())}`;
}

/** New-doc dot: `createdAt` is strictly after `baseline` (both ISO instants). False if either is unparseable. */
export function isNewSince(createdAt: string, baseline: string): boolean {
  const created = Date.parse(createdAt);
  const since = Date.parse(baseline);
  if (Number.isNaN(created) || Number.isNaN(since)) return false;
  return created > since;
}

/*
 * Calendar-date math on `YYYY-MM-DD` strings. These are local calendar dates
 * with no time of day, so the arithmetic runs on a UTC timestamp of the date:
 * UTC has no DST, so adding days never lands on 23:00 or 01:00 of the wrong day.
 */

/** Weekday letters, Sunday first (weeks run Sunday → Saturday). */
export const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"] as const;

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

const utcOf = (date: string) => {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d));
};

const fromUtc = (t: Date) => `${String(t.getUTCFullYear()).padStart(4, "0")}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;

/** `date` shifted by `n` calendar days (negative goes back). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return fromUtc(new Date(Date.UTC(y, m - 1, d + n)));
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayIndex(date: string): number {
  return utcOf(date).getUTCDay();
}

/** The seven dates (Sunday → Saturday) of the week containing `date`. */
export function weekOf(date: string): string[] {
  const sunday = addDays(date, -weekdayIndex(date));
  return Array.from({ length: 7 }, (_, i) => addDays(sunday, i));
}

/** Day of the month as a number. */
export function dayOfMonth(date: string): number {
  return parts(date)[2];
}

/** Journal heading: `{Weekday}, {Mon} {D}`, e.g. `Monday, Oct 5`. */
export function journalTitle(date: string): string {
  return `${WEEKDAYS[weekdayIndex(date)]}, ${monthDay(date)}`;
}

/** `1 doc`, `3 docs`: a count with its noun, singular for exactly one. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
