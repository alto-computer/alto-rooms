import type { Artifact, Info, JournalDay, Room } from "@alto-rooms/protocol-ts";

export type RoomsState = {
  status: "connecting" | "live" | "error";
  info: Info | null;
  rooms: Room[]; // listRooms order
  artifacts: Record<string, Artifact[] | undefined>; // roomId -> createdAt ASC; undefined = not loaded
  days: Record<string, JournalDay | undefined>; // date -> day; undefined = not loaded
  /** Last fetch failure per scope, keyed `room:<id>` / `day:<date>`; cleared on success. */
  errors: Record<string, string | undefined>;
  /** Consecutive failed full syncs (info/listRooms); 0 once one succeeds. */
  syncFailures: number;
};

// Pure helpers. Each returns `s` itself when nothing changed, so the store
// can skip notifying listeners on identity.

export const roomKey = (id: string) => `room:${id}`;
export const dayKey = (date: string) => `day:${date}`;

const instant = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** createdAt ASC (compared as instants, offsets vary), then id. */
export function sortArtifacts(list: Artifact[]): Artifact[] {
  return [...list].sort((a, b) => instant(a.createdAt) - instant(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function patch(s: RoomsState, p: Partial<RoomsState>): RoomsState {
  const changed = (Object.keys(p) as (keyof RoomsState)[]).some((k) => p[k] !== s[k]);
  return changed ? { ...s, ...p } : s;
}

/** Sets (or, with `undefined`, clears) one scope's error. */
export function withError(s: RoomsState, key: string, err: string | undefined): RoomsState {
  const errors = s.errors;
  if (errors[key] === err && (err !== undefined || !(key in errors))) return s;
  if (err === undefined) {
    const { [key]: _cleared, ...rest } = errors;
    return patch(s, { errors: rest });
  }
  return patch(s, { errors: { ...errors, [key]: err } });
}

export function withArtifacts(s: RoomsState, roomId: string, list: Artifact[]): RoomsState {
  return syncCount(patch(s, { artifacts: { ...s.artifacts, [roomId]: list } }), roomId);
}

/**
 * roomsd sends no room.updated when a room's documents change, so a room
 * whose artifacts are loaded takes its `artifactCount` from the list.
 */
export function syncCount(s: RoomsState, roomId: string): RoomsState {
  const list = s.artifacts[roomId];
  if (list === undefined) return s;
  const rooms = s.rooms;
  const i = rooms.findIndex((r) => r.id === roomId);
  if (i < 0 || rooms[i].artifactCount === list.length) return s;
  return patch(s, { rooms: rooms.map((r, j) => (j === i ? { ...r, artifactCount: list.length } : r)) });
}
