import { describe, expect, it } from "vitest";
import { dateLabel, isNewSince } from "./dates";

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
    expect(dateLabel(new Date(2026, 9, 5, 9, 30).toISOString(), now)).toBe("오늘");
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
    expect(dateLabel(new Date(2026, 9, 5, 0, 0, 0).toISOString(), justAfterMidnight)).toBe("오늘");
    const justBeforeMidnight = new Date(2026, 9, 5, 23, 59, 59);
    expect(dateLabel(new Date(2026, 9, 5, 0, 0, 0).toISOString(), justBeforeMidnight)).toBe("오늘");
    expect(dateLabel(new Date(2026, 9, 6, 0, 0, 0).toISOString(), justBeforeMidnight)).toBe("10·06");
  });

  it("converts any UTC offset to local time before comparing", () => {
    const earlyToday = new Date(2026, 9, 5, 0, 30); // local 00:30 today
    const lateYesterday = new Date(2026, 9, 4, 23, 30); // local 23:30 yesterday
    for (const off of [-12 * 60, -5 * 60, -150, 0, 330, 9 * 60, 14 * 60]) {
      expect(dateLabel(withOffset(earlyToday, off), now)).toBe("오늘");
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
