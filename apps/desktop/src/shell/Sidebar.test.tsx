import { RoomsApiError, type Artifact } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversation, memoryStorage, renderWithStores, room } from "@/test/fakes";
import { ViewerStore } from "@/data/viewerStore";
import { localDate } from "@/lib/dates";
import { ARTIFACT_DRAG_TYPE, CONVERSATION_DRAG_TYPE } from "@/lib/drag";
import { AppShell } from "./AppShell";

vi.mock("@/lib/native", () => ({
  pickFolder: vi.fn(async () => null),
  openInEditor: vi.fn(async () => {}),
  viewerInitial: vi.fn(async () => "J"),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const doc = (id: string, roomId: string, title: string): Artifact => ({
  id,
  roomId,
  relPath: `${id}.html`,
  title,
  createdAt: "2026-06-02T03:00:00Z",
  updatedAt: "2026-06-02T03:00:00Z",
  author: "agent",
  source: { agent: null, session: null, cwd: null, machine: null }, fileKey: "0000000000000000",
});

const ROOMS = [
  room("inbox", "Inbox", { artifactCount: 1 }),
  room("a", "벤치마크"),
  room("l", "연결된 폴더", { kind: "linked", path: "/Users/me/code" }),
  room("u", "없는 폴더", { status: "unavailable" }),
];
const ARTIFACTS = { inbox: [doc("x1", "inbox", "떠도는 문서")], a: [] };

/** jsdom has no DataTransfer that holds custom types; this one keeps data in a Map. */
function stubTransfer(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    dropEffect: "none",
    effectAllowed: "all",
    setData: (t: string, v: string) => void data.set(t, v),
    getData: (t: string) => data.get(t) ?? "",
    get types() {
      return [...data.keys()];
    },
  };
}

const sidebarRow = (name: string) => within(screen.getByRole("list", { name: "Rooms" })).getByRole("button", { name });
/** The inbox sits with Find and Journal, labelled with its count. */
const inboxRow = () => screen.queryByRole("button", { name: /^Inbox\d*$/ });

async function dropOn(target: HTMLElement, dt: ReturnType<typeof stubTransfer>) {
  fireEvent.dragEnter(target, { dataTransfer: dt });
  fireEvent.dragOver(target, { dataTransfer: dt });
  await act(async () => {
    fireEvent.drop(target, { dataTransfer: dt });
  });
}

describe("Sidebar: drag to move", () => {
  it("dragging an inbox card onto an owned room calls moveArtifact with the payload, highlighting while over", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: ROOMS, artifacts: ARTIFACTS });
    fireEvent.click(inboxRow()!);
    const row = await screen.findByTestId("artifact-card");
    const dt = stubTransfer();
    fireEvent.dragStart(row, { dataTransfer: dt });
    expect(JSON.parse(dt.data.get(ARTIFACT_DRAG_TYPE)!)).toEqual({ roomId: "inbox", artifactId: "x1" });

    const target = sidebarRow("벤치마크");
    fireEvent.dragEnter(target, { dataTransfer: dt });
    fireEvent.dragOver(target, { dataTransfer: dt });
    expect(target).toHaveClass("bg-surface-strong", "outline-ink");
    fireEvent.dragLeave(target, { dataTransfer: dt });
    expect(target).not.toHaveClass("outline-ink");

    await dropOn(target, dt);
    fireEvent.dragEnd(row, { dataTransfer: dt });
    expect(h.client.moveArtifact).toHaveBeenCalledTimes(1);
    expect(h.client.moveArtifact).toHaveBeenCalledWith("inbox", "x1", "a");
    expect(target).not.toHaveClass("outline-ink");
  });

  it("linked, unavailable and inbox rows (and the source room) are not drop targets", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: ROOMS, artifacts: ARTIFACTS });
    const payload = JSON.stringify({ roomId: "inbox", artifactId: "x1" });
    for (const target of [sidebarRow("연결된 폴더"), sidebarRow("없는 폴더"), inboxRow()!]) {
      const dt = stubTransfer({ [ARTIFACT_DRAG_TYPE]: payload });
      await dropOn(target, dt);
      expect(target).not.toHaveClass("outline-ink");
    }
    // A doc from room a dropped back on a.
    await dropOn(sidebarRow("벤치마크"), stubTransfer({ [ARTIFACT_DRAG_TYPE]: JSON.stringify({ roomId: "a", artifactId: "y" }) }));
    expect(h.client.moveArtifact).not.toHaveBeenCalled();
  });

  it("ignores a malformed payload", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: ROOMS, artifacts: ARTIFACTS });
    for (const bad of ["not json", "{}", JSON.stringify({ roomId: 1, artifactId: "x" }), "null"]) {
      await dropOn(sidebarRow("벤치마크"), stubTransfer({ [ARTIFACT_DRAG_TYPE]: bad }));
    }
    await dropOn(sidebarRow("벤치마크"), stubTransfer({ "text/plain": "x1" }));
    expect(h.client.moveArtifact).not.toHaveBeenCalled();
  });

  it("an error shows its copy near the sidebar for 3 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = await renderWithStores(<AppShell />, { rooms: ROOMS, artifacts: ARTIFACTS });
    h.client.moveArtifact.mockRejectedValueOnce(new RoomsApiError(400, "linked", "invalid_input"));
    const dt = stubTransfer({ [ARTIFACT_DRAG_TYPE]: JSON.stringify({ roomId: "inbox", artifactId: "x1" }) });
    await dropOn(sidebarRow("벤치마크"), dt);
    const msg = screen.getByText("This artifact can't be moved");
    const status = msg.closest("[role=status]")!;
    expect(status).toHaveClass("text-error");
    expect(status.querySelector("svg")).not.toBeNull();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByText("This artifact can't be moved")).toBeNull();
  });

  it("any other failure shows the generic copy", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: ROOMS, artifacts: ARTIFACTS });
    h.client.moveArtifact.mockRejectedValueOnce(new Error("boom"));
    await dropOn(sidebarRow("벤치마크"), stubTransfer({ [ARTIFACT_DRAG_TYPE]: JSON.stringify({ roomId: "inbox", artifactId: "x1" }) }));
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("read-only: no drag source, no drop target, no sidebar link", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: ROOMS, artifacts: ARTIFACTS, readOnly: true });
    fireEvent.click(inboxRow()!);
    const row = await screen.findByTestId("artifact-card");
    expect(row).not.toHaveAttribute("draggable", "true");
    const dt = stubTransfer();
    fireEvent.dragStart(row, { dataTransfer: dt });
    expect(dt.data.size).toBe(0);
    const target = sidebarRow("벤치마크");
    await dropOn(target, stubTransfer({ [ARTIFACT_DRAG_TYPE]: JSON.stringify({ roomId: "inbox", artifactId: "x1" }) }));
    expect(target).not.toHaveClass("outline-ink");
    expect(h.client.moveArtifact).not.toHaveBeenCalled();
  });
});

describe("Sidebar: drag a conversation into a room", () => {
  const today = localDate();
  const journal = () => {
    const viewer = new ViewerStore(memoryStorage());
    viewer.open({ kind: "journal", date: today });
    return viewer;
  };
  const talk = conversation("s1", { title: "Cold start" });
  const opts = () => ({
    rooms: ROOMS,
    artifacts: ARTIFACTS,
    viewer: journal(),
    conversations: [talk],
    days: { [today]: { conversations: [{ at: `${today}T01:00:00Z`, conversation: talk }] } },
  });

  it("a Journal row dropped on a room (linked ones too) adds it there, highlighting while over", async () => {
    const h = await renderWithStores(<AppShell />, opts());
    const row = await screen.findByTestId("day-conversation");
    const dt = stubTransfer();
    fireEvent.dragStart(row, { dataTransfer: dt });
    expect(JSON.parse(dt.data.get(CONVERSATION_DRAG_TYPE)!)).toEqual({ id: talk.id, roomId: null });

    const target = sidebarRow("연결된 폴더");
    fireEvent.dragEnter(target, { dataTransfer: dt });
    fireEvent.dragOver(target, { dataTransfer: dt });
    expect(target).toHaveClass("outline-ink");
    await dropOn(target, dt);
    fireEvent.dragEnd(row, { dataTransfer: dt });
    expect(h.client.setConversationRoom).toHaveBeenCalledWith(talk.id, "l");
    expect(h.client.moveArtifact).not.toHaveBeenCalled();
  });

  it("the room it is already in doesn't light up while it is carried over it", async () => {
    const inRoom = { ...talk, roomId: "a" };
    await renderWithStores(<AppShell />, { ...opts(), conversations: [inRoom], days: { [today]: { conversations: [{ at: `${today}T01:00:00Z`, conversation: inRoom }] } } });
    const dt = stubTransfer();
    fireEvent.dragStart(await screen.findByTestId("day-conversation"), { dataTransfer: dt });
    const own = sidebarRow("벤치마크");
    fireEvent.dragOver(own, { dataTransfer: dt });
    expect(own).not.toHaveClass("outline-ink");
    const other = sidebarRow("연결된 폴더");
    fireEvent.dragOver(other, { dataTransfer: dt });
    expect(other).toHaveClass("outline-ink");
  });

  it("is refused by the room it is already in, and a malformed payload does nothing", async () => {
    const h = await renderWithStores(<AppShell />, opts());
    await dropOn(sidebarRow("벤치마크"), stubTransfer({ [CONVERSATION_DRAG_TYPE]: JSON.stringify({ id: talk.id, roomId: "a" }) }));
    for (const bad of ["nope", "{}", JSON.stringify({ id: { agent: "gpt", session: "s1" }, roomId: null })]) {
      await dropOn(sidebarRow("벤치마크"), stubTransfer({ [CONVERSATION_DRAG_TYPE]: bad }));
    }
    expect(h.client.setConversationRoom).not.toHaveBeenCalled();
  });

  it("read-only: the row does not drag", async () => {
    await renderWithStores(<AppShell />, { ...opts(), readOnly: true });
    expect(await screen.findByTestId("day-conversation")).not.toHaveAttribute("draggable", "true");
  });
});

describe("Sidebar: reorder rooms", () => {
  // A fresh list per test: the fake moveRoom reorders the array it was given.
  const four = () => [room("inbox", "Inbox", { artifactCount: 1 }), room("a", "A"), room("b", "B"), room("c", "C")];
  const names = () => within(screen.getByRole("list", { name: "Rooms" })).getAllByRole("button").map((b) => b.textContent);

  it("rooms are sortable; the inbox stays put", async () => {
    await renderWithStores(<AppShell />, { rooms: four(), artifacts: { inbox: [doc("x1", "inbox", "떠도는 문서")] } });
    expect(inboxRow()).not.toHaveAttribute("aria-roledescription", "sortable");
    for (const n of ["A", "B", "C"]) expect(sidebarRow(n)).toHaveAttribute("aria-roledescription", "sortable");
  });

  it("follows rooms.reordered from the core", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: four(), artifacts: { inbox: [doc("x1", "inbox", "떠도는 문서")] } });
    act(() => h.emit({ type: "rooms.reordered", roomIds: ["inbox", "c", "a", "b"] }));
    expect(names()).toEqual(["C", "A", "B"]);
  });

  it("is off when read-only", async () => {
    await renderWithStores(<AppShell />, { rooms: four(), artifacts: { inbox: [doc("x1", "inbox", "떠도는 문서")] }, readOnly: true });
    expect(sidebarRow("A")).not.toHaveAttribute("aria-roledescription", "sortable");
  });
});

describe("Sidebar: pinned rooms", () => {
  // A fresh list per test: the fake moveRoom reorders the array it was given.
  const rooms = () => [
    room("inbox", "Inbox", { artifactCount: 1 }),
    room("p1", "P1", { color: "sage" }),
    room("p2", "P2", { color: "rose" }),
    room("p3", "P3", { color: "dusk" }),
    room("a", "A"),
    room("b", "B"),
  ];
  const opts = () => ({ rooms: rooms(), artifacts: { inbox: [doc("x1", "inbox", "떠도는 문서")] } });
  const listNames = (label: string) => within(screen.getByRole("list", { name: label })).getAllByRole("button").map((b) => b.textContent);
  const rowIn = (label: string, name: string) => within(screen.getByRole("list", { name: label })).getByRole("button", { name });

  /**
   * jsdom has no layout. Rows stack 29px apart; a list spans its rows; the lifted copy that follows
   * a keyboard drag (outside any list) starts where its row is. Enough for the keyboard sensor.
   */
  afterEach(() => vi.restoreAllMocks());
  function layOut() {
    const rows = screen.getAllByRole("listitem");
    const box = (top: number, height: number) => ({ x: 0, y: top, left: 0, top, right: 200, bottom: top + height, width: 200, height, toJSON: () => ({}) });
    const rowBox = (li: Element) => box(29 * (rows.indexOf(li as HTMLElement) + 1), 28);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "LI") return rowBox(this);
      if (this.tagName === "UL") {
        const own = rows.filter((li) => li.parentElement === this).map(rowBox);
        return own.length ? box(own[0].top, own[own.length - 1].bottom - own[0].top) : box(0, 0);
      }
      const row = this.closest("ul") ? null : rows.find((li) => li.textContent === this.textContent);
      return row ? rowBox(row) : box(0, 0);
    });
  }
  async function keyDrag(row: HTMLElement, key: "ArrowUp" | "ArrowDown", times = 1) {
    layOut();
    row.focus();
    await act(async () => void fireEvent.keyDown(row, { code: "Space" }));
    for (let i = 0; i < times; i++) await act(async () => void fireEvent.keyDown(row, { code: key }));
    await act(async () => void fireEvent.keyDown(row, { code: "Space" }));
  }

  it("hides the Pinned section while no room is pinned", async () => {
    await renderWithStores(<AppShell />, { rooms: [room("a", "A"), room("b", "B")] });
    expect(screen.queryByRole("list", { name: "Pinned" })).toBeNull();
    expect(screen.queryByText("Pinned")).toBeNull();
    expect(listNames("Rooms")).toEqual(["A", "B"]);
  });

  it("lists pinned rooms under Pinned with their colour dot instead of the folder icon", async () => {
    await renderWithStores(<AppShell />, opts());
    expect(listNames("Pinned")).toEqual(["P1", "P2", "P3"]);
    expect(listNames("Rooms")).toEqual(["A", "B"]);
    expect(rowIn("Pinned", "P2").querySelector("[data-tint]")).toHaveAttribute("data-tint", "rose");
    expect(rowIn("Pinned", "P2").querySelector("svg")).toBeNull();
    expect(rowIn("Rooms", "A").querySelector("[data-tint]")).toBeNull();
    expect(rowIn("Rooms", "A").querySelector("svg")).not.toBeNull();
  });

  it("brings the section back when the core pins a room, and hides it when the last one is unpinned", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: [room("inbox", "Inbox"), room("a", "A"), room("b", "B")] });
    act(() => {
      h.emit({ type: "room.updated", room: room("b", "B", { color: "clay" }) });
      h.emit({ type: "rooms.reordered", roomIds: ["inbox", "b", "a"] });
    });
    expect(listNames("Pinned")).toEqual(["B"]);
    expect(listNames("Rooms")).toEqual(["A"]);
    act(() => {
      h.emit({ type: "room.updated", room: room("b", "B", { color: null }) });
    });
    expect(screen.queryByRole("list", { name: "Pinned" })).toBeNull();
    expect(listNames("Rooms")).toEqual(["B", "A"]);
  });

  it("reorders within Pinned, sending the index among the rooms other than the inbox", async () => {
    const h = await renderWithStores(<AppShell />, opts());
    await keyDrag(rowIn("Pinned", "P3"), "ArrowUp", 2);
    expect(h.client.moveRoom).toHaveBeenCalledWith("p3", 0);
    expect(listNames("Pinned")).toEqual(["P3", "P1", "P2"]);
    expect(listNames("Rooms")).toEqual(["A", "B"]);
  });

  it("reorders within Rooms, counting the pinned rooms before it", async () => {
    const h = await renderWithStores(<AppShell />, opts());
    await keyDrag(rowIn("Rooms", "B"), "ArrowUp");
    expect(h.client.moveRoom).toHaveBeenCalledWith("b", 3);
    expect(listNames("Rooms")).toEqual(["B", "A"]);
    expect(listNames("Pinned")).toEqual(["P1", "P2", "P3"]);
  });

  it("a room can't be dragged out of its section", async () => {
    const h = await renderWithStores(<AppShell />, opts());
    await keyDrag(rowIn("Rooms", "A"), "ArrowUp", 2);
    await keyDrag(rowIn("Pinned", "P3"), "ArrowDown", 2);
    expect(h.client.moveRoom).not.toHaveBeenCalled();
    expect(listNames("Pinned")).toEqual(["P1", "P2", "P3"]);
    expect(listNames("Rooms")).toEqual(["A", "B"]);
  });

  it("while a room is carried, its place in the list is a gap marked by the thread line", async () => {
    await renderWithStores(<AppShell />, opts());
    const p3 = rowIn("Pinned", "P3");
    const marked = () => screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-drop"));
    layOut();
    p3.focus();
    await act(async () => void fireEvent.keyDown(p3, { code: "Space" }));
    await act(async () => void fireEvent.keyDown(p3, { code: "ArrowUp" }));
    expect(marked()).toEqual([p3.closest("li")]);
    expect(p3).toHaveClass("invisible");
    await act(async () => void fireEvent.keyDown(p3, { code: "Escape" }));
    expect(marked()).toEqual([]);
    expect(p3).not.toHaveClass("invisible");
  });
});

describe("Sidebar: room menu", () => {
  const rooms = () => [
    room("inbox", "Inbox"),
    room("p1", "P1", { color: "sage" }),
    room("p2", "P2", { color: "dusk" }),
    room("p3", "P3", { color: "sage" }),
    room("a", "A"),
  ];
  const openMenu = (name: string) => fireEvent.contextMenu(screen.getByRole("button", { name }));
  const openColours = async () => {
    fireEvent.click(await screen.findByRole("menuitem", { name: "Colour" }));
    return within(await screen.findByRole("menu", { name: "Colour" }));
  };
  const choice = (menu: ReturnType<typeof within>, name: string) => menu.getByRole("menuitemradio", { name: new RegExp(`^${name}`) });

  it("offers None and the eight colours by name, with the current one checked and who uses each", async () => {
    await renderWithStores(<AppShell />, { rooms: rooms() });
    openMenu("P1");
    const menu = await openColours();
    expect(menu.getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual([
      "NoneNot pinned",
      "Rose",
      "Clay",
      "Oat",
      "SageP3",
      "Sea",
      "DuskP2",
      "Lilac",
      "Stone",
    ]);
    expect(choice(menu, "Sage")).toHaveAttribute("aria-checked", "true");
    expect(menu.getAllByRole("menuitemradio").filter((i) => i.getAttribute("aria-checked") === "true")).toHaveLength(1);
  });

  it("picking a colour pins the room, and the sidebar follows the core", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: rooms() });
    openMenu("A");
    const menu = await openColours();
    expect(choice(menu, "None")).toHaveAttribute("aria-checked", "true");
    expect(menu.getByText("Picking a colour pins this room.")).toBeInTheDocument();
    await act(async () => void fireEvent.click(choice(menu, "Rose")));
    expect(h.client.setRoomColor).toHaveBeenCalledWith("a", "rose");
    act(() => {
      h.emit({ type: "room.updated", room: room("a", "A", { color: "rose" }) });
      h.emit({ type: "rooms.reordered", roomIds: ["inbox", "p1", "p2", "p3", "a"] });
    });
    const pinned = within(screen.getByRole("list", { name: "Pinned" }));
    expect(pinned.getAllByRole("button").map((b) => b.textContent)).toEqual(["P1", "P2", "P3", "A"]);
    expect(pinned.getByRole("button", { name: "A" }).querySelector("[data-tint]")).toHaveAttribute("data-tint", "rose");
  });

  it("None unpins a pinned room", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: rooms() });
    openMenu("P2");
    const menu = await openColours();
    expect(menu.getByText("None unpins this room.")).toBeInTheDocument();
    await act(async () => void fireEvent.click(choice(menu, "None")));
    expect(h.client.setRoomColor).toHaveBeenCalledWith("p2", null);
  });

  it("Open in New Tab and Rename… do what they say", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: rooms() });
    openMenu("A");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in New Tab" }));
    expect(h.viewer.getState().tabs.map((t) => (t.kind === "room" ? t.roomId : t.kind))).toEqual(["journal", "a"]);
    openMenu("A");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Room name" })).toHaveFocus());
  });

  it("read-only: no Colour and no Rename", async () => {
    await renderWithStores(<AppShell />, { rooms: rooms(), readOnly: true });
    openMenu("A");
    expect(await screen.findByRole("menuitem", { name: "Open in New Tab" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Colour" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Rename…" })).toBeNull();
  });
});

describe("Sidebar: inbox", () => {
  const rows = () => within(screen.getByRole("list", { name: "Rooms" })).getAllByRole("button").map((b) => b.textContent);

  it("sits above the rooms and hides while it is empty; once a doc waits there it shows with its count", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: [room("inbox", "Inbox", { artifactCount: 0 }), room("a", "A")] });
    expect(inboxRow()).toBeNull();
    act(() => h.emit({ type: "artifact.added", artifact: doc("x1", "inbox", "떠도는 문서") }));
    expect(inboxRow()).toHaveTextContent("Inbox1");
    expect(rows()).toEqual(["A"]);
  });

  it("keeps an empty inbox listed while its tab is the one being viewed", async () => {
    const viewer = new ViewerStore(memoryStorage());
    viewer.open({ kind: "room", roomId: "inbox" });
    await renderWithStores(<AppShell />, { rooms: [room("inbox", "Inbox", { artifactCount: 0 }), room("a", "A")], viewer });
    expect(inboxRow()).toHaveAttribute("aria-current", "page");
  });
});

describe("Sidebar: unread rooms", () => {
  // firstRunAt is "now" (2026-10), so a room counts as unread when something arrived after it.
  const later = "2099-01-01T00:00:00Z";
  const nameOf = (n: string) => within(sidebarRow(n)).getByText(n);

  it("shows a room semibold once something arrives after the last visit, with no dot", async () => {
    await renderWithStores(<AppShell />, { rooms: [room("a", "A", { updatedAt: later }), room("b", "B", { updatedAt: "2000-01-01T00:00:00Z" }), room("c", "C")] });
    expect(nameOf("A")).toHaveClass("font-semibold");
    expect(nameOf("B")).not.toHaveClass("font-semibold");
    expect(nameOf("C")).not.toHaveClass("font-semibold");
    expect(sidebarRow("A").querySelector("[class*=bg-thread]")).toBeNull();
  });

  it("never shows the room you are in as unread", async () => {
    const viewer = new ViewerStore(memoryStorage());
    viewer.open({ kind: "room", roomId: "a" });
    await renderWithStores(<AppShell />, { rooms: [room("a", "A", { updatedAt: later })], viewer });
    expect(nameOf("A")).not.toHaveClass("font-semibold");
  });
});

describe("Sidebar: Rooms menu", () => {
  const openMenu = () => fireEvent.keyDown(screen.getByRole("button", { name: "Rooms" }), { key: "Enter" });

  it("offers System, Light and Dark, defaulting to System, and nothing else", async () => {
    await renderWithStores(<AppShell />, { rooms: [room("a", "A")] });
    openMenu();
    const group = await screen.findByRole("group", { name: "Appearance" });
    expect(within(group).getAllByRole("menuitemradio").map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([
      ["System", "true"],
      ["Light", "false"],
      ["Dark", "false"],
    ]);
    expect(screen.queryByText(/Follows macOS/)).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("picking Dark saves it and keeps the menu open", async () => {
    const viewer = new ViewerStore(memoryStorage());
    await renderWithStores(<AppShell />, { rooms: [room("a", "A")], viewer });
    openMenu();
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Dark" }));
    expect(viewer.getState().appearance).toBe("dark");
    expect(screen.getByRole("menuitemradio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
  });
});
