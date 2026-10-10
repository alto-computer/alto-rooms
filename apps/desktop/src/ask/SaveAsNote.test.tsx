import type { Artifact, AskScope, AskTurn, Conversation } from "@alto-rooms/protocol-ts";
import { RoomsApiError, scopeKey } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localDate } from "@/lib/dates";
import { renderWithStores, room } from "@/test/fakes";
import { AskBar } from "./AskBar";
import type { AskSubject } from "./askSubjects";

const doc: Artifact = {
  id: "a1", roomId: "r1", relPath: "doc.html", title: "Doc", createdAt: "2026-10-06T09:00:00+09:00",
  updatedAt: "2026-10-06T09:00:00+09:00", author: "agent", fileKey: "k1",
  source: { agent: "codex", session: "S1", cwd: null, machine: null },
};
const roomScope: AskScope = { kind: "room", roomId: "r1" };
const turn = (scope: AskScope, extra: Partial<AskTurn> = {}): AskTurn => ({
  id: "t1", scope, question: "> picked\n\n회의에서 정한 것들 정리해줘", answer: "- 금요일 배포\n- 리뷰는 둘", agent: "claude-code", model: null, mode: "new",
  status: "done", error: null, startedAt: "2026-10-06T10:00:00+09:00", endedAt: "2026-10-06T10:00:09+09:00", images: [], kind: "question", leftOut: 0, session: null, ...extra,
});
const NAME = "회의에서 정한 것들 정리해줘";
const ROOM_NOTE = `Room: Planning\n\n## ${NAME}\n\n- 금요일 배포\n- 리뷰는 둘`;

/** Doc threads are keyed by file key, the others by scope key. */
const threadKey = (scope: AskScope) => (scope.kind === "doc" ? scope.fileKey : scopeKey(scope));

function setup(subject: AskSubject, t: AskTurn, notes: Record<string, string | Error> = {}) {
  return renderWithStores(<AskBar subject={subject} />, {
    rooms: [room("r1", "Planning")], artifacts: { r1: [doc] }, asks: { [threadKey(t.scope)]: [t] }, notes,
  });
}

async function openNameInput() {
  fireEvent.click(await screen.findByRole("button", { name: "Save as note" }));
  return screen.getByRole<HTMLInputElement>("textbox", { name: "Note name" });
}

describe("SaveAsNote", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("prefills the question as the name and saves a room answer into today's Journal under the room's name", async () => {
    const today = localDate();
    const { client, state, viewer } = await setup({ kind: "room", roomId: "r1" }, turn(roomScope));
    const input = await openNameInput();
    expect(input.value).toBe(NAME);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved to Journal")).toBeTruthy();
    expect(client.createNote).toHaveBeenCalledTimes(1);
    expect(client.saveNote).not.toHaveBeenCalled();
    expect(state.notes[`${today}/${NAME}.md`]).toBe(ROOM_NOTE);
    fireEvent.click(screen.getByRole("button", { name: "Open note" }));
    const { tabs, activeId } = viewer.getState();
    expect(tabs.find((t) => t.id === activeId)).toMatchObject({ kind: "note", date: today, name: `${NAME}.md` });
  });

  it("saves a session answer into today's Journal under the session's title", async () => {
    const conversation: Conversation = { id: { agent: "codex", session: "S1" }, title: "Sync bug", cwd: null, startedAt: "", endedAt: "", messages: 2, lastReply: null, artifactsWritten: [], roomId: null };
    const { state } = await setup({ kind: "conversation", conversation }, turn({ kind: "conversation", agent: "codex", session: "S1" }));
    await openNameInput();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved to Journal")).toBeTruthy();
    expect(state.notes[`${localDate()}/${NAME}.md`]).toBe(`Session: Sync bug\n\n## ${NAME}\n\n- 금요일 배포\n- 리뷰는 둘`);
  });

  it("saves under a name the user typed", async () => {
    const { state } = await setup({ kind: "room", roomId: "r1" }, turn(roomScope));
    fireEvent.change(await openNameInput(), { target: { value: "회의 정리" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved to Journal")).toBeTruthy();
    expect(state.notes[`${localDate()}/회의 정리.md`]).toBe(ROOM_NOTE);
  });

  it("takes the next free name when roomsd says the name is taken (a note the day list missed), and leaves that note alone", async () => {
    const today = localDate();
    const { client, state } = await setup({ kind: "room", roomId: "r1" }, turn(roomScope), { [`${today}/${NAME}.md`]: "mine" });
    await openNameInput();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved to Journal")).toBeTruthy();
    expect(client.createNote).toHaveBeenCalledTimes(2);
    await expect(client.createNote.mock.results[0].value).rejects.toMatchObject({ status: 409, code: "note_exists" });
    expect(client.createNote).toHaveBeenLastCalledWith(today, `${NAME} (2).md`, ROOM_NOTE);
    expect(client.saveNote).not.toHaveBeenCalled();
    expect(state.notes[`${today}/${NAME}.md`]).toBe("mine");
  });

  it("files a room answer under the day it is saved, not the day the name input opened", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 9, 9, 23, 59));
      const { state } = await setup({ kind: "room", roomId: "r1" }, turn(roomScope));
      await openNameInput();
      vi.setSystemTime(new Date(2026, 9, 10, 0, 5));
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText("Saved to Journal")).toBeTruthy();
      expect(Object.keys(state.notes)).toEqual([`2026-10-10/${NAME}.md`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves a day answer into the viewed day, with no source line", async () => {
    const day: AskScope = { kind: "day", date: "2026-10-05" };
    const { state } = await setup({ kind: "day", date: "2026-10-05" }, turn(day));
    await openNameInput();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved to Journal")).toBeTruthy();
    expect(state.notes[`2026-10-05/${NAME}.md`]).toBe(`## ${NAME}\n\n- 금요일 배포\n- 리뷰는 둘`);
  });

  it("shows a refused save inline and keeps the name to fix", async () => {
    const { client } = await setup({ kind: "room", roomId: "r1" }, turn(roomScope));
    client.createNote.mockRejectedValueOnce(new RoomsApiError(400, "bad", "invalid_input"));
    await openNameInput();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("That name can't be used")).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Note name" }).value).toBe(NAME);
    expect(screen.queryByText("Saved to Journal")).toBeNull();
  });

  it("shows any other failure inline and tries no other name", async () => {
    const { client } = await setup({ kind: "room", roomId: "r1" }, turn(roomScope));
    client.createNote.mockRejectedValueOnce(new RoomsApiError(500, "disk", "write_failed"));
    await openNameInput();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Couldn't save. Trying again")).toBeTruthy();
    expect(client.createNote).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Saved to Journal")).toBeNull();
  });

  it("counts the name's length the way roomsd does: 55 characters, not UTF-16 units", async () => {
    const { state } = await setup({ kind: "room", roomId: "r1" }, turn(roomScope));
    const input = await openNameInput();
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save" });
    fireEvent.change(input, { target: { value: "a".repeat(56) } });
    expect(screen.getByText("Names can be up to 55 characters")).toBeTruthy();
    expect(save.disabled).toBe(true);
    const emoji = "📝".repeat(30);
    fireEvent.change(input, { target: { value: emoji } });
    expect(screen.queryByText("Names can be up to 55 characters")).toBeNull();
    fireEvent.click(save);
    expect(await screen.findByText("Saved to Journal")).toBeTruthy();
    expect(state.notes[`${localDate()}/${emoji}.md`]).toBe(ROOM_NOTE);
  });

  it("closes the name input on Escape without saving", async () => {
    const { client } = await setup({ kind: "room", roomId: "r1" }, turn(roomScope));
    fireEvent.keyDown(await openNameInput(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Note name" })).toBeNull());
    expect(client.createNote).not.toHaveBeenCalled();
  });

  it("offers no save on a stopped answer, though Copy keeps its partial text", async () => {
    await setup({ kind: "room", roomId: "r1" }, turn(roomScope, { status: "cancelled", answer: "절반만" }));
    expect(await screen.findByText("절반만")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy answer" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save as note" })).toBeNull();
  });

  it("offers no save on a doc answer", async () => {
    await setup({ kind: "doc", artifact: doc }, turn({ kind: "doc", fileKey: "k1" }));
    expect(await screen.findByRole("button", { name: "Copy answer" })).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Save as note" })).toBeNull();
  });
});
