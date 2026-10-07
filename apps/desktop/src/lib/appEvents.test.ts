import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onBeforeQuitFlush, onQuitFlushAsync, runQuitFlush } from "./appEvents";
import { setDraftStoreForTests, tauriDraftStore, textHash } from "./drafts";
import { createNoteSaver, type NoteSaver } from "./noteSaver";
import { attachNoteSaver, flushAllNoteSaversAndWait, noteSaverKey, resetNoteSavers } from "./noteSaverRegistry";

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

describe("runQuitFlush async hooks", () => {
  it("waits for an async hook that finishes in time, alongside the notes", async () => {
    const order: string[] = [];
    const off = onQuitFlushAsync(async () => {
      await new Promise((r) => setTimeout(r, 200));
      order.push("plugins");
    });
    const done = vi.fn(async () => void order.push("done"));
    const p = runQuitFlush(2000, done);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(order).toEqual(["plugins", "done"]);
    off();
  });

  it("does not wait past the note window for a hook that never finishes", async () => {
    const off = onQuitFlushAsync(() => new Promise<void>(() => {}));
    const done = vi.fn(async () => {});
    const p = runQuitFlush(2000, done);
    await vi.advanceTimersByTimeAsync(1600);
    await p;
    expect(done).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("runQuitFlush drafts", () => {
  const KEY = "alto-rooms.note-draft.v1:2026-10-05/계획.md";
  afterEach(() => {
    localStorage.clear();
    setDraftStoreForTests(null);
  });

  function target(save: (text: string) => Promise<{ updatedAt: string }>, body = "") {
    const { saver } = attachNoteSaver(noteSaverKey("2026-10-05", "계획.md"), () => createNoteSaver({ save, warn: () => {} }), {
      date: "2026-10-05",
      name: "계획.md",
    });
    saver.load(body, null);
    return saver;
  }

  it("keeps the text of a note that could not be saved as a draft with the hash of its last known disk body", async () => {
    const saver = target(async () => Promise.reject(new Error("write_failed")), "디스크 본문");
    saver.edit("잃으면 안 되는 글");
    await vi.advanceTimersByTimeAsync(800 + 1000 + 2000); // now in error
    expect(saver.getState().status).toBe("error");
    const p = runQuitFlush(2000, async () => {});
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ v: 1, text: "잃으면 안 되는 글", baseHash: textHash("디스크 본문") });
  });

  it("answers flush_done only after the draft write has finished, within the cap", async () => {
    let finish!: () => void;
    const save = vi.fn(() => new Promise<void>((r) => (finish = r)));
    setDraftStoreForTests({ save, load: async () => null, remove: async () => {} });
    const saver = target(async () => Promise.reject(new Error("write_failed")));
    saver.edit("글");
    await vi.advanceTimersByTimeAsync(800 + 1000 + 2000);
    const done = vi.fn(async () => {});
    const p = runQuitFlush(2000, done);
    await vi.advanceTimersByTimeAsync(1700); // the notes' share of the cap
    expect(save).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
    finish();
    await p;
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("writes no draft when every note landed", async () => {
    const saver = target(async () => ({ updatedAt: "2026-10-05T01:00:00Z" }));
    saver.edit("저장됨");
    await runQuitFlush(2000, async () => {});
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe("tauriDraftStore", () => {
  it("goes through the Rust draft commands", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValueOnce(undefined).mockResolvedValueOnce("값").mockResolvedValueOnce(undefined);
    await tauriDraftStore.save("k", "v");
    expect(await tauriDraftStore.load("k")).toBe("값");
    await tauriDraftStore.remove("k");
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["save_note_draft", { key: "k", value: "v" }],
      ["load_note_draft", { key: "k" }],
      ["delete_note_draft", { key: "k" }],
    ]);
  });
});
