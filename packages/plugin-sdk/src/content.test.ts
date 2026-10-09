import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectContent } from "./content";

function fakeParent() {
  const sent: Record<string, unknown>[] = [];
  const parent = { postMessage: (m: Record<string, unknown>) => void sent.push(m) } as unknown as Window;
  Object.defineProperty(window, "parent", { value: parent, configurable: true });
  const deliver = (data: unknown, source: unknown = parent) =>
    window.dispatchEvent(new MessageEvent("message", { data, source: source as MessageEventSource }));
  return { sent, deliver };
}

let host: ReturnType<typeof fakeParent>;
beforeEach(() => {
  host = fakeParent();
  document.body.innerHTML = `<p id="t">hello world</p>`;
});

const reply = (id: unknown, extra: Record<string, unknown>) => ({ rooms: "content", v: 1, plugin: "marker", type: "reply", id, ...extra });

describe("connectContent", () => {
  it("posts storage calls with the content envelope and resolves on the matching reply", async () => {
    const c = connectContent("marker");
    c.ready();
    expect(host.sent[0]).toEqual({ rooms: "content", v: 1, plugin: "marker", type: "ready" });
    const p = c.storage.write("marks.json", "{}");
    const req = host.sent.at(-1)!;
    expect(req).toMatchObject({ rooms: "content", v: 1, plugin: "marker", type: "storage.write", path: "marks.json", text: "{}" });
    host.deliver(reply(req.id, { result: null }));
    await expect(p).resolves.toBeNull();
  });

  it("ignores messages whose source is not the app, or that name another plugin", async () => {
    const c = connectContent("marker", { timeoutMs: 50 });
    const p = c.storage.read("marks.json");
    const { id } = host.sent.at(-1)!;
    host.deliver(reply(id, { result: "forged" }), window);
    host.deliver({ ...reply(id, { result: "other" }), plugin: "other" });
    const seen: string[] = [];
    c.onDataChanged((path) => seen.push(path));
    host.deliver({ rooms: "content", v: 1, plugin: "marker", type: "dataChanged", path: "x" }, window);
    expect(seen).toEqual([]);
    await expect(p).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects with the app's error code", async () => {
    const c = connectContent("marker");
    const p = c.storage.write("../x", "t");
    host.deliver(reply(host.sent.at(-1)!.id, { error: { code: "invalid_path" } }));
    await expect(p).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("hands an action the last selection, even after the click cleared it", () => {
    const c = connectContent("marker");
    c.setActions([{ id: "mark", title: "Mark" }]);
    expect(host.sent.at(-1)).toEqual({ rooms: "content", v: 1, plugin: "marker", type: "actions", items: [{ id: "mark", title: "Mark" }] });
    const r = document.createRange();
    r.selectNodeContents(document.getElementById("t")!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
    document.dispatchEvent(new Event("selectionchange"));
    getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    const got: [string, string | undefined][] = [];
    c.onAction((id, s) => got.push([id, s?.text]));
    host.deliver({ rooms: "content", v: 1, plugin: "marker", type: "selection.action", actionId: "mark" });
    expect(got).toEqual([["mark", "hello world"]]);
  });
});

describe("onReveal", () => {
  it("hands over the anchor from the app, and ignores one the document posted or one for another plugin", () => {
    const c = connectContent("marker");
    const got: unknown[] = [];
    const off = c.onReveal((a) => got.push(a));
    const reveal = (anchor: unknown, extra: Record<string, unknown> = {}) => ({ rooms: "content", v: 1, plugin: "marker", type: "reveal", anchor, ...extra });
    host.deliver(reveal({ mark: "forged" }), window);
    host.deliver(reveal({ mark: "other" }, { plugin: "other" }));
    host.deliver(reveal({ mark: "x" }));
    off();
    host.deliver(reveal({ mark: "after" }));
    expect(got).toEqual([{ mark: "x" }]);
  });
});

describe("sync", () => {
  const sync = { rooms: "content", v: 1, plugin: "marker", type: "sync" };

  it("says ready and the last actions again when the app asks, and only what the script said", () => {
    const c = connectContent("marker");
    host.deliver(sync);
    expect(host.sent, "nothing said yet, nothing to repeat").toEqual([]);
    c.setActions([{ id: "old", title: "Old" }]);
    c.setActions([{ id: "mark", title: "Mark" }]);
    c.ready();
    host.sent.length = 0;
    host.deliver(sync, window);
    host.deliver({ ...sync, plugin: "other" });
    expect(host.sent, "a forged or foreign ask gets nothing").toEqual([]);
    host.deliver(sync);
    expect(host.sent).toEqual([
      { rooms: "content", v: 1, plugin: "marker", type: "actions", items: [{ id: "mark", title: "Mark" }] },
      { rooms: "content", v: 1, plugin: "marker", type: "ready" },
    ]);
  });
});

describe("content module", () => {
  it("loads without the panel SDK, so a content script bundle and index.ts share no import cycle", async () => {
    vi.resetModules();
    vi.doMock("./index", () => {
      throw new Error("content.ts imported index.ts");
    });
    const mod = await import("./content");
    expect(typeof mod.connectContent).toBe("function");
    vi.doUnmock("./index");
  });
});
