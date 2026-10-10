import type { Artifact, Room, RoomsEvent } from "@alto-rooms/protocol-ts";
import { describe, expect, it } from "vitest";
import { applyArtifactEvent, applyEvent, type ScopeView } from "./roomsEvents";
import type { RoomsState } from "./roomsState";

function room(id: string, artifactCount = 0): Room {
  return { id, name: id, kind: "owned", path: `/h/${id}`, status: "ok", artifactCount, updatedAt: null, color: null };
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
    fileKey: "0000000000000000",
  };
}

function state(p: Partial<RoomsState> = {}): RoomsState {
  return { status: "live", info: null, rooms: [], artifacts: {}, days: {}, errors: {}, syncFailures: 0, ...p };
}

/** roomsSeq 10; r1 watched with snapshot seq 10; day 2026-10-05 watched. */
function view(p: Partial<{ fetching: boolean; watched: string[] }> = {}): ScopeView {
  const watched = new Set(p.watched ?? ["r1"]);
  return {
    roomsSeq: () => 10,
    artifactsSeq: (id) => (watched.has(id) ? 10 : undefined),
    isWatchedRoom: (id) => watched.has(id),
    isFetchingRoom: () => p.fetching ?? false,
    isWatchedDay: (d) => d === "2026-10-05",
  };
}

describe("applyEvent", () => {
  it("adds a room newer than the rooms snapshot and asks to wake it", () => {
    const s = state({ rooms: [room("a")] });
    const r = applyEvent(s, { type: "room.added", seq: 11, room: room("b") }, view());
    expect(r.state.rooms.map((x) => x.id)).toEqual(["a", "b"]);
    expect(r.intents).toEqual([{ type: "wakeRoom", roomId: "b" }]);
  });

  it("drops room events at or below the rooms snapshot seq", () => {
    const s = state({ rooms: [room("a")] });
    for (const e of [
      { type: "room.added", seq: 10, room: room("b") },
      { type: "room.removed", seq: 9, roomId: "a" },
      { type: "rooms.reordered", seq: 10, roomIds: ["a"] },
    ] as RoomsEvent[]) {
      const r = applyEvent(s, e, view());
      expect(r.state).toBe(s);
      expect(r.intents).toEqual([]);
    }
  });

  it("keeps a loaded room's count in step with its list on room.updated", () => {
    const s = state({ rooms: [room("r1", 0)], artifacts: { r1: [art("a1")] } });
    const r = applyEvent(s, { type: "room.updated", seq: 11, room: { ...room("r1", 7), name: "renamed" } }, view());
    expect(r.state.rooms[0]).toMatchObject({ name: "renamed", artifactCount: 1 });
  });

  it("reorders listed rooms and keeps unlisted ones after them", () => {
    const s = state({ rooms: [room("a"), room("b"), room("c")] });
    const r = applyEvent(s, { type: "rooms.reordered", seq: 11, roomIds: ["c", "a"] }, view());
    expect(r.state.rooms.map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("removes a room and asks to forget its scope", () => {
    const s = state({ rooms: [room("a"), room("b")] });
    const r = applyEvent(s, { type: "room.removed", seq: 11, roomId: "a" }, view());
    expect(r.state.rooms.map((x) => x.id)).toEqual(["b"]);
    expect(r.intents).toEqual([{ type: "forgetRoom", roomId: "a" }]);
  });

  it("refetches a watched room on its resync, ignores unwatched ones", () => {
    const s = state();
    expect(applyEvent(s, { type: "resync", seq: 11, roomId: "r1" }, view()).intents).toEqual([{ type: "fetchRoom", roomId: "r1" }]);
    expect(applyEvent(s, { type: "resync", seq: 11, roomId: "r2" }, view()).intents).toEqual([]);
  });

  it("counts artifacts for a room whose list is not loaded", () => {
    const s = state({ rooms: [room("r2", 1)] });
    const added = applyEvent(s, { type: "artifact.added", seq: 11, artifact: art("a1", "r2") }, view());
    expect(added.state.rooms[0].artifactCount).toBe(2);
    const removed = applyEvent(added.state, { type: "artifact.removed", seq: 12, roomId: "r2", artifactId: "a1" }, view());
    expect(removed.state.rooms[0].artifactCount).toBe(1);
    // Never below zero.
    const s0 = state({ rooms: [room("r2", 0)] });
    expect(applyEvent(s0, { type: "artifact.removed", seq: 11, roomId: "r2", artifactId: "x" }, view()).state).toBe(s0);
  });

  it("inserts artifacts in createdAt order into a watched room and syncs its count", () => {
    const s = state({ rooms: [room("r1", 2)], artifacts: { r1: [art("a1"), art("a3")] } });
    const r = applyEvent(s, { type: "artifact.added", seq: 11, artifact: art("a2") }, view());
    expect(r.state.artifacts.r1?.map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    expect(r.state.rooms[0].artifactCount).toBe(3);
  });

  it("asks for debounced day refetches only for watched days", () => {
    const s = state();
    expect(applyEvent(s, { type: "journal.changed", seq: 11, date: "2026-10-05" }, view()).intents).toEqual([
      { type: "dayChanged", date: "2026-10-05" },
    ]);
    expect(applyEvent(s, { type: "note.removed", seq: 11, date: "2026-10-06", name: "n" } as RoomsEvent, view()).intents).toEqual([]);
  });
});

describe("applyArtifactEvent", () => {
  const s = state({ rooms: [room("r1", 1)], artifacts: { r1: [art("a1")] } });

  it("drops events at or below the room's snapshot seq", () => {
    const r = applyArtifactEvent(s, "r1", { type: "artifact.removed", seq: 10, roomId: "r1", artifactId: "a1" }, view());
    expect(r.state).toBe(s);
  });

  it("queues events while the room's snapshot is in flight", () => {
    const e: RoomsEvent = { type: "artifact.removed", seq: 11, roomId: "r1", artifactId: "a1" };
    const r = applyArtifactEvent(s, "r1", e, view({ fetching: true }));
    expect(r.state).toBe(s);
    expect(r.intents).toEqual([{ type: "queueArtifact", roomId: "r1", event: e }]);
  });

  it("ignores unwatched rooms", () => {
    const r = applyArtifactEvent(s, "r1", { type: "artifact.removed", seq: 11, roomId: "r1", artifactId: "a1" }, view({ watched: [] }));
    expect(r).toEqual({ state: s, intents: [] });
  });

  it("removes an artifact and syncs the count", () => {
    const r = applyArtifactEvent(s, "r1", { type: "artifact.removed", seq: 11, roomId: "r1", artifactId: "a1" }, view());
    expect(r.state.artifacts.r1).toEqual([]);
    expect(r.state.rooms[0].artifactCount).toBe(0);
  });
});
