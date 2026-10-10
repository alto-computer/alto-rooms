/*
 * The app side of the plugin bridge: one request from a plugin frame, checked
 * (shape, permission, path, size) and relayed to roomsd through the client.
 * The token never crosses to the plugin; roomsd checks paths again.
 */
import type { Artifact, PluginInfo, Room } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import type { TabInput, ViewerStore } from "@/data/viewerStore";
import { parseSurfaceId, type SurfaceId } from "@/surfaces/surfaceHub";

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
  /** The slot the calling frame fills: a tab opens docs in a tab of their own, a side panel or a background frame in the current tab. */
  slot: "tab" | "artifact.sidePanel" | "background";
  viewer: Pick<ViewerStore, "navigate" | "open" | "reveal">;
  /** The rooms in sidebar order. */
  rooms(): Room[];
  /** The tab that shows `surface` is open: unfold its thread and flash the range once the surface is on screen. */
  revealSurface(surface: SurfaceId, rangeId: string): void;
};

const RANGE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

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
  const refused = new BridgeError("bad_request", `anchor must be JSON of at most ${MAX_ANCHOR_BYTES} bytes`);
  // Counts at least one byte per key and value, and a string's length (UTF-8 never takes fewer bytes), so a
  // multi-megabyte anchor stops after a few thousand steps instead of being serialized whole.
  let budget = MAX_ANCHOR_BYTES;
  let json: string | undefined;
  try {
    json = JSON.stringify(anchor, (key, value: unknown) => {
      budget -= 1 + key.length + (typeof value === "string" ? value.length : 0);
      if (budget < 0) throw refused;
      return value;
    });
  } catch {
    throw refused;
  }
  if (json === undefined || new TextEncoder().encode(json).length > MAX_ANCHOR_BYTES) throw refused;
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

/** The tab whose ask bar holds the surface's thread. */
async function surfaceTab(surface: SurfaceId, deps: BridgeDeps): Promise<TabInput> {
  const { scope } = surface;
  switch (scope.kind) {
    case "doc": {
      const a = await relay(deps.client.findArtifactByFileKey(scope.fileKey));
      if (!a) throw new BridgeError("not_found");
      return { kind: "doc", roomId: a.roomId, artifactId: a.id };
    }
    case "room":
      if (!deps.rooms().some((r) => r.id === scope.roomId)) throw new BridgeError("not_found");
      return { kind: "room", roomId: scope.roomId };
    case "day":
      return { kind: "journal", date: scope.date };
  }
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
      if (field(call.params, "surface") !== undefined) {
        needs(p, "surfaces.text");
        const surface = parseSurfaceId(field(call.params, "surface"));
        const rangeId = field(call.params, "rangeId");
        if (!surface || typeof rangeId !== "string" || !RANGE_ID.test(rangeId)) throw new BridgeError("bad_request", "surface must name an answer and rangeId one of its ranges");
        const tab = await surfaceTab(surface, deps);
        if (deps.slot === "tab") viewer.open(tab, { nextToActive: true });
        else viewer.navigate(tab);
        deps.revealSurface(surface, rangeId);
        return null;
      }
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
