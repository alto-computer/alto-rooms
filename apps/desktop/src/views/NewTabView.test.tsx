import type { Artifact } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoresProvider } from "@/data/hooks";
import { RoomsStore } from "@/data/roomsStore";
import { ViewerStore } from "@/data/viewerStore";
import { fakeClient, manualTimers, memoryStorage, renderWithStores, room } from "@/test/fakes";
import { dateLabel } from "@/lib/dates";
import { NewTabView } from "./NewTabView";

afterEach(cleanup);

const artifact = (id: string, roomId: string, createdAt: string): Artifact => ({
  id,
  roomId,
  relPath: `${id}.html`,
  title: id,
  createdAt,
  updatedAt: createdAt,
  author: "agent",
  source: { agent: null, session: null, cwd: null, machine: null }, fileKey: "0000000000000000",
});

const OLD = "2026-01-02T03:00:00Z";
const NEW = "2026-06-02T03:00:00Z";

function viewer(lastVisit: Record<string, string> = {}) {
  const storage = memoryStorage();
  storage.setItem(
    "alto-rooms.viewer.v1",
    JSON.stringify({ tabs: [], sidebarOpen: true, lastVisit, firstRunAt: "2026-03-01T00:00:00Z" }),
  );
  return new ViewerStore(storage);
}

const cardNames = () => screen.getAllByTestId("new-room-card").map((c) => within(c).getByTestId("new-room-name").textContent);

describe("NewTabView", () => {
  it("counts rooms with new docs, sorts them first with \"k new\"", async () => {
    await renderWithStores(<NewTabView />, {
      viewer: viewer(),
      rooms: [
        room("a", "가", { artifactCount: 1, updatedAt: NEW }),
        room("b", "나", { artifactCount: 3, updatedAt: NEW }),
        room("c", "다", { artifactCount: 2, updatedAt: NEW }),
        room("d", "라", { artifactCount: 0 }),
      ],
      artifacts: {
        a: [artifact("a1", "a", OLD)],
        b: [artifact("b1", "b", OLD), artifact("b2", "b", NEW), artifact("b3", "b", NEW)],
        c: [artifact("c1", "c", NEW), artifact("c2", "c", OLD)],
        d: [],
      },
    });
    expect(await screen.findByText("New docs in 2 rooms.")).toBeInTheDocument();
    expect(cardNames()).toEqual(["나", "다", "가", "라"]);
    const [first, second, third] = screen.getAllByTestId("new-room-card");
    expect(within(first).getByText("2 new")).toBeInTheDocument();
    expect(within(first).getByText("3 docs")).toBeInTheDocument();
    expect(within(second).getByText("1 new")).toBeInTheDocument();
    expect(within(third).queryByText(/ new$/)).toBeNull();
  });

  it("says nothing is new when nothing is", async () => {
    await renderWithStores(<NewTabView />, {
      viewer: viewer({ a: "2026-03-02T00:00:00Z" }),
      rooms: [room("a", "가", { artifactCount: 1 })],
      artifacts: { a: [artifact("a1", "a", OLD)] },
    });
    expect(await screen.findByText("No new docs.")).toBeInTheDocument();
  });

  it("counts only the rooms that loaded when another room's load failed", async () => {
    await renderWithStores(<NewTabView />, {
      viewer: viewer(),
      rooms: [room("a", "가", { updatedAt: NEW }), room("b", "나", { updatedAt: NEW })],
      artifacts: { a: [artifact("a1", "a", NEW)] },
      artifactErrors: { b: new Error("boom") },
    });
    expect(await screen.findByText("New docs in 1 room.")).toBeInTheDocument();
  });

  it("lists unavailable rooms with the unavailable copy, and clicking a card opens the room", async () => {
    const v = viewer();
    await renderWithStores(<NewTabView />, {
      viewer: v,
      rooms: [room("a", "가", { status: "unavailable", artifactCount: 4 }), room("b", "나")],
      artifacts: { a: [], b: [] },
    });
    const card = (await screen.findAllByTestId("new-room-card"))[0];
    expect(within(card).getByText("Folder not found")).toBeInTheDocument();
    expect(within(card).queryByText("4 docs")).toBeNull();
    await act(async () => {
      fireEvent.click(card);
    });
    expect(v.getState().tabs.some((t) => t.kind === "room" && t.roomId === "a")).toBe(true);
  });
});

describe("NewTabView: rooms organized since", () => {
  it("never-visited rooms other than inbox count as newly sorted room when no doc is new by createdAt", async () => {
    await renderWithStores(<NewTabView />, {
      viewer: viewer({ c: "2026-03-02T00:00:00Z" }),
      rooms: [
        room("inbox", "Inbox", { artifactCount: 1 }),
        room("a", "가", { artifactCount: 1 }),
        room("b", "나", { artifactCount: 2 }),
        room("c", "다", { artifactCount: 1 }), // visited
      ],
      artifacts: { inbox: [artifact("i1", "inbox", OLD)], a: [artifact("a1", "a", OLD)] },
    });
    expect(await screen.findByText("2 newly sorted rooms.")).toBeInTheDocument();
    expect(screen.queryByText("No new docs.")).toBeNull();
  });

  it("new docs by createdAt still win the subtitle", async () => {
    await renderWithStores(<NewTabView />, {
      viewer: viewer(),
      rooms: [room("a", "가", { updatedAt: NEW }), room("b", "나")],
      artifacts: { a: [artifact("a1", "a", NEW)] },
    });
    expect(await screen.findByText("New docs in 1 room.")).toBeInTheDocument();
    expect(screen.queryByText(/newly sorted room/)).toBeNull();
  });

  it("an inbox that was never visited does not count", async () => {
    await renderWithStores(<NewTabView />, {
      viewer: viewer({ a: "2026-03-02T00:00:00Z" }),
      rooms: [room("inbox", "Inbox"), room("a", "가")],
    });
    expect(await screen.findByText("No new docs.")).toBeInTheDocument();
  });
});

describe("NewTabView loading", () => {
  it("loads only rooms changed since their baseline; the rest count 0 without a request", async () => {
    const h = await renderWithStores(<NewTabView />, {
      viewer: viewer(),
      rooms: [
        room("a", "가", { artifactCount: 1, updatedAt: OLD }), // before firstRunAt
        room("b", "나", { artifactCount: 1, updatedAt: NEW }),
        room("c", "다", { artifactCount: 0, updatedAt: null }),
      ],
      artifacts: { a: [artifact("a1", "a", OLD)], b: [artifact("b1", "b", NEW)] },
    });
    const spy = vi.spyOn(h.client, "listArtifacts");
    expect(await screen.findByText("New docs in 1 room.")).toBeInTheDocument();
    expect(h.rooms.getState().artifacts.a).toBeUndefined();
    expect(h.rooms.getState().artifacts.c).toBeUndefined();
    expect(cardNames()).toEqual(["나", "가", "다"]);
    spy.mockRestore();
  });

  it("a closed New tab lets go of its rooms: after the linger, resync {null} no longer refetches them", async () => {
    const linger = manualTimers();
    const h = await renderWithStores(<NewTabView />, {
      storeTimers: linger.timers,
      viewer: viewer(),
      rooms: [room("a", "가", { updatedAt: NEW }), room("b", "나", { updatedAt: NEW })],
      artifacts: { a: [artifact("a1", "a", NEW)], b: [] },
    });
    await screen.findByText("New docs in 1 room.");
    const spy = vi.spyOn(h.client, "listArtifacts");
    h.unmount();
    act(() => linger.run()); // the 45 s linger ends
    await act(async () => {
      h.emit({ type: "resync", roomId: null });
    });
    expect(spy).not.toHaveBeenCalled();
    expect(h.rooms.getState().artifacts).toEqual({});
  });
});

describe("NewTabView: first run", () => {
  const PROMPT = "Read ~/rooms/ONBOARD.md and follow it.";

  it("with no rooms but inbox, shows the welcome page instead of the grid; 복사 copies the prompt", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderWithStores(<NewTabView />, {
      viewer: viewer(),
      home: "/Users/me/rooms",
      rooms: [room("inbox", "Inbox")],
      artifacts: { inbox: [] },
    });
    expect(screen.getByRole("heading", { level: 1, name: "Welcome to Rooms" })).toBeInTheDocument();
    expect(screen.queryByText("Since your last visit")).toBeNull();
    expect(screen.getByTestId("welcome-prompt")).toHaveTextContent(PROMPT);
    await act(async () => {
      fireEvent.click(screen.getByTestId("welcome-copy"));
    });
    expect(writeText).toHaveBeenCalledWith(PROMPT);
    expect(screen.getByTestId("welcome-copy")).toHaveTextContent("Copied");
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByTestId("welcome-copy")).toHaveTextContent(/^Copy$/);
    vi.useRealTimers();
  });

  it("uses the absolute path when the home is not ~/rooms", async () => {
    await renderWithStores(<NewTabView />, { viewer: viewer(), home: "/Users/me/agent-rooms", rooms: [] });
    expect(screen.getByTestId("welcome-prompt")).toHaveTextContent("Read /Users/me/agent-rooms/ONBOARD.md and follow it.");
  });

  it("renders nothing before the first sync (no card flash)", () => {
    const fake = fakeClient({ rooms: [] });
    const rooms = new RoomsStore(fake.client, { warn: () => {} });
    render(
      <StoresProvider rooms={rooms} viewer={viewer()} client={fake.client}>
        <NewTabView />
      </StoresProvider>,
    );
    expect(screen.queryByText("Welcome to Rooms")).toBeNull();
    expect(screen.queryByText("Since your last visit")).toBeNull();
  });

  it("with rooms present, the heading reads Since your last visit and there is no card", async () => {
    await renderWithStores(<NewTabView />, { viewer: viewer(), rooms: [room("inbox", "Inbox"), room("a", "가")] });
    expect(screen.getByRole("heading", { level: 1, name: "Since your last visit" })).toBeInTheDocument();
    expect(screen.queryByText("Welcome to Rooms")).toBeNull();
  });

  it("the read-only welcome page still shows (copying is harmless)", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderWithStores(<NewTabView />, { viewer: viewer(), readOnly: true, home: "/Users/me/rooms", rooms: [] });
    expect(screen.getByText("Welcome to Rooms")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId("welcome-copy"));
    });
    expect(writeText).toHaveBeenCalledWith(PROMPT);
  });
});

describe("NewTabView: Waiting for a room", () => {
  const inboxRooms = [room("inbox", "Inbox", { artifactCount: 2 }), room("a", "가")];
  const inboxDocs = { inbox: [{ ...artifact("x1", "inbox", OLD), title: "오래된 문서" }, { ...artifact("x2", "inbox", NEW), title: "새 문서" }] };

  it("lists inbox artifacts newest first; clicking a row opens the doc tab", async () => {
    const v = viewer();
    await renderWithStores(<NewTabView />, { viewer: v, rooms: inboxRooms, artifacts: inboxDocs });
    const section = await screen.findByRole("region", { name: "Waiting for a room" });
    expect(within(section).getByRole("heading", { level: 2, name: "Waiting for a room" })).toBeInTheDocument();
    const rows = within(section).getAllByTestId("inbox-row");
    expect(rows.map((r) => within(r).getByTestId("inbox-title").textContent)).toEqual(["새 문서", "오래된 문서"]);
    expect(rows[0]).toHaveAttribute("draggable", "true");
    expect(within(rows[1]).getByText(dateLabel(OLD))).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(rows[0]);
    });
    expect(v.getState().tabs).toContainEqual(expect.objectContaining({ kind: "doc", roomId: "inbox", artifactId: "x2" }));
  });

  it("is hidden when the inbox is empty", async () => {
    await renderWithStores(<NewTabView />, { viewer: viewer(), rooms: inboxRooms, artifacts: { inbox: [] } });
    await screen.findByText("Since your last visit");
    expect(screen.queryByText("Waiting for a room")).toBeNull();
  });

  it("read-only: rows are not draggable", async () => {
    await renderWithStores(<NewTabView />, { viewer: viewer(), readOnly: true, rooms: inboxRooms, artifacts: inboxDocs });
    const rows = await screen.findAllByTestId("inbox-row");
    for (const r of rows) expect(r).not.toHaveAttribute("draggable", "true");
  });
});
