import type { Artifact, Info } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerStore } from "@/data/viewerStore";
import { AppShell } from "@/shell/AppShell";
import { memoryStorage, renderWithStores, room } from "@/test/fakes";
import { ArtifactCard } from "./ArtifactCard";
import { EmptyRoom } from "./EmptyRoom";
import { RoomView } from "./RoomView";

vi.mock("@/lib/native", () => ({
  pickFolder: vi.fn(async () => null),
  openInEditor: vi.fn(async () => {}),
  viewerInitial: vi.fn(async () => "J"),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const artifact = (id: string, title: string, createdAt: string, roomId = "r1"): Artifact => ({
  id,
  roomId,
  relPath: `${id}.html`,
  title,
  createdAt,
  updatedAt: createdAt,
  author: "agent",
  source: { agent: null, session: null, cwd: null, machine: null }, fileKey: "0000000000000000",
});

const longAgo = "2026-01-02T03:00:00Z";
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** A viewer whose room r1 was last left at `lastVisit`, with the r1 tab active. */
function viewerFor(lastVisit: string) {
  const storage = memoryStorage();
  storage.setItem(
    "alto-rooms.viewer.v1",
    JSON.stringify({ tabs: [], sidebarOpen: true, lastVisit: { r1: lastVisit }, firstRunAt: "2020-01-01T00:00:00Z" }),
  );
  const viewer = new ViewerStore(storage);
  viewer.open({ kind: "room", roomId: "r1" });
  return viewer;
}

const cards = () => screen.getAllByTestId("artifact-card");

describe("RoomView", () => {
  it("renders the header and the cards newest → oldest", async () => {
    await renderWithStores(<RoomView roomId="r1" />, {
      rooms: [room("r1", "벤치마크", { artifactCount: 3 })],
      artifacts: {
        r1: [artifact("a", "첫 문서", "2026-03-01T00:00:00Z"), artifact("b", "둘째", "2026-04-01T00:00:00Z"), artifact("c", "셋째", ago(60_000))],
      },
    });
    expect(screen.getByRole("heading", { level: 1, name: "벤치마크" })).toBeInTheDocument();
    expect(screen.getByText("3 artifacts")).toBeInTheDocument();
    expect(cards().map((c) => within(c).getByTestId("card-title").textContent)).toEqual(["셋째", "둘째", "첫 문서"]);
  });

  it("lays the cards out in a wrapping grid that scrolls vertically", async () => {
    await renderWithStores(<RoomView roomId="r1" />, {
      rooms: [room("r1", "벤치마크")],
      artifacts: { r1: [artifact("a", "첫 문서", longAgo), artifact("b", "둘째", ago(1000))] },
    });
    const grid = document.querySelector<HTMLElement>("[data-grid]")!;
    expect(grid).toHaveClass("grid");
    expect(grid.closest("[data-scroll-root]")).toHaveClass("overflow-y-auto");
    expect(cards().every((c) => c.parentElement === grid)).toBe(true);
  });

  it("says under each card which agent wrote it and how long ago", async () => {
    await renderWithStores(<RoomView roomId="r1" />, {
      rooms: [room("r1", "벤치마크")],
      artifacts: {
        r1: [
          artifact("a", "옛날", new Date(2026, 2, 7, 12).toISOString()),
          { ...artifact("b", "방금", ago(12 * 60_000)), source: { agent: "claude-code", session: null, cwd: null, machine: null } },
        ],
      },
    });
    const [fresh, old] = cards();
    expect(within(old).getByText("Mar 7")).toBeInTheDocument();
    expect(within(fresh).getByText("claude-code")).toBeInTheDocument();
    expect(within(fresh).getByText("12 min")).toBeInTheDocument();
  });

  it("the expand button opens a doc tab, and so does Enter on the card", async () => {
    const h = await renderWithStores(<RoomView roomId="r1" />, {
      rooms: [room("r1", "벤치마크")],
      artifacts: { r1: [artifact("a", "첫 문서", longAgo), artifact("b", "둘째", longAgo)] },
    });
    const [second, first] = cards();
    fireEvent.click(within(first).getByRole("button", { name: "Open in new tab" }));
    let active = h.viewer.getState().tabs.find((t) => t.id === h.viewer.getState().activeId);
    expect(active).toEqual(expect.objectContaining({ kind: "doc", roomId: "r1", artifactId: "a" }));

    const body = within(second).getByRole("button", { name: "둘째" });
    fireEvent.keyDown(body, { key: "Enter" });
    active = h.viewer.getState().tabs.find((t) => t.id === h.viewer.getState().activeId);
    expect(active).toEqual(expect.objectContaining({ kind: "doc", roomId: "r1", artifactId: "b" }));
  });

  it("a card opens in the current tab; ⌘-click opens it in a new tab", async () => {
    const h = await renderWithStores(<RoomView roomId="r1" />, {
      rooms: [room("r1", "벤치마크")],
      artifacts: { r1: [artifact("a", "첫 문서", longAgo), artifact("b", "둘째", longAgo)] },
    });
    const before = h.viewer.getState().tabs.length;
    fireEvent.click(screen.getByRole("button", { name: "첫 문서" }));
    expect(h.viewer.getState().tabs).toHaveLength(before);
    fireEvent.click(screen.getByRole("button", { name: "둘째" }), { metaKey: true });
    expect(h.viewer.getState().tabs).toHaveLength(before + 1);
  });

  it("clicking the card body opens the doc tab", async () => {
    const h = await renderWithStores(<RoomView roomId="r1" />, {
      rooms: [room("r1", "벤치마크")],
      artifacts: { r1: [artifact("a", "첫 문서", longAgo)] },
    });
    fireEvent.click(screen.getByRole("button", { name: "첫 문서" }));
    const active = h.viewer.getState().tabs.find((t) => t.id === h.viewer.getState().activeId);
    expect(active).toEqual(expect.objectContaining({ kind: "doc", artifactId: "a" }));
  });

  it("shows the new-doc dot for artifacts created after the last visit", async () => {
    const viewer = viewerFor("2026-05-01T00:00:00Z");
    await renderWithStores(<RoomView roomId="r1" />, {
      rooms: [room("r1", "벤치마크")],
      artifacts: { r1: [artifact("old", "옛 문서", "2026-04-01T00:00:00Z"), artifact("new", "새 문서", "2026-06-01T00:00:00Z")] },
      viewer,
    });
    const [fresh, old] = cards();
    expect(within(old).queryByLabelText("New artifact")).toBeNull();
    expect(within(fresh).getByLabelText("New artifact")).toBeInTheDocument();
  });

  it("keeps the dot while the tab stays active, even when lastVisit is written for it", async () => {
    const viewer = viewerFor("2026-05-01T00:00:00Z");
    await renderWithStores(<AppShell />, {
      rooms: [room("r1", "벤치마크")],
      artifacts: { r1: [artifact("new", "새 문서", "2026-06-01T00:00:00Z")] },
      viewer,
    });
    expect(within(cards()[0]).getByLabelText("New artifact")).toBeInTheDocument();
    // flush() records leaving the active room tab now, while RoomView stays mounted.
    act(() => viewer.flush());
    expect(Date.parse(viewer.getState().lastVisit.r1)).toBeGreaterThan(Date.parse("2026-06-01T00:00:00Z"));
    expect(within(cards()[0]).getByLabelText("New artifact")).toBeInTheDocument();
  });

  it("clears the dot after leaving the room tab and coming back", async () => {
    const viewer = viewerFor("2026-05-01T00:00:00Z");
    await renderWithStores(<AppShell />, {
      rooms: [room("r1", "벤치마크")],
      artifacts: { r1: [artifact("new", "새 문서", "2026-06-01T00:00:00Z")] },
      viewer,
    });
    const roomTab = viewer.getState().activeId!;
    expect(within(cards()[0]).getByLabelText("New artifact")).toBeInTheDocument();
    act(() => {
      viewer.open({ kind: "new" }); // leaves r1: records lastVisit, unmounts RoomView
    });
    expect(screen.queryAllByTestId("artifact-card")).toHaveLength(0);
    // Coming back within the unwatch linger: the artifacts are still there, no reload.
    act(() => viewer.activate(roomTab));
    expect(cards()).toHaveLength(1);
    expect(within(cards()[0]).queryByLabelText("New artifact")).toBeNull();
  });

  it("an empty room shows the empty state with the folder path to copy", async () => {
    await renderWithStores(<RoomView roomId="r1" />, { rooms: [room("r1", "벤치마크")], artifacts: { r1: [] } });
    expect(screen.getByText("No artifacts yet")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Nothing in 벤치마크 yet" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Empty room" })).getByText("/h/rooms/r1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy folder path" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "How artifacts arrive here" })).toBeInTheDocument();
  });

  it("previews render in a sandboxed iframe from the files origin, never same-origin", async () => {
    await renderWithStores(<RoomView roomId="r1" />, {
      rooms: [room("r1", "벤치마크")],
      artifacts: { r1: [artifact("a", "첫 문서", longAgo)] },
    });
    const iframe = screen.getByTitle("첫 문서");
    expect(iframe.tagName).toBe("IFRAME");
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-popups");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe).not.toHaveAttribute("srcdoc");
    expect(iframe).toHaveAttribute("src", "http://files.test/r1/a.html");
    expect(iframe).toHaveAttribute("tabindex", "-1");
    expect(iframe).toHaveAttribute("aria-hidden", "true");
    expect(iframe.style.pointerEvents).toBe("none");
    expect(iframe).toHaveAttribute("scrolling", "no");
    expect(iframe.style.width).toBe("1280px");
    expect(iframe.style.transform).toMatch(/^scale\(/);
  });

  it("shows a page-shaped skeleton until the preview loads, then fades the preview in", async () => {
    await renderWithStores(<RoomView roomId="r1" />, {
      rooms: [room("r1", "벤치마크")],
      artifacts: { r1: [artifact("a", "첫 문서", longAgo)] },
    });
    const iframe = screen.getByTitle("첫 문서");
    expect(screen.getByTestId("doc-skeleton")).toBeInTheDocument();
    expect(iframe).toHaveClass("opacity-0");
    fireEvent.load(iframe);
    expect(screen.queryByTestId("doc-skeleton")).toBeNull();
    expect(iframe).toHaveClass("opacity-100");
  });

  it("shows Something went wrong when the first load failed", async () => {
    await renderWithStores(<RoomView roomId="r1" />, {
      rooms: [room("r1", "벤치마크")],
      artifactErrors: { r1: new Error("boom") },
    });
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Empty room" })).toBeNull();
  });

  it("an unavailable linked room says so under the subtitle and keeps its cards", async () => {
    await renderWithStores(<RoomView roomId="r1" />, {
      rooms: [room("r1", "벤치마크", { kind: "linked", status: "unavailable", artifactCount: 1 })],
      artifacts: { r1: [artifact("a", "첫 문서", longAgo)] },
    });
    expect(screen.getByText("Folder not found")).toBeInTheDocument();
    expect(cards()).toHaveLength(1);
  });

  it("a removed room's panel says so", async () => {
    const h = await renderWithStores(<RoomView roomId="r1" />, { rooms: [room("r1", "벤치마크")], artifacts: { r1: [] } });
    act(() => h.emit({ type: "room.removed", roomId: "r1" }));
    expect(screen.getByText("This room is gone")).toBeInTheDocument();
  });
});

describe("RoomView: Clew's perch", () => {
  const filled = (n: number) => Array.from({ length: n }, (_, i) => artifact(`a${i}`, `문서 ${i}`, longAgo));
  const clew = () => screen.queryByRole("img", { name: /^Clew the otter/ });
  const slot = () => screen.queryByText("The next artifact lands here");

  it("perches above the empty state in an empty room", async () => {
    await renderWithStores(<RoomView roomId="r1" />, { rooms: [room("r1", "벤치마크")], artifacts: { r1: [] } });
    expect(screen.getByTestId("room-band")).toHaveAttribute("data-perch", "start");
    expect(clew()).toBeInTheDocument();
  });

  it.each([1, 2, 3])("perches over the cards with %i artifacts, and leaves a place for the next one", async (n) => {
    await renderWithStores(<RoomView roomId="r1" />, { rooms: [room("r1", "벤치마크", { artifactCount: n })], artifacts: { r1: filled(n) } });
    expect(screen.getByTestId("room-band")).toHaveAttribute("data-perch", "end");
    expect(clew()).toBeInTheDocument();
    expect(slot()).toBeInTheDocument();
  });

  it.each([4, 9])("is gone from a room with %i artifacts, and the band is compact", async (n) => {
    await renderWithStores(<RoomView roomId="r1" />, { rooms: [room("r1", "벤치마크", { artifactCount: n })], artifacts: { r1: filled(n) } });
    expect(screen.getByTestId("room-band")).not.toHaveAttribute("data-perch");
    expect(screen.getByTestId("room-band")).toHaveClass("pb-[26px]");
    expect(clew()).toBeNull();
    expect(slot()).toBeNull();
  });

  it("never shows on a load error", async () => {
    await renderWithStores(<RoomView roomId="r1" />, { rooms: [room("r1", "벤치마크")], artifactErrors: { r1: new Error("boom") } });
    expect(clew()).toBeNull();
  });
});

describe("ArtifactCard: lazy preview", () => {
  const info: Info = { version: "0", readOnly: false, home: "/h", journalRoomId: "journal", filesOrigin: "http://files.test" };

  it("renders only the blank page box until the card is near the viewport, and unloads 2 s after it leaves", async () => {
    let fire: (hit: boolean) => void = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: IntersectionObserverCallback) {
          fire = (hit) => cb([{ isIntersecting: hit } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      await renderWithStores(
        <ArtifactCard artifact={artifact("a", "첫 문서", longAgo)} info={info} isNew={false} onOpen={() => {}} />,
      );
      expect(screen.queryByTitle("첫 문서")).toBeNull();
      act(() => fire(true));
      expect(screen.getByTitle("첫 문서")).toBeInTheDocument();
      vi.useFakeTimers();
      act(() => fire(false));
      // Scrolling back within the delay keeps the loaded preview.
      act(() => vi.advanceTimersByTime(1500));
      act(() => fire(true));
      act(() => fire(false));
      act(() => vi.advanceTimersByTime(1999));
      expect(screen.getByTitle("첫 문서")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByTitle("첫 문서")).toBeNull();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("EmptyRoom", () => {
  it("shows ~ for the user's home and copies the absolute path", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<EmptyRoom room={room("r1", "벤치마크", { path: "/Users/x/rooms/벤치마크" })} home="/Users/x/rooms" />);
    expect(within(screen.getByRole("region", { name: "Empty room" })).getByText("~/rooms/벤치마크")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy folder path" }));
    });
    expect(writeText).toHaveBeenCalledWith("/Users/x/rooms/벤치마크");
    expect(screen.getByText("Copied")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("says Something went wrong briefly when the clipboard fails", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<EmptyRoom room={room("r1", "벤치마크", { path: "/Volumes/ext/bench" })} home="/Users/x/rooms" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy folder path" }));
    });
    expect(screen.queryByText("Copied")).toBeNull();
    const msg = screen.getByText("Something went wrong");
    expect(msg.closest("[role=status]")).toHaveClass("text-error");
    expect(msg.closest("[role=status]")!.querySelector("svg")).not.toBeNull();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });
});

describe("RoomView: drag from the inbox", () => {
  it("inbox cards are draggable with the artifact payload; the expand button and click still open the doc", async () => {
    const v = new ViewerStore(memoryStorage());
    v.open({ kind: "room", roomId: "inbox" });
    await renderWithStores(<RoomView roomId="inbox" />, {
      viewer: v,
      rooms: [room("inbox", "Inbox", { artifactCount: 1 })],
      artifacts: { inbox: [artifact("x1", "떠도는 문서", longAgo, "inbox")] },
    });
    const card = cards()[0];
    expect(card).toHaveAttribute("draggable", "true");
    const data = new Map<string, string>();
    fireEvent.dragStart(card, { dataTransfer: { setData: (t: string, d: string) => data.set(t, d), effectAllowed: "all" } });
    expect(JSON.parse(data.get("application/x-rooms-artifact")!)).toEqual({ roomId: "inbox", artifactId: "x1" });
    fireEvent.click(within(card).getByRole("button", { name: "떠도는 문서" }));
    expect(v.getState().tabs).toContainEqual(expect.objectContaining({ kind: "doc", artifactId: "x1" }));
  });

  it("cards in other rooms, or in a read-only inbox, are not draggable", async () => {
    await renderWithStores(<RoomView roomId="r1" />, {
      viewer: viewerFor(longAgo),
      rooms: [room("r1", "벤치마크", { artifactCount: 1 })],
      artifacts: { r1: [artifact("a", "첫째", longAgo)] },
    });
    expect(cards()[0]).not.toHaveAttribute("draggable", "true");
    cleanup();
    await renderWithStores(<RoomView roomId="inbox" />, {
      readOnly: true,
      rooms: [room("inbox", "Inbox", { artifactCount: 1 })],
      artifacts: { inbox: [artifact("x1", "떠도는 문서", longAgo, "inbox")] },
    });
    expect(cards()[0]).not.toHaveAttribute("draggable", "true");
  });
});
