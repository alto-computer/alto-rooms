import type { ApiError } from "./generated/ApiError";
import type { Artifact } from "./generated/Artifact";
import type { Info } from "./generated/Info";
import type { JournalDay } from "./generated/JournalDay";
import type { Note } from "./generated/Note";
import type { Room } from "./generated/Room";
import type { RoomsEvent } from "./generated/RoomsEvent";

export type Snapshot<T> = { data: T; seq: number };

export class RoomsApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "RoomsApiError";
    this.status = status;
    this.code = code;
  }
}

async function failure(r: Response): Promise<RoomsApiError> {
  const fallback = r.statusText || `HTTP ${r.status}`;
  try {
    const e = (await r.json()) as Partial<ApiError>;
    return new RoomsApiError(r.status, e.message ?? fallback, e.error);
  } catch {
    return new RoomsApiError(r.status, fallback);
  }
}

export function createRoomsClient(baseUrl: string, token?: string) {
  const get = async <T>(path: string): Promise<Snapshot<T>> => {
    const r = await fetch(baseUrl + path);
    if (!r.ok) throw await failure(r);
    return { data: (await r.json()) as T, seq: Number(r.headers.get("x-rooms-seq") ?? 0) };
  };
  const write = async <T>(method: string, path: string, body: string, type = "application/json"): Promise<T> => {
    const r = await fetch(baseUrl + path, {
      method,
      headers: { "content-type": type, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body,
    });
    if (!r.ok) throw await failure(r);
    return (await r.json()) as T;
  };
  return {
    info: async () => (await get<Info>("/v1/info")).data,
    listRooms: () => get<Room[]>("/v1/rooms"),
    listArtifacts: (roomId: string) => get<Artifact[]>(`/v1/rooms/${encodeURIComponent(roomId)}/artifacts`),
    journalDay: (date: string) => get<JournalDay>(`/v1/journal/${date}`),
    getNote: async (date: string, name: string): Promise<string> => {
      const r = await fetch(`${baseUrl}/v1/journal/${date}/notes/${encodeURIComponent(name)}`);
      if (!r.ok) throw await failure(r);
      return r.text();
    },
    createRoom: (name: string) => write<Room>("POST", "/v1/rooms", JSON.stringify({ name })),
    linkFolder: (path: string, name?: string) => write<Room>("POST", "/v1/rooms/link", JSON.stringify({ path, name })),
    renameRoom: (id: string, name: string) => write<Room>("PATCH", `/v1/rooms/${encodeURIComponent(id)}`, JSON.stringify({ name })),
    saveNote: (date: string, name: string, body: string) =>
      write<Note>("PUT", `/v1/journal/${date}/notes/${encodeURIComponent(name)}`, body, "text/markdown"),
    /** Renames a note in place; 404 `not_found` if `from` is gone, 409 `note_exists` if `to` is taken (case-insensitively). */
    renameNote: (date: string, from: string, to: string) =>
      write<Note>("POST", `/v1/journal/${date}/notes/${encodeURIComponent(from)}/rename`, JSON.stringify({ to })),
    /** Moves an artifact from an owned room (inbox allowed) to the top level of another owned room (not inbox), keeping
     *  its createdAt; a taken name gets " (2)". 400 `invalid_input` for linked/journal/inbox/same-room or a broken link,
     *  404 `room_not_found` / `not_found`. */
    moveArtifact: (roomId: string, artifactId: string, toRoomId: string) =>
      write<Artifact>("POST", "/v1/artifacts/move", JSON.stringify({ roomId, artifactId, toRoomId })),
    fileUrl: (info: Info, a: Artifact) =>
      `${info.filesOrigin}/${encodeURIComponent(a.roomId)}/${a.relPath.split("/").map(encodeURIComponent).join("/")}`,
    /** Every (re)connection first delivers `resync {roomId: null}`; `onOpen` fires on each (re)open. */
    subscribe: (onEvent: (e: RoomsEvent) => void, onOpen?: () => void) => {
      const es = new EventSource(baseUrl + "/v1/events");
      if (onOpen) es.onopen = () => onOpen();
      es.onmessage = (m) => onEvent(JSON.parse(m.data) as RoomsEvent);
      return () => es.close();
    },
  };
}
