import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, PluginError, type PluginContext } from "./index";

/** Stands in for the app: records what the plugin posts, and delivers messages "from" any window. */
function fakeParent() {
  const sent: Record<string, unknown>[] = [];
  const parent = { postMessage: (m: Record<string, unknown>) => void sent.push(m) } as unknown as Window;
  Object.defineProperty(window, "parent", { value: parent, configurable: true });
  const deliver = (data: unknown, source: unknown = parent) =>
    window.dispatchEvent(new MessageEvent("message", { data, source: source as MessageEventSource }));
  return { sent, parent, deliver };
}

const sidePanel: PluginContext = {
  slot: "artifact.sidePanel",
  artifact: { roomId: "r1", artifactId: "a1", fileKey: "abcdef0123456789", title: "Doc", createdAt: "2026-10-06T00:00:00Z" },
};

let host: ReturnType<typeof fakeParent>;
beforeEach(() => {
  host = fakeParent();
});
afterEach(() => {
  vi.useRealTimers();
});

async function ready() {
  const p = connect();
  expect(host.sent[0]).toEqual({ rooms: 1, type: "ready" });
  host.deliver({ rooms: 1, type: "context", pluginId: "echo", context: sidePanel });
  return p;
}

describe("connect", () => {
  it("posts ready and resolves on the first context, with the plugin id", async () => {
    const rooms = await ready();
    expect(rooms.pluginId).toBe("echo");
  });

  it("onContext fires at once with the current context and again on each change", async () => {
    const rooms = await ready();
    const seen: PluginContext[] = [];
    rooms.onContext((c) => seen.push(c));
    host.deliver({ rooms: 1, type: "context", pluginId: "echo", context: { slot: "tab" } });
    expect(seen).toEqual([sidePanel, { slot: "tab" }]);
  });

  it("rejects with timeout when no context arrives", async () => {
    vi.useFakeTimers();
    const p = connect({ timeoutMs: 1000 });
    const check = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(1001);
    await check;
  });
});

describe("requests", () => {
  it("posts {rooms, id, method, params} and resolves with the result", async () => {
    const rooms = await ready();
    const p = rooms.storage.read("notes/a.txt");
    const req = host.sent.at(-1)!;
    expect(req).toMatchObject({ rooms: 1, method: "storage.read", params: { path: "notes/a.txt" } });
    host.deliver({ rooms: 1, id: req.id, result: "hello" });
    await expect(p).resolves.toBe("hello");
  });

  it("maps every API to its method name", async () => {
    const rooms = await ready();
    const calls: [() => Promise<unknown>, string, unknown][] = [
      [() => rooms.storage.write("a", "t"), "storage.write", { path: "a", text: "t" }],
      [() => rooms.storage.list("n/"), "storage.list", { prefix: "n/" }],
      [() => rooms.storage.delete("a"), "storage.delete", { path: "a" }],
      [() => rooms.rooms.list(), "rooms.list", {}],
      [() => rooms.artifacts.list("r1"), "artifacts.list", { roomId: "r1" }],
      [() => rooms.open({ fileKey: "k" }), "open", { fileKey: "k" }],
    ];
    for (const [call, method, params] of calls) {
      const p = call();
      const req = host.sent.at(-1)!;
      expect(req).toMatchObject({ method, params });
      host.deliver({ rooms: 1, id: req.id, result: null });
      await p;
    }
  });

  it("an error reply rejects with a PluginError carrying the code", async () => {
    const rooms = await ready();
    const p = rooms.rooms.list();
    host.deliver({ rooms: 1, id: host.sent.at(-1)!.id, error: { code: "permission_denied", message: "needs rooms.read" } });
    await expect(p).rejects.toBeInstanceOf(PluginError);
    await expect(p).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("times out a request the host never answers", async () => {
    vi.useFakeTimers();
    const p0 = connect({ timeoutMs: 500 });
    host.deliver({ rooms: 1, type: "context", pluginId: "echo", context: sidePanel });
    const rooms = await p0;
    const p = rooms.storage.read("a");
    const check = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(501);
    await check;
  });
});

describe("only the parent window is trusted", () => {
  const sibling = {} as Window;

  it("ignores a forged context from a sibling frame", async () => {
    const rooms = await ready();
    const seen: PluginContext[] = [];
    rooms.onContext((c) => seen.push(c));
    host.deliver({ rooms: 1, type: "context", pluginId: "evil", context: { ...sidePanel, artifact: { ...sidePanel.artifact, fileKey: "forged" } } }, sibling);
    expect(seen).toEqual([sidePanel]);
    expect(rooms.pluginId).toBe("echo");
  });

  it("ignores a forged reply to a pending request", async () => {
    const rooms = await ready();
    const p = rooms.storage.read("a");
    const id = host.sent.at(-1)!.id;
    host.deliver({ rooms: 1, id, result: "forged" }, sibling);
    host.deliver({ rooms: 1, id, result: "real" });
    await expect(p).resolves.toBe("real");
  });

  it("ignores a forged beforeClose and ping", async () => {
    const rooms = await ready();
    const handler = vi.fn();
    rooms.onBeforeClose(handler);
    const before = host.sent.length;
    host.deliver({ rooms: 1, type: "beforeClose", id: "x" }, sibling);
    host.deliver({ rooms: 1, type: "ping", id: "y" }, sibling);
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    expect(host.sent.length).toBe(before);
  });

  it("ignores messages without rooms: 1", async () => {
    const rooms = await ready();
    const p = rooms.storage.read("a");
    const id = host.sent.at(-1)!.id;
    host.deliver({ id, result: "no tag" });
    host.deliver({ rooms: 1, id, result: "ok" });
    await expect(p).resolves.toBe("ok");
  });
});

describe("lifecycle", () => {
  it("beforeClose runs handlers, then acks with the same id even if one throws", async () => {
    const rooms = await ready();
    const order: string[] = [];
    rooms.onBeforeClose(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("save");
    });
    rooms.onBeforeClose(() => {
      throw new Error("boom");
    });
    host.deliver({ rooms: 1, type: "beforeClose", id: "c1" });
    await vi.waitFor(() => expect(host.sent.at(-1)).toEqual({ rooms: 1, type: "beforeClose.done", id: "c1" }));
    expect(order).toEqual(["save"]);
  });

  it("answers ping with pong", async () => {
    await ready();
    host.deliver({ rooms: 1, type: "ping", id: "p1" });
    expect(host.sent.at(-1)).toEqual({ rooms: 1, type: "pong", id: "p1" });
  });
});
