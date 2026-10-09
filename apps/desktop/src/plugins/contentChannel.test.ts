import { afterEach, describe, expect, it, vi } from "vitest";
import { createContentChannel, MAX_CONTENT_WRITE_BYTES, MAX_READS_PER_SECOND, MAX_WRITES_PER_SECOND, type ContentAction, type ContentChannelDeps } from "./contentChannel";
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
    onReady: () => {},
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

  it("refuses an oversized write without encoding it, and counts UTF-8 bytes for the rest", async () => {
    const s = track(setup());
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    s.send({ plugin: "marker", type: "storage.write", id: "long", path: "a", text: "x".repeat(MAX_CONTENT_WRITE_BYTES + 1) });
    expect(encode).not.toHaveBeenCalled();
    s.send({ plugin: "marker", type: "storage.write", id: "wide", path: "a", text: "한".repeat(MAX_CONTENT_WRITE_BYTES / 3 + 1) });
    await s.flush();
    encode.mockRestore();
    const code = (id: string) => (s.replies().find((r) => r.id === id)?.error as { code?: string } | undefined)?.code;
    expect(code("long")).toBe("too_large");
    expect(code("wide")).toBe("too_large");
    expect(s.client.putPluginData).not.toHaveBeenCalled();
  });

  it("takes the write slot before encoding, so a flood past the limit costs no encode", async () => {
    const s = track(setup());
    for (let i = 0; i < MAX_WRITES_PER_SECOND; i++) s.send({ plugin: "marker", type: "storage.write", id: `w${i}`, path: "a", text: "x" });
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    s.send({ plugin: "marker", type: "storage.write", id: "over", path: "a", text: "x".repeat(MAX_CONTENT_WRITE_BYTES) });
    expect(encode).not.toHaveBeenCalled();
    encode.mockRestore();
    await s.flush();
    expect((s.replies().find((r) => r.id === "over")?.error as { code?: string } | undefined)?.code).toBe("rate_limited");
  });

  it("allows 100 reads or lists in a second, apart from the write budget", async () => {
    const s = track(setup());
    for (let i = 0; i < MAX_READS_PER_SECOND - 1; i++) s.send({ plugin: "marker", type: "storage.read", id: `r${i}`, path: "a" });
    s.send({ plugin: "second", type: "storage.list", id: "l" });
    s.send({ plugin: "marker", type: "storage.read", id: "over", path: "a" });
    s.send({ plugin: "marker", type: "storage.list", id: "lover" });
    s.send({ plugin: "marker", type: "storage.write", id: "w", path: "a", text: "x" });
    s.tick(1000);
    s.send({ plugin: "marker", type: "storage.read", id: "after", path: "a" });
    await s.flush();
    const code = (id: string) => (s.replies().find((r) => r.id === id)?.error as { code?: string } | undefined)?.code;
    expect(code(`r${MAX_READS_PER_SECOND - 2}`)).toBeUndefined();
    expect(code("l")).toBeUndefined();
    expect(code("over")).toBe("rate_limited");
    expect(code("lover")).toBe("rate_limited");
    expect(code("w")).toBeUndefined();
    expect(code("after")).toBeUndefined();
    expect(s.client.getPluginData).toHaveBeenCalledTimes(MAX_READS_PER_SECOND);
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

  it("cuts titles by code point and strips control and bidi formatting characters", () => {
    const s = track(setup());
    const emoji = "\u{1F58D}";
    s.send({
      plugin: "marker",
      type: "actions",
      items: [
        { id: "cut", title: "x".repeat(23) + emoji + "tail" },
        { id: "rlo", title: "\u202Egnp.exe\u0007" },
      ],
    });
    s.send({ plugin: "second", type: "actions", items: [{ id: "only", title: "\u202E\u200B\n" }] });
    expect(s.ch.dropped).toBe(1);
    const titles = s.actions.at(-1)!.get("marker")!.map((a) => a.title);
    expect(titles[0]).toBe("x".repeat(23) + emoji);
    expect(titles[1]).toBe("gnp.exe");
    expect(titles.join("")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
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

describe("contentChannel reveal", () => {
  const reveals = (got: Record<string, unknown>[]) => got.filter((m) => m.type === "reveal");

  it("asks each plugin's script in the frame to repeat itself", () => {
    const s = track(setup());
    s.ch.sync();
    expect(s.doc.got).toEqual([
      { rooms: "content", v: 1, type: "sync", plugin: "marker" },
      { rooms: "content", v: 1, type: "sync", plugin: "second" },
    ]);
  });

  it("refuses an anchor until the plugin says ready, then posts it and reports ready", () => {
    const onReady = vi.fn();
    const s = track(setup({ onReady }));
    expect(s.ch.reveal("marker", { mark: "x" }), "kept by the caller until ready").toBe(false);
    s.send({ plugin: "second", type: "ready" });
    expect(s.ch.reveal("marker", { mark: "x" })).toBe(false);
    s.send({ plugin: "marker", type: "ready" });
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(s.ch.reveal("marker", { mark: "x" })).toBe(true);
    expect(reveals(s.doc.got)).toEqual([{ rooms: "content", v: 1, type: "reveal", plugin: "marker", anchor: { mark: "x" } }]);
  });

  it("uses up an anchor for a plugin outside the set at once, and posts nothing", () => {
    const s = track(setup());
    expect(s.ch.reveal("goals", 2)).toBe(true);
    s.send({ plugin: "goals", type: "ready" });
    expect(s.ch.reveal("goals", 2)).toBe(true);
    expect(reveals(s.doc.got)).toEqual([]);
  });
});
