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
