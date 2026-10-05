import type { Artifact } from "./generated/Artifact";
import type { Info } from "./generated/Info";
import type { JournalDay } from "./generated/JournalDay";
import type { Note } from "./generated/Note";
import type { Room } from "./generated/Room";
import type { RoomsEvent } from "./generated/RoomsEvent";

export type Snapshot<T> = { data: T; seq: number };

export function createRoomsClient(baseUrl: string, token?: string) {
  const get = async <T>(path: string): Promise<Snapshot<T>> => {
    const r = await fetch(baseUrl + path);
    if (!r.ok) throw await r.json();
    return { data: (await r.json()) as T, seq: Number(r.headers.get("x-rooms-seq") ?? 0) };
  };
  const write = async <T>(method: string, path: string, body: string, type = "application/json"): Promise<T> => {
    const r = await fetch(baseUrl + path, {
      method,
      headers: { "content-type": type, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body,
    });
    if (!r.ok) throw await r.json();
    return (await r.json()) as T;
  };
  return {
    info: async () => (await get<Info>("/v1/info")).data,
    listRooms: () => get<Room[]>("/v1/rooms"),
    listArtifacts: (roomId: string) => get<Artifact[]>(`/v1/rooms/${encodeURIComponent(roomId)}/artifacts`),
    journalDay: (date: string) => get<JournalDay>(`/v1/journal/${date}`),
    createRoom: (name: string) => write<Room>("POST", "/v1/rooms", JSON.stringify({ name })),
    linkFolder: (path: string, name?: string) => write<Room>("POST", "/v1/rooms/link", JSON.stringify({ path, name })),
    renameRoom: (id: string, name: string) => write<Room>("PATCH", `/v1/rooms/${encodeURIComponent(id)}`, JSON.stringify({ name })),
    saveNote: (date: string, name: string, body: string) =>
      write<Note>("PUT", `/v1/journal/${date}/notes/${encodeURIComponent(name)}`, body, "text/markdown"),
    fileUrl: (info: Info, a: Artifact) =>
      `${info.filesOrigin}/${encodeURIComponent(a.roomId)}/${a.relPath.split("/").map(encodeURIComponent).join("/")}`,
    subscribe: (onEvent: (e: RoomsEvent) => void) => {
      const es = new EventSource(baseUrl + "/v1/events");
      es.onmessage = (m) => onEvent(JSON.parse(m.data) as RoomsEvent);
      return () => es.close();
    },
  };
}
