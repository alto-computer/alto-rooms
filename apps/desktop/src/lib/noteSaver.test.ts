import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoteSaver, type Clock, type NoteSaver } from "./noteSaver";

type Deferred = { resolve: (updatedAt: string) => void; reject: (e: unknown) => void };

/** A save fn whose calls stay pending until the test settles them. */
function controlledSave() {
  const calls: { text: string; d: Deferred }[] = [];
  const save = vi.fn(
    (text: string) =>
      new Promise<{ updatedAt: string }>((resolve, reject) => {
        calls.push({ text, d: { resolve: (updatedAt) => resolve({ updatedAt }), reject } });
      }),
  );
  return { save, calls };
}

const failing = () => vi.fn(async (_text: string): Promise<{ updatedAt: string }> => Promise.reject(new Error("write_failed")));
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

let saver: NoteSaver | null = null;
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  saver?.dispose();
  saver = null;
  vi.useRealTimers();
});

function make(save: (text: string) => Promise<{ updatedAt: string }>, warn = vi.fn()) {
  saver = createNoteSaver({ save, warn });
  saver.load("", "2026-10-05T00:00:00Z");
  return saver;
}

describe("noteSaver: debounce and blur", () => {
  it("saves exactly once, 800ms after the last edit, with the latest text", async () => {
    const save = vi.fn(async () => ({ updatedAt: "2026-10-05T01:00:00Z" }));
    const s = make(save);
    s.edit("a");
    await tick(500);
    s.edit("ab");
    await tick(799);
    expect(save).not.toHaveBeenCalled();
    await tick(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("ab");
    await tick(10_000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(s.getState()).toMatchObject({ text: "ab", savedText: "ab", status: "saved", failures: 0, inFlight: false });
  });

  it("saves on blur right away when dirty, and not at all when clean", async () => {
    const save = vi.fn(async () => ({ updatedAt: "2026-10-05T01:00:00Z" }));
    const s = make(save);
    s.blur();
    expect(save).not.toHaveBeenCalled();
    s.edit("x");
    s.blur();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("x");
    await tick(2000); // the debounce was replaced by the blur save
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not save when the text returns to the saved text", async () => {
    const save = vi.fn(async () => ({ updatedAt: "2026-10-05T01:00:00Z" }));
    const s = make(save);
    s.edit("x");
    s.edit("");
    await tick(1000);
    expect(save).not.toHaveBeenCalled();
  });

  it("ignores edits until the note is loaded", async () => {
    const save = vi.fn(async () => ({ updatedAt: "2026-10-05T01:00:00Z" }));
    saver = createNoteSaver({ save });
    saver.edit("typed too early");
    await tick(1000);
    expect(save).not.toHaveBeenCalled();
    expect(saver.getState().text).toBe("");
    saver.load("server body", null);
    expect(saver.getState()).toMatchObject({ text: "server body", savedText: "server body", ready: true });
  });
});

describe("noteSaver: single flight", () => {
  it("an edit during an in-flight save causes exactly one follow-up save of the latest text", async () => {
    const { save, calls } = controlledSave();
    const s = make(save);
    s.edit("a");
    await tick(800);
    expect(calls).toHaveLength(1);
    expect(s.getState().inFlight).toBe(true);

    s.edit("ab");
    s.edit("abc");
    expect(s.getState().dirtyDuringFlight).toBe(true);
    await tick(800); // debounce fires while in flight: no second request
    s.blur(); // neither does a blur
    expect(calls).toHaveLength(1);

    calls[0].d.resolve("2026-10-05T01:00:00Z");
    await tick(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].text).toBe("abc");
    expect(s.getState().savedText).toBe("a");

    calls[1].d.resolve("2026-10-05T01:00:01Z");
    await tick(10_000);
    expect(calls).toHaveLength(2);
    expect(s.getState()).toMatchObject({ savedText: "abc", inFlight: false, dirtyDuringFlight: false, status: "saved" });
  });

  it("the follow-up still waits for the debounce while the user keeps typing", async () => {
    const { save, calls } = controlledSave();
    const s = make(save);
    s.edit("a");
    await tick(800);
    s.edit("ab");
    calls[0].d.resolve("2026-10-05T01:00:00Z");
    await tick(0);
    expect(calls).toHaveLength(1); // debounce for "ab" still pending
    await tick(800);
    expect(calls).toHaveLength(2);
    expect(calls[1].text).toBe("ab");
  });
});

describe("noteSaver: retries", () => {
  it("retries after 1s, 2s, 4s; errors after the 3rd failure; then every 10s; keeps the text", async () => {
    const save = failing();
    const s = make(save);
    s.edit("내용");
    await tick(800);
    expect(save).toHaveBeenCalledTimes(1);
    expect(s.getState()).toMatchObject({ failures: 1, status: "saving" });

    await tick(999);
    expect(save).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(s.getState().status).not.toBe("error");

    await tick(1999);
    expect(save).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(save).toHaveBeenCalledTimes(3);
    expect(s.getState()).toMatchObject({ failures: 3, status: "error", text: "내용" });

    await tick(3999);
    expect(save).toHaveBeenCalledTimes(3);
    await tick(1);
    expect(save).toHaveBeenCalledTimes(4);

    await tick(9999);
    expect(save).toHaveBeenCalledTimes(4);
    await tick(1);
    expect(save).toHaveBeenCalledTimes(5);
    await tick(10_000);
    expect(save).toHaveBeenCalledTimes(6);
    expect(s.getState()).toMatchObject({ status: "error", text: "내용", savedText: "" });
    for (const [t] of save.mock.calls) expect(t).toBe("내용");
  });

  it("a success resets failures and clears the error", async () => {
    let fail = true;
    const save = vi.fn(async (_t: string) => {
      if (fail) throw new Error("nope");
      return { updatedAt: "2026-10-05T01:00:00Z" };
    });
    const s = make(save);
    s.edit("x");
    await tick(800 + 1000 + 2000);
    expect(s.getState()).toMatchObject({ failures: 3, status: "error" });
    fail = false;
    await tick(4000);
    expect(save).toHaveBeenCalledTimes(4);
    expect(s.getState()).toMatchObject({ failures: 0, status: "saved", savedText: "x" });
    await tick(60_000);
    expect(save).toHaveBeenCalledTimes(4);
  });

  it("never discards edits made while failing; retries send the latest text", async () => {
    const save = failing();
    const s = make(save);
    s.edit("a");
    await tick(800);
    s.edit("ab");
    await tick(800); // the edit's debounce replaces the pending retry
    expect(save).toHaveBeenLastCalledWith("ab");
    expect(s.getState().text).toBe("ab");
  });
});

describe("noteSaver: unmount flush", () => {
  it("fires one last save of unsaved text and warns (not throws) if it fails", async () => {
    const warn = vi.fn();
    const save = failing();
    const s = make(save, warn);
    s.edit("마지막");
    s.dispose();
    saver = null;
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("마지막");
    await tick(60_000);
    expect(save).toHaveBeenCalledTimes(1); // no retries after unmount
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there is nothing unsaved", async () => {
    const save = vi.fn(async () => ({ updatedAt: "2026-10-05T01:00:00Z" }));
    const s = make(save);
    s.edit("x");
    await tick(800);
    s.dispose();
    saver = null;
    await tick(60_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("with a save in flight, sends the remaining edits once it settles", async () => {
    const { save, calls } = controlledSave();
    const s = make(save);
    s.edit("a");
    await tick(800);
    s.edit("ab");
    s.dispose();
    saver = null;
    expect(calls).toHaveLength(1);
    calls[0].d.reject(new Error("boom"));
    await tick(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].text).toBe("ab");
    calls[1].d.resolve("2026-10-05T01:00:00Z");
    await tick(60_000);
    expect(calls).toHaveLength(2);
  });
});

describe("noteSaver: external changes", () => {
  it("treats only updatedAt strictly newer than the last load/save as external", async () => {
    const save = vi.fn(async () => ({ updatedAt: "2026-10-05T02:00:00Z" }));
    const s = make(save); // loaded at 00:00
    expect(s.isNewer("2026-10-05T00:00:00Z")).toBe(false);
    expect(s.isNewer("2026-10-05T00:30:00Z")).toBe(true);
    s.edit("x");
    await tick(800);
    // Our own save's updatedAt (and anything older) is an echo.
    expect(s.isNewer("2026-10-05T02:00:00Z")).toBe(false);
    expect(s.isNewer("2026-10-05T11:00:00+09:00")).toBe(false); // same instant, another offset
    expect(s.isNewer("2026-10-05T01:00:00Z")).toBe(false);
    expect(s.isNewer("2026-10-05T02:00:01Z")).toBe(true);
  });

  it("applies a remote body only when there are no unsaved edits and nothing in flight", async () => {
    const { save, calls } = controlledSave();
    const s = make(save);
    s.edit("local");
    expect(s.applyRemote("remote", "2026-10-05T05:00:00Z")).toBe(false);
    expect(s.getState().text).toBe("local");
    await tick(800);
    expect(s.applyRemote("remote", "2026-10-05T05:00:00Z")).toBe(false); // in flight
    calls[0].d.resolve("2026-10-05T01:00:00Z");
    await tick(0);
    expect(s.applyRemote("remote", "2026-10-05T05:00:00Z")).toBe(true);
    expect(s.getState()).toMatchObject({ text: "remote", savedText: "remote" });
    expect(s.isNewer("2026-10-05T05:00:00Z")).toBe(false);
  });
});

describe("noteSaver: injectable clock", () => {
  it("schedules through the given clock", async () => {
    vi.useRealTimers();
    const timers: { fn: () => void; ms: number }[] = [];
    const clock: Clock = {
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
      clearTimeout: (h) => {
        const t = timers[(h as number) - 1];
        if (t) t.fn = () => {};
      },
    };
    const save = vi.fn(async () => ({ updatedAt: "2026-10-05T01:00:00Z" }));
    saver = createNoteSaver({ save, clock });
    saver.load("", null);
    saver.edit("a");
    expect(timers.map((t) => t.ms)).toEqual([800]);
    timers[0].fn();
    expect(save).toHaveBeenCalledWith("a");
    vi.useFakeTimers();
  });
});

describe("noteSaver: flush", () => {
  it("skips the debounce, and during a flight makes the follow-up immediate", async () => {
    const { save, calls } = controlledSave();
    const s = make(save);
    s.edit("a");
    s.flush();
    expect(calls).toHaveLength(1);
    s.edit("ab"); // debounce pending
    s.flush();
    calls[0].d.resolve("2026-10-05T01:00:00Z");
    await tick(0);
    expect(calls).toHaveLength(2); // not waiting 800ms
    expect(calls[1].text).toBe("ab");
  });
});
