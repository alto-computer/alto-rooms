import type { Artifact, Info, JournalDay, Room, RoomsEvent, Snapshot } from "@alto-rooms/protocol-ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomsStore, type RoomsClientLike } from "./roomsStore";

const INFO: Info = {
  version: "0.1.0",
  readOnly: false,
  home: "/h",
  journalRoomId: "journal",
  filesOrigin: "http://127.0.0.1:4318",
};

function room(id: string, name = id): Room {
  return { id, name, kind: "owned", path: `/h/${id}`, status: "ok", artifactCount: 0, updatedAt: null };
}

function art(id: string, roomId = "r1", createdAt = `2026-10-05T00:00:0${id.slice(-1)}Z`): Artifact {
  return {
    id,
    roomId,
    relPath: `${id}.html`,
    title: id,
    createdAt,
    updatedAt: createdAt,
    author: "agent",
    source: { agent: null, session: null, cwd: null, machine: null },
  };
}

function day(date: string, n = 0): JournalDay {
  return { date, artifacts: [], notes: Array.from({ length: n }, (_, i) => ({ date, name: `n${i}`, relPath: `n${i}.md`, updatedAt: date, author: "me" })) };
}

/** Scripted roomsd: snapshot results are captured at call time; `hold()` delays responses until `release*()`. */
class FakeClient implements RoomsClientLike {
  infoResult: Info | Error = INFO;
  rooms: Snapshot<Room[]> | Error = { data: [], seq: 0 };
  artifacts = new Map<string, Snapshot<Artifact[]> | Error>();
  days = new Map<string, Snapshot<JournalDay>>();
  calls = { info: 0, listRooms: 0, listArtifacts: [] as string[], journalDay: [] as string[] };
  onEvent?: (e: RoomsEvent) => void;
  onOpen?: () => void;
  private held = false;
  private pending: Array<() => void> = [];

  hold() {
    this.held = true;
  }
  releaseAll() {
    this.held = false;
    const p = this.pending;
    this.pending = [];
    p.forEach((r) => r());
  }
  releaseReverse() {
    this.held = false;
    const p = this.pending;
    this.pending = [];
    p.reverse().forEach((r) => r());
  }
  private respond<T>(v: T | Error | undefined): Promise<T> {
    const settle = () => (v instanceof Error || v === undefined ? Promise.reject(v ?? new Error("404")) : Promise.resolve(v));
    if (!this.held) return settle();
    return new Promise<void>((r) => this.pending.push(r)).then(settle);
  }

  info() {
    this.calls.info++;
    return this.respond(this.infoResult);
  }
  listRooms() {
    this.calls.listRooms++;
    const r = this.rooms;
    return this.respond(r instanceof Error ? r : { data: [...r.data], seq: r.seq });
  }
  listArtifacts(roomId: string) {
    this.calls.listArtifacts.push(roomId);
    const a = this.artifacts.get(roomId);
    return this.respond(a instanceof Error || !a ? a : { data: [...a.data], seq: a.seq });
  }
  journalDay(date: string) {
    this.calls.journalDay.push(date);
    return this.respond(this.days.get(date));
  }
  subscribe(onEvent: (e: RoomsEvent) => void, onOpen?: () => void) {
    this.onEvent = onEvent;
    this.onOpen = onOpen;
    return () => {
      this.onEvent = undefined;
      this.onOpen = undefined;
    };
  }
  emit(e: RoomsEvent) {
    this.onEvent?.(e);
  }
  /** What a (re)connection looks like on the wire: onopen, then `resync {null}`. */
  connect(seq: number) {
    this.onOpen?.();
    this.emit({ seq, type: "resync", roomId: null });
  }
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

const ids = (s: RoomsStore, roomId = "r1") => s.getState().artifacts[roomId]?.map((a) => a.id);

async function liveStore(c: FakeClient, opts?: ConstructorParameters<typeof RoomsStore>[1]) {
  const s = new RoomsStore(c, opts);
  s.start();
  c.connect(c.rooms instanceof Error ? 0 : c.rooms.seq);
  await flush();
  return s;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RoomsStore sync", () => {
  it("goes live after the first sync with info and rooms in listRooms order", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r2"), room("r1")], seq: 3 };
    const s = new RoomsStore(c);
    expect(s.getState().status).toBe("connecting");
    s.start();
    c.connect(3);
    await flush();
    expect(s.getState().status).toBe("live");
    expect(s.getState().info).toEqual(INFO);
    expect(s.getState().rooms.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(s.getState().artifacts.r1).toBeUndefined();
    s.stop();
  });

  it("start() and onOpen only buffer; one connect causes exactly one listRooms", async () => {
    vi.useFakeTimers();
    const c = new FakeClient();
    c.rooms = { data: [room("r1")], seq: 3 };
    const s = new RoomsStore(c);
    s.start();
    c.onOpen?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls.listRooms).toBe(0);
    c.emit({ seq: 3, type: "resync", roomId: null });
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.calls.listRooms).toBe(1);
    expect(s.getState().status).toBe("live");

    c.connect(3); // reconnect
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.calls.listRooms).toBe(2);
    s.stop();
  });

  it("falls back to a sync 2s after start()/onOpen if no resync {null} arrives", async () => {
    vi.useFakeTimers();
    const c = new FakeClient();
    c.rooms = { data: [room("r1")], seq: 3 };
    const s = new RoomsStore(c);
    s.start();
    await vi.advanceTimersByTimeAsync(1999);
    expect(c.calls.listRooms).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.calls.listRooms).toBe(1);
    expect(s.getState().status).toBe("live");

    c.onOpen?.();
    await vi.advanceTimersByTimeAsync(1999);
    expect(c.calls.listRooms).toBe(1);
    c.emit({ seq: 2, type: "room.added", room: room("r2") }); // buffered, not applied
    expect(s.getState().rooms.map((r) => r.id)).toEqual(["r1"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.calls.listRooms).toBe(2);
    s.stop();
  });

  it("applies the snapshot and all queued events with a single notification", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r1")], seq: 1 };
    c.artifacts.set("r1", { data: [art("a1")], seq: 1 });
    const s = await liveStore(c);
    await s.loadArtifacts("r1");
    const l = vi.fn();
    s.subscribe(l);
    c.hold();
    c.rooms = { data: [room("r1"), room("r2")], seq: 2 };
    c.connect(2);
    c.emit({ seq: 3, type: "room.added", room: room("r3") });
    c.emit({ seq: 4, type: "artifact.added", artifact: art("a2") });
    c.emit({ seq: 5, type: "room.updated", room: room("r1", "One") });
    c.releaseAll();
    await flush();
    expect(s.getState().rooms.map((r) => r.name)).toEqual(["One", "r2", "r3"]);
    expect(ids(s)).toEqual(["a1", "a2"]);
    expect(l).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it("prunes watched rooms that vanished while disconnected, except the journal room", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r1"), room("r2")], seq: 1 };
    c.artifacts.set("r1", { data: [art("a1")], seq: 1 });
    c.artifacts.set("r2", { data: [art("b1", "r2")], seq: 1 });
    c.artifacts.set("journal", { data: [art("j1", "journal")], seq: 1 });
    const warn = vi.fn();
    const s = await liveStore(c, { warn });
    await s.loadArtifacts("r1");
    await s.loadArtifacts("r2");
    await s.loadArtifacts("journal"); // not in listRooms

    c.rooms = { data: [room("r1")], seq: 5 }; // r2 deleted while disconnected
    c.artifacts.delete("r2");
    c.connect(5);
    await flush();
    expect("r2" in s.getState().artifacts).toBe(false);
    expect(s.getState().errors["room:r2"]).toBeUndefined();
    expect(ids(s, "journal")).toEqual(["j1"]);
    expect(warn).not.toHaveBeenCalled();

    // No longer watched: the next resync does not ask for it.
    c.calls.listArtifacts = [];
    c.connect(5);
    await flush();
    expect(c.calls.listArtifacts.sort()).toEqual(["journal", "r1"]);
    s.stop();
  });

  it("reconnect gap: snapshot replaces stale data and stale buffered events are dropped", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r1")], seq: 5 };
    c.artifacts.set("r1", { data: [art("a1"), art("a2")], seq: 5 });
    const s = await liveStore(c);
    await s.loadArtifacts("r1");
    expect(ids(s)).toEqual(["a1", "a2"]);

    // Disconnected: server adds a3 (seq 6) and removes a1 (seq 7); we never see those events.
    c.rooms = { data: [room("r1")], seq: 7 };
    c.artifacts.set("r1", { data: [art("a2"), art("a3")], seq: 7 });

    c.connect(7);
    c.emit({ seq: 6, type: "artifact.added", artifact: art("a1") }); // newer than old seq 5, older than new 7
    await flush();
    expect(ids(s)).toEqual(["a2", "a3"]);
    expect(s.getState().status).toBe("live");
    s.stop();
  });

  it("buffers events during sync, drops seq <= snapshot seq, applies the rest after all fetches settle", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r1")], seq: 5 };
    c.artifacts.set("r1", { data: [art("a1")], seq: 5 });
    const s = await liveStore(c);
    await s.loadArtifacts("r1");

    c.hold();
    c.rooms = { data: [room("r1"), room("r2")], seq: 7 };
    c.artifacts.set("r1", { data: [art("a1"), art("a2")], seq: 7 });
    c.connect(7);
    c.emit({ seq: 6, type: "artifact.added", artifact: art("a3") }); // <= 7: drop
    c.emit({ seq: 8, type: "artifact.added", artifact: art("a4") }); // > 7: apply
    c.emit({ seq: 7, type: "room.added", room: room("r9") }); // <= 7: drop
    c.emit({ seq: 9, type: "room.added", room: room("r3") }); // > 7: apply
    await flush();
    expect(ids(s)).toEqual(["a1"]); // nothing applied while fetches are in flight
    expect(s.getState().rooms.map((r) => r.id)).toEqual(["r1"]);

    c.releaseAll();
    await flush();
    expect(ids(s)).toEqual(["a1", "a2", "a4"]);
    expect(s.getState().rooms.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);

    // Live mode: same per-scope rule.
    c.emit({ seq: 7, type: "artifact.removed", roomId: "r1", artifactId: "a1" });
    expect(ids(s)).toEqual(["a1", "a2", "a4"]);
    c.emit({ seq: 10, type: "artifact.removed", roomId: "r1", artifactId: "a1" });
    expect(ids(s)).toEqual(["a2", "a4"]);
    s.stop();
  });

  it("a second resync {null} mid-sync restarts it and stale results of the first are discarded", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r1")], seq: 5 };
    c.artifacts.set("r1", { data: [art("a1")], seq: 5 });
    const s = await liveStore(c);
    await s.loadArtifacts("r1");

    c.hold();
    c.rooms = { data: [room("r1"), room("old")], seq: 6 };
    c.artifacts.set("r1", { data: [art("a1"), art("a2")], seq: 6 });
    c.connect(6);
    c.rooms = { data: [room("r1")], seq: 8 };
    c.artifacts.set("r1", { data: [art("a3")], seq: 8 });
    c.emit({ seq: 8, type: "resync", roomId: null });
    c.emit({ seq: 9, type: "artifact.added", artifact: art("a4") });
    c.releaseReverse(); // second sync settles first, then the stale first one
    await flush();
    expect(s.getState().rooms.map((r) => r.id)).toEqual(["r1"]);
    expect(ids(s)).toEqual(["a3", "a4"]);
    s.stop();
  });

  it("applies live artifact events idempotently and keeps createdAt order across mixed offsets", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r1")], seq: 1 };
    c.artifacts.set("r1", { data: [art("a1", "r1", "2026-10-05T10:00:00+09:00")], seq: 1 }); // 01:00Z
    const s = await liveStore(c);
    await s.loadArtifacts("r1");
    const a0 = art("a0", "r1", "2026-10-05T00:30:00Z"); // earlier than a1 in instant terms
    c.emit({ seq: 2, type: "artifact.added", artifact: a0 });
    c.emit({ seq: 3, type: "artifact.added", artifact: a0 });
    expect(ids(s)).toEqual(["a0", "a1"]);
    c.emit({ seq: 4, type: "artifact.updated", artifact: { ...a0, title: "renamed" } });
    expect(s.getState().artifacts.r1?.[0].title).toBe("renamed");
    expect(ids(s)).toEqual(["a0", "a1"]);
    s.stop();
  });

  it("does not load artifacts for rooms that are not watched (only their count moves)", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r1")], seq: 1 };
    const s = await liveStore(c);
    const before = s.getState();
    c.emit({ seq: 2, type: "artifact.added", artifact: art("a1", "r1") });
    expect(s.getState().artifacts).toBe(before.artifacts);
    expect(s.getState().artifacts.r1).toBeUndefined();
    expect(s.getState().rooms[0].artifactCount).toBe(1);
    s.stop();
  });

  it("keeps room.artifactCount in step with artifact events (roomsd sends no room.updated for them)", async () => {
    const c = new FakeClient();
    c.rooms = { data: [{ ...room("r1"), artifactCount: 1 }, room("r2")], seq: 3 };
    c.artifacts.set("r1", { data: [art("a1")], seq: 3 });
    const s = await liveStore(c);
    await s.loadArtifacts("r1");
    const count = (id: string) => s.getState().rooms.find((r) => r.id === id)?.artifactCount;
    c.emit({ seq: 2, type: "artifact.added", artifact: art("a0") }); // covered by the snapshot
    expect(count("r1")).toBe(1);
    c.emit({ seq: 4, type: "artifact.added", artifact: art("a2") });
    c.emit({ seq: 5, type: "artifact.added", artifact: art("a2") }); // duplicate: already listed
    c.emit({ seq: 6, type: "artifact.updated", artifact: { ...art("a2"), title: "t" } });
    expect(count("r1")).toBe(2);
    c.emit({ seq: 7, type: "artifact.removed", roomId: "r1", artifactId: "a1" });
    c.emit({ seq: 8, type: "artifact.removed", roomId: "r1", artifactId: "a1" }); // already gone
    expect(count("r1")).toBe(1);
    // Unwatched room: counted from the events alone, never below 0.
    c.emit({ seq: 9, type: "artifact.added", artifact: art("b1", "r2") });
    expect(count("r2")).toBe(1);
    c.emit({ seq: 10, type: "artifact.removed", roomId: "r2", artifactId: "b1" });
    c.emit({ seq: 11, type: "artifact.removed", roomId: "r2", artifactId: "b1" });
    expect(count("r2")).toBe(0);
    // Journal artifacts belong to no listed room.
    const before = s.getState().rooms;
    c.emit({ seq: 12, type: "artifact.added", artifact: art("j1", "journal") });
    expect(s.getState().rooms).toBe(before);
    s.stop();
  });

  it("buffers a watched room's events while its own load is in flight", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r1")], seq: 1 };
    c.artifacts.set("r1", { data: [art("a1")], seq: 5 });
    const s = await liveStore(c);
    c.hold();
    const p = s.loadArtifacts("r1");
    c.emit({ seq: 4, type: "artifact.added", artifact: art("a0") }); // already in snapshot window: drop
    c.emit({ seq: 6, type: "artifact.added", artifact: art("a2") });
    c.releaseAll();
    await p;
    await flush();
    expect(ids(s)).toEqual(["a1", "a2"]);
    s.stop();
  });

  it("resync {roomId} refetches only that room's artifacts", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r1"), room("r2")], seq: 1 };
    c.artifacts.set("r1", { data: [art("a1")], seq: 1 });
    c.artifacts.set("r2", { data: [art("b1", "r2")], seq: 1 });
    const s = await liveStore(c);
    await s.loadArtifacts("r1");
    await s.loadArtifacts("r2");
    const roomsCalls = c.calls.listRooms;
    c.artifacts.set("r2", { data: [art("b1", "r2"), art("b2", "r2")], seq: 4 });
    c.calls.listArtifacts = [];
    c.emit({ seq: 4, type: "resync", roomId: "r2" });
    await flush();
    expect(c.calls.listArtifacts).toEqual(["r2"]);
    expect(c.calls.listRooms).toBe(roomsCalls);
    expect(ids(s, "r2")).toEqual(["b1", "b2"]);
    s.stop();
  });
});

describe("RoomsStore artifactCount", () => {
  const count = (s: RoomsStore, id: string) => s.getState().rooms.find((r) => r.id === id)?.artifactCount;

  it("a loaded room's count is its list length, even after a late event older than the artifacts fetch", async () => {
    const c = new FakeClient();
    c.rooms = { data: [{ ...room("r1"), artifactCount: 0 }], seq: 5 }; // rooms snapshot older than the artifacts one
    c.artifacts.set("r1", { data: [art("a1"), art("a2")], seq: 10 });
    const s = await liveStore(c);
    await s.loadArtifacts("r1");
    expect(count(s, "r1")).toBe(2);
    // seq 8 > roomsSeq 5 but already covered by the seq-10 artifacts snapshot.
    c.emit({ seq: 8, type: "artifact.added", artifact: art("a2") });
    c.emit({ seq: 8, type: "artifact.added", artifact: art("a3") });
    expect(ids(s)).toEqual(["a1", "a2"]);
    expect(count(s, "r1")).toBe(2);
    c.emit({ seq: 11, type: "artifact.added", artifact: art("a4") });
    expect(count(s, "r1")).toBe(3);
    // room.updated carries the daemon's stale count; the loaded list wins.
    c.emit({ seq: 12, type: "room.updated", room: { ...room("r1", "renamed"), artifactCount: 0 } });
    expect(count(s, "r1")).toBe(3);
    s.stop();
  });

  it("a per-room resync refetch updates the count", async () => {
    const c = new FakeClient();
    c.rooms = { data: [{ ...room("r1"), artifactCount: 1 }], seq: 1 };
    c.artifacts.set("r1", { data: [art("a1")], seq: 1 });
    const s = await liveStore(c);
    await s.loadArtifacts("r1");
    c.artifacts.set("r1", { data: [art("a1"), art("a2"), art("a3")], seq: 4 });
    c.emit({ seq: 4, type: "resync", roomId: "r1" });
    await flush();
    expect(count(s, "r1")).toBe(3);
    s.stop();
  });

  it("a full resync sets loaded rooms' counts from their lists", async () => {
    const c = new FakeClient();
    c.rooms = { data: [{ ...room("r1"), artifactCount: 0 }], seq: 1 };
    c.artifacts.set("r1", { data: [art("a1")], seq: 1 });
    const s = await liveStore(c);
    await s.loadArtifacts("r1");
    c.rooms = { data: [{ ...room("r1"), artifactCount: 7 }], seq: 3 };
    c.artifacts.set("r1", { data: [art("a1"), art("a2")], seq: 3 });
    c.connect(3);
    await flush();
    expect(count(s, "r1")).toBe(2);
    s.stop();
  });

  it("an unloaded room moves by ±1 for events newer than the rooms snapshot", async () => {
    const c = new FakeClient();
    c.rooms = { data: [{ ...room("r2"), artifactCount: 2 }], seq: 5 };
    const s = await liveStore(c);
    c.emit({ seq: 4, type: "artifact.added", artifact: art("b0", "r2") }); // in the snapshot
    expect(count(s, "r2")).toBe(2);
    c.emit({ seq: 6, type: "artifact.added", artifact: art("b1", "r2") });
    expect(count(s, "r2")).toBe(3);
    c.emit({ seq: 7, type: "artifact.removed", roomId: "r2", artifactId: "b1" });
    c.emit({ seq: 8, type: "artifact.removed", roomId: "r2", artifactId: "b0" });
    expect(count(s, "r2")).toBe(1);
    s.stop();
  });
});

describe("RoomsStore rooms scope", () => {
  it("room.updated keeps array position and artifacts", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r1"), room("r2"), room("r3")], seq: 1 };
    c.artifacts.set("r2", { data: [art("a1", "r2")], seq: 1 });
    const s = await liveStore(c);
    await s.loadArtifacts("r2");
    const arts = s.getState().artifacts.r2;
    c.emit({ seq: 2, type: "room.updated", room: room("r2", "Renamed") });
    expect(s.getState().rooms.map((r) => r.name)).toEqual(["r1", "Renamed", "r3"]);
    expect(s.getState().artifacts.r2).toBe(arts);
    s.stop();
  });

  it("room.removed removes the room and its artifacts", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r1"), room("r2")], seq: 1 };
    c.artifacts.set("r2", { data: [art("a1", "r2")], seq: 1 });
    const s = await liveStore(c);
    await s.loadArtifacts("r2");
    c.emit({ seq: 2, type: "room.removed", roomId: "r2" });
    expect(s.getState().rooms.map((r) => r.id)).toEqual(["r1"]);
    expect("r2" in s.getState().artifacts).toBe(false);
    s.stop();
  });

  it("returns the same state object when an event changes nothing", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r1")], seq: 5 };
    const s = await liveStore(c);
    const before = s.getState();
    c.emit({ seq: 3, type: "room.removed", roomId: "r1" });
    expect(s.getState()).toBe(before);
    s.stop();
  });

  it("notifies subscribers on change and stops after unsubscribe", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r1")], seq: 1 };
    const s = await liveStore(c);
    const l = vi.fn();
    const off = s.subscribe(l);
    c.emit({ seq: 2, type: "room.added", room: room("r2") });
    expect(l).toHaveBeenCalledTimes(1);
    off();
    c.emit({ seq: 3, type: "room.added", room: room("r3") });
    expect(l).toHaveBeenCalledTimes(1);
    s.stop();
  });
});

describe("RoomsStore days", () => {
  it("journal.changed refetches only watched days, debounced 150 ms per date", async () => {
    vi.useFakeTimers();
    const c = new FakeClient();
    c.days.set("2026-10-05", { data: day("2026-10-05"), seq: 1 });
    const s = await liveStore(c);
    await s.loadDay("2026-10-05");
    expect(s.getState().days["2026-10-05"]?.notes).toHaveLength(0);
    expect(c.calls.journalDay).toEqual(["2026-10-05"]);

    c.days.set("2026-10-05", { data: day("2026-10-05", 2), seq: 4 });
    c.emit({ seq: 2, type: "journal.changed", date: "2026-10-05" });
    c.emit({ seq: 3, type: "journal.changed", date: "2026-10-05" });
    c.emit({ seq: 4, type: "journal.changed", date: "2026-10-05" });
    c.emit({ seq: 5, type: "journal.changed", date: "2026-10-04" }); // not watched
    await vi.advanceTimersByTimeAsync(149);
    expect(c.calls.journalDay).toEqual(["2026-10-05"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.calls.journalDay).toEqual(["2026-10-05", "2026-10-05"]);
    expect(s.getState().days["2026-10-05"]?.notes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.calls.journalDay).toEqual(["2026-10-05", "2026-10-05"]);
    s.stop();
  });

  it("note.saved and note.removed refetch a watched day", async () => {
    vi.useFakeTimers();
    const c = new FakeClient();
    c.days.set("2026-10-05", { data: day("2026-10-05"), seq: 1 });
    const s = await liveStore(c);
    await s.loadDay("2026-10-05");
    c.emit({ seq: 2, type: "note.saved", note: { date: "2026-10-05", name: "x", relPath: "x.md", updatedAt: "", author: "me" } });
    await vi.advanceTimersByTimeAsync(150);
    c.emit({ seq: 3, type: "note.removed", date: "2026-10-05", name: "x" });
    await vi.advanceTimersByTimeAsync(150);
    expect(c.calls.journalDay).toHaveLength(3);
    s.stop();
  });

  it("refetches watched days on full resync", async () => {
    const c = new FakeClient();
    c.days.set("2026-10-05", { data: day("2026-10-05"), seq: 1 });
    const s = await liveStore(c);
    await s.loadDay("2026-10-05");
    c.days.set("2026-10-05", { data: day("2026-10-05", 1), seq: 3 });
    c.connect(3);
    await flush();
    expect(s.getState().days["2026-10-05"]?.notes).toHaveLength(1);
    s.stop();
  });
});

describe("RoomsStore scope errors", () => {
  it("sets errors[room:<id>] on a failed first load, retries on the next resync, and clears on success", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r1")], seq: 1 };
    c.artifacts.set("r1", new Error("boom"));
    const s = await liveStore(c, { warn: vi.fn() });
    await s.loadArtifacts("r1");
    expect(s.getState().artifacts.r1).toBeUndefined();
    expect(s.getState().errors["room:r1"]).toBe("boom");
    expect(s.getState().status).toBe("live");

    c.artifacts.set("r1", { data: [art("a1")], seq: 2 });
    c.connect(2);
    await flush();
    expect(ids(s)).toEqual(["a1"]);
    expect(s.getState().errors["room:r1"]).toBeUndefined();
    s.stop();
  });

  it("sets errors[day:<date>] on a failed day load and clears it on success", async () => {
    const c = new FakeClient();
    const s = await liveStore(c, { warn: vi.fn() });
    await s.loadDay("2026-10-05"); // FakeClient rejects unknown days
    expect(s.getState().errors["day:2026-10-05"]).toBeTruthy();
    c.days.set("2026-10-05", { data: day("2026-10-05"), seq: 1 });
    c.connect(1);
    await flush();
    expect(s.getState().days["2026-10-05"]).toBeDefined();
    expect(s.getState().errors["day:2026-10-05"]).toBeUndefined();
    s.stop();
  });
});

describe("RoomsStore errors", () => {
  it("goes to error when info() fails and retries with backoff 1s, 2s, 4s capped at 10s", async () => {
    vi.useFakeTimers();
    const c = new FakeClient();
    c.infoResult = new Error("down");
    const warn = vi.fn();
    const s = await liveStore(c, { warn });
    expect(s.getState().status).toBe("error");
    expect(warn).toHaveBeenCalled();
    const base = c.calls.info; // start() sync + the leading resync {null}
    await vi.advanceTimersByTimeAsync(999);
    expect(c.calls.info).toBe(base);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.calls.info).toBe(base + 1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.calls.info).toBe(base + 2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(c.calls.info).toBe(base + 3);
    await vi.advanceTimersByTimeAsync(8000);
    expect(c.calls.info).toBe(base + 4);
    await vi.advanceTimersByTimeAsync(9999);
    expect(c.calls.info).toBe(base + 4);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.calls.info).toBe(base + 5);

    c.infoResult = INFO;
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.getState().status).toBe("live");
    const n = c.calls.info;
    await vi.advanceTimersByTimeAsync(60000);
    expect(c.calls.info).toBe(n);
    s.stop();
  });

  it("goes to error when listRooms() fails", async () => {
    vi.useFakeTimers();
    const c = new FakeClient();
    c.rooms = new Error("down");
    const s = await liveStore(c, { warn: vi.fn() });
    expect(s.getState().status).toBe("error");
    c.rooms = { data: [room("r1")], seq: 1 };
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.getState().status).toBe("live");
    expect(s.getState().rooms.map((r) => r.id)).toEqual(["r1"]);
    s.stop();
  });

  it("a failed per-scope fetch keeps previous data, warns, and does not flip status", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r1")], seq: 1 };
    c.artifacts.set("r1", { data: [art("a1")], seq: 1 });
    c.days.set("2026-10-05", { data: day("2026-10-05", 1), seq: 1 });
    const warn = vi.fn();
    const s = await liveStore(c, { warn });
    await s.loadArtifacts("r1");
    await s.loadDay("2026-10-05");
    c.artifacts.set("r1", new Error("boom"));
    c.days.delete("2026-10-05");
    c.connect(2);
    await flush();
    expect(s.getState().status).toBe("live");
    expect(ids(s)).toEqual(["a1"]);
    expect(s.getState().days["2026-10-05"]?.notes).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(s.getState().errors).toEqual({ "room:r1": "boom", "day:2026-10-05": "404" });
    s.stop();
  });

  it("stop() unsubscribes and ignores late results", async () => {
    const c = new FakeClient();
    c.rooms = { data: [room("r1")], seq: 1 };
    c.hold();
    const s = new RoomsStore(c);
    s.start();
    c.connect(1);
    s.stop();
    expect(c.onEvent).toBeUndefined();
    c.releaseAll();
    await flush();
    expect(s.getState().status).toBe("connecting");
  });
});
