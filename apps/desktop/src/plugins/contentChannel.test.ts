import { afterEach, describe, expect, it, vi } from "vitest";
import { createContentChannel, MAX_CONTENT_WRITE_BYTES, type ContentAction, type ContentChannelDeps } from "./contentChannel";
import { pluginDataBus } from "./pluginDataBus";

const FILE_KEY = "00000000000000aa";

/** A doc frame window stand-in: records what the host posts to it. */
function fakeWindow() {
  const got: Record<string, unknown>[] = [];
  return { got, win: { postMessage: (m: Record<string, unknown>) => void got.push(m) } as unknown as Window };
}

function setup(over: Partial<ContentChannelDeps> = {}) {
  const doc = fakeWindow();
  let t = 0;
  const client = {
    getPluginData: vi.fn(async (_id: string, _p: string): Promise<string | null> => "stored"),
    putPluginData: vi.fn(async (_id: string, _p: string, _t: string) => undefined),
    listPluginData: vi.fn(async (_id: string, _prefix?: string) => [`docs/${FILE_KEY}/a.json`, `docs/${FILE_KEY}/n/b.json`]),
    deletePluginData: vi.fn(async (_id: string, _p: string) => undefined),
  };
  const actions: ReadonlyMap<string, ContentAction[]>[] = [];
  const ch = createContentChannel({
    fileKey: FILE_KEY,
    plugins: new Set(["marker", "second"]),
    frame: () => doc.win,
    client,
    onActions: (a) => actions.push(a),
    now: () => t,
    validColor: (v) => /^#[0-9a-f]{3,8}$|^[a-z]+$/i.test(v),
    ...over,
  });
  const send = (data: Record<string, unknown>, source: unknown = doc.win) =>
    ch.receive(new MessageEvent("message", { data: { rooms: "content", v: 1, ...data }, source: source as MessageEventSource }));
  const replies = () => doc.got.filter((m) => m.type === "reply");
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { ch, doc, client, actions, send, replies, flush, tick: (ms: number) => void (t += ms) };
}

let open: { dispose(): void }[] = [];
const track = <T extends { ch: { dispose(): void } }>(s: T) => (open.push(s.ch), s);
afterEach(() => {
  for (const c of open) c.dispose();
  open = [];
});

describe("contentChannel", () => {
  it("maps storage under docs/<fileKey>/ of the named plugin and replies to the frame", async () => {
    const s = track(setup());
    s.send({ plugin: "marker", type: "storage.write", id: "1", path: "marks.json", text: "{}" });
    s.send({ plugin: "marker", type: "storage.read", id: "2", path: "marks.json" });
    s.send({ plugin: "marker", type: "storage.list", id: "3", prefix: "" });
    s.send({ plugin: "marker", type: "storage.delete", id: "4", path: "marks.json" });
    await s.flush();
    expect(s.client.putPluginData).toHaveBeenCalledWith("marker", `docs/${FILE_KEY}/marks.json`, "{}");
    expect(s.client.getPluginData).toHaveBeenCalledWith("marker", `docs/${FILE_KEY}/marks.json`);
    expect(s.client.listPluginData).toHaveBeenCalledWith("marker", `docs/${FILE_KEY}/`);
    expect(s.client.deletePluginData).toHaveBeenCalledWith("marker", `docs/${FILE_KEY}/marks.json`);
    expect(s.replies()).toEqual([
      { rooms: "content", v: 1, type: "reply", plugin: "marker", id: "1", result: null },
      { rooms: "content", v: 1, type: "reply", plugin: "marker", id: "2", result: "stored" },
      { rooms: "content", v: 1, type: "reply", plugin: "marker", id: "3", result: ["a.json", "n/b.json"] },
      { rooms: "content", v: 1, type: "reply", plugin: "marker", id: "4", result: null },
    ]);
  });

  it("ignores every window but the doc frame", async () => {
    const s = track(setup());
    s.send({ plugin: "marker", type: "storage.write", id: "1", path: "a", text: "x" }, fakeWindow().win);
    s.send({ plugin: "marker", type: "storage.write", id: "1", path: "a", text: "x" }, window);
    await s.flush();
    expect(s.client.putPluginData).not.toHaveBeenCalled();
    expect(s.doc.got).toEqual([]);
  });

  it("drops and counts a plugin outside the frame's set, or a malformed message", async () => {
    const s = track(setup());
    s.send({ plugin: "goals", type: "storage.write", id: "1", path: "a", text: "x" });
    s.send({ plugin: "marker", type: "storage.write", path: "a", text: "x" });
    s.send({ plugin: "marker", type: "nope", id: "1" });
    s.send({ plugin: 7, type: "ready" });
    await s.flush();
    expect(s.client.putPluginData).not.toHaveBeenCalled();
    expect(s.doc.got).toEqual([]);
    expect(s.ch.dropped).toBe(4);
  });

  it("refuses path escapes, a fileKey of the frame's choosing, and non-string text before any request", async () => {
    const s = track(setup());
    const bad = ["../other/marks.json", "../../token", `/docs/${FILE_KEY}/x`, "a/./b", "", "x".repeat(200)];
    bad.forEach((path, i) => s.send({ plugin: "marker", type: "storage.write", id: `w${i}`, path, text: "x" }));
    s.send({ plugin: "marker", type: "storage.write", id: "k", path: "marks.json", text: "x", fileKey: "ffffffffffffffff" });
    s.send({ plugin: "marker", type: "storage.write", id: "t", path: "marks.json", text: 5 });
    s.send({ plugin: "marker", type: "storage.list", id: "l", prefix: "../" });
    await s.flush();
    const codes = Object.fromEntries(s.replies().map((r) => [r.id, (r.error as { code?: string } | undefined)?.code ?? "ok"]));
    expect(codes).toEqual({ w0: "invalid_path", w1: "invalid_path", w2: "invalid_path", w3: "invalid_path", w4: "invalid_path", w5: "invalid_path", k: "ok", t: "invalid_path", l: "invalid_path" });
    expect(s.client.putPluginData.mock.calls).toEqual([["marker", `docs/${FILE_KEY}/marks.json`, "x"]]);
    expect(s.client.listPluginData).not.toHaveBeenCalled();
  });

  it("refuses a write over 1 MiB", async () => {
    const s = track(setup());
    s.send({ plugin: "marker", type: "storage.write", id: "big", path: "a", text: "x".repeat(MAX_CONTENT_WRITE_BYTES + 1) });
    s.send({ plugin: "marker", type: "storage.write", id: "max", path: "a", text: "x".repeat(MAX_CONTENT_WRITE_BYTES) });
    await s.flush();
    expect(s.replies().map((r) => [r.id, (r.error as { code?: string } | undefined)?.code])).toEqual([
      ["big", "too_large"],
      ["max", undefined],
    ]);
  });

  it("allows 20 writes or deletes in a second and refuses the 21st until the second passes", async () => {
    const s = track(setup());
    for (let i = 0; i < 19; i++) s.send({ plugin: "marker", type: "storage.write", id: `w${i}`, path: "a", text: "x" });
    s.send({ plugin: "second", type: "storage.delete", id: "d", path: "a" });
    s.send({ plugin: "marker", type: "storage.write", id: "over", path: "a", text: "x" });
    s.send({ plugin: "marker", type: "storage.read", id: "read", path: "a" });
    s.tick(999);
    s.send({ plugin: "marker", type: "storage.write", id: "still", path: "a", text: "x" });
    s.tick(1);
    s.send({ plugin: "marker", type: "storage.write", id: "after", path: "a", text: "x" });
    await s.flush();
    const code = (id: string) => (s.replies().find((r) => r.id === id)?.error as { code?: string } | undefined)?.code;
    expect(code("w18")).toBeUndefined();
    expect(code("d")).toBeUndefined();
    expect(code("over")).toBe("rate_limited");
    expect(code("read")).toBeUndefined();
    expect(code("still")).toBe("rate_limited");
    expect(code("after")).toBeUndefined();
    expect(s.client.putPluginData).toHaveBeenCalledTimes(20);
  });

  it("sends dataChanged for this document's folder to the frame, never back to the writer", async () => {
    const s = track(setup());
    const other = fakeWindow();
    pluginDataBus.publish({ pluginId: "marker", path: `docs/${FILE_KEY}/marks.json`, from: other.win });
    pluginDataBus.publish({ pluginId: "marker", path: "docs/00000000000000bb/marks.json", from: other.win });
    pluginDataBus.publish({ pluginId: "goals", path: `docs/${FILE_KEY}/marks.json`, from: other.win });
    pluginDataBus.publish({ pluginId: "marker", path: "tab.json", from: other.win });
    s.send({ plugin: "marker", type: "storage.write", id: "1", path: "own.json", text: "x" });
    await s.flush();
    expect(s.doc.got.filter((m) => m.type === "dataChanged")).toEqual([{ rooms: "content", v: 1, type: "dataChanged", plugin: "marker", path: "marks.json" }]);
  });

  it("publishes its writes so the plugin's other frames hear of them", async () => {
    const s = track(setup());
    const heard: unknown[] = [];
    const off = pluginDataBus.subscribe((c) => heard.push(c));
    s.send({ plugin: "marker", type: "storage.write", id: "1", path: "marks.json", text: "x" });
    s.send({ plugin: "marker", type: "storage.delete", id: "2", path: "marks.json" });
    s.send({ plugin: "marker", type: "storage.write", id: "3", path: "../x", text: "x" });
    await s.flush();
    off();
    expect(heard).toEqual([
      { pluginId: "marker", path: `docs/${FILE_KEY}/marks.json`, from: s.doc.win },
      { pluginId: "marker", path: `docs/${FILE_KEY}/marks.json`, from: s.doc.win },
    ]);
  });

  it("takes at most 6 actions with checked colors, cuts titles, and keeps them per plugin", () => {
    const s = track(setup());
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, title: `Action ${i}` }));
    s.send({ plugin: "marker", type: "actions", items: items(7) });
    s.send({ plugin: "marker", type: "actions", items: [{ id: "x", title: "Bad", color: "url(x)" }] });
    s.send({ plugin: "marker", type: "actions", items: [{ id: "x", title: "A" }, { id: "x", title: "B" }] });
    expect(s.actions).toEqual([]);
    expect(s.ch.dropped).toBe(3);
    s.send({ plugin: "marker", type: "actions", items: [{ id: "mark", title: "Mark this passage for later reading", color: "#ffd400" }] });
    s.send({ plugin: "second", type: "actions", items: items(6) });
    const last = s.actions.at(-1)!;
    expect(last.get("marker")).toEqual([{ id: "mark", title: "Mark this passage for la", color: "#ffd400" }]);
    expect(last.get("second")).toHaveLength(6);
  });

  it("posts selection.action only to the plugin that declared the action", () => {
    const s = track(setup());
    s.send({ plugin: "marker", type: "actions", items: [{ id: "mark", title: "Mark" }] });
    s.ch.runAction("second", "mark");
    s.ch.runAction("marker", "other");
    s.ch.runAction("marker", "mark");
    expect(s.doc.got).toEqual([{ rooms: "content", v: 1, type: "selection.action", plugin: "marker", actionId: "mark" }]);
  });
});
