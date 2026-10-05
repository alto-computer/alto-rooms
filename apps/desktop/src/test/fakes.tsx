import type { Artifact, Info, JournalDay, Room, RoomsEvent } from "@alto-rooms/protocol-ts";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { StoresProvider, type RoomsClient } from "@/data/hooks";
import { RoomsStore, type StoreTimers } from "@/data/roomsStore";
import { ViewerStore } from "@/data/viewerStore";

/** roomsd's note file name: one trailing ".md" (any case) stripped, NFC, then ".md". */
const noteFile = (name: string) => `${name.trim().replace(/\.md$/i, "").normalize("NFC")}.md`;

type EventInput = RoomsEvent extends infer T ? (T extends RoomsEvent ? Omit<T, "seq"> : never) : never;

export const room = (id: string, name: string, extra: Partial<Room> = {}): Room => ({
  id,
  name,
  kind: "owned",
  path: `/h/rooms/${id}`,
  status: "ok",
  artifactCount: 0,
  updatedAt: null,
  ...extra,
});

export function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

/**
 * A fake roomsd client: reads come from in-memory lists, writes are vi.fn()s,
 * and `emit` delivers SSE events to the store.
 */
export function fakeClient(
  opts: {
    rooms?: Room[];
    artifacts?: Record<string, Artifact[]>;
    artifactErrors?: Record<string, Error>;
    days?: Record<string, Partial<JournalDay>>;
    dayErrors?: Record<string, Error>;
    /** On-disk note bodies (or the error getNote throws), keyed `${date}/${file name with .md}`; absent = 404. */
    notes?: Record<string, string | Error>;
    readOnly?: boolean;
    /** `Info.home` (default `/h`). */
    home?: string;
  } = {},
) {
  let onEvent: (e: RoomsEvent) => void = () => {};
  let seq = 1;
  const state = { rooms: opts.rooms ?? [], artifacts: opts.artifacts ?? {}, days: opts.days ?? {}, notes: opts.notes ?? {} };
  const info: Info = {
    version: "0",
    readOnly: opts.readOnly ?? false,
    home: opts.home ?? "/h",
    journalRoomId: "journal",
    filesOrigin: "http://files.test",
  };
  const client = {
    info: async () => info,
    listRooms: async () => ({ data: state.rooms, seq }),
    listArtifacts: async (roomId: string) => {
      const err = opts.artifactErrors?.[roomId];
      if (err) throw err;
      return { data: state.artifacts[roomId] ?? [], seq };
    },
    journalDay: async (date: string) => {
      const err = opts.dayErrors?.[date];
      if (err) throw err;
      return { data: { date, artifacts: [], notes: [], ...state.days[date] } as JournalDay, seq };
    },
    // Like roomsd: the file is the name with exactly one trailing ".md" stripped, plus ".md".
    getNote: vi.fn(async (date: string, name: string): Promise<string> => {
      const v = state.notes[`${date}/${noteFile(name)}`];
      if (v instanceof Error) throw v;
      if (v === undefined) throw new RoomsApiError(404, "not found", "not_found");
      return v;
    }),
    createRoom: vi.fn(async (name: string) => room(`new-${name}`, name)),
    linkFolder: vi.fn(async (path: string, name?: string) => room(`linked-${path}`, name ?? path, { kind: "linked", path })),
    renameRoom: vi.fn(async (id: string, name: string) => room(id, name)),
    saveNote: vi.fn(async (date: string, name: string, body: string = "") => {
      const file = noteFile(name);
      state.notes[`${date}/${file}`] = body;
      return { date, name: file, relPath: `${date}/${file}`, updatedAt: new Date().toISOString(), author: "me" as const };
    }),
    // Like roomsd: 404 if the source is gone, 409 note_exists if another note folds to the target name.
    renameNote: vi.fn(async (date: string, from: string, to: string) => {
      const src = `${date}/${noteFile(from)}`;
      const file = noteFile(to);
      const dst = `${date}/${file}`;
      if (!(src in state.notes)) throw new RoomsApiError(404, "not found", "not_found");
      if (Object.keys(state.notes).some((k) => k !== src && k.toLowerCase() === dst.toLowerCase())) {
        throw new RoomsApiError(409, "note exists", "note_exists");
      }
      const body = state.notes[src];
      delete state.notes[src];
      state.notes[dst] = body;
      const updatedAt = new Date().toISOString();
      const renamed = { date, name: file, relPath: dst, updatedAt, author: "me" as const };
      const day = state.days[date];
      if (day?.notes) day.notes = day.notes.map((n) => (n.name === noteFile(from) ? renamed : n));
      return renamed;
    }),
    moveRoom: vi.fn(async (id: string, to: number): Promise<string[]> => {
      const from = state.rooms.findIndex((r) => r.id === id);
      if (from < 0) throw new RoomsApiError(404, "room not found", "room_not_found");
      const [moved] = state.rooms.splice(from, 1);
      const others = state.rooms.flatMap((r, i) => (r.id === "inbox" ? [] : [i]));
      state.rooms.splice(others[to] ?? state.rooms.length, 0, moved);
      return state.rooms.map((r) => r.id);
    }),
    moveArtifact: vi.fn(async (roomId: string, artifactId: string, toRoomId: string): Promise<Artifact> => {
      const a = state.artifacts[roomId]?.find((x) => x.id === artifactId);
      if (!a) throw new RoomsApiError(404, "not found", "not_found");
      return { ...a, roomId: toRoomId };
    }),
    fileUrl: (i: Info, a: Artifact) => `${i.filesOrigin}/${a.roomId}/${a.relPath}`,
    subscribe: (cb: (e: RoomsEvent) => void) => {
      onEvent = cb;
      return () => {};
    },
  };
  return {
    client: client as unknown as RoomsClient & typeof client,
    state,
    info,
    /** Delivers an event with the next seq. */
    emit: (e: EventInput) => onEvent({ ...e, seq: ++seq } as RoomsEvent),
  };
}

/** Timers fired by hand: `run()` fires everything pending (e.g. the store's unwatch linger). */
export function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  const timers: StoreTimers = {
    setTimeout: (fn) => {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (h) => void pending.delete(h as number),
  };
  return {
    timers,
    run() {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
  };
}

/** Renders `ui` with real stores on a fake client, started and synced. */
export async function renderWithStores(
  ui: ReactNode,
  opts: Parameters<typeof fakeClient>[0] & { viewer?: ViewerStore; storeTimers?: StoreTimers } = {},
) {
  const fake = fakeClient(opts);
  const rooms = new RoomsStore(fake.client, { warn: () => {}, timers: opts.storeTimers });
  const viewer = opts.viewer ?? new ViewerStore(memoryStorage());
  const utils = render(
    <StoresProvider rooms={rooms} viewer={viewer} client={fake.client}>
      {ui}
    </StoresProvider>,
  );
  await act(async () => {
    rooms.start();
    fake.emit({ type: "resync", roomId: null });
  });
  return { ...utils, ...fake, rooms, viewer };
}
