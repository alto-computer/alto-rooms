import type { Artifact, PluginInfo } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerStore } from "@/data/viewerStore";
import { AppShell } from "@/shell/AppShell";
import { memoryStorage, renderWithStores, room } from "@/test/fakes";
import { plugin } from "@/test/plugins";
import { DocView } from "@/views/DocView";
import { EnableCard } from "./EnableCard";
import { flushAllPlugins } from "./host";
import { pluginDataBus, type PluginDataChange } from "./pluginDataBus";

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
    const group = screen.getByRole("group", { name: "Artifact actions" });
    expect(within(group).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Share"]);
  });

  it("opens from an icon beside Share, drawn from the manifest's icon, else a pencil", async () => {
    await openDoc([plugin({ slots: { artifactSidePanel: { title: "Echo", icon: "palette" }, tab: null } })]);
    const group = screen.getByRole("group", { name: "Artifact actions" });
    expect(within(group).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Share", "Open Echo"]);
    const opener = within(group).getByRole("button", { name: "Open Echo" });
    expect(opener).toHaveTextContent("");
    expect(opener.querySelector("svg.lucide-palette")).not.toBeNull();
    cleanup();
    await openDoc();
    expect(screen.getByRole("button", { name: "Open Echo" }).querySelector("svg.lucide-pencil")).not.toBeNull();
  });

  it("an open panel leaves Share alone in the group", async () => {
    await openDoc();
    await openPanel();
    const group = screen.getByRole("group", { name: "Artifact actions" });
    expect(within(group).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Share"]);
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

  it("a bridge write tells the plugin's other frames, not the frame that wrote it", async () => {
    await openDoc();
    const { f, posted } = await openPanel();
    const heard: PluginDataChange[] = [];
    const off = pluginDataBus.subscribe((c) => heard.push(c));
    fromFrame(f, { rooms: 1, id: "w1", method: "storage.write", params: { path: "notes/a.txt", text: "hi" } });
    await act(async () => {});
    off();
    expect(heard).toEqual([{ pluginId: "echo", path: "notes/a.txt", from: f.contentWindow }]);
    const changes = () => posted.mock.calls.map((c) => c[0] as { type?: string }).filter((m) => m.type === "dataChanged");
    expect(changes(), "no echo of its own write").toEqual([]);
    act(() => pluginDataBus.publish({ pluginId: "echo", path: "docs/9f2c000000000000/marks.json", from: window }));
    act(() => pluginDataBus.publish({ pluginId: "other", path: "x.json", from: window }));
    expect(changes()).toEqual([{ rooms: 1, type: "dataChanged", path: "docs/9f2c000000000000/marks.json" }]);
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
    await openDoc([plugin(), plugin({ id: "notes", name: "Notes", slots: { artifactSidePanel: { title: "Notes", icon: null }, tab: null } })]);
    await openPanel();
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByTitle("Notes")).toBeInTheDocument();
    expect(screen.queryByTitle("Echo")).toBeNull();
  });
});

describe("plugin tabs, the sidebar flyout, and the enable card", () => {
  const flyout = () => screen.getByRole("menu", { name: "Plugins" });
  const plugins = () => screen.getByRole("button", { name: "Plugins" });

  it("the sidebar has one Plugins row, then Settings, and no plugin list or right-click menu", async () => {
    await renderWithStores(<AppShell />, { rooms: [room("r1", "Bench")], plugins: [echoTab()] });
    await act(async () => {});
    expect(screen.queryByRole("list", { name: "Plugins" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Echo" })).toBeNull();
    expect(plugins().nextElementSibling).toBe(screen.getByRole("button", { name: /^Settings/ }));
    expect(plugins()).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.contextMenu(plugins());
    expect(screen.queryByRole("menuitem", { name: /Turn (on|off)/ })).toBeNull();
  });

  it("a click opens the flyout: openable plugins, then Plugin settings…; an item opens its tab, marked current", async () => {
    await renderWithStores(<AppShell />, {
      rooms: [room("r1", "Bench")],
      plugins: [
        echoTab(),
        plugin({ id: "side", name: "Side" }),
        echoTab({ id: "off", name: "Off", enabled: false, slots: { artifactSidePanel: null, tab: { title: "Off", icon: null, sidebar: true } } }),
      ],
    });
    await act(async () => {});
    fireEvent.click(plugins());
    expect(within(flyout()).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Echo", "Plugin settings…"]);
    expect(within(flyout()).getByRole("menuitem", { name: "Echo" })).toHaveFocus();
    fireEvent.click(within(flyout()).getByRole("menuitem", { name: "Echo" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("tab", { name: "Echo", selected: true })).toBeInTheDocument();
    expect(frame("Echo").getAttribute("src")).toBe("http://files.test/_plugins/echo/index.html");
    fireEvent.click(plugins());
    expect(within(flyout()).getByRole("menuitem", { name: "Echo" })).toHaveAttribute("aria-current", "page");
  });

  it("⌘-click on a flyout item opens the plugin in a new tab", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: [room("r1", "Bench")], plugins: [echoTab()] });
    await act(async () => {});
    fireEvent.click(plugins());
    fireEvent.click(within(flyout()).getByRole("menuitem", { name: "Echo" }), { metaKey: true });
    expect(h.viewer.getState().tabs.map((t) => t.kind)).toEqual(["journal", "plugin"]);
  });

  it("with nothing to open, the flyout holds only Plugin settings…, which opens Settings at Plugins", async () => {
    const scrolled: string[] = [];
    const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      if (this.id.startsWith("settings-")) scrolled.push(this.id);
    });
    const h = await renderWithStores(<AppShell />, { rooms: [room("r1", "Bench")], plugins: [plugin()] });
    await act(async () => {});
    fireEvent.click(plugins());
    expect(within(flyout()).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Plugin settings…"]);
    expect(within(flyout()).queryByRole("separator")).toBeNull();
    fireEvent.click(within(flyout()).getByRole("menuitem", { name: "Plugin settings…" }));
    const { tabs, activeId } = h.viewer.getState();
    expect(tabs.find((t) => t.id === activeId)?.kind).toBe("settings");
    expect(scrolled).toEqual(["settings-plugins"]);
    // Already on Settings: it scrolls again without a second tab.
    fireEvent.click(plugins());
    fireEvent.click(within(flyout()).getByRole("menuitem", { name: "Plugin settings…" }));
    expect(scrolled).toEqual(["settings-plugins", "settings-plugins"]);
    expect(h.viewer.getState().tabs.filter((t) => t.kind === "settings")).toHaveLength(1);
    spy.mockRestore();
  });

  it("keyboard: → opens at the first item, ↓/↑ move and wrap, ← and Esc go back to the row", async () => {
    await renderWithStores(<AppShell />, { rooms: [room("r1", "Bench")], plugins: [echoTab()] });
    await act(async () => {});
    plugins().focus();
    fireEvent.keyDown(plugins(), { key: "ArrowRight" });
    const [echo, settings] = within(flyout()).getAllByRole("menuitem");
    expect(echo).toHaveFocus();
    fireEvent.keyDown(echo, { key: "ArrowDown" });
    expect(settings).toHaveFocus();
    fireEvent.keyDown(settings, { key: "ArrowDown" });
    expect(echo).toHaveFocus();
    fireEvent.keyDown(echo, { key: "ArrowUp" });
    expect(settings).toHaveFocus();
    fireEvent.keyDown(settings, { key: "ArrowLeft" });
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(plugins()).toHaveFocus()); // Radix hands focus back on the next tick
    fireEvent.keyDown(plugins(), { key: "Enter" });
    fireEvent.click(plugins()); // Enter on a button clicks it
    expect(within(flyout()).getAllByRole("menuitem")[0]).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(plugins()).toHaveFocus());
  });

  it("hovering opens it after a short delay without taking focus, and it closes once the pointer has left", async () => {
    await renderWithStores(<AppShell />, { rooms: [room("r1", "Bench")], plugins: [echoTab()] });
    await act(async () => {});
    const typing = document.createElement("textarea");
    document.body.append(typing);
    typing.focus();
    vi.useFakeTimers();
    const mouse = { pointerType: "mouse" };
    fireEvent.pointerEnter(plugins(), mouse);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.pointerLeave(plugins(), mouse); // passing by opens nothing
    await act(async () => void vi.advanceTimersByTime(400));
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.pointerEnter(plugins(), mouse);
    await act(async () => void vi.advanceTimersByTime(200));
    expect(flyout()).toBeInTheDocument();
    expect(typing).toHaveFocus();
    // The pointer crosses to the flyout in time, so it stays; leaving it closes it.
    fireEvent.pointerLeave(plugins(), mouse);
    await act(async () => void vi.advanceTimersByTime(100));
    fireEvent.pointerEnter(flyout(), mouse);
    await act(async () => void vi.advanceTimersByTime(400));
    expect(flyout()).toBeInTheDocument();
    fireEvent.pointerLeave(flyout(), mouse);
    await act(async () => void vi.advanceTimersByTime(400));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(typing).toHaveFocus();
    typing.remove();
  });

  it("asks again with only the new permissions when an approved plugin wants more", async () => {
    const h = await renderWithStores(<AppShell />, {
      rooms: [room("r1", "Bench")],
      plugins: [echoTab({ permissions: ["rooms.read", "clipboard"], granted: ["rooms.read"], needsApproval: true })],
    });
    await act(async () => {});
    const card = screen.getByRole("dialog", { name: "Updated plugin: Echo" });
    expect(within(card).getByText("Can copy and paste")).toBeInTheDocument();
    expect(within(card).queryByText("Can see your rooms and artifacts")).toBeNull();
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

  it("lists artifact.content under the other permissions, and a content-only plugin adds nothing", async () => {
    const h = await renderWithStores(<AppShell />, {
      rooms: [room("r1", "Bench")],
      plugins: [
        plugin({
          id: "marker",
          name: "Marker",
          slots: { artifactSidePanel: null, tab: null },
          enabled: false,
          granted: null,
          needsApproval: true,
          permissions: ["rooms.read", "artifact.content"],
        }),
      ],
    });
    await act(async () => {});
    const card = screen.getByRole("dialog", { name: "New plugin: Marker" });
    expect(within(card).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Adds scripts inside artifacts",
      "Can see your rooms and artifacts",
      "Can read the text of artifacts and use the network inside them",
    ]);
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Turn on" }));
    });
    expect(h.client.setPluginEnabled).toHaveBeenCalledWith("marker", true, ["rooms.read", "artifact.content"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Marker" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Marker" })).toBeNull();
  });

  it("an enabled content-only plugin adds no panel opener beside documents", async () => {
    const marker = plugin({ id: "marker", name: "Marker", slots: { artifactSidePanel: null, tab: null }, permissions: ["artifact.content"], granted: ["artifact.content"] });
    await openDoc([marker]);
    expect(screen.queryByRole("button", { name: /^Open / })).toBeNull();
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
    expect(within(card).getByText("Can see your rooms and artifacts")).toBeInTheDocument();
    expect(within(card).getByText("Can save files you export")).toBeInTheDocument();
    expect(screen.queryByTitle("Echo")).toBeNull();
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Turn on" }));
    });
    expect(h.client.setPluginEnabled).toHaveBeenCalledWith("echo", true, ["rooms.read", "downloads"]);
    expect(screen.queryByRole("dialog", { name: "New plugin: Echo" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plugins" }));
    expect(within(screen.getByRole("menu", { name: "Plugins" })).getByRole("menuitem", { name: "Echo" })).toBeInTheDocument();
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

describe("Settings › Plugins", () => {
  const openSettings = async (plugins: PluginInfo[]) => {
    const viewer = new ViewerStore(memoryStorage());
    viewer.open({ kind: "settings" });
    const h = await renderWithStores(<AppShell />, { rooms: [room("r1", "Bench")], plugins, viewer });
    await act(async () => {});
    return h;
  };
  const section = () => screen.getByRole("region", { name: "Plugins" });

  it("lists every plugin with what it adds and the permissions it holds, in the enable card's words", async () => {
    await openSettings([
      echoTab({ permissions: ["rooms.read", "clipboard"], granted: ["rooms.read", "clipboard"], description: "Echoes things." }),
      plugin({ id: "marker", name: "Marker", slots: { artifactSidePanel: null, tab: null }, permissions: ["artifact.content"], granted: ["artifact.content"], enabled: false }),
    ]);
    expect(within(section()).getByText("Echoes things.")).toBeInTheDocument();
    expect(within(section()).getByRole("list", { name: "Echo: what it adds and can do" }).textContent).toBe(
      "Adds a tabCan see your rooms and artifactsCan copy and paste",
    );
    expect(within(section()).getByRole("list", { name: "Marker: what it adds and can do" }).textContent).toBe(
      "Adds scripts inside artifactsCan read the text of artifacts and use the network inside them",
    );
    expect(within(section()).getByRole("switch", { name: "Echo" })).toBeChecked();
    expect(within(section()).getByRole("switch", { name: "Marker" })).not.toBeChecked();
  });

  it("the switch turns a plugin off, keeping its approval, and on again with what the row lists", async () => {
    const h = await openSettings([echoTab({ permissions: ["rooms.read"], granted: ["rooms.read"] })]);
    await act(async () => {
      fireEvent.click(within(section()).getByRole("switch", { name: "Echo" }));
    });
    expect(h.client.setPluginEnabled).toHaveBeenLastCalledWith("echo", false, undefined);
    expect(within(section()).getByRole("switch", { name: "Echo" })).not.toBeChecked();
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      fireEvent.click(within(section()).getByRole("switch", { name: "Echo" }));
    });
    expect(h.client.setPluginEnabled).toHaveBeenLastCalledWith("echo", true, ["rooms.read"]);
    expect(within(section()).getByRole("switch", { name: "Echo" })).toBeChecked();
  });

  it("an update waiting for approval is off, with its new permissions marked; turning it on approves them", async () => {
    const h = await openSettings([echoTab({ permissions: ["rooms.read", "clipboard"], granted: ["rooms.read"], needsApproval: true })]);
    const sw = within(section()).getByRole("switch", { name: "Echo" });
    expect(sw).not.toBeChecked();
    expect(within(section()).getByText("Can copy and paste (new)")).toBeInTheDocument();
    expect(within(section()).getByText("Can see your rooms and artifacts")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(sw);
    });
    expect(h.client.setPluginEnabled).toHaveBeenCalledWith("echo", true, ["rooms.read", "clipboard"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a plugin that can't run says why and has no switch", async () => {
    await openSettings([
      plugin({ id: "broken", name: "", status: "invalid", reason: "manifest.json: missing id" }),
      plugin({ id: "future", name: "Future", minAppVersion: "99.0.0" }),
    ]);
    expect(within(section()).getByText("Couldn't load: manifest.json: missing id")).toBeInTheDocument();
    expect(within(section()).getByText("Needs Rooms 99.0.0 or later")).toBeInTheDocument();
    expect(within(section()).queryByRole("switch")).toBeNull();
  });

  it("says why when turning a plugin off fails, and leaves it on", async () => {
    const h = await openSettings([echoTab()]);
    h.client.setPluginEnabled.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      fireEvent.click(within(section()).getByRole("switch", { name: "Echo" }));
    });
    expect(within(section()).getByRole("alert")).toHaveTextContent("Couldn't turn it off");
    expect(within(section()).getByRole("switch", { name: "Echo" })).toBeChecked();
  });
});

describe("background frames", () => {
  const tagger = (extra: Partial<PluginInfo> = {}) =>
    plugin({ id: "tagger", name: "Tagger", slots: { artifactSidePanel: null, tab: null }, permissions: ["surfaces.text"], granted: ["surfaces.text"], background: "background.html", ...extra });

  it("asks with the surfaces.text line, then runs the background page hidden, in the plugin sandbox, until the plugin is off", async () => {
    const h = await renderWithStores(<AppShell />, {
      rooms: [room("r1", "Bench")],
      plugins: [tagger({ enabled: false, granted: null, needsApproval: true })],
    });
    await act(async () => {});
    const card = screen.getByRole("dialog", { name: "New plugin: Tagger" });
    expect(within(card).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Can read and mark chat answers"]);
    expect(screen.queryByTitle("Tagger"), "nothing runs before the user says so").toBeNull();
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Turn on" }));
    });
    expect(h.client.setPluginEnabled).toHaveBeenCalledWith("tagger", true, ["surfaces.text"]);
    const f = screen.getByTitle("Tagger") as HTMLIFrameElement;
    expect(f.src).toBe("http://files.test/_plugins/tagger/background.html");
    expect(f.sandbox.toString()).toBe("allow-scripts");
    expect(f.closest("[data-background-frames]")).toHaveAttribute("hidden");
    expect(screen.queryByRole("tab", { name: "Tagger" })).toBeNull();
    Object.assign(h.state.plugins[0], { enabled: false });
    await act(async () => {
      h.emit({ type: "plugins.changed" });
    });
    await act(async () => {});
    expect(screen.queryByTitle("Tagger")).toBeNull();
  });
});
