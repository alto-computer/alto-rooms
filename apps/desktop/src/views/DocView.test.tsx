import type { Artifact } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Activity, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStorage, renderWithStores, room } from "@/test/fakes";
import { plugin } from "@/test/plugins";
import { ViewerStore } from "@/data/viewerStore";
import { CurrentTabContext } from "@/shell/currentTab";
import { DocView } from "./DocView";

afterEach(cleanup);

const artifact = (id: string, title: string): Artifact => ({
  id,
  roomId: "r1",
  relPath: `sub/${id}.html`,
  title,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  author: "agent",
  source: { agent: null, session: null, cwd: null, machine: null }, fileKey: "0000000000000000",
});

describe("DocView", () => {
  it("renders the artifact full size in a sandboxed iframe from fileUrl", async () => {
    const { container } = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    const frame = container.querySelector("iframe")!;
    expect(frame).toBeInTheDocument();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-popups");
    expect(frame.getAttribute("src")).toMatch(/^http:\/\/files\.test\/r1\/sub\/a1\.html\?doc=1&cs=[0-9a-f]{8}$/);
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(frame).toHaveAttribute("title", "보고서");
  });

  it("keys the doc URL by the content plugins that are on, so turning one off reloads the frame", async () => {
    const marker = plugin({ id: "marker", permissions: ["artifact.content"], granted: ["artifact.content"], slots: { artifactSidePanel: null, tab: null } });
    const { container, client, emit } = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
      plugins: [marker],
    });
    const frame = container.querySelector("iframe")!;
    const withMarker = frame.getAttribute("src")!;
    const toggle = async (enabled: boolean) => {
      await client.setPluginEnabled("marker", enabled, ["artifact.content"]);
      await act(async () => void emit({ type: "plugins.changed" }));
    };
    await toggle(false);
    await waitFor(() => expect(frame.getAttribute("src")).not.toBe(withMarker));
    await toggle(true);
    await waitFor(() => expect(frame.getAttribute("src")).toBe(withMarker));
  });

  it("shows a skeleton until the document loads", async () => {
    const { container } = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    expect(screen.getByTestId("doc-skeleton")).toBeInTheDocument();
    fireEvent.load(container.querySelector("iframe")!);
    expect(screen.queryByTestId("doc-skeleton")).toBeNull();
  });

  it("fades the document in, without the fade under reduced motion", async () => {
    const { container } = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    const frame = container.querySelector("iframe")!;
    expect(frame).toHaveClass("opacity-0", "transition-opacity", "motion-reduce:transition-none");
    fireEvent.load(frame);
    expect(frame).toHaveClass("opacity-100");
  });

  it("takes the dark-mode dim unless its own page reports a dark background", async () => {
    const { container } = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    const frame = container.querySelector("iframe")!;
    const dimmed = () => frame.classList.contains("[filter:var(--artifact-filter)]");
    const tone = (t: string, source: MessageEventSource | null = frame.contentWindow) =>
      act(() => void window.dispatchEvent(new MessageEvent("message", { data: { roomsTone: 1, tone: t }, source })));
    expect(dimmed()).toBe(true);
    tone("dark", window);
    expect(dimmed()).toBe(true);
    tone("dark");
    expect(dimmed()).toBe(false);
    tone("light");
    expect(dimmed()).toBe(true);
  });

  it("names where the artifact lives in a breadcrumb, and the room opens from it", async () => {
    const { viewer } = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumb).toHaveTextContent("방보고서");
    fireEvent.click(within(crumb).getByRole("button", { name: "방" }));
    expect(viewer.getState().tabs.find((t) => t.id === viewer.getState().activeId)).toMatchObject({ kind: "room", roomId: "r1" });
  });

  it("middle-click on the breadcrumb's room opens it in a new tab", async () => {
    const { viewer } = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    const before = viewer.getState().tabs.length;
    fireEvent(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "방" }), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(viewer.getState().tabs).toHaveLength(before + 1);
    expect(viewer.getState().tabs.at(-1)).toMatchObject({ kind: "room", roomId: "r1" });
  });

  it("says the document is gone once the room's artifacts no longer include it", async () => {
    const fake = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    await act(async () => {
      fake.emit({ type: "artifact.removed", roomId: "r1", artifactId: "a1" });
    });
    expect(screen.getByText("This artifact is gone")).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("shows the generic error when the room can't be loaded", async () => {
    await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifactErrors: { r1: new Error("boom") },
    });
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });
});

describe("DocView: removed room", () => {
  it("says the document is gone when its room is removed", async () => {
    const fake = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    await act(async () => {
      fake.emit({ type: "room.removed", roomId: "r1" });
    });
    expect(screen.getByText("This artifact is gone")).toBeInTheDocument();
  });

  it("offers Ask over text selected in its own frame and quotes it in the ask bar", async () => {
    const { container, client } = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
    });
    const frame = container.querySelector("iframe")!;
    const post = (data: unknown, source: MessageEventSource | null = frame.contentWindow) =>
      act(() => void window.dispatchEvent(new MessageEvent("message", { data, source })));
    // Another frame's message, or a malformed one, does nothing.
    post({ roomsSelection: 1, text: "elsewhere", rect: { x: 1, y: 100, w: 10, h: 10 } }, window);
    post({ roomsSelection: 1, text: 42 });
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
    post({ roomsSelection: 1, text: "한도 초과 판정은 공통", rect: { x: 100, y: 200, w: 80, h: 16 } });
    const ask = await screen.findByRole("button", { name: "Ask" });
    expect(ask.style.left).toBe("140px");
    fireEvent.click(ask);
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
    const quotes = await screen.findByRole("list", { name: "Quoted text" });
    expect(quotes.textContent).toContain("한도 초과 판정은 공통");
    const input = screen.getByPlaceholderText("Ask about this artifact…");
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: "왜 공통이야?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith(expect.objectContaining({ question: "> 한도 초과 판정은 공통\n\n왜 공통이야?" })));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Quoted text" })).toBeNull());
    // An empty selection hides the button.
    post({ roomsSelection: 1, text: "x", rect: { x: 1, y: 100, w: 1, h: 1 } });
    await screen.findByRole("button", { name: "Ask" });
    post({ roomsSelection: 1, text: "", rect: null });
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
  });
});

describe("DocView: content scripts", () => {
  const marker = plugin({ id: "marker", name: "Marker", permissions: ["artifact.content"], granted: ["artifact.content"], slots: { artifactSidePanel: null, tab: null } });

  async function open(opts: { readOnly?: boolean } = {}) {
    const h = await renderWithStores(<DocView roomId="r1" artifactId="a1" />, {
      rooms: [room("r1", "방")],
      artifacts: { r1: [artifact("a1", "보고서")] },
      plugins: [marker],
      ...opts,
    });
    const frame = h.container.querySelector("iframe")!;
    const posted = vi.spyOn(frame.contentWindow!, "postMessage");
    const post = (data: unknown) => act(() => void window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow })));
    return { ...h, posted, post };
  }

  it("shows a content plugin's action after Ask and tells only that plugin it was clicked", async () => {
    const { posted, post } = await open();
    post({ rooms: "content", v: 1, plugin: "marker", type: "actions", items: [{ id: "mark", title: "Mark" }] });
    post({ roomsSelection: 1, text: "p95 118 ms", rect: { x: 100, y: 200, w: 80, h: 16 } });
    const bar = await screen.findByRole("toolbar", { name: "Selection actions" });
    expect(Array.from(bar.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Ask", "Mark"]);
    fireEvent.click(screen.getByRole("button", { name: "Mark" }));
    expect(posted).toHaveBeenCalledWith({ rooms: "content", v: 1, type: "selection.action", plugin: "marker", actionId: "mark" }, "*");
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("forgets a plugin's actions when its script changes, so the reloaded frame shows only what the new script declares", async () => {
    const { post, state, emit, container } = await open();
    post({ rooms: "content", v: 1, plugin: "marker", type: "actions", items: [{ id: "mark", title: "Mark" }] });
    post({ roomsSelection: 1, text: "p95", rect: { x: 100, y: 200, w: 80, h: 16 } });
    await screen.findByRole("button", { name: "Mark" });
    const before = container.querySelector("iframe")!.getAttribute("src");
    state.plugins[0].rev = `${state.plugins[0].rev}-2`;
    await act(async () => void emit({ type: "plugins.changed" }));
    await waitFor(() => expect(container.querySelector("iframe")!.getAttribute("src")).not.toBe(before));
    post({ roomsSelection: 1, text: "p95", rect: { x: 100, y: 200, w: 80, h: 16 } });
    await screen.findByRole("button", { name: "Ask" });
    expect(screen.queryByRole("button", { name: "Mark" })).toBeNull();
  });

  it("keeps a document's writes in its own folder of the plugin's data", async () => {
    const { posted, post, state } = await open();
    post({ rooms: "content", v: 1, plugin: "marker", type: "storage.write", id: "1", path: "marks.json", text: "보고서" });
    post({ rooms: "content", v: 1, plugin: "marker", type: "storage.write", id: "2", path: "../other/marks.json", text: "x" });
    await act(async () => {});
    expect(state.pluginData).toEqual({ "marker/docs/0000000000000000/marks.json": "보고서" });
    expect(posted).toHaveBeenCalledWith({ rooms: "content", v: 1, type: "reply", plugin: "marker", id: "1", result: null }, "*");
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ id: "2", error: expect.objectContaining({ code: "invalid_path" }) }), "*");
  });

  it("drops Ask under read-only but keeps plugin actions", async () => {
    const { post } = await open({ readOnly: true });
    post({ rooms: "content", v: 1, plugin: "marker", type: "actions", items: [{ id: "mark", title: "Mark" }] });
    post({ roomsSelection: 1, text: "p95", rect: { x: 100, y: 200, w: 80, h: 16 } });
    await screen.findByRole("button", { name: "Mark" });
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
  });
});

describe("DocView: a frame that outlives its channel", () => {
  const marker = plugin({ id: "marker", name: "Marker", permissions: ["artifact.content"], granted: ["artifact.content"], slots: { artifactSidePanel: null, tab: null } });
  const sync = { rooms: "content", v: 1, type: "sync", plugin: "marker" };
  const reveals = (posted: { mock: { calls: unknown[][] } }) => posted.mock.calls.map(([m]) => m as { type: string }).filter((m) => m.type === "reveal");

  /** The doc in a tab that can go to the background, as AppShell keeps one. */
  async function kept() {
    const viewer = new ViewerStore(memoryStorage());
    const tabId = viewer.open({ kind: "doc", roomId: "r1", artifactId: "a1" });
    let show!: (visible: boolean) => void;
    function Tab() {
      const [visible, setVisible] = useState(true);
      show = setVisible;
      return (
        <Activity mode={visible ? "visible" : "hidden"}>
          <CurrentTabContext.Provider value={tabId}>
            <DocView roomId="r1" artifactId="a1" />
          </CurrentTabContext.Provider>
        </Activity>
      );
    }
    const h = await renderWithStores(<Tab />, { rooms: [room("r1", "방")], artifacts: { r1: [artifact("a1", "보고서")] }, plugins: [marker], viewer });
    const frame = h.container.querySelector("iframe")!;
    // One window for every load, as a browser's frame keeps; jsdom would make a new one per URL.
    const win = { postMessage: vi.fn() } as unknown as Window;
    Object.defineProperty(frame, "contentWindow", { get: () => win });
    const posted = vi.mocked(win.postMessage);
    const post = (data: unknown) => act(() => void window.dispatchEvent(new MessageEvent("message", { data, source: win })));
    const reload = async () => {
      const before = frame.getAttribute("src");
      h.state.plugins[0].rev = `${h.state.plugins[0].rev}-2`;
      await act(async () => void h.emit({ type: "plugins.changed" }));
      await waitFor(() => expect(frame.getAttribute("src")).not.toBe(before));
    };
    return { ...h, tabId, frame, posted: () => posted, post, reload, show: (v: boolean) => act(() => show(v)) };
  }

  it("asks the frame's scripts to repeat themselves on each load and when the tab comes back, never while a new URL loads", async () => {
    const t = await kept();
    expect(t.posted()).not.toHaveBeenCalledWith(sync, "*");
    fireEvent.load(t.frame);
    expect(t.posted()).toHaveBeenCalledWith(sync, "*");
    t.post({ rooms: "content", v: 1, plugin: "marker", type: "actions", items: [{ id: "mark", title: "Mark" }] });

    t.posted().mockClear();
    t.show(false);
    t.show(true);
    expect(t.posted(), "back from the background, the loaded frame is asked").toHaveBeenCalledWith(sync, "*");
    t.post({ roomsSelection: 1, text: "p95", rect: { x: 100, y: 200, w: 80, h: 16 } });
    await screen.findByRole("button", { name: "Ask" });
    expect(screen.queryByRole("button", { name: "Mark" }), "the new channel knows only what the frame tells it").toBeNull();
    t.post({ rooms: "content", v: 1, plugin: "marker", type: "actions", items: [{ id: "mark", title: "Mark" }] });
    t.post({ roomsSelection: 1, text: "p95", rect: { x: 100, y: 200, w: 80, h: 16 } });
    await screen.findByRole("button", { name: "Mark" });

    t.posted().mockClear();
    await t.reload();
    expect(t.posted(), "the page on its way out is not asked").not.toHaveBeenCalledWith(sync, "*");
    fireEvent.load(t.frame);
    expect(t.posted()).toHaveBeenCalledWith(sync, "*");
  });

  it("asks when a tab comes back whose frame finished loading in the background", async () => {
    const t = await kept();
    fireEvent.load(t.frame);
    await t.reload();
    t.show(false);
    fireEvent.load(t.frame);
    t.posted().mockClear();
    t.show(true);
    expect(t.posted()).toHaveBeenCalledWith(sync, "*");
  });

  it("keeps the last anchor across a reload until the new page's script says ready", async () => {
    const t = await kept();
    fireEvent.load(t.frame);
    act(() => t.viewer.reveal(t.tabId, { pluginId: "marker", anchor: { mark: "first" } }));
    act(() => t.viewer.reveal(t.tabId, { pluginId: "marker", anchor: { mark: "x" } }));
    await t.reload();
    t.post({ rooms: "content", v: 1, plugin: "marker", type: "ready" });
    expect(reveals(t.posted())).toEqual([{ rooms: "content", v: 1, type: "reveal", plugin: "marker", anchor: { mark: "x" } }]);
    t.post({ rooms: "content", v: 1, plugin: "marker", type: "ready" });
    expect(reveals(t.posted()), "handed over once").toHaveLength(1);
  });

  it("drops an anchor for a plugin that is not on in this doc", async () => {
    const t = await kept();
    act(() => t.viewer.reveal(t.tabId, { pluginId: "goals", anchor: 1 }));
    const left: unknown[] = [];
    t.viewer.takeReveal(t.tabId, (r) => (left.push(r), true));
    expect(left).toEqual([]);
  });
});
