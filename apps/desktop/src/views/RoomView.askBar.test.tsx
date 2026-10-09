import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithStores, room } from "@/test/fakes";
import { RoomView } from "./RoomView";

const mounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/ask/AskBar", () => ({
  AskBar: () => {
    mounts.count++;
    return <div data-testid="ask-bar" />;
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mounts.count = 0;
});

/** A requestAnimationFrame that only calls back when `flush` runs, like a window the user can't see. */
function holdFrames() {
  const queued: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queued.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return { flush: () => act(() => queued.splice(0).forEach((cb) => cb(0))) };
}

const doc = {
  id: "a1", roomId: "r1", relPath: "a.html", title: "A", createdAt: "2026-10-06T09:00:00+09:00",
  updatedAt: "2026-10-06T09:00:00+09:00", author: "agent" as const, fileKey: "k1",
  source: { agent: null, session: null, cwd: null, machine: null },
};

it("mounts the room's ask bar once the cards paint, and never in read-only", async () => {
  const first = await renderWithStores(<RoomView roomId="r1" />, { rooms: [room("r1", "R", { artifactCount: 1 })], artifacts: { r1: [doc] } });
  expect(await screen.findByTestId("ask-bar")).toBeTruthy();
  first.unmount();
  mounts.count = 0;
  await renderWithStores(<RoomView roomId="r1" />, { readOnly: true, rooms: [room("r1", "R", { artifactCount: 1 })], artifacts: { r1: [doc] } });
  await screen.findByText("A");
  await new Promise((r) => setTimeout(r, 50));
  expect(mounts.count).toBe(0);
});

it("mounts the ask bar on the frame after the first card, not with it", async () => {
  const frames = holdFrames();
  await renderWithStores(<RoomView roomId="r1" />, { rooms: [room("r1", "R", { artifactCount: 1 })], artifacts: { r1: [doc] } });
  await screen.findByText("A");
  expect(screen.queryByTestId("ask-bar")).toBeNull();
  frames.flush();
  expect(screen.getByTestId("ask-bar")).toBeTruthy();
});

it("mounts the ask bar even when the window never paints a frame", async () => {
  holdFrames();
  await renderWithStores(<RoomView roomId="r1" />, { rooms: [room("r1", "R", { artifactCount: 1 })], artifacts: { r1: [doc] } });
  expect(await screen.findByTestId("ask-bar")).toBeTruthy();
});
