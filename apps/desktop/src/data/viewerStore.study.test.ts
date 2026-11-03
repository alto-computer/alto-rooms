import { describe, expect, it } from "vitest";
import { memoryStorage } from "@/test/fakes";
import { VIEWER_STORAGE_KEY, ViewerStore, type TabInput } from "./viewerStore";

/** A viewer restarted on storage that holds `tabs`, as a saved session would. */
function restartWith(tabs: unknown[]) {
  const storage = memoryStorage();
  storage.setItem(VIEWER_STORAGE_KEY, JSON.stringify({ tabs, activeId: null, firstRunAt: "2026-11-01T00:00:00Z" }));
  return new ViewerStore(storage).getState().tabs.map(({ id: _id, ...rest }) => rest);
}

const PAGES: TabInput[] = [
  { kind: "study", page: "library" },
  { kind: "study", page: "room", roomId: "s000000001" },
  { kind: "study", page: "volume", roomId: "s000000001", number: 3 },
  { kind: "study", page: "day", date: "2026-11-03" },
  { kind: "study", page: "book", date: "2026-11-03" },
  { kind: "study", page: "shelf" },
];

describe("Study tabs", () => {
  it("survive a restart with exactly their page fields", () => {
    const storage = memoryStorage();
    const viewer = new ViewerStore(storage);
    for (const t of PAGES) viewer.open(t);
    viewer.flush();
    const back = new ViewerStore(storage).getState().tabs.map(({ id: _id, ...rest }) => rest);
    expect(back.slice(1)).toEqual(PAGES);
  });

  it("drop fields that belong to another page, and one tab per page", () => {
    const viewer = new ViewerStore(memoryStorage());
    const id = viewer.open({ kind: "study", page: "room", roomId: "s1", number: 2, date: "2026-11-03" } as unknown as TabInput);
    expect(viewer.getState().tabs.find((t) => t.id === id)).toEqual({ id, kind: "study", page: "room", roomId: "s1" });
    expect(viewer.open({ kind: "study", page: "room", roomId: "s1" })).toBe(id);
    expect(viewer.open({ kind: "study", page: "volume", roomId: "s1", number: 1 })).not.toBe(id);
    const book = viewer.open({ kind: "study", page: "book", date: "2026-11-03" });
    expect(book).not.toBe(viewer.open({ kind: "study", page: "day", date: "2026-11-03" }));
    expect(viewer.open({ kind: "study", page: "book", date: "2026-11-03" })).toBe(book);
  });

  it("from storage, refuse a page that is unknown or missing its fields", () => {
    const tabs = restartWith([
      { id: "a", kind: "study", page: "attic" },
      { id: "b", kind: "study" },
      { id: "c", kind: "study", page: "room" },
      { id: "d", kind: "study", page: "room", roomId: "" },
      { id: "e", kind: "study", page: "volume", roomId: "s1", number: 0 },
      { id: "f", kind: "study", page: "volume", roomId: "s1", number: 1.5 },
      { id: "g", kind: "study", page: "volume", roomId: "s1", number: "2" },
      { id: "h", kind: "study", page: "day", date: "11/03/2026" },
      { id: "i", kind: "study", page: "day" },
      { id: "k", kind: "study", page: "book", date: "2026-11-3" },
      { id: "l", kind: "study", page: "book" },
      { id: "j", kind: "study", page: "volume", roomId: "s1", number: 2, extra: "kept?" },
    ]);
    expect(tabs).toEqual([{ kind: "study", page: "volume", roomId: "s1", number: 2 }]);
  });
});
