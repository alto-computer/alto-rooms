import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithStores, room } from "@/test/fakes";
import { AppShell } from "./AppShell";

// Inside Tauri: the native menu owns ⌘W/⌘T and reaches the page as events.
const handlers = new Map<string, () => void>();
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, fn: () => void) => {
    handlers.set(event, fn);
    return () => handlers.delete(event);
  }),
}));
vi.mock("@/lib/native", () => ({
  pickFolder: vi.fn(async () => null),
  openInEditor: vi.fn(async () => {}),
  viewerInitial: vi.fn(async () => "J"),
}));

afterEach(() => {
  cleanup();
  handlers.clear();
});

const rooms = [room("r1", "벤치마크"), room("r2", "디자인")];
const menu = (event: string) =>
  act(() => {
    const fn = handlers.get(event);
    if (!fn) throw new Error(`no listener for ${event}`);
    fn();
  });
const keyOn = (el: EventTarget, k: string) => {
  const ev = new KeyboardEvent("keydown", { key: k, code: `Key${k.toUpperCase()}`, metaKey: true, cancelable: true, bubbles: true });
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev;
};

describe("AppShell in Tauri", () => {
  it("the page leaves ⌘W/⌘T/⌘B/⌘K to the menu, so they never fire twice", async () => {
    const h = await renderWithStores(<AppShell />, { rooms });
    fireEvent.click(screen.getByRole("button", { name: "벤치마크" }));
    const before = h.viewer.getState().tabs.length;
    expect(keyOn(window, "w").defaultPrevented).toBe(false);
    expect(keyOn(window, "t").defaultPrevented).toBe(false);
    expect(h.viewer.getState().tabs).toHaveLength(before);
    expect(keyOn(window, "b").defaultPrevented).toBe(false);
    expect(h.viewer.getState().sidebarOpen).toBe(true);
    expect(keyOn(window, "k").defaultPrevented).toBe(false);
    expect(screen.queryByPlaceholderText("Find a room or doc")).toBeNull();
  });

  it("menu://find and menu://toggle-sidebar open quick find and toggle the sidebar", async () => {
    const h = await renderWithStores(<AppShell />, { rooms });
    await act(async () => {}); // listeners register asynchronously
    menu("menu://toggle-sidebar");
    expect(h.viewer.getState().sidebarOpen).toBe(false);
    menu("menu://toggle-sidebar");
    expect(h.viewer.getState().sidebarOpen).toBe(true);
    menu("menu://find");
    expect(screen.getByPlaceholderText("Find a room or doc")).toBeInTheDocument();
  });

  it("from a text field the menu's ⌘K still finds, but its ⌘B does nothing", async () => {
    const h = await renderWithStores(<AppShell />, { rooms });
    fireEvent.click(screen.getByRole("button", { name: "New room" }));
    screen.getByLabelText("New room name").focus();
    await act(async () => {});
    menu("menu://toggle-sidebar");
    expect(h.viewer.getState().sidebarOpen).toBe(true);
    expect(screen.getByLabelText("New room name")).toBeInTheDocument();
    menu("menu://find");
    expect(screen.getByPlaceholderText("Find a room or doc")).toBeInTheDocument();
  });

  it("menu://back and menu://forward walk the active tab's history; the page leaves ⌘[ to the menu", async () => {
    const h = await renderWithStores(<AppShell />, { rooms });
    fireEvent.click(screen.getByRole("button", { name: "벤치마크" }));
    fireEvent.click(screen.getByRole("button", { name: "디자인" }));
    await act(async () => {}); // listeners register asynchronously
    const active = () => h.viewer.getState().tabs.find((t) => t.id === h.viewer.getState().activeId);
    const ev = new KeyboardEvent("keydown", { key: "[", code: "BracketLeft", metaKey: true, cancelable: true, bubbles: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
    expect(active()).toMatchObject({ kind: "room", roomId: "r2" });
    menu("menu://back");
    expect(active()).toMatchObject({ kind: "room", roomId: "r1" });
    menu("menu://forward");
    expect(active()).toMatchObject({ kind: "room", roomId: "r2" });
    // ⌘← has no menu item, so the page handles it even in Tauri.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft", metaKey: true, bubbles: true }));
    });
    expect(active()).toMatchObject({ kind: "room", roomId: "r1" });
  });

  it("menu://close-tab and menu://new-tab run the tab actions", async () => {
    const h = await renderWithStores(<AppShell />, { rooms });
    fireEvent.click(screen.getByRole("button", { name: "벤치마크" }));
    await act(async () => {}); // listeners register asynchronously
    menu("menu://close-tab");
    expect(h.viewer.getState().tabs.some((t) => t.kind === "room")).toBe(false);
    act(() => {
      h.viewer.close(h.viewer.getState().activeId!);
    });
    expect(h.viewer.getState().tabs).toHaveLength(0);
    menu("menu://new-tab");
    expect(h.viewer.getState().tabs.map((t) => t.kind)).toEqual(["new"]);
  });

  it("the menu's ⌘W follows the text-field rule", async () => {
    const h = await renderWithStores(<AppShell />, { rooms });
    fireEvent.click(screen.getByRole("button", { name: "벤치마크" }));
    fireEvent.click(screen.getByRole("button", { name: "New room" }));
    const input = screen.getByLabelText("New room name");
    input.focus();
    await act(async () => {});
    const before = h.viewer.getState().tabs.length;
    menu("menu://close-tab");
    menu("menu://new-tab");
    expect(h.viewer.getState().tabs).toHaveLength(before);
    expect(screen.getByLabelText("New room name")).toBeInTheDocument();
  });
});
