import type { Artifact } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithStores, room } from "@/test/fakes";
import { QuickFind } from "./QuickFind";

afterEach(cleanup);

const artifact = (id: string, roomId: string, title: string): Artifact => ({
  id,
  roomId,
  relPath: `${id}.html`,
  title,
  createdAt: "2026-06-02T03:00:00Z",
  updatedAt: "2026-06-02T03:00:00Z",
  author: "agent",
  source: { agent: null, session: null, cwd: null, machine: null },
});

const setup = (onClose = vi.fn()) =>
  renderWithStores(<QuickFind open onClose={onClose} />, {
    rooms: [room("r1", "벤치마크"), room("r2", "디자인")],
    artifacts: { r1: [artifact("d1", "r1", "벤치마크 현황")], r2: [artifact("d2", "r2", "색 정리")] },
  });

describe("QuickFind", () => {
  it("typing finds a doc under 문서, and Enter opens its doc tab and closes", async () => {
    const onClose = vi.fn();
    const h = await setup(onClose);
    const input = screen.getByPlaceholderText("방이나 문서 찾기");
    await act(async () => {
      fireEvent.change(input, { target: { value: "현황" } });
    });
    const group = await screen.findByRole("group", { name: "문서" });
    expect(within(group).getByText("벤치마크 현황")).toBeInTheDocument();
    expect(within(group).getByText("벤치마크")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "방" })).toBeNull();
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    const active = h.viewer.getState().tabs.find((t) => t.id === h.viewer.getState().activeId);
    expect(active).toEqual(expect.objectContaining({ kind: "doc", roomId: "r1", artifactId: "d1" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("matches rooms (NFC, case-insensitive) and opens the room tab", async () => {
    const onClose = vi.fn();
    const h = await setup(onClose);
    const input = screen.getByPlaceholderText("방이나 문서 찾기");
    await act(async () => {
      fireEvent.change(input, { target: { value: "벤치".normalize("NFD") } });
    });
    const group = await screen.findByRole("group", { name: "방" });
    await act(async () => {
      fireEvent.click(within(group).getByText("벤치마크"));
    });
    expect(h.viewer.getState().tabs.some((t) => t.kind === "room" && t.roomId === "r1")).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it("loads every room's artifacts on first open", async () => {
    const h = await setup();
    await waitFor(() => expect(h.rooms.getState().artifacts.r2).toBeDefined());
  });
});
