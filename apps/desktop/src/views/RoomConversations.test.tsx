import type { Artifact } from "@alto-rooms/protocol-ts";
import { useState } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { conversation, renderWithStores, room } from "@/test/fakes";
import { RoomView } from "./RoomView";

afterEach(() => {
  cleanup();
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

describe("Room: conversations", () => {
  it("lists the room's conversations below its artifacts, counts both, and filters between them", async () => {
    await renderWithStores(<RoomView roomId="p" />, {
      rooms: [room("p", "벤치마크", { artifactCount: 1, color: "clay" })],
      artifacts: { p: [artifact("a1")] },
      conversations: [conversation("s1", { title: "Cold start", messages: 42, roomId: "p" }), conversation("s9", { title: "Elsewhere" })],
    });
    const section = await screen.findByRole("region", { name: "Sessions" });
    const card = within(section).getByTestId("conversation-card");
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

  it("has no filter and no conversations section when the room has none", async () => {
    const h = await renderWithStores(<RoomView roomId="p" />, { rooms: [room("p", "벤치마크", { artifactCount: 1 })], artifacts: { p: [artifact("a1")] } });
    await waitFor(() => expect(h.client.listRoomConversations).toHaveBeenCalledWith("p"));
    expect(screen.queryByRole("group", { name: "Show" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Sessions" })).toBeNull();
  });

  it("refetches when a conversation moves in, and on window focus", async () => {
    const c = conversation("s1", { title: "Moved here" });
    const h = await renderWithStores(<RoomView roomId="p" />, { rooms: [room("p", "벤치마크")], artifacts: { p: [] }, conversations: [c] });
    await waitFor(() => expect(h.client.listRoomConversations).toHaveBeenCalled());
    const calls = () => h.client.listRoomConversations.mock.calls.length;
    const before = calls();
    await act(async () => h.emit({ type: "conversation.moved", conversation: { ...c, id: { agent: "codex", session: "x" } }, fromRoomId: "r" }));
    expect(calls()).toBe(before);
    h.state.conversations[0] = { ...c, roomId: "p" };
    await act(async () => h.emit({ type: "conversation.moved", conversation: { ...c, roomId: "p" }, fromRoomId: null }));
    expect(await screen.findByText("Moved here")).toBeInTheDocument();
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(calls()).toBe(before + 2);
  });

  it("opens a card's menu from the keyboard, offering Move to Room and Remove from Room", async () => {
    await renderWithStores(<RoomView roomId="p" />, { rooms: [room("p", "벤치마크")], artifacts: { p: [] }, conversations: [conversation("s1", { title: "Cold start", roomId: "p" })] });
    fireEvent.keyDown(await screen.findByRole("article", { name: "Cold start" }), { key: "F10", shiftKey: true });
    const menu = within(await screen.findByRole("menu", { name: "Cold start menu" }));
    expect(menu.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Continue in Claude Code", "Move to Room", "Remove from Room"]);
  });

  it("starts another room on All when the tab moves there", async () => {
    const opts = {
      rooms: [room("p", "벤치마크", { artifactCount: 1 }), room("q", "리서치", { artifactCount: 1 })],
      artifacts: { p: [artifact("a1")], q: [artifact("b1", { roomId: "q" })] },
      conversations: [conversation("s1", { roomId: "p" }), conversation("s2", { roomId: "q" })],
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
