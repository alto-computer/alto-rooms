import type { Artifact, Info, JournalDay, Room, RoomsEvent } from "@alto-rooms/protocol-ts";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { StoresProvider, type RoomsClient } from "@/data/hooks";
import { RoomsStore } from "@/data/roomsStore";
import { ViewerStore } from "@/data/viewerStore";

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
    /** Note bodies (or the error getNote throws), keyed `${date}/${name}`; absent = "". */
    notes?: Record<string, string | Error>;
    readOnly?: boolean;
  } = {},
) {
  let onEvent: (e: RoomsEvent) => void = () => {};
  let seq = 1;
  const state = { rooms: opts.rooms ?? [], artifacts: opts.artifacts ?? {}, days: opts.days ?? {}, notes: opts.notes ?? {} };
  const info: Info = {
    version: "0",
    readOnly: opts.readOnly ?? false,
    home: "/h",
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
    getNote: vi.fn(async (date: string, name: string): Promise<string> => {
      const v = state.notes[`${date}/${name}`];
      if (v instanceof Error) throw v;
      return v ?? "";
    }),
    createRoom: vi.fn(async (name: string) => room(`new-${name}`, name)),
    linkFolder: vi.fn(async (path: string, name?: string) => room(`linked-${path}`, name ?? path, { kind: "linked", path })),
    renameRoom: vi.fn(async (id: string, name: string) => room(id, name)),
    saveNote: vi.fn(async (date: string, name: string, _body?: string) => ({
      date,
      name: `${name}.md`,
      relPath: `${date}/${name}.md`,
      updatedAt: new Date().toISOString(),
      author: "me" as const,
    })),
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

/** Renders `ui` with real stores on a fake client, started and synced. */
export async function renderWithStores(ui: ReactNode, opts: Parameters<typeof fakeClient>[0] & { viewer?: ViewerStore } = {}) {
  const fake = fakeClient(opts);
  const rooms = new RoomsStore(fake.client, { warn: () => {} });
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
