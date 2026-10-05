import type { Artifact } from "@alto-rooms/protocol-ts";
import { describe, expect, it, vi } from "vitest";
import { VIEWER_STORAGE_KEY, ViewerStore } from "./viewerStore";

function memoryStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    map: m,
  };
}

function clock(start = "2026-10-05T00:00:00Z") {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    set: (iso: string) => {
      t = Date.parse(iso);
    },
  };
}

function art(roomId: string, createdAt: string): Artifact {
  return {
    id: "a",
    roomId,
    relPath: "a.html",
    title: "a",
    createdAt,
    updatedAt: createdAt,
    author: "agent",
    source: { agent: null, session: null, cwd: null, machine: null },
  };
}

describe("ViewerStore", () => {
  it("starts with a single active new tab and firstRunAt = now", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    const s = st.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].kind).toBe("new");
    expect(s.activeId).toBe(s.tabs[0].id);
    expect(s.firstRunAt).toBe("2026-10-05T00:00:00.000Z");
    expect(s.sidebarOpen).toBe(true);
  });

  it("open de-duplicates equal tabs and re-activates the existing one", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    const a = st.open({ kind: "room", roomId: "r1" });
    const b = st.open({ kind: "doc", roomId: "r1", artifactId: "x" });
    expect(st.getState().activeId).toBe(b);
    expect(st.open({ kind: "room", roomId: "r1" })).toBe(a);
    expect(st.getState().activeId).toBe(a);
    expect(st.open({ kind: "doc", roomId: "r1", artifactId: "y" })).not.toBe(b);
    expect(st.open({ kind: "note", date: "2026-10-05", name: "n" })).toBe(st.open({ kind: "note", date: "2026-10-05", name: "n" }));
    expect(st.getState().tabs).toHaveLength(5);
  });

  it("open with activate: false adds without activating", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    const active = st.getState().activeId;
    const id = st.open({ kind: "journal", date: "2026-10-05" }, { activate: false });
    expect(st.getState().activeId).toBe(active);
    expect(st.getState().tabs.map((t) => t.id)).toContain(id);
  });

  it("close activates the right neighbour, else left, else null", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    const n = st.getState().tabs[0].id;
    const a = st.open({ kind: "room", roomId: "a" });
    const b = st.open({ kind: "room", roomId: "b" });
    st.activate(a);
    st.close(a);
    expect(st.getState().activeId).toBe(b);
    st.close(b);
    expect(st.getState().activeId).toBe(n);
    st.close(n);
    expect(st.getState().activeId).toBeNull();
    expect(st.getState().tabs).toEqual([]);
  });

  it("replace swaps a tab's id fields in place, keeping its id and position", () => {
    const v = new ViewerStore(memoryStorage());
    const j = v.open({ kind: "journal", date: "2026-10-04" });
    v.open({ kind: "room", roomId: "r1" });
    v.replace(j, { kind: "journal", date: "2026-10-05" });
    expect(v.getState().tabs[1]).toEqual({ id: j, kind: "journal", date: "2026-10-05" });
    const before = v.getState();
    v.replace(j, { kind: "journal", date: "2026-10-05" });
    v.replace("missing", { kind: "new" });
    expect(v.getState()).toBe(before);
  });

  it("closing an inactive tab keeps the active one", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    const n = st.getState().tabs[0].id;
    const a = st.open({ kind: "room", roomId: "a" });
    st.close(n);
    expect(st.getState().activeId).toBe(a);
  });

  it("records lastVisit when leaving a room tab", () => {
    const c = clock();
    const st = new ViewerStore(memoryStorage(), c.now);
    const r = st.open({ kind: "room", roomId: "r1" });
    c.set("2026-10-05T01:00:00Z");
    st.open({ kind: "doc", roomId: "r1", artifactId: "x" });
    expect(st.getState().lastVisit).toEqual({ r1: "2026-10-05T01:00:00.000Z" });
    c.set("2026-10-05T02:00:00Z");
    st.activate(r);
    expect(st.getState().lastVisit.r1).toBe("2026-10-05T01:00:00.000Z");
    c.set("2026-10-05T03:00:00Z");
    st.close(r);
    expect(st.getState().lastVisit.r1).toBe("2026-10-05T03:00:00.000Z");
  });

  it("flush records lastVisit for the active room tab and persists it", () => {
    const c = clock();
    const storage = memoryStorage();
    const st = new ViewerStore(storage, c.now);
    st.flush(); // active tab is "new": nothing to record
    expect(st.getState().lastVisit).toEqual({});
    st.open({ kind: "room", roomId: "r1" });
    c.set("2026-10-05T04:00:00Z");
    st.flush();
    expect(st.getState().lastVisit.r1).toBe("2026-10-05T04:00:00.000Z");
    expect(st.getState().activeId).not.toBeNull();
    expect(new ViewerStore(storage, c.now).getState().lastVisit.r1).toBe("2026-10-05T04:00:00.000Z");
  });

  it("isNew compares instants, using firstRunAt for rooms never visited", () => {
    const c = clock("2026-10-05T00:00:00Z");
    const st = new ViewerStore(memoryStorage(), c.now);
    // Same instant expressed with a +09:00 offset is not newer.
    expect(st.isNew(art("never", "2026-10-05T09:00:00+09:00"))).toBe(false);
    expect(st.isNew(art("never", "2026-10-05T09:00:01+09:00"))).toBe(true);
    expect(st.isNew(art("never", "2026-10-04T23:59:59Z"))).toBe(false);

    st.open({ kind: "room", roomId: "r1" });
    c.set("2026-10-05T05:00:00Z");
    st.open({ kind: "new" });
    expect(st.isNew(art("r1", "2026-10-05T04:00:00Z"))).toBe(false);
    expect(st.isNew(art("r1", "2026-10-05T06:00:00Z"))).toBe(true);
    expect(st.isNew(art("never", "2026-10-05T04:00:00Z"))).toBe(true);
  });

  it("persists across instances under alto-rooms.viewer.v1", () => {
    const storage = memoryStorage();
    const c = clock();
    const st = new ViewerStore(storage, c.now);
    const r = st.open({ kind: "room", roomId: "r1" });
    st.setSidebarOpen(false);
    expect(storage.map.has(VIEWER_STORAGE_KEY)).toBe(true);
    expect(VIEWER_STORAGE_KEY).toBe("alto-rooms.viewer.v1");

    c.set("2026-10-06T00:00:00Z");
    const st2 = new ViewerStore(storage, c.now);
    expect(st2.getState()).toEqual(st.getState());
    expect(st2.getState().activeId).toBe(r);
    expect(st2.getState().firstRunAt).toBe("2026-10-05T00:00:00.000Z");
  });

  it("starts fresh on corrupt storage without throwing", () => {
    const storage = memoryStorage({ [VIEWER_STORAGE_KEY]: "{not json" });
    const st = new ViewerStore(storage, clock().now);
    expect(st.getState().tabs.map((t) => t.kind)).toEqual(["new"]);
    const st2 = new ViewerStore(memoryStorage({ [VIEWER_STORAGE_KEY]: JSON.stringify({ tabs: "nope" }) }), clock().now);
    expect(st2.getState().tabs.map((t) => t.kind)).toEqual(["new"]);
  });

  it("survives storage that throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const st = new ViewerStore(storage, clock().now);
    expect(() => st.open({ kind: "room", roomId: "r1" })).not.toThrow();
  });

  it("returns the same state object when nothing changed and notifies on change", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    const l = vi.fn();
    st.subscribe(l);
    const before = st.getState();
    st.activate(before.activeId!);
    st.setSidebarOpen(true);
    expect(st.getState()).toBe(before);
    expect(l).not.toHaveBeenCalled();
    st.setSidebarOpen(false);
    expect(st.getState()).not.toBe(before);
    expect(l).toHaveBeenCalledTimes(1);
  });
});

describe("ViewerStore: onboarding", () => {
  it("openOnboarding activates the existing New tab (or opens one) and flags it, without persisting the flag", () => {
    const storage = memoryStorage();
    const st = new ViewerStore(storage, clock().now);
    const first = st.getState().activeId!;
    st.open({ kind: "room", roomId: "r1" });
    st.openOnboarding();
    expect(st.getState().activeId).toBe(first);
    expect(st.getState().onboardingTabId).toBe(first);
    expect(storage.map.get(VIEWER_STORAGE_KEY)).not.toContain("onboarding");
    expect(new ViewerStore(storage, clock().now).getState().onboardingTabId).toBeNull();

    st.close(first);
    st.openOnboarding();
    const created = st.getState().tabs.find((t) => t.kind === "new")!;
    expect(st.getState().activeId).toBe(created.id);
    expect(st.getState().onboardingTabId).toBe(created.id);
  });

  it("the flag clears when the tab stops being active, or closes", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    const r = st.open({ kind: "room", roomId: "r1" });
    st.openOnboarding();
    const n = st.getState().onboardingTabId!;
    st.activate(r);
    expect(st.getState().onboardingTabId).toBeNull();
    st.activate(n);
    expect(st.getState().onboardingTabId).toBeNull();
    st.openOnboarding();
    st.close(n);
    expect(st.getState().onboardingTabId).toBeNull();
  });
});
