import type { Artifact, AskScope, AskTurn } from "@alto-rooms/protocol-ts";
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithStores, room } from "@/test/fakes";
import { RoomView } from "./RoomView";

const cardRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./ArtifactCard", () => ({
  ArtifactCard: ({ artifact }: { artifact: Artifact }) => {
    cardRenders.count++;
    return <div data-testid="artifact-card">{artifact.title}</div>;
  },
}));

afterEach(cleanup);

const docs: Artifact[] = Array.from({ length: 40 }, (_, i) => ({
  id: `a${i}`, roomId: "r1", relPath: `d${i}.html`, title: `Doc ${i}`, createdAt: "2026-10-06T09:00:00+09:00",
  updatedAt: "2026-10-06T09:00:00+09:00", author: "agent", fileKey: `k${i}`,
  source: { agent: null, session: null, cwd: null, machine: null },
}));
const scope: AskScope = { kind: "room", roomId: "r1" };
const running: AskTurn = {
  id: "t1", scope, question: "q", answer: "", agent: "claude-code", model: null, mode: "new", status: "running",
  error: null, startedAt: "2026-10-06T10:00:00+09:00", endedAt: null, images: [], kind: "question", leftOut: 0,
};

it("never re-renders the card grid while a room answer streams", async () => {
  const { emit } = await renderWithStores(<RoomView roomId="r1" />, { rooms: [room("r1", "R", { artifactCount: 40 })], artifacts: { r1: docs } });
  expect(await screen.findAllByTestId("artifact-card")).toHaveLength(40);
  await screen.findByPlaceholderText("Ask about this room…");
  act(() => emit({ type: "ask.started", turn: running }));
  await screen.findByText("Thinking");
  const before = cardRenders.count;
  let answer = "";
  for (let i = 0; i < 60; i++) {
    answer += `word${i} `;
    act(() => emit({ type: "ask.progress", id: "t1", scope, answer, activity: i % 10 === 0 ? `Read · d${i}.html` : null }));
  }
  act(() => emit({ type: "ask.done", turn: { ...running, status: "done", answer, endedAt: "2026-10-06T10:01:00+09:00" } }));
  expect(await screen.findByText(/word59/)).toBeTruthy();
  expect(cardRenders.count).toBe(before);
});
