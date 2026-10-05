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

describe("NewTabView: first run", () => {
  const PROMPT = "~/rooms/ONBOARD.md 를 읽고 따라 해줘";

  it("with no rooms but inbox, shows the full onboarding card with the exact copy; clicking the chip copies the prompt", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderWithStores(<NewTabView />, {
      viewer: viewer(),
      home: "/Users/me/rooms",
      rooms: [room("inbox", "Inbox")],
      artifacts: { inbox: [] },
    });
    expect(screen.getByRole("heading", { level: 1, name: "이 한 줄을 에이전트에게 붙여넣으세요" })).toBeInTheDocument();
    expect(
      screen.getByText("에이전트가 최근 14일 동안 만든 HTML을 주제별 방으로 정리해요. 원본은 그대로 두고 링크만 만들어요."),
    ).toBeInTheDocument();
    expect(screen.getByText("Claude Code나 Codex에 붙여넣으면 돼요.")).toBeInTheDocument();
    expect(screen.queryByText("지난 방문 이후")).toBeNull();
    const chip = screen.getByRole("button", { name: PROMPT });
    await act(async () => {
      fireEvent.click(chip);
    });
    expect(writeText).toHaveBeenCalledWith(PROMPT);
    expect(screen.getByText("복사했어요")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.queryByText("복사했어요")).toBeNull();
    vi.useRealTimers();
  });

  it("uses the absolute path when the home is not ~/rooms", async () => {
    await renderWithStores(<NewTabView />, { viewer: viewer(), home: "/Users/me/agent-rooms", rooms: [] });
    expect(screen.getByRole("button", { name: "/Users/me/agent-rooms/ONBOARD.md 를 읽고 따라 해줘" })).toBeInTheDocument();
  });

  it("renders nothing before the first sync (no card flash)", () => {
    const fake = fakeClient({ rooms: [] });
    const rooms = new RoomsStore(fake.client, { warn: () => {} });
    render(
      <StoresProvider rooms={rooms} viewer={viewer()} client={fake.client}>
        <NewTabView />
      </StoresProvider>,
    );
    expect(screen.queryByText("이 한 줄을 에이전트에게 붙여넣으세요")).toBeNull();
    expect(screen.queryByText("지난 방문 이후")).toBeNull();
  });

  it("with rooms present, the heading reads 지난 방문 이후 and there is no card", async () => {
    await renderWithStores(<NewTabView />, { viewer: viewer(), rooms: [room("inbox", "Inbox"), room("a", "가")] });
    expect(screen.getByRole("heading", { level: 1, name: "지난 방문 이후" })).toBeInTheDocument();
    expect(screen.queryByText("이 한 줄을 에이전트에게 붙여넣으세요")).toBeNull();
    expect(screen.queryByText("에이전트로 다시 정리하기")).toBeNull();
  });

  it("the read-only full card still shows (copying is harmless)", async () => {
    await renderWithStores(<NewTabView />, { viewer: viewer(), readOnly: true, rooms: [] });
    expect(screen.getByText("이 한 줄을 에이전트에게 붙여넣으세요")).toBeInTheDocument();
  });
});

describe("NewTabView: 방을 기다리는 문서", () => {
  const inboxRooms = [room("inbox", "Inbox", { artifactCount: 2 }), room("a", "가")];
  const inboxDocs = { inbox: [{ ...artifact("x1", "inbox", OLD), title: "오래된 문서" }, { ...artifact("x2", "inbox", NEW), title: "새 문서" }] };

  it("lists inbox artifacts newest first with the hint; clicking a row opens the doc tab", async () => {
    const v = viewer();
    await renderWithStores(<NewTabView />, { viewer: v, rooms: inboxRooms, artifacts: inboxDocs });
    const section = await screen.findByRole("region", { name: "방을 기다리는 문서" });
    expect(within(section).getByRole("heading", { level: 2, name: "방을 기다리는 문서" })).toBeInTheDocument();
    expect(within(section).getByText("카드를 왼쪽 방에 끌어다 놓으면 옮겨져요")).toBeInTheDocument();
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
    await screen.findByText("지난 방문 이후");
    expect(screen.queryByText("방을 기다리는 문서")).toBeNull();
  });

  it("read-only: rows are not draggable and there is no drag hint", async () => {
    await renderWithStores(<NewTabView />, { viewer: viewer(), readOnly: true, rooms: inboxRooms, artifacts: inboxDocs });
    const rows = await screen.findAllByTestId("inbox-row");
    for (const r of rows) expect(r).not.toHaveAttribute("draggable", "true");
    expect(screen.queryByText("카드를 왼쪽 방에 끌어다 놓으면 옮겨져요")).toBeNull();
  });
});
