import type { Artifact, Room } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { describe, expect, it, vi } from "vitest";
import { BridgeError, handleBridgeCall, validPath } from "./bridge";
import { frameAttrs, PERMISSION_COPY } from "./permissions";
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
  const rooms: Room[] = [{ id: "r1", name: "Bench", kind: "owned", path: "/h/r1", status: "ok", artifactCount: 2, updatedAt: null }];
  return { client, navigate: vi.fn(), rooms: () => rooms };
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
  it("has plain words for every permission", () => {
    expect(PERMISSION_COPY).toEqual({
      "rooms.read": "Can see your rooms and documents",
      clipboard: "Can copy and paste",
      downloads: "Can save files you export",
    });
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

  it("opens rooms and documents by fileKey in the current tab", async () => {
    const d = deps();
    await handleBridgeCall(plugin(), call("open", { roomId: "r1" }), d);
    expect(d.navigate).toHaveBeenLastCalledWith({ kind: "room", roomId: "r1" });
    await handleBridgeCall(plugin(), call("open", { fileKey: "key-new" }), d);
    expect(d.navigate).toHaveBeenLastCalledWith({ kind: "doc", roomId: "r1", artifactId: "new" });
    expect(await codeOf(handleBridgeCall(plugin(), call("open", { fileKey: "nope" }), d))).toBe("not_found");
    expect(await codeOf(handleBridgeCall(plugin(), call("open", { roomId: "gone" }), d))).toBe("not_found");
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
