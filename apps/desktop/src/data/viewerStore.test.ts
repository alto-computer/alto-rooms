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
    source: { agent: null, session: null, cwd: null, machine: null }, fileKey: "0000000000000000",
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

  it("close activates the right neighbour, else left, else a fresh New tab", () => {
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
    const [only] = st.getState().tabs;
    expect(only.kind).toBe("new");
    expect(only.id).not.toBe(n);
    expect(st.getState().activeId).toBe(only.id);
  });

  it("reopen brings back closed tabs, newest first, at their old place with their history", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    const n = st.getState().tabs[0].id;
    const a = st.open({ kind: "room", roomId: "a" });
    st.navigate({ kind: "room", roomId: "a2" });
    st.open({ kind: "room", roomId: "b" });
    st.close(a);
    st.activate(n);
    st.reopen();
    const tabs = st.getState().tabs;
    expect(tabs.map((t) => (t.kind === "room" ? t.roomId : t.kind))).toEqual(["new", "a2", "b"]);
    expect(st.getState().activeId).toBe(tabs[1].id);
    expect(st.canGoBack()).toBe(true);
    st.reopen(); // nothing left
    expect(st.getState().tabs).toHaveLength(3);
  });

  it("activateAt picks by index (-1 = last); cycle wraps around", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    const n = st.getState().tabs[0].id;
    const a = st.open({ kind: "room", roomId: "a" });
    const b = st.open({ kind: "room", roomId: "b" });
    st.activateAt(0);
    expect(st.getState().activeId).toBe(n);
    st.activateAt(-1);
    expect(st.getState().activeId).toBe(b);
    st.activateAt(7);
    expect(st.getState().activeId).toBe(b);
    st.cycle(1);
    expect(st.getState().activeId).toBe(n);
    st.cycle(-1);
    expect(st.getState().activeId).toBe(b);
    st.cycle(-1);
    expect(st.getState().activeId).toBe(a);
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

  it("move reorders a tab, clamping the index and keeping the active tab", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    const a = st.getState().tabs[0].id;
    const b = st.open({ kind: "room", roomId: "r1" });
    const c = st.open({ kind: "room", roomId: "r2" });
    st.move(c, 0);
    expect(st.getState().tabs.map((t) => t.id)).toEqual([c, a, b]);
    st.move(c, 99);
    expect(st.getState().tabs.map((t) => t.id)).toEqual([a, b, c]);
    expect(st.getState().activeId).toBe(c);
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

describe("ViewerStore: in-tab history", () => {
  const room = (roomId: string) => ({ kind: "room", roomId }) as const;
  const doc = (artifactId: string) => ({ kind: "doc", roomId: "r1", artifactId }) as const;
  const activeTab = (st: ViewerStore) => st.getState().tabs.find((t) => t.id === st.getState().activeId)!;

  it("navigate changes the active tab in place and back/forward walk its history", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    const id = st.getState().activeId!;
    st.navigate(room("r1"));
    st.navigate(doc("x"));
    expect(st.getState().tabs).toHaveLength(1);
    expect(activeTab(st)).toEqual({ id, ...doc("x") });
    expect(st.canGoBack()).toBe(true);
    expect(st.canGoForward()).toBe(false);

    st.back();
    expect(activeTab(st)).toEqual({ id, ...room("r1") });
    expect(st.canGoForward()).toBe(true);
    st.back();
    expect(activeTab(st)).toEqual({ id, kind: "new" });
    expect(st.canGoBack()).toBe(false);
    st.back();
    expect(activeTab(st)).toEqual({ id, kind: "new" });

    st.forward();
    st.forward();
    expect(activeTab(st)).toEqual({ id, ...doc("x") });
  });

  it("navigating after going back drops the forward entries", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    st.navigate(room("r1"));
    st.navigate(doc("x"));
    st.back();
    st.navigate(doc("y"));
    expect(st.canGoForward()).toBe(false);
    st.back();
    expect(activeTab(st).kind).toBe("room");
  });

  it("navigating to what the tab already shows adds nothing", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    st.navigate(room("r1"));
    st.navigate(room("r1"));
    st.back();
    expect(activeTab(st).kind).toBe("new");
  });

  it("each tab keeps its own history; a new tab starts without one", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    st.navigate(room("r1"));
    const second = st.open({ kind: "new" });
    expect(st.getState().activeId).toBe(second);
    expect(st.canGoBack()).toBe(false);
    st.navigate(room("r2"));
    st.back();
    expect(activeTab(st).kind).toBe("new");
  });

  it("records lastVisit when navigating away from a room and when going back from it", () => {
    const c = clock("2026-10-05T01:00:00Z");
    const st = new ViewerStore(memoryStorage(), c.now);
    st.navigate(room("r1"));
    c.set("2026-10-05T02:00:00Z");
    st.navigate(doc("x"));
    expect(st.getState().lastVisit.r1).toBe("2026-10-05T02:00:00.000Z");
    st.back();
    c.set("2026-10-05T03:00:00Z");
    st.back();
    expect(st.getState().lastVisit.r1).toBe("2026-10-05T03:00:00.000Z");
  });

  it("navKey changes on every navigation, so the view remounts even between two rooms", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    const id = st.getState().activeId!;
    st.navigate(room("r1"));
    const k1 = st.navKey(id);
    st.navigate(room("r2"));
    const k2 = st.navKey(id);
    st.back();
    expect(new Set([k1, k2, st.navKey(id)]).size).toBe(3);
  });

  it("persists history across instances and drops it when the tab closes", () => {
    const storage = memoryStorage();
    const st = new ViewerStore(storage, clock().now);
    st.navigate(room("r1"));
    st.navigate(doc("x"));
    const again = new ViewerStore(storage, clock().now);
    expect(again.canGoBack()).toBe(true);
    again.back();
    expect(activeTab(again).kind).toBe("room");
    again.close(again.getState().activeId!);
    expect(JSON.parse(storage.map.get(VIEWER_STORAGE_KEY)!).history).toEqual({});
  });

  it("keeps at most 50 back entries per tab", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    for (let i = 0; i < 60; i++) st.navigate(room(`r${i}`));
    let steps = 0;
    while (st.canGoBack()) {
      st.back();
      steps++;
    }
    expect(steps).toBe(50);
  });

  it("navigate with no tab open opens one", () => {
    const st = new ViewerStore(memoryStorage(), clock().now);
    st.close(st.getState().activeId!);
    st.navigate(room("r1"));
    expect(st.getState().tabs).toHaveLength(1);
    expect(activeTab(st).kind).toBe("room");
  });
});

describe("ViewerStore: plugins", () => {
  it("plugin tabs open, navigate, persist and come back", () => {
    const storage = memoryStorage();
    const st = new ViewerStore(storage, clock().now);
    st.navigate({ kind: "plugin", pluginId: "goals" });
    const id = st.getState().activeId!;
    expect(st.getState().tabs.find((t) => t.id === id)).toEqual({ id, kind: "plugin", pluginId: "goals" });
    st.navigate({ kind: "room", roomId: "r1" });
    st.back();
    expect(st.getState().tabs[0]).toMatchObject({ kind: "plugin", pluginId: "goals" });
    const again = new ViewerStore(storage, clock().now);
    expect(again.getState().tabs[0]).toMatchObject({ kind: "plugin", pluginId: "goals" });
    expect(st.open({ kind: "plugin", pluginId: "goals" })).toBe(id);
  });

  it("the side panel state defaults to closed, persists, and ignores junk", () => {
    const storage = memoryStorage();
    const st = new ViewerStore(storage, clock().now);
    expect(st.getState().pluginPanel).toEqual({ open: false, width: 360, pluginId: null });
    st.setPluginPanel({ open: true, pluginId: "excalidraw" });
    st.setPluginPanel({ width: 480 });
    expect(new ViewerStore(storage, clock().now).getState().pluginPanel).toEqual({ open: true, width: 480, pluginId: "excalidraw" });
    storage.map.set(VIEWER_STORAGE_KEY, JSON.stringify({ ...JSON.parse(storage.map.get(VIEWER_STORAGE_KEY)!), pluginPanel: { open: "yes", width: -5 } }));
    expect(new ViewerStore(storage, clock().now).getState().pluginPanel).toEqual({ open: false, width: 360, pluginId: null });
  });
});
