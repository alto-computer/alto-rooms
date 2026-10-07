import type { ApiError } from "./generated/ApiError";
import type { Artifact } from "./generated/Artifact";
import type { AskTarget } from "./generated/AskTarget";
import type { AskTurn } from "./generated/AskTurn";
import type { Info } from "./generated/Info";
import type { JournalDay } from "./generated/JournalDay";
import type { Note } from "./generated/Note";
import type { PluginInfo } from "./generated/PluginInfo";
import type { Room } from "./generated/Room";
import type { RoomsEvent } from "./generated/RoomsEvent";
import type { StartAsk } from "./generated/StartAsk";

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
    return (r.status === 204 ? undefined : await r.json()) as T;
  };
  const auth = (): HeadersInit => (token ? { authorization: `Bearer ${token}` } : {});
  const dataPath = (id: string, path: string) =>
    `/v1/plugins/${encodeURIComponent(id)}/data/${path.split("/").map(encodeURIComponent).join("/")}`;
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
    /** Moves a room to position `to` among the rooms other than the inbox (past the end = last); returns the new order
     *  of all room ids. 400 `invalid_input` for the inbox, 404 `room_not_found`. Also emits `rooms.reordered`. */
    moveRoom: (id: string, to: number) => write<string[]>("POST", `/v1/rooms/${encodeURIComponent(id)}/move`, JSON.stringify({ to })),
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
    startAsk: (req: StartAsk) => write<AskTurn>("POST", "/v1/asks", JSON.stringify(req)),
    /** Which agent an ask from this doc goes to, and the models it can pick from. */
    askTarget: async (roomId: string, artifactId: string) =>
      (await get<AskTarget>(`/v1/asks/target?roomId=${encodeURIComponent(roomId)}&artifactId=${encodeURIComponent(artifactId)}`)).data,
    askThread: async (fileKey: string) => (await get<AskTurn[]>(`/v1/asks?fileKey=${encodeURIComponent(fileKey)}`)).data,
    cancelAsk: (askId: string) => write<void>("DELETE", `/v1/asks/${encodeURIComponent(askId)}`, ""),
    listPlugins: async () => (await get<PluginInfo[]>("/v1/plugins")).data,
    /** Turning on grants `permissions` (what the user was shown) that the manifest still declares; off keeps the approval. */
    setPluginEnabled: (id: string, enabled: boolean, permissions?: string[]) =>
      write<PluginInfo>("PATCH", `/v1/plugins/${encodeURIComponent(id)}`, JSON.stringify({ enabled, permissions })),
    /** A plugin's data file as text, or null when it doesn't exist. Plugin data is private: token required. */
    getPluginData: async (id: string, path: string): Promise<string | null> => {
      const r = await fetch(baseUrl + dataPath(id, path), { headers: auth() });
      if (r.status === 404) {
        const e = await failure(r);
        if (e.code === "not_found") return null;
        throw e;
      }
      if (!r.ok) throw await failure(r);
      return r.text();
    },
    /** Writes atomically. 400 `invalid_path`, 413 `too_large`, 404 when the plugin isn't enabled. */
    putPluginData: (id: string, path: string, text: string) => write<void>("PUT", dataPath(id, path), text, "text/plain; charset=utf-8"),
    listPluginData: async (id: string, prefix = ""): Promise<string[]> => {
      const r = await fetch(`${baseUrl}/v1/plugins/${encodeURIComponent(id)}/data?prefix=${encodeURIComponent(prefix)}`, { headers: auth() });
      if (!r.ok) throw await failure(r);
      return (await r.json()) as string[];
    },
    deletePluginData: (id: string, path: string) => write<void>("DELETE", dataPath(id, path), ""),
    /** The artifact holding the original with this fileKey (first in sidebar order), or null. */
    findArtifactByFileKey: async (fileKey: string): Promise<Artifact | null> => {
      const r = await fetch(`${baseUrl}/v1/artifacts/by-file-key/${encodeURIComponent(fileKey)}`);
      if (r.status === 404) return null;
      if (!r.ok) throw await failure(r);
      return (await r.json()) as Artifact;
    },
    pluginEntryUrl: (info: Info, p: PluginInfo) =>
      `${info.filesOrigin}/_plugins/${encodeURIComponent(p.id)}/${p.entry.split("/").map(encodeURIComponent).join("/")}`,
    /** Versioned by `updatedAt`: when the file changes, frames showing it get a new URL and reload. */
    fileUrl: (info: Info, a: Artifact) =>
      `${info.filesOrigin}/${encodeURIComponent(a.roomId)}/${a.relPath.split("/").map(encodeURIComponent).join("/")}?v=${encodeURIComponent(a.updatedAt)}`,
    /** Every (re)connection first delivers `resync {roomId: null}`; `onOpen` fires on each (re)open. */
    subscribe: (onEvent: (e: RoomsEvent) => void, onOpen?: () => void) => {
      const es = new EventSource(baseUrl + "/v1/events");
      if (onOpen) es.onopen = () => onOpen();
      es.onmessage = (m) => onEvent(JSON.parse(m.data) as RoomsEvent);
      return () => es.close();
    },
  };
}
