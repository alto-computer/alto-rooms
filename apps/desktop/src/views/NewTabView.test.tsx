import type { Artifact } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerStore } from "@/data/viewerStore";
import { manualTimers, memoryStorage, renderWithStores, room } from "@/test/fakes";
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
  source: { agent: null, session: null, cwd: null, machine: null },
});

const OLD = "2026-01-02T03:00:00Z";
const NEW = "2026-06-02T03:00:00Z";

function viewer() {
  const storage = memoryStorage();
  storage.setItem(
    "alto-rooms.viewer.v1",
    JSON.stringify({ tabs: [], sidebarOpen: true, lastVisit: {}, firstRunAt: "2026-03-01T00:00:00Z" }),
  );
  return new ViewerStore(storage);
}

const cardNames = () => screen.getAllByTestId("new-room-card").map((c) => within(c).getByTestId("new-room-name").textContent);

describe("NewTabView", () => {
  it("counts rooms with new docs, sorts them first with 새 문서 k", async () => {
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
    expect(await screen.findByText("방 2곳에 새 문서가 들어왔어요.")).toBeInTheDocument();
    expect(cardNames()).toEqual(["나", "다", "가", "라"]);
    const [first, second, third] = screen.getAllByTestId("new-room-card");
    expect(within(first).getByText("새 문서 2")).toBeInTheDocument();
    expect(within(first).getByText("문서 3")).toBeInTheDocument();
    expect(within(second).getByText("새 문서 1")).toBeInTheDocument();
    expect(within(third).queryByText(/새 문서/)).toBeNull();
  });

  it("says nothing is new when nothing is", async () => {
    await renderWithStores(<NewTabView />, {
      viewer: viewer(),
      rooms: [room("a", "가", { artifactCount: 1 })],
      artifacts: { a: [artifact("a1", "a", OLD)] },
    });
    expect(await screen.findByText("새로 들어온 문서가 없어요.")).toBeInTheDocument();
  });

  it("counts only the rooms that loaded when another room's load failed", async () => {
    await renderWithStores(<NewTabView />, {
      viewer: viewer(),
      rooms: [room("a", "가", { updatedAt: NEW }), room("b", "나", { updatedAt: NEW })],
      artifacts: { a: [artifact("a1", "a", NEW)] },
      artifactErrors: { b: new Error("boom") },
    });
    expect(await screen.findByText("방 1곳에 새 문서가 들어왔어요.")).toBeInTheDocument();
  });

  it("lists unavailable rooms with the unavailable copy, and clicking a card opens the room", async () => {
    const v = viewer();
    await renderWithStores(<NewTabView />, {
      viewer: v,
      rooms: [room("a", "가", { status: "unavailable", artifactCount: 4 }), room("b", "나")],
      artifacts: { a: [], b: [] },
    });
    const card = (await screen.findAllByTestId("new-room-card"))[0];
    expect(within(card).getByText("폴더를 찾을 수 없어요")).toBeInTheDocument();
    expect(within(card).queryByText("문서 4")).toBeNull();
    await act(async () => {
      fireEvent.click(card);
    });
    expect(v.getState().tabs.some((t) => t.kind === "room" && t.roomId === "a")).toBe(true);
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
    expect(await screen.findByText("방 1곳에 새 문서가 들어왔어요.")).toBeInTheDocument();
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
    await screen.findByText("방 1곳에 새 문서가 들어왔어요.");
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
