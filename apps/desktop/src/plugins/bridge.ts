/*
 * The app side of the plugin bridge: one request from a plugin frame, checked
 * (shape, permission, path, size) and relayed to roomsd through the client.
 * The token never crosses to the plugin; roomsd checks paths again.
 */
import type { Artifact, PluginInfo, Room } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import type { ViewerStore } from "@/data/viewerStore";

export type BridgeErrorCode = "permission_denied" | "invalid_path" | "too_large" | "not_found" | "write_failed" | "unknown_method" | "rate_limited" | "bad_request";

export class BridgeError extends Error {
  code: BridgeErrorCode;
  constructor(code: BridgeErrorCode, message: string = code) {
    super(message);
    this.code = code;
  }
}

export type BridgeCall = { id: string; method: string; params: unknown };

export type BridgeDeps = {
  client: {
    getPluginData(id: string, path: string): Promise<string | null>;
    putPluginData(id: string, path: string, text: string): Promise<void>;
    listPluginData(id: string, prefix?: string): Promise<string[]>;
    deletePluginData(id: string, path: string): Promise<void>;
    listArtifacts(roomId: string): Promise<{ data: Artifact[] }>;
    findArtifactByFileKey(fileKey: string): Promise<Artifact | null>;
  };
  /** A write or delete of `path` in the plugin's data went through. */
  changed(path: string): void;
  /** The slot the calling frame fills: a tab opens docs in a tab of their own, a side panel in its doc's tab. */
  slot: "tab" | "artifact.sidePanel";
  viewer: Pick<ViewerStore, "navigate" | "open" | "reveal">;
  /** The rooms in sidebar order. */
  rooms(): Room[];
};

/** Largest text a plugin may store in one file (UTF-8 bytes); matches roomsd. */
export const MAX_DATA_BYTES = 10 * 1024 * 1024;

/** Largest anchor `open` passes on to a content script (UTF-8 bytes of its JSON). */
export const MAX_ANCHOR_BYTES = 4096;

/** The core's data path rule: 1–200 chars, `/`-joined `[A-Za-z0-9._-]` segments, no `.`/`..`/empty, ≤ 8 deep. */
export function validPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 200) return false;
  const segs = path.split("/");
  return segs.length <= 8 && segs.every((s) => s !== "" && s !== "." && s !== ".." && /^[A-Za-z0-9._-]+$/.test(s));
}

const field = (params: unknown, key: string): unknown =>
  params && typeof params === "object" ? (params as Record<string, unknown>)[key] : undefined;

function pathOf(params: unknown): string {
  const p = field(params, "path");
  if (!validPath(p)) throw new BridgeError("invalid_path");
  return p;
}

/** `open`'s anchor as a fresh copy of its JSON, or undefined when there is none. */
function anchorOf(params: unknown): unknown {
  const anchor = field(params, "anchor");
  if (anchor === undefined) return undefined;
  let json: string | undefined;
  try {
    json = JSON.stringify(anchor);
  } catch {
    json = undefined;
  }
  if (json === undefined || new TextEncoder().encode(json).length > MAX_ANCHOR_BYTES) {
    throw new BridgeError("bad_request", `anchor must be JSON of at most ${MAX_ANCHOR_BYTES} bytes`);
  }
  return JSON.parse(json);
}

function needs(p: PluginInfo, permission: string) {
  if (!p.permissions.includes(permission)) throw new BridgeError("permission_denied", `needs the ${permission} permission`);
}

/** roomsd failures as bridge codes (unknown failures read as write_failed). */
export function relay<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((e: unknown) => {
    const code = e instanceof RoomsApiError ? e.code : undefined;
    if (code === "invalid_path" || code === "too_large" || code === "not_found") throw new BridgeError(code);
    throw new BridgeError("write_failed", e instanceof Error ? e.message : String(e));
  });
}

export async function handleBridgeCall(p: PluginInfo, call: BridgeCall, deps: BridgeDeps): Promise<unknown> {
  const { client } = deps;
  switch (call.method) {
    case "storage.read":
      return relay(client.getPluginData(p.id, pathOf(call.params)));
    case "storage.write": {
      const path = pathOf(call.params);
      const text = field(call.params, "text");
      if (typeof text !== "string") throw new BridgeError("invalid_path", "text must be a string");
      if (new TextEncoder().encode(text).length > MAX_DATA_BYTES) throw new BridgeError("too_large");
      await relay(client.putPluginData(p.id, path, text));
      deps.changed(path);
      return null;
    }
    case "storage.list": {
      const prefix = field(call.params, "prefix") ?? "";
      if (typeof prefix !== "string") throw new BridgeError("invalid_path");
      return relay(client.listPluginData(p.id, prefix));
    }
    case "storage.delete": {
      const path = pathOf(call.params);
      await relay(client.deletePluginData(p.id, path));
      deps.changed(path);
      return null;
    }
    case "rooms.list":
      needs(p, "rooms.read");
      return deps.rooms().map((r) => ({ id: r.id, name: r.name }));
    case "artifacts.list": {
      needs(p, "rooms.read");
      const roomId = field(call.params, "roomId");
      if (typeof roomId !== "string") throw new BridgeError("not_found");
      const { data } = await relay(client.listArtifacts(roomId));
      return [...data]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map((a) => ({ roomId: a.roomId, artifactId: a.id, fileKey: a.fileKey, title: a.title, createdAt: a.createdAt }));
    }
    case "open": {
      const roomId = field(call.params, "roomId");
      const fileKey = field(call.params, "fileKey");
      const anchor = anchorOf(call.params);
      const { viewer } = deps;
      if (typeof roomId === "string") {
        if (!deps.rooms().some((r) => r.id === roomId)) throw new BridgeError("not_found");
        viewer.navigate({ kind: "room", roomId });
        return null;
      }
      if (typeof fileKey === "string") {
        const a = await relay(client.findArtifactByFileKey(fileKey));
        if (!a) throw new BridgeError("not_found");
        const doc = { kind: "doc", roomId: a.roomId, artifactId: a.id } as const;
        const tabId = deps.slot === "tab" ? viewer.open(doc, { nextToActive: true }) : viewer.navigate(doc);
        if (anchor !== undefined) viewer.reveal(tabId, { pluginId: p.id, anchor });
        return null;
      }
      throw new BridgeError("not_found");
    }
    default:
      throw new BridgeError("unknown_method", `unknown method: ${call.method}`);
  }
}
