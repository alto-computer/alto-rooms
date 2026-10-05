import { RoomsApiError, type Note } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeClient, memoryStorage, renderWithStores, room } from "@/test/fakes";
import { StoresProvider } from "@/data/hooks";
import { RoomsStore } from "@/data/roomsStore";
import { ViewerStore } from "@/data/viewerStore";
import { AppShell } from "./AppShell";

vi.mock("@/lib/native", () => ({
  pickFolder: vi.fn(async () => "/Users/me/code/bench"),
  openInEditor: vi.fn(async () => {}),
  viewerInitial: vi.fn(async () => "J"),
}));

afterEach(cleanup);

const twoRooms = [room("r1", "벤치마크"), room("r2", "디자인")];

const key = (k: string, extra: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(window, { key: k, code: `Key${k.toUpperCase()}`, metaKey: true, ...extra });
  });

const activeTab = () => screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true");

describe("AppShell: new room", () => {
  it("clicking + shows the input; Enter creates the room and opens its tab", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "New room" }));
    const input = screen.getByLabelText("New room name");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "연구 도구" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(h.client.createRoom).toHaveBeenCalledWith("연구 도구");
    // Opened and activated right away, without waiting for SSE.
    const active = h.viewer.getState().tabs.find((t) => t.id === h.viewer.getState().activeId);
    expect(active).toEqual(expect.objectContaining({ kind: "room", roomId: "new-연구 도구" }));
    expect(screen.queryByLabelText("New room name")).toBeNull();
    // The name arrives with room.added.
    act(() => h.emit({ type: "room.added", room: room("new-연구 도구", "연구 도구") }));
    expect(activeTab()).toHaveTextContent("연구 도구");
    expect(screen.getByRole("button", { name: "연구 도구" })).toBeInTheDocument();
  });

  it("room_exists shows the copy and keeps the input", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    h.client.createRoom.mockRejectedValueOnce(new RoomsApiError(409, "exists", "room_exists"));
    fireEvent.click(screen.getByRole("button", { name: "New room" }));
    const input = screen.getByLabelText("New room name");
    fireEvent.change(input, { target: { value: "벤치마크" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(screen.getByText("A room with that name already exists")).toBeInTheDocument();
    expect(screen.getByLabelText("New room name")).toHaveValue("벤치마크");
  });

  it("Escape cancels the new room row", async () => {
    await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "New room" }));
    fireEvent.keyDown(screen.getByLabelText("New room name"), { key: "Escape" });
    expect(screen.queryByLabelText("New room name")).toBeNull();
  });

  it("Link a folder… picks a folder, links it and opens it", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "New room" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Link a folder…" }));
    });
    expect(h.client.linkFolder).toHaveBeenCalledWith("/Users/me/code/bench");
    const active = h.viewer.getState().tabs.find((t) => t.id === h.viewer.getState().activeId);
    expect(active).toEqual(expect.objectContaining({ kind: "room", roomId: "linked-/Users/me/code/bench" }));
  });
});

describe("AppShell: sidebar", () => {
  it("⌘B hides the sidebar and the tab bar offers to show it; ⌘B again shows it", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    expect(screen.getByRole("button", { name: "Hide sidebar (⌘B)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show sidebar (⌘B)" })).toBeNull();

    key("b");
    expect(h.viewer.getState().sidebarOpen).toBe(false);
    expect(screen.getByRole("button", { name: "Show sidebar (⌘B)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "벤치마크" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide sidebar (⌘B)" })).toBeNull();

    key("b");
    expect(h.viewer.getState().sidebarOpen).toBe(true);
    expect(screen.getByRole("button", { name: "벤치마크" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show sidebar (⌘B)" })).toBeNull();
  });

  it("the collapse and expand buttons toggle the sidebar", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar (⌘B)" }));
    expect(h.viewer.getState().sidebarOpen).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar (⌘B)" }));
    expect(h.viewer.getState().sidebarOpen).toBe(true);
  });

  it("clicking a room row opens its tab; rows follow listRooms order", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    const list = screen.getByRole("list", { name: "Rooms" });
    expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual(["벤치마크", "디자인"]);
    fireEvent.click(screen.getByRole("button", { name: "디자인" }));
    expect(activeTab()).toHaveTextContent("디자인");
    expect(h.viewer.getState().tabs.some((t) => t.kind === "room" && t.roomId === "r2")).toBe(true);
    expect(screen.getByRole("button", { name: "디자인" })).toHaveAttribute("aria-current", "page");
  });

  it("double-clicking a row edits its name and Enter calls renameRoom", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.doubleClick(screen.getByRole("button", { name: "디자인" }));
    const input = screen.getByRole("textbox", { name: "Room name" });
    expect(input).toHaveValue("디자인");
    fireEvent.change(input, { target: { value: "디자인 시스템" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(h.client.renameRoom).toHaveBeenCalledWith("r2", "디자인 시스템");
    expect(screen.queryByRole("textbox", { name: "Room name" })).toBeNull();
  });

  it("Journal opens a single journal tab for today", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "Journal" }));
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Journal" }));
    const journals = h.viewer.getState().tabs.filter((t) => t.kind === "journal");
    expect(journals).toHaveLength(1);
    const now = new Date();
    expect(activeTab()).toHaveTextContent(`Journal · ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][now.getMonth()]} ${now.getDate()}`);
  });

  it("a note tab's label strips one .md (any case) from the file name", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    act(() => {
      h.viewer.open({ kind: "note", date: "2026-10-05", name: "x.md.md" });
    });
    expect(activeTab()).toHaveTextContent(/^x\.md$/);
    act(() => {
      h.viewer.open({ kind: "note", date: "2026-10-05", name: "Plan.MD" });
    });
    expect(activeTab()).toHaveTextContent(/^Plan$/);
  });

  it("찾기 and ⌘K open the quick find dialog", async () => {
    await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(await screen.findByPlaceholderText("Find a room or doc")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByPlaceholderText("Find a room or doc"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByPlaceholderText("Find a room or doc")).toBeNull());
    key("k");
    expect(await screen.findByPlaceholderText("Find a room or doc")).toBeInTheDocument();
  });

  it("read-only hides every write affordance", async () => {
    await renderWithStores(<AppShell />, { rooms: twoRooms, readOnly: true });
    expect(screen.queryByRole("button", { name: "New room" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "디자인" }));
    fireEvent.doubleClick(screen.getByRole("button", { name: "디자인" }));
    expect(screen.queryByRole("textbox", { name: "Room name" })).toBeNull();
    // The room panel's title is not editable either.
    const heading = screen.getByRole("heading", { level: 1, name: "디자인" });
    fireEvent.click(heading);
    expect(screen.queryByRole("textbox", { name: "Room name" })).toBeNull();
  });

  it("an unavailable room is dimmed", async () => {
    await renderWithStores(<AppShell />, { rooms: [room("r1", "벤치마크", { status: "unavailable" })] });
    // The new tab also lists the room; the sidebar row is the dimmed one.
    expect(screen.getAllByText("벤치마크").some((el) => el.classList.contains("opacity-50"))).toBe(true);
  });
});

describe("AppShell: tabs", () => {
  it("hover close button closes a tab; ⌘W closes the active tab", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "벤치마크" }), { metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "디자인" }), { metaKey: true });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["New tab", "벤치마크", "디자인"]);

    const benchTab = screen.getByRole("tab", { name: "벤치마크" });
    fireEvent.mouseEnter(benchTab);
    fireEvent.click(within(benchTab.parentElement!).getByRole("button", { name: "Close tab" }));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["New tab", "디자인"]);

    key("w");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["New tab"]);
    expect(h.viewer.getState().tabs).toHaveLength(1);
  });

  it("middle-click closes a tab", async () => {
    await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "벤치마크" }), { metaKey: true });
    const tab = screen.getByRole("tab", { name: "벤치마크" });
    fireEvent(tab, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(screen.queryByRole("tab", { name: "벤치마크" })).toBeNull();
  });

  it("a sidebar room opens in the current tab; back and forward walk that tab's history", async () => {
    await renderWithStores(<AppShell />, { rooms: twoRooms });
    const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);
    const back = screen.getByRole("button", { name: "Back (⌘[)" });
    const forward = screen.getByRole("button", { name: "Forward (⌘])" });
    expect(back).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "벤치마크" }));
    fireEvent.click(screen.getByRole("button", { name: "디자인" }));
    expect(tabNames()).toEqual(["디자인"]);
    expect(back).toBeEnabled();
    expect(forward).toBeDisabled();

    fireEvent.click(back);
    expect(tabNames()).toEqual(["벤치마크"]);
    fireEvent.keyDown(window, { key: "[", code: "BracketLeft", metaKey: true });
    expect(tabNames()).toEqual(["New tab"]);
    fireEvent.keyDown(window, { key: "]", code: "BracketRight", metaKey: true });
    expect(tabNames()).toEqual(["벤치마크"]);
    fireEvent.keyDown(window, { key: "ArrowLeft", code: "ArrowLeft", metaKey: true });
    expect(tabNames()).toEqual(["New tab"]);
    fireEvent.keyDown(window, { key: "ArrowRight", code: "ArrowRight", metaKey: true });
    expect(tabNames()).toEqual(["벤치마크"]);
    fireEvent(window, new MouseEvent("mouseup", { button: 4 }));
    expect(tabNames()).toEqual(["디자인"]);
    fireEvent(window, new MouseEvent("mouseup", { button: 3 }));
    expect(tabNames()).toEqual(["벤치마크"]);
  });

  it("⌘← stays a caret move inside a text field", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "벤치마크" }));
    fireEvent.click(screen.getByRole("button", { name: "New room" }));
    const input = screen.getByLabelText("New room name");
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowLeft", code: "ArrowLeft", metaKey: true });
    expect(h.viewer.getState().tabs.find((t) => t.id === h.viewer.getState().activeId)).toMatchObject({ kind: "room", roomId: "r1" });
  });

  it("⌘-click and middle click on a sidebar room open a new tab", async () => {
    await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "벤치마크" }), { metaKey: true });
    fireEvent(screen.getByRole("button", { name: "디자인" }), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["New tab", "벤치마크", "디자인"]);
  });

  it("⌘T opens (or activates) the new tab", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "벤치마크" }));
    key("t");
    expect(activeTab()).toHaveTextContent("New tab");
    expect(h.viewer.getState().tabs.filter((t) => t.kind === "new")).toHaveLength(1);
  });

  it("shortcuts call preventDefault", async () => {
    await renderWithStores(<AppShell />, { rooms: twoRooms });
    for (const k of ["b", "w", "t", "k"]) {
      const ev = new KeyboardEvent("keydown", { key: k, code: `Key${k.toUpperCase()}`, metaKey: true, cancelable: true, bubbles: true });
      act(() => {
        window.dispatchEvent(ev);
      });
      expect(ev.defaultPrevented).toBe(true);
    }
  });

  it("tab titles follow the room's current name and a removed room's panel says so", async () => {
    const viewer = new ViewerStore(memoryStorage());
    viewer.open({ kind: "room", roomId: "r1" });
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms, viewer });
    expect(activeTab()).toHaveTextContent("벤치마크");
    expect(screen.getByRole("heading", { level: 1, name: "벤치마크" })).toBeInTheDocument();
    act(() => h.emit({ type: "room.updated", room: room("r1", "벤치마크 v2") }));
    expect(activeTab()).toHaveTextContent("벤치마크 v2");
    act(() => h.emit({ type: "room.removed", roomId: "r1" }));
    expect(screen.getByText("This room is gone")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(2); // the tab stays until closed
  });

  it("the room title is editable in place", async () => {
    const viewer = new ViewerStore(memoryStorage());
    viewer.open({ kind: "room", roomId: "r1" });
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms, viewer });
    fireEvent.click(screen.getByRole("heading", { level: 1, name: "벤치마크" }));
    const input = screen.getByRole("textbox", { name: "Room name" });
    fireEvent.change(input, { target: { value: "벤치" } });
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(h.client.renameRoom).toHaveBeenCalledWith("r1", "벤치");
  });
});

describe("AppShell: shortcuts while typing", () => {
  const keyOn = (el: Element, k: string) => {
    const ev = new KeyboardEvent("keydown", { key: k, code: `Key${k.toUpperCase()}`, metaKey: true, cancelable: true, bubbles: true });
    act(() => {
      el.dispatchEvent(ev);
    });
    return ev;
  };

  it("⌘B, ⌘T and ⌘W do nothing in the new room input, and keep its draft", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "벤치마크" }));
    fireEvent.click(screen.getByRole("button", { name: "New room" }));
    const input = screen.getByLabelText("New room name");
    fireEvent.change(input, { target: { value: "초안" } });
    const before = h.viewer.getState();
    for (const k of ["b", "t", "w"]) expect(keyOn(input, k).defaultPrevented).toBe(false);
    expect(h.viewer.getState().tabs).toEqual(before.tabs);
    expect(h.viewer.getState().activeId).toBe(before.activeId);
    expect(h.viewer.getState().sidebarOpen).toBe(true);
    expect(screen.getByLabelText("New room name")).toHaveValue("초안");
  });

  it("⌘W in the room title input keeps the tab and the draft", async () => {
    const viewer = new ViewerStore(memoryStorage());
    viewer.open({ kind: "room", roomId: "r1" });
    await renderWithStores(<AppShell />, { rooms: twoRooms, viewer });
    fireEvent.click(screen.getByRole("heading", { level: 1, name: "벤치마크" }));
    const input = screen.getByRole("textbox", { name: "Room name" });
    fireEvent.change(input, { target: { value: "벤치" } });
    keyOn(input, "w");
    expect(activeTab()).toHaveTextContent("벤치마크");
    expect(screen.getByRole("textbox", { name: "Room name" })).toHaveValue("벤치");
  });

  it("⌘K still opens quick find from an input", async () => {
    await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "New room" }));
    expect(keyOn(screen.getByLabelText("New room name"), "k").defaultPrevented).toBe(true);
    expect(await screen.findByPlaceholderText("Find a room or doc")).toBeInTheDocument();
  });

  it("⌘W in the note body still closes the note tab", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms, notes: { "2026-10-05/계획.md": "내용" } });
    act(() => {
      h.viewer.open({ kind: "note", date: "2026-10-05", name: "계획.md" });
    });
    const body = await screen.findByRole("textbox", { name: "Note" });
    expect(keyOn(body, "t").defaultPrevented).toBe(false); // ⌘T is ignored there
    expect(activeTab()).toHaveTextContent("계획");
    expect(keyOn(body, "w").defaultPrevented).toBe(true);
    expect(h.viewer.getState().tabs.some((t) => t.kind === "note")).toBe(false);
  });
});

describe("AppShell: gone rooms and docs, and before the first sync", () => {
  it("labels a tab whose room or doc is gone Missing room / Missing doc once synced", async () => {
    const viewer = new ViewerStore(memoryStorage());
    viewer.open({ kind: "room", roomId: "gone" });
    viewer.open({ kind: "doc", roomId: "r1", artifactId: "missing" });
    viewer.open({ kind: "doc", roomId: "gone", artifactId: "x" });
    await renderWithStores(<AppShell />, { rooms: twoRooms, artifacts: { r1: [] }, viewer });
    await act(async () => {});
    const labels = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(labels).toEqual(["New tab", "Missing room", "Missing doc", "Missing doc"]);
  });

  it("before the first sync (no info): tabs show …, and nothing is writable", async () => {
    const viewer = new ViewerStore(memoryStorage());
    viewer.open({ kind: "room", roomId: "r1" });
    const fake = fakeClient({ rooms: twoRooms });
    const rooms = new RoomsStore(fake.client, { warn: () => {} });
    render(
      <StoresProvider rooms={rooms} viewer={viewer} client={fake.client}>
        <AppShell />
      </StoresProvider>,
    );
    expect(activeTab()).toHaveTextContent("…");
    expect(screen.queryByRole("button", { name: "New room" })).toBeNull();
  });
});

describe("AppShell: a new note, then its name", () => {
  it("New note opens New Note in a new tab with the cursor in the body; renaming it updates the tab and the Journal card", async () => {
    const date = "2026-10-05";
    const viewer = new ViewerStore(memoryStorage());
    const journalId = viewer.open({ kind: "journal", date });
    const h = await renderWithStores(<AppShell />, { viewer, days: { [date]: { notes: [] } } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New note" }));
    });
    expect(activeTab()).toHaveTextContent("New Note");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note" })).toHaveFocus());
    // roomsd announces the new note; the store refetches the day.
    h.state.days[date] = { notes: [(await h.client.saveNote.mock.results[0].value) as Note] };
    await act(async () => {
      h.emit({ type: "note.saved", note: h.state.days[date].notes![0] });
    });

    fireEvent.click(screen.getByRole("heading", { level: 1, name: "New Note" }));
    const input = screen.getByRole("textbox", { name: "Note name" });
    fireEvent.change(input, { target: { value: "회고" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => expect(activeTab()).toHaveTextContent("회고"));
    expect(screen.getByRole("heading", { level: 1, name: "회고" })).toBeInTheDocument();
    const renamed = h.state.days[date].notes![0];
    await act(async () => {
      h.emit({ type: "note.removed", date, name: "New Note.md" });
      h.emit({ type: "note.saved", note: renamed });
    });

    act(() => viewer.activate(journalId));
    const me = screen.getByRole("region", { name: "From me" });
    await waitFor(() => expect(within(me).getByRole("button", { name: "회고" })).toBeInTheDocument());
    expect(within(me).queryByRole("button", { name: "New Note" })).not.toBeInTheDocument();
  });
});
