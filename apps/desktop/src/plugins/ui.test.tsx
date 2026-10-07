import type { Artifact, PluginInfo } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerStore } from "@/data/viewerStore";
import { AppShell } from "@/shell/AppShell";
import { memoryStorage, renderWithStores, room } from "@/test/fakes";
import { plugin } from "@/test/plugins";
import { DocView } from "@/views/DocView";
import { EnableCard } from "./EnableCard";
import { flushAllPlugins } from "./host";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const doc: Artifact = {
  id: "a1",
  roomId: "r1",
  relPath: "a1.html",
  title: "Latency report",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  author: "agent",
  source: { agent: null, session: null, cwd: null, machine: null },
  fileKey: "9f2c000000000000",
};

const echoTab = (extra: Partial<PluginInfo> = {}) =>
  plugin({ slots: { artifactSidePanel: null, tab: { title: "Echo", icon: "puzzle", sidebar: true } }, ...extra });

async function openDoc(plugins: PluginInfo[] = [plugin()], pluginData: Record<string, string> = {}) {
  const h = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
    rooms: [room("r1", "Bench")],
    artifacts: { r1: [doc] },
    plugins,
    pluginData,
  });
  await act(async () => {});
  return h;
}

const frame = (name: string) => screen.getByTitle(name) as HTMLIFrameElement;

function fromFrame(f: HTMLIFrameElement, data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source: f.contentWindow }));
  });
}

async function openPanel(name = "Echo") {
  fireEvent.click(screen.getByRole("button", { name: `Open ${name}` }));
  await act(async () => {});
  const f = frame(name);
  const posted = vi.spyOn(f.contentWindow!, "postMessage");
  return { f, posted };
}

describe("artifact side panel", () => {
  it("previews drag width without persisting until release and stops after cancellation", async () => {
    const h = await openDoc();
    await openPanel();
    const handle = screen.getByRole("separator", { name: "Resize panel" });
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = () => false;
    const panel = handle.parentElement!;
    const initial = h.viewer.getState().pluginPanel.width;
    const writes = vi.spyOn(h.viewer, "setPluginPanel");
    vi.useFakeTimers();
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 800 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 700 });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(panel.style.width).toBe(`${initial + 100}px`);
    expect(writes).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 690 });
    expect(h.viewer.getState().pluginPanel.width).toBe(initial + 110);
    expect(writes).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: 690 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 650 });
    fireEvent.pointerCancel(window, { pointerId: 2 });
    const afterCancel = h.viewer.getState().pluginPanel.width;
    writes.mockClear();
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 400 });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(panel.style.width).toBe(`${afterCancel}px`);
    expect(writes).not.toHaveBeenCalled();
  });

  it.each(["lostpointercapture", "blur", "unmount"])("cleans up a resize on %s", async (reason) => {
    const h = await openDoc();
    await openPanel();
    const handle = screen.getByRole("separator", { name: "Resize panel" });
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = () => false;
    const initial = h.viewer.getState().pluginPanel.width;
    const writes = vi.spyOn(h.viewer, "setPluginPanel");
    vi.useFakeTimers();
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 800 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 300 });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(handle.parentElement!.style.width).toBe(`${initial}px`);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 650 });
    if (reason === "unmount") cleanup();
    else if (reason === "blur") fireEvent(window, new Event("blur"));
    else fireEvent(handle, new PointerEvent("lostpointercapture", { pointerId: 1 }));
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 500 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 500 });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(writes).not.toHaveBeenCalled();
    expect(document.body.style.userSelect).not.toBe("none");
  });

  it("shows nothing without an enabled side-panel plugin", async () => {
    await openDoc([plugin({ enabled: false, needsApproval: true }), echoTab()]);
    expect(screen.queryByRole("button", { name: /^Open / })).toBeNull();
  });

  it("opens a sandboxed frame from the plugin's folder and remembers it is open", async () => {
    const h = await openDoc();
    const { f } = await openPanel();
    expect(f.getAttribute("src")).toBe("http://files.test/_plugins/echo/index.html");
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
    expect(f.hasAttribute("allow")).toBe(false);
    expect(h.viewer.getState().pluginPanel).toMatchObject({ open: true, pluginId: "echo" });
  });

  it("answers ready with the open document's context", async () => {
    await openDoc();
    const { f, posted } = await openPanel();
    fromFrame(f, { rooms: 1, type: "ready" });
    expect(posted).toHaveBeenLastCalledWith(
      {
        rooms: 1,
        type: "context",
        pluginId: "echo",
        context: {
          slot: "artifact.sidePanel",
          artifact: {
            roomId: "r1",
            artifactId: "a1",
            fileKey: "9f2c000000000000",
            title: "Latency report",
            createdAt: "2026-10-01T00:00:00Z",
          },
        },
      },
      "*",
    );
  });

  it("relays requests to the plugin's data and replies to the same frame", async () => {
    const h = await openDoc();
    const { f, posted } = await openPanel();
    fromFrame(f, { rooms: 1, id: "r1", method: "storage.write", params: { path: "notes/9f2c.txt", text: "hi" } });
    await act(async () => {});
    expect(h.state.pluginData["echo/notes/9f2c.txt"]).toBe("hi");
    expect(posted).toHaveBeenLastCalledWith({ rooms: 1, id: "r1", result: null }, "*");
    fromFrame(f, { rooms: 1, id: "r2", method: "rooms.list", params: {} });
    await act(async () => {});
    expect(posted).toHaveBeenLastCalledWith(
      { rooms: 1, id: "r2", error: { code: "permission_denied", message: "needs the rooms.read permission" } },
      "*",
    );
  });

  it("tells the frame when its own plugin's data changes, and no other plugin's", async () => {
    const h = await openDoc();
    const { posted } = await openPanel();
    h.emit({ type: "plugin.data.changed", pluginId: "other", path: "drawings/a.jsonl" });
    expect(posted).not.toHaveBeenCalled();
    h.emit({ type: "plugin.data.changed", pluginId: "echo", path: "drawings/a.jsonl" });
    expect(posted).toHaveBeenLastCalledWith({ rooms: 1, type: "dataChanged", path: "drawings/a.jsonl" }, "*");
  });

  it("stops relaying data changes once the frame is gone", async () => {
    const h = await openDoc();
    let listeners = 0;
    const onSignal = h.rooms.onSignal.bind(h.rooms);
    vi.spyOn(h.rooms, "onSignal").mockImplementation((fn) => {
      listeners++;
      const off = onSignal(fn);
      return () => {
        listeners--;
        off();
      };
    });
    const { posted } = await openPanel();
    expect(listeners).toBeGreaterThan(0);
    cleanup();
    expect(listeners).toBe(0);
    h.emit({ type: "plugin.data.changed", pluginId: "echo", path: "a.jsonl" });
    expect(posted.mock.calls.filter((c) => (c[0] as { type?: string }).type === "dataChanged")).toEqual([]);
  });

  it("ignores messages from any other window", async () => {
    const h = await openDoc();
    const { posted } = await openPanel();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { rooms: 1, id: "x", method: "storage.write", params: { path: "a", text: "x" } },
          source: window,
        }),
      );
    });
    await act(async () => {});
    expect(posted).not.toHaveBeenCalled();
    expect(h.state.pluginData).toEqual({});
  });

  it("closing waits for the plugin's beforeClose ack", async () => {
    const h = await openDoc();
    const { f, posted } = await openPanel();
    fromFrame(f, { rooms: 1, type: "ready" });
    fireEvent.click(screen.getByRole("button", { name: "Close Echo" }));
    const close = posted.mock.calls.map((c) => c[0] as { type?: string; id?: string }).find((m) => m.type === "beforeClose")!;
    expect(close).toBeTruthy();
    expect(screen.getByTitle("Echo")).toBeInTheDocument();
    fromFrame(f, { rooms: 1, type: "beforeClose.done", id: close.id });
    await act(async () => {});
    expect(screen.queryByTitle("Echo")).toBeNull();
    expect(h.viewer.getState().pluginPanel.open).toBe(false);
  });

  it("closing gives up waiting after 1.5 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openDoc();
    const { f } = await openPanel();
    fromFrame(f, { rooms: 1, type: "ready" });
    fireEvent.click(screen.getByRole("button", { name: "Close Echo" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(screen.queryByTitle("Echo")).toBeNull();
  });

  it("shows a stopped overlay when pings go unanswered, and Reload brings the frame back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openDoc();
    const { f, posted } = await openPanel();
    fromFrame(f, { rooms: 1, type: "ready" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const ping = posted.mock.calls.map((c) => c[0] as { type?: string; id?: string }).find((m) => m.type === "ping")!;
    expect(ping).toBeTruthy();
    fromFrame(f, { rooms: 1, type: "pong", id: ping.id });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8100);
    });
    expect(screen.getByText("This plugin stopped responding")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(screen.queryByText("This plugin stopped responding")).toBeNull();
    expect(frame("Echo")).toBeInTheDocument();
  });

  it("several side-panel plugins share the panel with a switcher", async () => {
    await openDoc([plugin(), plugin({ id: "notes", name: "Notes", slots: { artifactSidePanel: { title: "Notes" }, tab: null } })]);
    await openPanel();
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByTitle("Notes")).toBeInTheDocument();
    expect(screen.queryByTitle("Echo")).toBeNull();
  });
});

describe("plugin tabs, sidebar items, and the enable card", () => {
  it("a sidebar item opens the plugin in a tab; right-click turns it off", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: [room("r1", "Bench")], plugins: [echoTab()] });
    await act(async () => {});
    const plugins = screen.getByRole("list", { name: "Plugins" });
    fireEvent.click(within(plugins).getByRole("button", { name: "Echo" }));
    expect(screen.getByRole("tab", { name: "Echo", selected: true })).toBeInTheDocument();
    expect(frame("Echo").getAttribute("src")).toBe("http://files.test/_plugins/echo/index.html");
    fireEvent.contextMenu(within(plugins).getByRole("button", { name: "Echo" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Turn off" }));
    });
    expect(h.client.setPluginEnabled).toHaveBeenCalledWith("echo", false, undefined);
    // Off stays listed, dimmed, with no card asking again; right-click turns it back on.
    const off = within(screen.getByRole("list", { name: "Plugins" }))
      .getByText("Echo")
      .closest("li")!;
    expect(off).toHaveTextContent("Off");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.contextMenu(within(off).getByText("Echo"));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Turn on" }));
    });
    expect(h.client.setPluginEnabled).toHaveBeenLastCalledWith("echo", true, []);
    expect(within(screen.getByRole("list", { name: "Plugins" })).getByRole("button", { name: "Echo" })).toBeInTheDocument();
  });

  it("a side-panel-only plugin can be turned off from the Plugins list too", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: [room("r1", "Bench")], plugins: [plugin()] });
    await act(async () => {});
    const row = within(screen.getByRole("list", { name: "Plugins" })).getByText("Echo");
    fireEvent.contextMenu(row);
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Turn off" }));
    });
    expect(h.client.setPluginEnabled).toHaveBeenCalledWith("echo", false, undefined);
  });

  it("asks again with only the new permissions when an approved plugin wants more", async () => {
    const h = await renderWithStores(<AppShell />, {
      rooms: [room("r1", "Bench")],
      plugins: [echoTab({ permissions: ["rooms.read", "clipboard"], granted: ["rooms.read"], needsApproval: true })],
    });
    await act(async () => {});
    const card = screen.getByRole("dialog", { name: "Updated plugin: Echo" });
    expect(within(card).getByText("Can copy and paste")).toBeInTheDocument();
    expect(within(card).queryByText("Can see your rooms and documents")).toBeNull();
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Turn on" }));
    });
    expect(h.client.setPluginEnabled).toHaveBeenCalledWith("echo", true, ["rooms.read", "clipboard"]);
  });

  it("a plugin tab for a removed plugin says so", async () => {
    const viewer = new ViewerStore(memoryStorage());
    viewer.open({ kind: "plugin", pluginId: "gone" });
    await renderWithStores(<AppShell />, { rooms: [room("r1", "Bench")], viewer });
    await act(async () => {});
    expect(within(screen.getByRole("tabpanel")).getByText("Missing plugin")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Missing plugin" })).toBeInTheDocument();
  });

  it("asks before a new plugin runs, in plain words; Turn on enables it", async () => {
    const h = await renderWithStores(<AppShell />, {
      rooms: [room("r1", "Bench")],
      plugins: [
        echoTab({
          enabled: false,
          granted: null,
          needsApproval: true,
          permissions: ["rooms.read", "downloads"],
          description: "Echoes things.",
        }),
      ],
    });
    await act(async () => {});
    const card = screen.getByRole("dialog", { name: "New plugin: Echo" });
    expect(within(card).getByText("Echoes things.")).toBeInTheDocument();
    expect(within(card).getByText("Can see your rooms and documents")).toBeInTheDocument();
    expect(within(card).getByText("Can save files you export")).toBeInTheDocument();
    expect(screen.queryByTitle("Echo")).toBeNull();
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Turn on" }));
    });
    expect(h.client.setPluginEnabled).toHaveBeenCalledWith("echo", true, ["rooms.read", "downloads"]);
    expect(screen.queryByRole("dialog", { name: "New plugin: Echo" })).toBeNull();
    expect(within(screen.getByRole("list", { name: "Plugins" })).getByRole("button", { name: "Echo" })).toBeInTheDocument();
  });

  it("Not now hides the card for this run without enabling", async () => {
    const h = await renderWithStores(<AppShell />, {
      rooms: [room("r1", "Bench")],
      plugins: [echoTab({ enabled: false, needsApproval: true })],
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.client.setPluginEnabled).not.toHaveBeenCalled();
  });

  it("never asks about invalid or incompatible plugins", async () => {
    await renderWithStores(<AppShell />, {
      rooms: [room("r1", "Bench")],
      plugins: [
        echoTab({ status: "invalid", enabled: false, needsApproval: false }),
        echoTab({ id: "future", minAppVersion: "99.0.0", enabled: false, needsApproval: true }),
      ],
    });
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("an open plugin when the plugin changes", () => {
  async function openEcho(h: Awaited<ReturnType<typeof openDoc>>) {
    const { f, posted } = await openPanel();
    fromFrame(f, { rooms: 1, type: "ready" });
    return { f, posted, h };
  }

  async function change(h: Awaited<ReturnType<typeof openDoc>>, patch: Partial<PluginInfo> | null) {
    if (patch === null) h.state.plugins.splice(0, 1);
    else Object.assign(h.state.plugins[0], patch);
    await act(async () => {
      h.emit({ type: "plugins.changed" });
    });
    await act(async () => {});
  }

  const closeMessage = (posted: { mock: { calls: unknown[][] } }) =>
    posted.mock.calls.map((c) => c[0] as { type?: string; id?: string }).find((m) => m.type === "beforeClose");

  it("an update (new rev) asks beforeClose, then reloads the frame", async () => {
    const { f, posted, h } = await openEcho(await openDoc());
    await change(h, { rev: "r2" });
    const close = closeMessage(posted)!;
    expect(close).toBeTruthy();
    expect(frame("Echo")).toBe(f);
    fromFrame(f, { rooms: 1, type: "beforeClose.done", id: close.id });
    await act(async () => {});
    expect(frame("Echo")).not.toBe(f);
  });

  it("new permissions close it after beforeClose and the enable card asks again", async () => {
    const h = await renderWithStores(
      <>
        <DocView roomId="r1" artifactId="a1" />
        <EnableCard />
      </>,
      { rooms: [room("r1", "Bench")], artifacts: { r1: [doc] }, plugins: [plugin()] },
    );
    await act(async () => {});
    const { f, posted } = await openEcho(h);
    await change(h, { needsApproval: true, permissions: ["clipboard"] });
    const close = closeMessage(posted)!;
    expect(close).toBeTruthy();
    fromFrame(f, { rooms: 1, type: "beforeClose.done", id: close.id });
    await act(async () => {});
    expect(screen.queryByTitle("Echo")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Updated plugin: Echo" })).toBeInTheDocument();
  });

  it("a plugin tab whose manifest breaks says it can't load, after beforeClose", async () => {
    const viewer = new ViewerStore(memoryStorage());
    viewer.open({ kind: "plugin", pluginId: "echo" });
    const h = await renderWithStores(<AppShell />, { rooms: [room("r1", "Bench")], plugins: [echoTab()], viewer });
    await act(async () => {});
    const f = frame("Echo");
    const posted = vi.spyOn(f.contentWindow!, "postMessage");
    fromFrame(f, { rooms: 1, type: "ready" });
    await change(h, { status: "invalid", reason: "manifest.json is not valid JSON" });
    const close = closeMessage(posted)!;
    fromFrame(f, { rooms: 1, type: "beforeClose.done", id: close.id });
    await act(async () => {});
    expect(within(screen.getByRole("tabpanel")).getByText("This plugin can't load")).toBeInTheDocument();
  });

  it("while closing for new permissions it keeps what was approved: same src, same sandbox, no new methods, no reload", async () => {
    const { f, posted, h } = await openEcho(await openDoc());
    // A real permission bump also changes the manifest bytes, so rev changes too.
    await change(h, { rev: "r2", permissions: ["rooms.read", "downloads"], needsApproval: true });
    expect(frame("Echo")).toBe(f);
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
    fromFrame(f, { rooms: 1, id: "q1", method: "rooms.list", params: {} });
    await act(async () => {});
    expect(posted).toHaveBeenCalledWith(
      { rooms: 1, id: "q1", error: { code: "permission_denied", message: "needs the rooms.read permission" } },
      "*",
    );
    const closes = posted.mock.calls.map((c) => c[0] as { type?: string; id?: string }).filter((m) => m.type === "beforeClose");
    expect(closes).toHaveLength(1);
    fromFrame(f, { rooms: 1, type: "beforeClose.done", id: closes[0].id });
    await act(async () => {});
    expect(screen.queryByTitle("Echo")).toBeNull();
  });

  it("a manifest that breaks while open keeps the frame on its page until it has closed", async () => {
    const viewer = new ViewerStore(memoryStorage());
    viewer.open({ kind: "plugin", pluginId: "echo" });
    const h = await renderWithStores(<AppShell />, { rooms: [room("r1", "Bench")], plugins: [echoTab()], viewer });
    await act(async () => {});
    const f = frame("Echo");
    fromFrame(f, { rooms: 1, type: "ready" });
    await change(h, { status: "invalid", entry: "", rev: "", permissions: [] });
    expect(frame("Echo")).toBe(f);
    expect(f.getAttribute("src")).toBe("http://files.test/_plugins/echo/index.html");
  });

  it("after the panel was closed, turning the plugin off leaves no toggle and opens no frame", async () => {
    const { f, posted, h } = await openEcho(await openDoc());
    fireEvent.click(screen.getByRole("button", { name: "Close Echo" }));
    const close = closeMessage(posted)!;
    fromFrame(f, { rooms: 1, type: "beforeClose.done", id: close.id });
    await act(async () => {});
    await change(h, { enabled: false });
    expect(screen.queryByRole("button", { name: "Open Echo" })).toBeNull();
    expect(screen.queryByTitle("Echo")).toBeNull();
  });

  it("a deleted plugin's frame goes away at once", async () => {
    const { h } = await openEcho(await openDoc());
    await change(h, null);
    expect(screen.queryByTitle("Echo")).toBeNull();
  });

  it("quitting asks every open frame to save", async () => {
    const { f, posted } = await openEcho(await openDoc());
    const flushing = flushAllPlugins(1500);
    const close = closeMessage(posted)!;
    expect(close).toBeTruthy();
    fromFrame(f, { rooms: 1, type: "beforeClose.done", id: close.id });
    await flushing;
  });
});
