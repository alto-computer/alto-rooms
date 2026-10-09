import type { Artifact, AskKind, AskScope, AskTarget, AskTurn, Info, JournalDay, PluginInfo, Room, RoomColor, RoomsEvent } from "@alto-rooms/protocol-ts";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { RoomsApiError, scopeKey } from "@alto-rooms/protocol-ts";
import { StoresProvider, type RoomsClient } from "@/data/hooks";
import { RoomsStore } from "@/data/roomsStore";
import type { Clock } from "@/lib/clock";
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
  color: null,
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
    /** Plugins roomsd lists, and their data files keyed `${pluginId}/${path}`. */
    plugins?: PluginInfo[];
    pluginData?: Record<string, string>;
    /** `Info.home` (default `/h`). */
    home?: string;
    /** Ask threads by file key (a doc scope). */
    asks?: Record<string, AskTurn[]>;
    /** What `askTarget` answers (or throws), by file key; default: the doc's own agent with no models. */
    askTargets?: Record<string, AskTarget | Error>;
  } = {},
) {
  let onEvent: (e: RoomsEvent) => void = () => {};
  let seq = 1;
  const state = {
    rooms: opts.rooms ?? [],
    artifacts: opts.artifacts ?? {},
    days: opts.days ?? {},
    notes: opts.notes ?? {},
    plugins: opts.plugins ?? [],
    pluginData: opts.pluginData ?? {},
    asks: opts.asks ?? {},
  };
  const info: Info = {
    version: "0",
    readOnly: opts.readOnly ?? false,
    home: opts.home ?? "/h",
    journalRoomId: "journal",
    filesOrigin: "http://files.test",
  };
  // Like roomsd before F1-2: only a doc scope resolves, through the artifact holding its file.
  const docOf = (scope: AskScope) =>
    scope.kind === "doc" ? Object.values(state.artifacts).flat().find((a) => a.fileKey === scope.fileKey) : undefined;
  const client = {
    info: async () => info,
    listPlugins: vi.fn(async () => state.plugins.map((p) => ({ ...p }))),
    // Like roomsd: on grants what was shown (still declared); off keeps the approval.
    setPluginEnabled: vi.fn(async (id: string, enabled: boolean, shown?: string[]): Promise<PluginInfo> => {
      const p = state.plugins.find((x) => x.id === id);
      if (!p) throw new RoomsApiError(404, "not found", "not_found");
      const granted = enabled ? p.permissions.filter((x) => !shown || shown.includes(x)) : p.granted;
      const needsApproval = !granted || !p.permissions.every((x) => granted.includes(x));
      Object.assign(p, { enabled, granted, needsApproval });
      return { ...p };
    }),
    getPluginData: vi.fn(async (id: string, path: string) => state.pluginData[`${id}/${path}`] ?? null),
    putPluginData: vi.fn(async (id: string, path: string, text: string) => void (state.pluginData[`${id}/${path}`] = text)),
    listPluginData: vi.fn(async (id: string, prefix = "") =>
      Object.keys(state.pluginData)
        .filter((k) => k.startsWith(`${id}/${prefix}`))
        .map((k) => k.slice(id.length + 1))
        .sort(),
    ),
    deletePluginData: vi.fn(async (id: string, path: string) => void delete state.pluginData[`${id}/${path}`]),
    findArtifactByFileKey: vi.fn(
      async (fileKey: string) =>
        Object.values(state.artifacts)
          .flat()
          .find((a) => a.fileKey === fileKey) ?? null,
    ),
    pluginEntryUrl: (i: Info, p: PluginInfo) => `${i.filesOrigin}/_plugins/${p.id}/${p.entry}`,
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
    // Like roomsd: `to` counts the rooms other than the inbox and stays within the room's section (pinned first).
    moveRoom: vi.fn(async (id: string, to: number): Promise<string[]> => {
      const from = state.rooms.findIndex((r) => r.id === id);
      if (from < 0) throw new RoomsApiError(404, "room not found", "room_not_found");
      const [moved] = state.rooms.splice(from, 1);
      const others = state.rooms.flatMap((r, i) => (r.id === "inbox" ? [] : [i]));
      const pinned = others.filter((i) => state.rooms[i].color !== null).length;
      const at = moved.color !== null ? Math.min(to, pinned) : Math.max(to, pinned);
      state.rooms.splice(others[at] ?? state.rooms.length, 0, moved);
      return state.rooms.map((r) => r.id);
    }),
    // Like roomsd: pinning moves the room to the end of the pinned rooms, unpinning to the top of the others.
    setRoomColor: vi.fn(async (id: string, color: RoomColor | null): Promise<Room> => {
      if (id === "inbox") throw new RoomsApiError(400, "invalid input: the inbox can't be pinned", "invalid_input");
      const from = state.rooms.findIndex((r) => r.id === id);
      if (from < 0) throw new RoomsApiError(404, "room not found", "room_not_found");
      const updated = { ...state.rooms[from], color };
      if ((state.rooms[from].color !== null) === (color !== null)) {
        state.rooms[from] = updated;
        return updated;
      }
      state.rooms.splice(from, 1);
      const others = state.rooms.flatMap((r, i) => (r.id === "inbox" ? [] : [i]));
      const pinned = others.filter((i) => state.rooms[i].color !== null).length;
      state.rooms.splice(others[pinned] ?? state.rooms.length, 0, updated);
      return updated;
    }),
    moveArtifact: vi.fn(async (roomId: string, artifactId: string, toRoomId: string): Promise<Artifact> => {
      const a = state.artifacts[roomId]?.find((x) => x.id === artifactId);
      if (!a) throw new RoomsApiError(404, "not found", "not_found");
      return { ...a, roomId: toRoomId };
    }),
    startAsk: vi.fn(async (req: { scope: AskScope; question: string; model: string | null; images?: string[]; kind?: AskKind }): Promise<AskTurn> => {
      const a = docOf(req.scope);
      if (!a) throw new RoomsApiError(404, "Can't find this doc", "not_found");
      const kind = req.kind ?? "question";
      const question = kind === "clear" ? "/new" : kind === "compact" ? "/compact" : req.question;
      return {
        id: `ask-${question}`, scope: req.scope, question, answer: "", agent: a.source.agent ?? "claude-code",
        model: req.model, mode: a.source.session ? "resume" : "new", status: kind === "clear" ? "done" : "running", error: null,
        startedAt: "2026-10-06T10:00:00+09:00", endedAt: kind === "clear" ? "2026-10-06T10:00:00+09:00" : null,
        images: kind === "question" ? (req.images ?? []) : [], kind, leftOut: 0,
      };
    }),
    uploadAskImage: vi.fn(async (image: Blob) => ({ id: `img-${(image as File).name ?? "blob"}` })),
    askImageUrl: (i: Info, id: string) => `${i.filesOrigin}/_asks/images/${id}`,
    askTarget: vi.fn(async (scope: AskScope): Promise<AskTarget> => {
      const a = docOf(scope);
      if (!a) throw new RoomsApiError(404, "Can't find this doc", "not_found");
      const t = opts.askTargets?.[a.fileKey];
      if (t instanceof Error) throw t;
      return t ?? { agent: a.source.agent ?? "claude-code", mode: a.source.session ? "resume" : "new", models: [] };
    }),
    askThread: vi.fn(async (scope: AskScope) => (scope.kind === "doc" ? state.asks[scope.fileKey] : state.asks[scopeKey(scope)]) ?? []),
    cancelAsk: vi.fn(async () => {}),
    // Like the real client minus encoding, and unversioned so tests can match plain paths.
    fileUrl: (i: Info, a: Artifact, doc?: { contentKey: string }) => `${i.filesOrigin}/${a.roomId}/${a.relPath}${doc ? `?doc=1&cs=${doc.contentKey}` : ""}`,
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
  const timers: Clock = {
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
  opts: Parameters<typeof fakeClient>[0] & { viewer?: ViewerStore; storeTimers?: Clock } = {},
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
