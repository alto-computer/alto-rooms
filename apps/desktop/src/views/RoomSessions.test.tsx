import type { Artifact } from "@alto-rooms/protocol-ts";
import { useState } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { session, renderWithStores, room } from "@/test/fakes";
import { RoomView } from "./RoomView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const today = "2026-10-05";

const artifact = (id: string, extra: Partial<Artifact> = {}): Artifact => ({
  id,
  roomId: "p",
  relPath: `${id}.html`,
  title: `Artifact ${id}`,
  createdAt: `${today}T03:00:00Z`,
  updatedAt: `${today}T03:00:00Z`,
  author: "agent",
  source: { agent: null, session: null, cwd: null, machine: null },
  fileKey: "0000000000000000",
  ...extra,
});

describe("Room: sessions", () => {
  it("lists the room's sessions below its artifacts, counts both, and filters between them", async () => {
    await renderWithStores(<RoomView roomId="p" />, {
      rooms: [room("p", "벤치마크", { artifactCount: 1, color: "clay" })],
      artifacts: { p: [artifact("a1")] },
      sessions: [session("s1", { title: "Cold start", messages: 42, roomId: "p" }), session("s9", { title: "Elsewhere" })],
    });
    const section = await screen.findByRole("region", { name: "Sessions" });
    const card = within(section).getByTestId("session-card");
    expect(card).toHaveTextContent("Cold start");
    expect(card).toHaveTextContent("42 msgs");
    expect(screen.queryByText("Elsewhere")).toBeNull();
    const grid = screen.getByTestId("artifact-card");
    expect(grid.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("1 session")).toBeInTheDocument();

    const filter = within(screen.getByRole("group", { name: "Show" }));
    fireEvent.click(filter.getByRole("button", { name: /^Sessions/ }));
    expect(screen.queryByTestId("artifact-card")).toBeNull();
    fireEvent.click(filter.getByRole("button", { name: /^Artifacts/ }));
    expect(screen.queryByRole("region", { name: "Sessions" })).toBeNull();
    expect(screen.getByTestId("artifact-card")).toBeInTheDocument();
  });

  it("a card opens its session in a tab, ⌘-click in a new one", async () => {
    const h = await renderWithStores(<RoomView roomId="p" />, {
      rooms: [room("p", "벤치마크")],
      artifacts: { p: [] },
      sessions: [session("s1", { title: "Cold start", roomId: "p" }), session("s2", { title: "Report", roomId: "p" })],
    });
    const [first, second] = await screen.findAllByTestId("session-card");
    fireEvent.click(first);
    fireEvent.click(second, { metaKey: true });
    const sessions = h.viewer.getState().tabs.filter((t) => t.kind === "session");
    expect(sessions.map((t) => (t.kind === "session" ? t.sessionId : null)).sort()).toEqual(["s1", "s2"]);
  });

  it("says so in the Sessions area when the first list fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await renderWithStores(<RoomView roomId="p" />, {
      rooms: [room("p", "벤치마크", { artifactCount: 1 })],
      artifacts: { p: [artifact("a1")] },
      sessionErrors: { p: new Error("down") },
    });
    expect(within(await screen.findByRole("region", { name: "Sessions" })).getByText("Couldn't load this room's sessions")).toBeInTheDocument();
  });

  it("keeps the sessions it showed when a refetch fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = await renderWithStores(<RoomView roomId="p" />, {
      rooms: [room("p", "벤치마크", { artifactCount: 1 })],
      artifacts: { p: [artifact("a1")] },
      sessions: [session("s1", { title: "Cold start", roomId: "p" })],
    });
    await screen.findByText("Cold start");
    h.client.listRoomSessions.mockRejectedValueOnce(new Error("down"));
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(within(screen.getByRole("region", { name: "Sessions" })).getByText("Cold start")).toBeInTheDocument();
  });

  it("a room with sessions and no artifacts shows the sessions, not the empty room", async () => {
    await renderWithStores(<RoomView roomId="p" />, {
      rooms: [room("p", "벤치마크")],
      artifacts: { p: [] },
      sessions: [session("s1", { title: "Cold start", roomId: "p" })],
    });
    expect(within(await screen.findByRole("region", { name: "Sessions" })).getByText("Cold start")).toBeInTheDocument();
    expect(screen.queryByText("Nothing in 벤치마크 yet")).toBeNull();
    expect(screen.getByText("No artifacts in this room yet")).toBeInTheDocument();
    expect(screen.getByTestId("room-band")).toHaveAttribute("data-perch", "end");
  });

  it("has no filter and no sessions section when the room has none", async () => {
    const h = await renderWithStores(<RoomView roomId="p" />, { rooms: [room("p", "벤치마크", { artifactCount: 1 })], artifacts: { p: [artifact("a1")] } });
    await waitFor(() => expect(h.client.listRoomSessions).toHaveBeenCalledWith("p"));
    expect(screen.queryByRole("group", { name: "Show" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Sessions" })).toBeNull();
  });

  it("refetches when a session moves in, and on window focus", async () => {
    const c = session("s1", { title: "Moved here" });
    const h = await renderWithStores(<RoomView roomId="p" />, { rooms: [room("p", "벤치마크")], artifacts: { p: [] }, sessions: [c] });
    await waitFor(() => expect(h.client.listRoomSessions).toHaveBeenCalled());
    const calls = () => h.client.listRoomSessions.mock.calls.length;
    const before = calls();
    await act(async () => h.emit({ type: "session.moved", session: { ...c, agent: "codex", id: "x" }, fromRoomId: "r" }));
    expect(calls()).toBe(before);
    h.state.sessions[0] = { ...c, roomId: "p" };
    await act(async () => h.emit({ type: "session.moved", session: { ...c, roomId: "p" }, fromRoomId: null }));
    expect(await screen.findByText("Moved here")).toBeInTheDocument();
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(calls()).toBe(before + 2);
  });

  it("opens a card's menu from the keyboard, offering Move to Room and Remove from Room and no Continue", async () => {
    await renderWithStores(<RoomView roomId="p" />, { rooms: [room("p", "벤치마크")], artifacts: { p: [] }, sessions: [session("s1", { title: "Cold start", roomId: "p" })] });
    const card = await screen.findByRole("button", { name: "Cold start" });
    expect(within(card).queryByRole("button")).toBeNull();
    fireEvent.keyDown(card, { key: "F10", shiftKey: true });
    const menu = within(await screen.findByRole("menu", { name: "Cold start menu" }));
    expect(menu.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Move to Room", "Remove from Room"]);
  });

  it("starts another room on All when the tab moves there", async () => {
    const opts = {
      rooms: [room("p", "벤치마크", { artifactCount: 1 }), room("q", "리서치", { artifactCount: 1 })],
      artifacts: { p: [artifact("a1")], q: [artifact("b1", { roomId: "q" })] },
      sessions: [session("s1", { roomId: "p" }), session("s2", { roomId: "q" })],
    };
    function Tab() {
      const [roomId, setRoomId] = useState("p");
      return (
        <>
          <button type="button" onClick={() => setRoomId("q")}>
            Go to q
          </button>
          <RoomView roomId={roomId} />
        </>
      );
    }
    await renderWithStores(<Tab />, opts);
    fireEvent.click(within(await screen.findByRole("group", { name: "Show" })).getByRole("button", { name: /^Sessions/ }));
    expect(screen.queryByTestId("artifact-card")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go to q" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByTestId("artifact-card")).toBeInTheDocument();
  });
});
