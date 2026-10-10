import type { Artifact, Room } from "@alto-rooms/protocol-ts";
import { PERMISSIONS, RoomsApiError } from "@alto-rooms/protocol-ts";
import { describe, expect, it, vi } from "vitest";
import { BridgeError, handleBridgeCall, validPath, type BridgeDeps } from "./bridge";
import { frameAttrs, PERMISSION_COPY, permissionLine } from "./permissions";
import { plugin } from "@/test/plugins";

const art = (id: string, createdAt: string): Artifact => ({
  id,
  roomId: "r1",
  relPath: `${id}.html`,
  title: id.toUpperCase(),
  createdAt,
  updatedAt: createdAt,
  author: "agent",
  source: { agent: null, session: null, cwd: null, machine: null },
  fileKey: `key-${id}`,
});

function deps() {
  const client = {
    getPluginData: vi.fn(async () => "text"),
    putPluginData: vi.fn(async () => undefined),
    listPluginData: vi.fn(async () => ["a.txt"]),
    deletePluginData: vi.fn(async () => undefined),
    listArtifacts: vi.fn(async () => ({ data: [art("old", "2026-01-01T00:00:00Z"), art("new", "2026-02-01T00:00:00Z")], seq: 1 })),
    findArtifactByFileKey: vi.fn(async (k: string) => (k === "key-new" ? art("new", "2026-02-01T00:00:00Z") : null)),
  };
  const rooms: Room[] = [{ id: "r1", name: "Bench", kind: "owned", path: "/h/r1", status: "ok", artifactCount: 2, updatedAt: null, color: null }];
  const viewer = { navigate: vi.fn(() => "current"), open: vi.fn(() => "opened"), reveal: vi.fn() };
  return { client, changed: vi.fn(), slot: "artifact.sidePanel" as BridgeDeps["slot"], viewer, rooms: () => rooms };
}

const call = (method: string, params: unknown = {}) => ({ id: "1", method, params });
const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: BridgeError) => e.code,
  );

describe("frameAttrs", () => {
  it("is allow-scripts only by default, never same-origin or popups", () => {
    expect(frameAttrs(plugin())).toEqual({ sandbox: "allow-scripts", allow: undefined });
  });
  it("adds downloads and clipboard only when declared", () => {
    expect(frameAttrs(plugin({ permissions: ["downloads", "clipboard"] }))).toEqual({
      sandbox: "allow-scripts allow-downloads",
      allow: "clipboard-read; clipboard-write",
    });
  });
  it("opens nothing in the plugin frame for artifact.content", () => {
    expect(frameAttrs(plugin({ permissions: ["artifact.content"] }))).toEqual({ sandbox: "allow-scripts", allow: undefined });
  });
  it("has plain words for every permission", () => {
    expect(PERMISSION_COPY).toEqual({
      "rooms.read": "Can see your rooms and artifacts",
      clipboard: "Can copy and paste",
      downloads: "Can save files you export",
      "artifact.content": "Can read the text of artifacts and use the network inside them",
    });
  });
  it("has copy for exactly the permissions the core accepts", () => {
    expect(Object.keys(PERMISSION_COPY).sort()).toEqual([...PERMISSIONS].sort());
  });
  it("still names a permission it has no copy for", () => {
    expect(permissionLine("clipboard")).toBe("Can copy and paste");
    expect(permissionLine("camera")).toBe("Can use camera");
  });
});

describe("validPath", () => {
  it("matches the core's rule", () => {
    for (const ok of ["a", "notes/a.excalidraw", "1/2/3/4/5/6/7/8"]) expect(validPath(ok)).toBe(true);
    for (const bad of ["", "/x", "../x", "a/../b", "a/./b", "a//b", "a/", "a b", "1/2/3/4/5/6/7/8/9", "a".repeat(201), "é", 3, null])
      expect(validPath(bad)).toBe(false);
  });
});

describe("handleBridgeCall", () => {
  it("relays storage calls to the plugin's data", async () => {
    const d = deps();
    expect(await handleBridgeCall(plugin(), call("storage.read", { path: "a.txt" }), d)).toBe("text");
    await handleBridgeCall(plugin(), call("storage.write", { path: "a.txt", text: "hi" }), d);
    expect(d.client.putPluginData).toHaveBeenCalledWith("echo", "a.txt", "hi");
    expect(await handleBridgeCall(plugin(), call("storage.list", { prefix: "" }), d)).toEqual(["a.txt"]);
    await handleBridgeCall(plugin(), call("storage.delete", { path: "a.txt" }), d);
    expect(d.client.deletePluginData).toHaveBeenCalledWith("echo", "a.txt");
    expect(d.changed.mock.calls).toEqual([["a.txt"], ["a.txt"]]);
  });

  it("refuses bad paths and oversized text before any request", async () => {
    const d = deps();
    expect(await codeOf(handleBridgeCall(plugin(), call("storage.write", { path: "../token", text: "x" }), d))).toBe("invalid_path");
    const big = "x".repeat(10 * 1024 * 1024 + 1);
    expect(await codeOf(handleBridgeCall(plugin(), call("storage.write", { path: "a", text: big }), d))).toBe("too_large");
    expect(await codeOf(handleBridgeCall(plugin(), call("storage.write", { path: "a", text: 5 }), d))).toBe("invalid_path");
    expect(d.client.putPluginData).not.toHaveBeenCalled();
  });

  it("needs rooms.read for rooms and artifacts", async () => {
    const d = deps();
    expect(await codeOf(handleBridgeCall(plugin(), call("rooms.list"), d))).toBe("permission_denied");
    expect(await codeOf(handleBridgeCall(plugin(), call("artifacts.list", { roomId: "r1" }), d))).toBe("permission_denied");
    const reader = plugin({ permissions: ["rooms.read"] });
    expect(await handleBridgeCall(reader, call("rooms.list"), d)).toEqual([{ id: "r1", name: "Bench" }]);
    expect(await handleBridgeCall(reader, call("artifacts.list", { roomId: "r1" }), d)).toEqual([
      { roomId: "r1", artifactId: "new", fileKey: "key-new", title: "NEW", createdAt: "2026-02-01T00:00:00Z" },
      { roomId: "r1", artifactId: "old", fileKey: "key-old", title: "OLD", createdAt: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("opens rooms and documents by fileKey in the current tab from a side panel", async () => {
    const d = deps();
    await handleBridgeCall(plugin(), call("open", { roomId: "r1" }), d);
    expect(d.viewer.navigate).toHaveBeenLastCalledWith({ kind: "room", roomId: "r1" });
    await handleBridgeCall(plugin(), call("open", { fileKey: "key-new" }), d);
    expect(d.viewer.navigate).toHaveBeenLastCalledWith({ kind: "doc", roomId: "r1", artifactId: "new" });
    expect(d.viewer.open).not.toHaveBeenCalled();
    expect(d.viewer.reveal).not.toHaveBeenCalled();
    expect(await codeOf(handleBridgeCall(plugin(), call("open", { fileKey: "nope" }), d))).toBe("not_found");
    expect(await codeOf(handleBridgeCall(plugin(), call("open", { roomId: "gone" }), d))).toBe("not_found");
  });

  it("from a tab, opens a document in a tab next to it and a room in place", async () => {
    const d = { ...deps(), slot: "tab" as const };
    await handleBridgeCall(plugin(), call("open", { fileKey: "key-new" }), d);
    expect(d.viewer.open).toHaveBeenCalledWith({ kind: "doc", roomId: "r1", artifactId: "new" }, { nextToActive: true });
    expect(d.viewer.navigate).not.toHaveBeenCalled();
    await handleBridgeCall(plugin(), call("open", { roomId: "r1" }), d);
    expect(d.viewer.navigate).toHaveBeenCalledWith({ kind: "room", roomId: "r1" });
  });

  it("hands the anchor, as a copy of its JSON, to the tab the document opened in", async () => {
    const tab = { ...deps(), slot: "tab" as const };
    const anchor = { mark: "x", at: [1, 2], when: new Date("2026-01-01T00:00:00Z") };
    await handleBridgeCall(plugin({ id: "marker" }), call("open", { fileKey: "key-new", anchor }), tab);
    expect(tab.viewer.reveal).toHaveBeenCalledWith("opened", { pluginId: "marker", anchor: { mark: "x", at: [1, 2], when: "2026-01-01T00:00:00.000Z" } });
    const panel = deps();
    await handleBridgeCall(plugin({ id: "marker" }), call("open", { fileKey: "key-new", anchor: null }), panel);
    expect(panel.viewer.reveal).toHaveBeenCalledWith("current", { pluginId: "marker", anchor: null });
  });

  it("refuses an anchor over 4 KiB or that is not JSON, before opening anything", async () => {
    const d = { ...deps(), slot: "tab" as const };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const anchor of ["x".repeat(5 * 1024), "é".repeat(2048), cyclic, 1n, () => 1]) {
      expect(await codeOf(handleBridgeCall(plugin(), call("open", { fileKey: "key-new", anchor }), d))).toBe("bad_request");
    }
    expect(d.client.findArtifactByFileKey).not.toHaveBeenCalled();
    expect(d.viewer.open).not.toHaveBeenCalled();
    expect(d.viewer.reveal).not.toHaveBeenCalled();
    expect(await codeOf(handleBridgeCall(plugin(), call("open", { fileKey: "key-new", anchor: "x".repeat(4094) }), d))).toBe("ok");
  });

  it("refuses a multi-megabyte anchor without serializing it whole", async () => {
    const d = { ...deps(), slot: "tab" as const };
    let visited = 0;
    const item = {
      toJSON() {
        visited++;
        return 0;
      },
    };
    const wide = new Array<unknown>(2_000_000).fill(item);
    for (const anchor of ["x".repeat(8 * 1024 * 1024), wide, { deep: wide }]) {
      expect(await codeOf(handleBridgeCall(plugin(), call("open", { fileKey: "key-new", anchor }), d))).toBe("bad_request");
    }
    expect(visited, "stops within the 4 KiB budget").toBeLessThan(2 * 4096);
    expect(d.viewer.open).not.toHaveBeenCalled();
  });

  it("hands the anchor to the calling plugin, whatever plugin the call names", async () => {
    const d = { ...deps(), slot: "tab" as const };
    await handleBridgeCall(plugin({ id: "marker" }), call("open", { fileKey: "key-new", anchor: 1, plugin: "other", pluginId: "other" }), d);
    expect(d.viewer.reveal).toHaveBeenCalledWith("opened", { pluginId: "marker", anchor: 1 });
  });

  it("maps server errors and unknown methods to codes", async () => {
    const d = deps();
    d.client.putPluginData.mockRejectedValueOnce(new RoomsApiError(413, "too large", "too_large"));
    expect(await codeOf(handleBridgeCall(plugin(), call("storage.write", { path: "a", text: "x" }), d))).toBe("too_large");
    d.client.getPluginData.mockRejectedValueOnce(new RoomsApiError(500, "disk", "write_failed"));
    expect(await codeOf(handleBridgeCall(plugin(), call("storage.read", { path: "a" }), d))).toBe("write_failed");
    expect(await codeOf(handleBridgeCall(plugin(), call("network.fetch"), d))).toBe("unknown_method");
  });
});
