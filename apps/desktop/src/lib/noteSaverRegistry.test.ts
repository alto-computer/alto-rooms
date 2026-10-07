import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoteSaver } from "./noteSaver";
import {
  attachNoteSaver,
  detachNoteSaver,
  flushNoteSaverAndWait,
  noteSaverKey,
  noteSaverKeys,
  rebindNoteSavers,
  renameNoteSaver,
  resetNoteSavers,
} from "./noteSaverRegistry";

/** A save fn whose calls stay pending until the test settles them. */
function controlledSave() {
  const calls: { text: string; d: { resolve: (updatedAt: string) => void; reject: (e: unknown) => void } }[] = [];
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

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("noteSaver registry: keys and rebinding", () => {
  afterEach(() => {
    resetNoteSavers();
  });

  it("case-folds the key after NFC, so Plan.md and plan.md share one saver", () => {
    const D = "2026-10-05";
    expect(noteSaverKey(D, "Plan.md")).toBe(noteSaverKey(D, "plan.md"));
    expect(noteSaverKey(D, "계획.md".normalize("NFD"))).toBe(noteSaverKey(D, "계획.md"));
    const create = () => createNoteSaver({ save: async () => ({ updatedAt: "" }), warn: () => {} });
    const a = attachNoteSaver(noteSaverKey(D, "Plan.md"), create);
    const b = attachNoteSaver(noteSaverKey(D, "plan.md"), create);
    expect(b.fresh).toBe(false);
    expect(b.saver).toBe(a.saver);
    expect(noteSaverKeys()).toHaveLength(1);
  });

  it("rebindNoteSavers switches live savers to the new client and retries now", async () => {
    const D = "2026-10-05";
    const oldSave = failing();
    const { saver: s } = attachNoteSaver(
      noteSaverKey(D, "계획.md"),
      () => createNoteSaver({ save: oldSave, warn: () => {} }),
      { date: D, name: "계획.md" },
    );
    s.load("", null);
    s.edit("살릴 글");
    await tick(800);
    expect(oldSave).toHaveBeenCalledTimes(1);
    const newSaveNote = vi.fn(async (_date: string, _name: string, _text: string) => ({ updatedAt: "2026-10-05T02:00:00Z" }));
    rebindNoteSavers(newSaveNote);
    await tick(0);
    expect(newSaveNote).toHaveBeenCalledWith(D, "계획.md", "살릴 글");
    expect(s.getState().savedText).toBe("살릴 글");
    await tick(60_000);
    expect(oldSave).toHaveBeenCalledTimes(1);
  });
});

describe("noteSaver registry: flush one note and rename", () => {
  const D = "2026-10-05";
  afterEach(() => {
    resetNoteSavers();
  });

  it("flushNoteSaverAndWait resolves only after the in-flight save and the dirty follow-up land", async () => {
    const { save, calls } = controlledSave();
    const key = noteSaverKey(D, "New Note.md");
    const { saver: s } = attachNoteSaver(key, () => createNoteSaver({ save, warn: () => {} }), { date: D, name: "New Note.md" });
    s.load("", null);
    s.edit("a");
    s.flush(); // "a" in flight
    s.edit("ab"); // dirty during flight, debounce pending
    let done: boolean | null = null;
    void flushNoteSaverAndWait(key).then((ok) => (done = ok));
    await tick(0);
    expect(done).toBeNull();
    calls[0].d.resolve("2026-10-05T01:00:00Z");
    await tick(0);
    expect(calls).toHaveLength(2); // the follow-up is immediate, not after 800ms
    expect(calls[1].text).toBe("ab");
    expect(done).toBeNull();
    calls[1].d.resolve("2026-10-05T01:00:01Z");
    await tick(0);
    expect(done).toBe(true);
  });

  it("flushNoteSaverAndWait is true right away with no saver, and false when the save keeps failing", async () => {
    await expect(flushNoteSaverAndWait(noteSaverKey(D, "none.md"))).resolves.toBe(true);
    const key = noteSaverKey(D, "a.md");
    const { saver: s } = attachNoteSaver(key, () => createNoteSaver({ save: failing(), warn: () => {} }), { date: D, name: "a.md" });
    s.load("", null);
    s.edit("x");
    let done: boolean | null = null;
    void flushNoteSaverAndWait(key, 3000).then((ok) => (done = ok));
    await tick(2999);
    expect(done).toBeNull();
    await tick(1);
    expect(done).toBe(false);
  });

  it("renameNoteSaver re-keys the entry and saves under the new name; the old key's detach still releases it", async () => {
    const oldKey = noteSaverKey(D, "New Note.md");
    const newKey = noteSaverKey(D, "회고.md");
    const oldSave = vi.fn(async (_t: string) => ({ updatedAt: "2026-10-05T01:00:00Z" }));
    const { saver: s } = attachNoteSaver(oldKey, () => createNoteSaver({ save: oldSave, warn: () => {} }), { date: D, name: "New Note.md" });
    s.load("", null);
    const saveNote = vi.fn(async (_d: string, _n: string, _t: string) => ({ updatedAt: "2026-10-05T02:00:00Z" }));
    expect(renameNoteSaver(oldKey, newKey, { date: D, name: "회고.md" }, saveNote)).toBe(true);
    expect(noteSaverKeys()).toEqual([newKey]);
    // The view re-renders with the new name and attaches there: same live saver, not a fresh one.
    const again = attachNoteSaver(newKey, () => createNoteSaver({ save: oldSave, warn: () => {} }));
    expect(again).toMatchObject({ saver: s, fresh: false });
    s.edit("본문");
    await tick(800);
    expect(oldSave).not.toHaveBeenCalled();
    expect(saveNote).toHaveBeenCalledWith(D, "회고.md", "본문");
    // Rebinding later (a new connection) keeps the new name.
    const next = vi.fn(async (_d: string, _n: string, _t: string) => ({ updatedAt: "2026-10-05T03:00:00Z" }));
    rebindNoteSavers(next);
    s.edit("본문2");
    await tick(800);
    expect(next).toHaveBeenCalledWith(D, "회고.md", "본문2");
    // The old mount detaches with its old key, the new one with the new key: then it is released.
    detachNoteSaver(oldKey, s);
    expect(noteSaverKeys()).toEqual([newKey]);
    detachNoteSaver(newKey, s);
    expect(noteSaverKeys()).toEqual([]);
  });

  it("renameNoteSaver refuses when another live saver holds the new key, and keeps both", async () => {
    const aKey = noteSaverKey(D, "a.md");
    const bKey = noteSaverKey(D, "b.md");
    const aSave = vi.fn(async (_t: string) => ({ updatedAt: "2026-10-05T01:00:00Z" }));
    const bSave = failing(); // b is dirty and retrying
    const { saver: a } = attachNoteSaver(aKey, () => createNoteSaver({ save: aSave, warn: () => {} }), { date: D, name: "a.md" });
    const { saver: b } = attachNoteSaver(bKey, () => createNoteSaver({ save: bSave, warn: () => {} }), { date: D, name: "b.md" });
    a.load("", null);
    b.load("", null);
    b.edit("b의 글");
    const saveNote = vi.fn(async (_d: string, _n: string, _t: string) => ({ updatedAt: "" }));
    expect(renameNoteSaver(aKey, bKey, { date: D, name: "b.md" }, saveNote)).toBe(false);
    expect(noteSaverKeys().sort()).toEqual([aKey, bKey].sort());
    expect(attachNoteSaver(bKey, () => createNoteSaver({ save: aSave, warn: () => {} })).saver).toBe(b);
    a.edit("a의 글");
    await tick(800);
    expect(aSave).toHaveBeenCalledWith("a의 글"); // a still writes a.md
    expect(saveNote).not.toHaveBeenCalled();
    expect(b.getState().text).toBe("b의 글");
  });

  it("renameNoteSaver with a case-only change keeps one entry", () => {
    const key = noteSaverKey(D, "a.md");
    const { saver: s } = attachNoteSaver(key, () => createNoteSaver({ save: failing(), warn: () => {} }), { date: D, name: "a.md" });
    expect(renameNoteSaver(key, noteSaverKey(D, "A.md"), { date: D, name: "A.md" }, vi.fn())).toBe(true);
    expect(noteSaverKeys()).toEqual([key]);
    detachNoteSaver(key, s);
    expect(noteSaverKeys()).toEqual([]);
  });
});
