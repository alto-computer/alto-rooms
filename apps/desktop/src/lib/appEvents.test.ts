import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onBeforeQuitFlush, runQuitFlush } from "./appEvents";
import { attachNoteSaver, createNoteSaver, flushAllNoteSaversAndWait, resetNoteSavers, type NoteSaver } from "./noteSaver";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  resetNoteSavers();
  vi.useRealTimers();
});

/** A registered saver whose saves stay pending until the test settles them. */
function pendingSaver(key: string) {
  const calls: { text: string; resolve: () => void }[] = [];
  const save = vi.fn(
    (text: string) => new Promise<{ updatedAt: string }>((resolve) => calls.push({ text, resolve: () => resolve({ updatedAt: new Date().toISOString() }) })),
  );
  const { saver } = attachNoteSaver(key, () => createNoteSaver({ save, warn: () => {} }));
  saver.load("", null);
  return { saver: saver as NoteSaver, calls };
}

describe("flushAllNoteSaversAndWait", () => {
  it("resolves at once when nothing is unsaved", async () => {
    pendingSaver("2026-10-05/a.md");
    await expect(flushAllNoteSaversAndWait(2000)).resolves.toBe(true);
  });

  it("skips the debounce and resolves when the save lands", async () => {
    const { saver, calls } = pendingSaver("2026-10-05/a.md");
    saver.edit("할 일");
    const p = flushAllNoteSaversAndWait(2000);
    expect(calls.map((c) => c.text)).toEqual(["할 일"]); // sent now, not after 800ms
    let result: boolean | undefined;
    void p.then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(100);
    expect(result).toBeUndefined();
    calls[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe(true);
  });

  it("gives up after the cap when a save never lands", async () => {
    const { saver } = pendingSaver("2026-10-05/a.md");
    saver.edit("x");
    let result: boolean | undefined;
    void flushAllNoteSaversAndWait(2000).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(1999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
  });
});

describe("runQuitFlush", () => {
  it("runs the hooks, waits for notes (capped), then answers flush_done", async () => {
    const order: string[] = [];
    const off = onBeforeQuitFlush(() => order.push("hook"));
    const { saver, calls } = pendingSaver("2026-10-05/a.md");
    saver.edit("x");
    const done = vi.fn(async () => {
      order.push("done");
    });
    const p = runQuitFlush(2000, done);
    expect(order).toEqual(["hook"]);
    expect(calls).toHaveLength(1);
    calls[0].resolve();
    await p;
    expect(order).toEqual(["hook", "done"]);
    off();
  });

  it("answers even when a hook throws or the notes time out", async () => {
    const off = onBeforeQuitFlush(() => {
      throw new Error("boom");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { saver } = pendingSaver("2026-10-05/a.md");
    saver.edit("x");
    const done = vi.fn(async () => {});
    const p = runQuitFlush(2000, done);
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(done).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    off();
  });
});
