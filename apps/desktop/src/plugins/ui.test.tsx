import type { Artifact, PluginInfo } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerStore } from "@/data/viewerStore";
import { AppShell } from "@/shell/AppShell";
import { memoryStorage, renderWithStores, room } from "@/test/fakes";
import { plugin } from "@/test/plugins";
import { DocView } from "@/views/DocView";

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
    expect(h.client.setPluginEnabled).toHaveBeenCalledWith("echo", false);
    expect(screen.queryByRole("list", { name: "Plugins" })).toBeNull();
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
      plugins: [echoTab({ enabled: false, needsApproval: true, permissions: ["rooms.read", "downloads"], description: "Echoes things." })],
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
    expect(h.client.setPluginEnabled).toHaveBeenCalledWith("echo", true);
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
