import { afterEach, describe, expect, it } from "vitest";
import { addDays, dateLabel, isNewSince, journalTitle, localDate, weekdayIndex, weekOf, WEEKDAY_LETTERS } from "./dates";

const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");

/** The same instant as `d`, written as an ISO string with an explicit UTC offset (minutes east of UTC). */
function withOffset(d: Date, offsetMin: number): string {
  const shifted = new Date(d.getTime() + offsetMin * 60_000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const off = `${sign}${pad(Math.trunc(offsetMin / 60))}:${pad(offsetMin % 60)}`;
  return shifted.toISOString().replace("Z", off).replace(/\.\d{3}/, "");
}

describe("dateLabel", () => {
  const now = new Date(2026, 9, 5, 15, 0, 0); // local 2026-10-05 15:00

  it("says 오늘 for a local time earlier today", () => {
    expect(dateLabel(new Date(2026, 9, 5, 9, 30).toISOString(), now)).toBe("Today");
  });

  it("is MM·DD (zero-padded, U+00B7) for other days", () => {
    expect(dateLabel(new Date(2026, 8, 3, 12).toISOString(), now)).toBe("09·03");
    expect(dateLabel(new Date(2025, 9, 5, 12).toISOString(), now)).toBe("10·05"); // same day, last year
    expect(dateLabel(new Date(2026, 0, 1, 12).toISOString(), now)).toBe("01·01");
    expect(dateLabel(new Date(2026, 8, 3, 12).toISOString(), now)).toContain("·");
  });

  it("uses the local date at the midnight boundaries", () => {
    const justAfterMidnight = new Date(2026, 9, 5, 0, 0, 30);
    expect(dateLabel(new Date(2026, 9, 4, 23, 59, 59).toISOString(), justAfterMidnight)).toBe("10·04");
    expect(dateLabel(new Date(2026, 9, 5, 0, 0, 0).toISOString(), justAfterMidnight)).toBe("Today");
    const justBeforeMidnight = new Date(2026, 9, 5, 23, 59, 59);
    expect(dateLabel(new Date(2026, 9, 5, 0, 0, 0).toISOString(), justBeforeMidnight)).toBe("Today");
    expect(dateLabel(new Date(2026, 9, 6, 0, 0, 0).toISOString(), justBeforeMidnight)).toBe("10·06");
  });

  it("converts any UTC offset to local time before comparing", () => {
    const earlyToday = new Date(2026, 9, 5, 0, 30); // local 00:30 today
    const lateYesterday = new Date(2026, 9, 4, 23, 30); // local 23:30 yesterday
    for (const off of [-12 * 60, -5 * 60, -150, 0, 330, 9 * 60, 14 * 60]) {
      expect(dateLabel(withOffset(earlyToday, off), now)).toBe("Today");
      expect(dateLabel(withOffset(lateYesterday, off), now)).toBe("10·04");
    }
  });

  it("is empty for an unparseable time", () => {
    expect(dateLabel("nope", now)).toBe("");
  });
});

describe("isNewSince", () => {
  it("is true only when createdAt is strictly after the baseline", () => {
    expect(isNewSince("2026-10-05T10:00:01Z", "2026-10-05T10:00:00Z")).toBe(true);
    expect(isNewSince("2026-10-05T10:00:00Z", "2026-10-05T10:00:00Z")).toBe(false);
    expect(isNewSince("2026-10-05T09:59:59Z", "2026-10-05T10:00:00Z")).toBe(false);
  });

  it("compares instants across UTC offsets", () => {
    // 19:00+09:00 is 10:00Z.
    expect(isNewSince("2026-10-05T19:00:01+09:00", "2026-10-05T10:00:00Z")).toBe(true);
    expect(isNewSince("2026-10-05T18:59:59+09:00", "2026-10-05T10:00:00Z")).toBe(false);
  });

  it("is false when either time is unparseable", () => {
    expect(isNewSince("bad", "2026-10-05T10:00:00Z")).toBe(false);
    expect(isNewSince("2026-10-05T10:00:00Z", "bad")).toBe(false);
  });
});

describe("calendar-date math (YYYY-MM-DD, local calendar)", () => {
  const origTZ = process.env.TZ;
  afterEach(() => {
    if (origTZ === undefined) delete process.env.TZ;
    else process.env.TZ = origTZ;
  });

  it("adds and subtracts days across month and year boundaries", () => {
    expect(addDays("2026-10-05", 7)).toBe("2026-10-12");
    expect(addDays("2026-10-05", -7)).toBe("2026-09-28");
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29"); // leap year
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-03", -7)).toBe("2026-12-27");
    expect(addDays("2026-12-29", 7)).toBe("2027-01-05");
    expect(addDays("2026-10-05", 0)).toBe("2026-10-05");
  });

  it("is unaffected by DST transitions in any time zone", () => {
    for (const tz of ["America/New_York", "Europe/Berlin", "Australia/Sydney", "Asia/Seoul", "Pacific/Chatham"]) {
      process.env.TZ = tz;
      // US 2026: DST starts 03-08, ends 11-01. EU: 03-29 / 10-25. AU: ends 04-05, starts 10-04.
      expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
      expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
      expect(addDays("2026-03-28", 7)).toBe("2026-04-04");
      expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
      expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
      expect(addDays("2026-10-25", -1)).toBe("2026-10-24");
      expect(addDays("2026-10-04", 7)).toBe("2026-10-11");
      expect(weekOf("2026-03-10")).toEqual(["2026-03-08", "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14"]);
      expect(weekdayIndex("2026-11-01")).toBe(0);
      // Local midnight on a DST day is still that local date.
      expect(localDate(new Date(2026, 2, 8, 0, 0, 0))).toBe("2026-03-08");
      expect(localDate(new Date(2026, 10, 1, 23, 59, 59))).toBe("2026-11-01");
    }
  });

  it("weeks run Sunday → Saturday", () => {
    expect(WEEKDAY_LETTERS).toEqual(["S", "M", "T", "W", "T", "F", "S"]);
    expect(weekdayIndex("2026-10-05")).toBe(1); // Monday
    expect(weekdayIndex("2026-10-04")).toBe(0); // Sunday
    expect(weekOf("2026-10-05")).toEqual(["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"]);
    expect(weekOf("2026-10-04")[0]).toBe("2026-10-04");
    expect(weekOf("2026-10-10")[0]).toBe("2026-10-04");
    // Spans a month and a year boundary.
    expect(weekOf("2026-12-31")).toEqual(["2026-12-27", "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
    expect(weekOf("2026-07-01")[0]).toBe("2026-06-28");
  });

  it("titles a day as {M}월 {D}일 {요일}요일", () => {
    expect(journalTitle("2026-10-05")).toBe("Monday, Oct 5");
    expect(journalTitle("2026-10-04")).toBe("Sunday, Oct 4");
    expect(journalTitle("2027-01-02")).toBe("Saturday, Jan 2");
  });
});
