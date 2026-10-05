import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStorage, renderWithStores, room } from "@/test/fakes";
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
    fireEvent.click(screen.getByRole("button", { name: "새 방" }));
    const input = screen.getByLabelText("새 방 이름");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "연구 도구" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(h.client.createRoom).toHaveBeenCalledWith("연구 도구");
    // Opened and activated right away, without waiting for SSE.
    const active = h.viewer.getState().tabs.find((t) => t.id === h.viewer.getState().activeId);
    expect(active).toEqual(expect.objectContaining({ kind: "room", roomId: "new-연구 도구" }));
    expect(screen.queryByLabelText("새 방 이름")).toBeNull();
    // The name arrives with room.added.
    act(() => h.emit({ type: "room.added", room: room("new-연구 도구", "연구 도구") }));
    expect(activeTab()).toHaveTextContent("연구 도구");
    expect(screen.getByRole("button", { name: "연구 도구" })).toBeInTheDocument();
  });

  it("room_exists shows the copy and keeps the input", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    h.client.createRoom.mockRejectedValueOnce(new RoomsApiError(409, "exists", "room_exists"));
    fireEvent.click(screen.getByRole("button", { name: "새 방" }));
    const input = screen.getByLabelText("새 방 이름");
    fireEvent.change(input, { target: { value: "벤치마크" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(screen.getByText("같은 이름의 방이 있어요")).toBeInTheDocument();
    expect(screen.getByLabelText("새 방 이름")).toHaveValue("벤치마크");
  });

  it("Escape cancels the new room row", async () => {
    await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "새 방" }));
    fireEvent.keyDown(screen.getByLabelText("새 방 이름"), { key: "Escape" });
    expect(screen.queryByLabelText("새 방 이름")).toBeNull();
  });

  it("기존 폴더 연결… picks a folder, links it and opens it", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "새 방" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "기존 폴더 연결…" }));
    });
    expect(h.client.linkFolder).toHaveBeenCalledWith("/Users/me/code/bench");
    const active = h.viewer.getState().tabs.find((t) => t.id === h.viewer.getState().activeId);
    expect(active).toEqual(expect.objectContaining({ kind: "room", roomId: "linked-/Users/me/code/bench" }));
  });
});

describe("AppShell: sidebar", () => {
  it("⌘B hides the sidebar and the tab bar offers to show it; ⌘B again shows it", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    expect(screen.getByRole("button", { name: "사이드바 접기 (⌘B)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "사이드바 펼치기 (⌘B)" })).toBeNull();

    key("b");
    expect(h.viewer.getState().sidebarOpen).toBe(false);
    expect(screen.getByRole("button", { name: "사이드바 펼치기 (⌘B)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "벤치마크" })).toBeNull();
    expect(screen.queryByRole("button", { name: "사이드바 접기 (⌘B)" })).toBeNull();

    key("b");
    expect(h.viewer.getState().sidebarOpen).toBe(true);
    expect(screen.getByRole("button", { name: "벤치마크" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "사이드바 펼치기 (⌘B)" })).toBeNull();
  });

  it("the collapse and expand buttons toggle the sidebar", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "사이드바 접기 (⌘B)" }));
    expect(h.viewer.getState().sidebarOpen).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "사이드바 펼치기 (⌘B)" }));
    expect(h.viewer.getState().sidebarOpen).toBe(true);
  });

  it("clicking a room row opens its tab; rows follow listRooms order", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    const list = screen.getByRole("list", { name: "방" });
    expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual(["벤치마크", "디자인"]);
    fireEvent.click(screen.getByRole("button", { name: "디자인" }));
    expect(activeTab()).toHaveTextContent("디자인");
    expect(h.viewer.getState().tabs.some((t) => t.kind === "room" && t.roomId === "r2")).toBe(true);
    expect(screen.getByRole("button", { name: "디자인" })).toHaveAttribute("aria-current", "page");
  });

  it("double-clicking a row edits its name and Enter calls renameRoom", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.doubleClick(screen.getByRole("button", { name: "디자인" }));
    const input = screen.getByRole("textbox", { name: "방 이름" });
    expect(input).toHaveValue("디자인");
    fireEvent.change(input, { target: { value: "디자인 시스템" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(h.client.renameRoom).toHaveBeenCalledWith("r2", "디자인 시스템");
    expect(screen.queryByRole("textbox", { name: "방 이름" })).toBeNull();
  });

  it("Journal opens a single journal tab for today", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "Journal" }));
    fireEvent.click(screen.getByRole("button", { name: "새 탭" }));
    fireEvent.click(screen.getByRole("button", { name: "Journal" }));
    const journals = h.viewer.getState().tabs.filter((t) => t.kind === "journal");
    expect(journals).toHaveLength(1);
    const now = new Date();
    expect(activeTab()).toHaveTextContent(`Journal · ${now.getMonth() + 1}월 ${now.getDate()}일`);
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
    fireEvent.click(screen.getByRole("button", { name: "찾기" }));
    expect(await screen.findByPlaceholderText("방이나 문서 찾기")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByPlaceholderText("방이나 문서 찾기"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByPlaceholderText("방이나 문서 찾기")).toBeNull());
    key("k");
    expect(await screen.findByPlaceholderText("방이나 문서 찾기")).toBeInTheDocument();
  });

  it("read-only hides every write affordance", async () => {
    await renderWithStores(<AppShell />, { rooms: twoRooms, readOnly: true });
    expect(screen.queryByRole("button", { name: "새 방" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "디자인" }));
    fireEvent.doubleClick(screen.getByRole("button", { name: "디자인" }));
    expect(screen.queryByRole("textbox", { name: "방 이름" })).toBeNull();
    // The room panel's title is not editable either.
    const heading = screen.getByRole("heading", { level: 1, name: "디자인" });
    fireEvent.click(heading);
    expect(screen.queryByRole("textbox", { name: "방 이름" })).toBeNull();
  });

  it("an unavailable room is dimmed", async () => {
    await renderWithStores(<AppShell />, { rooms: [room("r1", "벤치마크", { status: "unavailable" })] });
    expect(screen.getByText("벤치마크")).toHaveClass("opacity-50");
  });
});

describe("AppShell: tabs", () => {
  it("hover close button closes a tab; ⌘W closes the active tab", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "벤치마크" }));
    fireEvent.click(screen.getByRole("button", { name: "디자인" }));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["새 탭", "벤치마크", "디자인"]);

    const benchTab = screen.getByRole("tab", { name: "벤치마크" });
    fireEvent.mouseEnter(benchTab);
    fireEvent.click(within(benchTab.parentElement!).getByRole("button", { name: "탭 닫기" }));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["새 탭", "디자인"]);

    key("w");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["새 탭"]);
    expect(h.viewer.getState().tabs).toHaveLength(1);
  });

  it("middle-click closes a tab", async () => {
    await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "벤치마크" }));
    const tab = screen.getByRole("tab", { name: "벤치마크" });
    fireEvent(tab, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(screen.queryByRole("tab", { name: "벤치마크" })).toBeNull();
  });

  it("⌘T opens (or activates) the new tab", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms });
    fireEvent.click(screen.getByRole("button", { name: "벤치마크" }));
    key("t");
    expect(activeTab()).toHaveTextContent("새 탭");
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
    expect(screen.getByText("이 방은 더 이상 없어요")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(2); // the tab stays until closed
  });

  it("the room title is editable in place", async () => {
    const viewer = new ViewerStore(memoryStorage());
    viewer.open({ kind: "room", roomId: "r1" });
    const h = await renderWithStores(<AppShell />, { rooms: twoRooms, viewer });
    fireEvent.click(screen.getByRole("heading", { level: 1, name: "벤치마크" }));
    const input = screen.getByRole("textbox", { name: "방 이름" });
    expect(screen.getByText("Enter 또는 바깥을 누르면 저장")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "벤치" } });
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(h.client.renameRoom).toHaveBeenCalledWith("r1", "벤치");
  });
});
