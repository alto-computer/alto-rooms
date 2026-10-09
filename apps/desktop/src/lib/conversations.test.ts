import { describe, expect, it } from "vitest";
import { conversation } from "@/test/fakes";
import { conversationSpan } from "./conversations";

/** A local wall-clock time as an ISO instant, so the test reads the same in every timezone. */
const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m).toISOString();

describe("conversationSpan", () => {
  const now = new Date(2026, 9, 9, 18, 0);

  it("says Today for today, the date otherwise, and the end day only when it differs", () => {
    expect(conversationSpan(conversation("s", { startedAt: at(9, 13, 58), endedAt: at(9, 15, 10) }), now)).toBe("Today, 13:58 – 15:10");
    expect(conversationSpan(conversation("s", { startedAt: at(5, 9, 5), endedAt: at(5, 9, 40) }), now)).toBe("Oct 5, 09:05 – 09:40");
    expect(conversationSpan(conversation("s", { startedAt: at(8, 23, 50), endedAt: at(9, 0, 10) }), now)).toBe("Oct 8, 23:50 – Today, 00:10");
  });

  it("is one time when it started and ended in the same minute", () => {
    expect(conversationSpan(conversation("s", { startedAt: at(9, 10, 0), endedAt: at(9, 10, 0) }), now)).toBe("Today, 10:00");
  });
});
