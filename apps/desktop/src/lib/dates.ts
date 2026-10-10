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

/** `1 artifact`, `3 artifacts`: a count with its noun, singular for exactly one. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** `Friday`. */
export const weekdayName = (date: string): string => WEEKDAYS[weekdayIndex(date)];

/** `October 4`. */
export function longMonthDay(date: string): string {
  const [, m, d] = parts(date);
  return `${MONTHS_LONG[m - 1]} ${d}`;
}

/** The Journal's day heading: `Friday, 9 October`. */
export function daybookTitle(date: string): string {
  const [, m, d] = parts(date);
  return `${weekdayName(date)}, ${d} ${MONTHS_LONG[m - 1]}`;
}

/** ISO 8601 week number (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeek(date: string): number {
  const t = utcOf(date);
  const thursday = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7)));
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return 1 + Math.floor((thursday.getTime() - jan1) / 86_400_000 / 7);
}

/** Local wall-clock time as `09:12`; empty for an unparseable time. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Age = { kind: "now" } | { kind: "min" | "h"; n: number } | { kind: "yesterday" } | { kind: "weekday"; day: number } | { kind: "date"; date: string };

/** How long ago `iso` was, in the steps a person reads at a glance: minutes, hours today, then calendar days. */
function age(iso: string, now: Date): Age | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const min = Math.floor((now.getTime() - d.getTime()) / 60_000);
  const day = localDate(d);
  const daysBack = Math.round((utcOf(localDate(now)).getTime() - utcOf(day).getTime()) / 86_400_000);
  if (min < 1) return { kind: "now" };
  if (min < 60) return { kind: "min", n: min };
  if (daysBack <= 0) return { kind: "h", n: Math.floor(min / 60) };
  if (daysBack === 1) return { kind: "yesterday" };
  if (daysBack < 7) return { kind: "weekday", day: weekdayIndex(day) };
  return { kind: "date", date: day };
}

/** A card's time: `now`, `12 min`, `3 h`, `Yesterday`, `Tue`, then `Sep 30`. */
export function shortAge(iso: string, now: Date = new Date()): string {
  const a = age(iso, now);
  if (!a) return "";
  switch (a.kind) {
    case "now": return "now";
    case "min": return `${a.n} min`;
    case "h": return `${a.n} h`;
    case "yesterday": return "Yesterday";
    case "weekday": return WEEKDAYS[a.day].slice(0, 3);
    case "date": return monthDay(a.date);
  }
}

/** The same in a sentence ("last added …"): `just now`, `12 min ago`, `3 h ago`, `yesterday`, `Tuesday`, `Sep 30`. */
export function agoPhrase(iso: string, now: Date = new Date()): string {
  const a = age(iso, now);
  if (!a) return "";
  switch (a.kind) {
    case "now": return "just now";
    case "min": return `${a.n} min ago`;
    case "h": return `${a.n} h ago`;
    case "yesterday": return "yesterday";
    case "weekday": return WEEKDAYS[a.day];
    case "date": return monthDay(a.date);
  }
}
