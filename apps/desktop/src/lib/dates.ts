const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar date as `YYYY-MM-DD`. */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `{M}월 {D}일` for a `YYYY-MM-DD` date (no timezone math: it is already local). */
export function monthDay(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}월 ${d}일`;
}

/**
 * Card date label: `오늘` when `createdAt` falls on today's local date, else
 * `MM·DD` (zero-padded, U+00B7). Any UTC offset in `createdAt` is converted to
 * local time first. Empty for an unparseable time.
 */
export function dateLabel(createdAt: string, now: Date = new Date()): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "";
  if (localDate(d) === localDate(now)) return "오늘";
  return `${pad(d.getMonth() + 1)}·${pad(d.getDate())}`;
}

/** New-doc dot: `createdAt` is strictly after `baseline` (both ISO instants). False if either is unparseable. */
export function isNewSince(createdAt: string, baseline: string): boolean {
  const created = Date.parse(createdAt);
  const since = Date.parse(baseline);
  if (Number.isNaN(created) || Number.isNaN(since)) return false;
  return created > since;
}
