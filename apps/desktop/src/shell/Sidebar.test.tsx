import { RoomsApiError, type Artifact } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithStores, room } from "@/test/fakes";
import { ARTIFACT_DRAG_TYPE } from "@/lib/drag";
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
  source: { agent: null, session: null, cwd: null, machine: null },
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

async function dropOn(target: HTMLElement, dt: ReturnType<typeof stubTransfer>) {
  fireEvent.dragEnter(target, { dataTransfer: dt });
  fireEvent.dragOver(target, { dataTransfer: dt });
  await act(async () => {
    fireEvent.drop(target, { dataTransfer: dt });
  });
}

describe("Sidebar: Sort with an agent", () => {
  it("opens the New tab with the compact card; leaving the tab dismisses it", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: ROOMS, artifacts: ARTIFACTS });
    // Leave the initial New tab first.
    fireEvent.click(sidebarRow("벤치마크"));
    const link = screen.getByRole("button", { name: "Sort with an agent" });
    expect(link).toHaveClass("text-[13px]", "text-ink-3");
    await act(async () => {
      fireEvent.click(link);
    });
    const active = h.viewer.getState().tabs.find((t) => t.id === h.viewer.getState().activeId);
    expect(active?.kind).toBe("new");
    expect(h.viewer.getState().tabs.filter((t) => t.kind === "new")).toHaveLength(1);
    expect(screen.getByText("Sort again with an agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sort my rooms" })).toBeInTheDocument();
    expect(screen.getByText("Since your last visit")).toBeInTheDocument();

    fireEvent.click(sidebarRow("벤치마크"));
    act(() => h.viewer.open({ kind: "new" }));
    expect(screen.getByText("Since your last visit")).toBeInTheDocument();
    expect(screen.queryByText("Sort again with an agent")).toBeNull();
  });

  it("the compact chip copies Sort my rooms", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderWithStores(<AppShell />, { rooms: ROOMS, artifacts: ARTIFACTS });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sort with an agent" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sort my rooms" }));
    });
    expect(writeText).toHaveBeenCalledWith("Sort my rooms");
    expect(screen.getByText("Copied")).toBeInTheDocument();
  });
});

describe("Sidebar: Sort with an agent visibility", () => {
  it("is hidden while there is no room besides inbox", async () => {
    await renderWithStores(<AppShell />, { rooms: [room("inbox", "Inbox")], artifacts: { inbox: [] } });
    expect(screen.queryByRole("button", { name: "Sort with an agent" })).toBeNull();
  });

  it("is hidden with no rooms at all", async () => {
    await renderWithStores(<AppShell />, { rooms: [] });
    expect(screen.queryByRole("button", { name: "Sort with an agent" })).toBeNull();
  });

  it("shows once a room besides inbox exists", async () => {
    await renderWithStores(<AppShell />, { rooms: [room("inbox", "Inbox"), room("a", "가")], artifacts: { inbox: [] } });
    expect(screen.getByRole("button", { name: "Sort with an agent" })).toBeInTheDocument();
  });
});

describe("Sidebar: drag to move", () => {
  it("dragging an inbox row onto an owned room calls moveArtifact with the payload, highlighting while over", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: ROOMS, artifacts: ARTIFACTS });
    const row = await screen.findByTestId("inbox-row");
    const dt = stubTransfer();
    fireEvent.dragStart(row, { dataTransfer: dt });
    expect(JSON.parse(dt.data.get(ARTIFACT_DRAG_TYPE)!)).toEqual({ roomId: "inbox", artifactId: "x1" });

    const target = sidebarRow("벤치마크");
    fireEvent.dragEnter(target, { dataTransfer: dt });
    fireEvent.dragOver(target, { dataTransfer: dt });
    expect(target).toHaveClass("bg-[#ebebeb]", "outline-ink");
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
    for (const name of ["연결된 폴더", "없는 폴더", "Inbox"]) {
      const dt = stubTransfer({ [ARTIFACT_DRAG_TYPE]: payload });
      const target = sidebarRow(name);
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
    const msg = screen.getByText("This doc can't be moved");
    const status = msg.closest("[role=status]")!;
    expect(status).toHaveClass("text-[#c13515]");
    expect(status.querySelector("svg")).not.toBeNull();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByText("This doc can't be moved")).toBeNull();
  });

  it("any other failure shows the generic copy", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: ROOMS, artifacts: ARTIFACTS });
    h.client.moveArtifact.mockRejectedValueOnce(new Error("boom"));
    await dropOn(sidebarRow("벤치마크"), stubTransfer({ [ARTIFACT_DRAG_TYPE]: JSON.stringify({ roomId: "inbox", artifactId: "x1" }) }));
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("read-only: no drag source, no drop target, no sidebar link", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: ROOMS, artifacts: ARTIFACTS, readOnly: true });
    const row = await screen.findByTestId("inbox-row");
    expect(row).not.toHaveAttribute("draggable", "true");
    const dt = stubTransfer();
    fireEvent.dragStart(row, { dataTransfer: dt });
    expect(dt.data.size).toBe(0);
    const target = sidebarRow("벤치마크");
    await dropOn(target, stubTransfer({ [ARTIFACT_DRAG_TYPE]: JSON.stringify({ roomId: "inbox", artifactId: "x1" }) }));
    expect(target).not.toHaveClass("outline-ink");
    expect(h.client.moveArtifact).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Sort with an agent" })).toBeNull();
  });
});
