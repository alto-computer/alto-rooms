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
  });
});


describe("Sidebar: reorder rooms", () => {
  // A fresh list per test: the fake moveRoom reorders the array it was given.
  const four = () => [room("inbox", "Inbox"), room("a", "A"), room("b", "B"), room("c", "C")];
  const names = () => within(screen.getByRole("list", { name: "Rooms" })).getAllByRole("button").map((b) => b.textContent);

  it("rooms below the inbox are sortable; the inbox stays put", async () => {
    await renderWithStores(<AppShell />, { rooms: four() });
    expect(sidebarRow("Inbox")).not.toHaveAttribute("aria-roledescription", "sortable");
    for (const n of ["A", "B", "C"]) expect(sidebarRow(n)).toHaveAttribute("aria-roledescription", "sortable");
  });

  it("follows rooms.reordered from the core", async () => {
    const h = await renderWithStores(<AppShell />, { rooms: four() });
    act(() => h.emit({ type: "rooms.reordered", roomIds: ["inbox", "c", "a", "b"] }));
    expect(names()).toEqual(["Inbox", "C", "A", "B"]);
  });

  it("is off when read-only", async () => {
    await renderWithStores(<AppShell />, { rooms: four(), readOnly: true });
    expect(sidebarRow("A")).not.toHaveAttribute("aria-roledescription", "sortable");
  });
});
