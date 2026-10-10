import type { RoomsEvent } from "@alto-rooms/protocol-ts";
import { sameConversation } from "@/lib/conversations";
import { patch, sortArtifacts, syncCount, withArtifacts, type RoomsState } from "./roomsState";

/** What the reducer may read about the store's scopes. */
export type ScopeView = {
  /** Seq of the last rooms snapshot. */
  roomsSeq(): number;
  /** Snapshot seq of a room's loaded artifacts. */
  artifactsSeq(roomId: string): number | undefined;
  /** Watched (or lingering) and not dormant. */
  isWatchedRoom(roomId: string): boolean;
  isFetchingRoom(roomId: string): boolean;
  isWatchedDay(date: string): boolean;
};

/** Work the store must do after taking the new state, in order. */
export type Intent =
  | { type: "fetchRoom"; roomId: string }
  /** The room is listed: reload it if it was dormant. */
  | { type: "wakeRoom"; roomId: string }
  /** The room left the list: drop its scope. */
  | { type: "forgetRoom"; roomId: string }
  /** The room's snapshot is in flight: replay `event` once it lands. */
  | { type: "queueArtifact"; roomId: string; event: RoomsEvent }
  | { type: "dayChanged"; date: string };

export type Applied = { state: RoomsState; intents: Intent[] };

/**
 * Applies one live (or drained) event. `resync {null}` and `plugins.changed`
 * never get here; the store handles them before buffering.
 */
export function applyEvent(s: RoomsState, e: RoomsEvent, view: ScopeView): Applied {
  const none = (state: RoomsState): Applied => ({ state, intents: [] });
  switch (e.type) {
    case "resync":
      return { state: s, intents: e.roomId !== null && view.isWatchedRoom(e.roomId) ? [{ type: "fetchRoom", roomId: e.roomId }] : [] };
    case "room.added":
    case "room.updated": {
      if (e.seq <= view.roomsSeq()) return none(s);
      const rooms = s.rooms;
      const i = rooms.findIndex((r) => r.id === e.room.id);
      const next = patch(s, { rooms: i < 0 ? [...rooms, e.room] : rooms.map((r, j) => (j === i ? e.room : r)) });
      return { state: syncCount(next, e.room.id), intents: [{ type: "wakeRoom", roomId: e.room.id }] };
    }
    case "rooms.reordered": {
      if (e.seq <= view.roomsSeq()) return none(s);
      const byId = new Map(s.rooms.map((r) => [r.id, r]));
      const listed = new Set(e.roomIds);
      const ordered = e.roomIds.flatMap((id) => byId.get(id) ?? []);
      return none(patch(s, { rooms: [...ordered, ...s.rooms.filter((r) => !listed.has(r.id))] }));
    }
    case "room.removed": {
      if (e.seq <= view.roomsSeq()) return none(s);
      const rooms = s.rooms.filter((r) => r.id !== e.roomId);
      const next = rooms.length !== s.rooms.length ? patch(s, { rooms }) : s;
      return { state: next, intents: [{ type: "forgetRoom", roomId: e.roomId }] };
    }
    case "artifact.added":
    case "artifact.updated": {
      const roomId = e.artifact.roomId;
      const counted = e.type === "artifact.added" ? countArtifact(s, roomId, 1, e.seq, view) : s;
      return applyArtifactEvent(counted, roomId, e, view);
    }
    case "artifact.removed":
      return applyArtifactEvent(countArtifact(s, e.roomId, -1, e.seq, view), e.roomId, e, view);
    case "journal.changed":
    case "note.removed":
      return dayChanged(s, e.date, view);
    case "note.saved":
      return dayChanged(s, e.note.date, view);
    case "conversation.moved": {
      // Its room chip changed on every watched day that lists it.
      const id = e.conversation.id;
      const dates = Object.entries(s.days)
        .filter(([date, day]) => view.isWatchedDay(date) && day?.conversations.some((c) => sameConversation(c.conversation.id, id)))
        .map(([date]) => date);
      return { state: s, intents: dates.map((date) => ({ type: "dayChanged", date })) };
    }
  }
  return none(s);
}

/**
 * Applies an artifact event to a watched room's list, under the per-scope
 * rule (seq must be newer than the room's snapshot). While the room's
 * snapshot is in flight the event is queued instead.
 */
export function applyArtifactEvent(s: RoomsState, roomId: string, e: RoomsEvent, view: ScopeView): Applied {
  if (!view.isWatchedRoom(roomId)) return { state: s, intents: [] };
  if (view.isFetchingRoom(roomId)) return { state: s, intents: [{ type: "queueArtifact", roomId, event: e }] };
  const list = s.artifacts[roomId];
  const seq = view.artifactsSeq(roomId);
  if (list === undefined || seq === undefined || e.seq <= seq) return { state: s, intents: [] };
  if (e.type === "artifact.removed") {
    const next = list.some((a) => a.id === e.artifactId) ? withArtifacts(s, roomId, list.filter((a) => a.id !== e.artifactId)) : s;
    return { state: next, intents: [] };
  }
  if (e.type === "artifact.added" || e.type === "artifact.updated") {
    const a = e.artifact;
    return { state: withArtifacts(s, roomId, sortArtifacts([...list.filter((x) => x.id !== a.id), a])), intents: [] };
  }
  return { state: s, intents: [] };
}

/**
 * For a room whose artifacts are not loaded: moves `artifactCount` by one for
 * an artifact event newer than the rooms snapshot. Loaded rooms take their
 * count from the list instead (see `syncCount`).
 */
function countArtifact(s: RoomsState, roomId: string, delta: 1 | -1, seq: number, view: ScopeView): RoomsState {
  if (seq <= view.roomsSeq() || s.artifacts[roomId] !== undefined) return s;
  const rooms = s.rooms;
  const i = rooms.findIndex((r) => r.id === roomId);
  if (i < 0) return s;
  const r = rooms[i];
  const artifactCount = Math.max(0, r.artifactCount + delta);
  if (artifactCount === r.artifactCount) return s;
  return patch(s, { rooms: rooms.map((x, j) => (j === i ? { ...r, artifactCount } : x)) });
}

/** Days are refetch-only: a change to a watched day just asks for a refetch. */
function dayChanged(s: RoomsState, date: string, view: ScopeView): Applied {
  return { state: s, intents: view.isWatchedDay(date) ? [{ type: "dayChanged", date }] : [] };
}
