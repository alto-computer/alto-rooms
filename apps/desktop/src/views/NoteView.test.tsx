import type { Note } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openInEditor } from "@/lib/native";
import { renderWithStores } from "@/test/fakes";
import { NoteView } from "./NoteView";

vi.mock("@/lib/native", () => ({
  pickFolder: vi.fn(async () => null),
  openInEditor: vi.fn(async () => {}),
  viewerInitial: vi.fn(async () => "J"),
}));

const DATE = "2026-10-05";
const ERROR_COPY = "저장하지 못했어요. 다시 시도할게요";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T03:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const note = (name: string, updatedAt: string): Note => ({ date: DATE, name, relPath: `${DATE}/${name}`, updatedAt, author: "me" });

async function renderNote(opts: Parameters<typeof renderWithStores>[1] = {}) {
  const r = await renderWithStores(<NoteView date={DATE} name="계획" />, {
    notes: { [`${DATE}/계획`]: "원래 내용" },
    days: { [DATE]: { notes: [note("계획.md", "2026-10-05T01:00:00Z")] } },
    ...opts,
  });
  await advance(0); // getNote settles
  return r;
}

const textarea = () => screen.getByRole("textbox", { name: "노트" }) as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(textarea(), { target: { value: text } });

describe("NoteView: loading", () => {
  it("shows the heading and loads the body", async () => {
    const { client } = await renderNote();
    expect(screen.getByRole("heading", { level: 1, name: "계획" })).toBeInTheDocument();
    expect(client.getNote).toHaveBeenCalledWith(DATE, "계획");
    expect(textarea()).toHaveValue("원래 내용");
    expect(textarea()).not.toBeDisabled();
  });

  it("treats a 404 as an empty, editable note", async () => {
    await renderNote({ notes: { [`${DATE}/계획`]: new RoomsApiError(404, "nope", "not_found") } });
    expect(textarea()).toHaveValue("");
    expect(textarea()).not.toBeDisabled();
    expect(screen.queryByText("문제가 생겼어요")).not.toBeInTheDocument();
  });

  it("on any other error, shows the copy, keeps the textarea disabled, and retries on request", async () => {
    const { client, state } = await renderNote({ notes: { [`${DATE}/계획`]: new RoomsApiError(500, "boom") } });
    expect(screen.getByText("문제가 생겼어요")).toBeInTheDocument();
    expect(textarea()).toBeDisabled();
    type("이건 저장되면 안 돼요");
    await advance(5000);
    expect(client.saveNote).not.toHaveBeenCalled();

    state.notes[`${DATE}/계획`] = "서버 내용";
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await advance(0);
    expect(screen.queryByText("문제가 생겼어요")).not.toBeInTheDocument();
    expect(textarea()).not.toBeDisabled();
    expect(textarea()).toHaveValue("서버 내용");
  });
});

describe("NoteView: autosave", () => {
  it("typing then 800ms idle saves exactly once", async () => {
    const { client } = await renderNote();
    type("원래 내용!");
    await advance(400);
    type("원래 내용!!");
    await advance(799);
    expect(client.saveNote).not.toHaveBeenCalled();
    await advance(1);
    expect(client.saveNote).toHaveBeenCalledTimes(1);
    expect(client.saveNote).toHaveBeenCalledWith(DATE, "계획", "원래 내용!!");
    await advance(10_000);
    expect(client.saveNote).toHaveBeenCalledTimes(1);
  });

  it("saves on blur", async () => {
    const { client } = await renderNote();
    fireEvent.focus(textarea());
    type("바로 저장");
    fireEvent.blur(textarea());
    await advance(0);
    expect(client.saveNote).toHaveBeenCalledWith(DATE, "계획", "바로 저장");
  });

  it("after 3 failures shows the error copy and keeps the text; recovers on the 4th attempt", async () => {
    const { client } = await renderNote();
    const fail = new RoomsApiError(500, "disk", "write_failed");
    client.saveNote.mockRejectedValueOnce(fail).mockRejectedValueOnce(fail).mockRejectedValueOnce(fail);
    type("잃으면 안 되는 글");
    await advance(800); // 1st attempt fails
    await advance(1000); // 2nd
    expect(screen.queryByText(ERROR_COPY)).not.toBeInTheDocument();
    await advance(2000); // 3rd
    expect(client.saveNote).toHaveBeenCalledTimes(3);
    expect(screen.getByText(ERROR_COPY)).toBeInTheDocument();
    expect(textarea()).toHaveValue("잃으면 안 되는 글");

    await advance(4000); // 4th succeeds
    expect(client.saveNote).toHaveBeenCalledTimes(4);
    expect(client.saveNote).toHaveBeenLastCalledWith(DATE, "계획", "잃으면 안 되는 글");
    expect(screen.queryByText(ERROR_COPY)).not.toBeInTheDocument();
    expect(textarea()).toHaveValue("잃으면 안 되는 글");
  });

  it("an edit during an in-flight save produces exactly one extra save", async () => {
    const { client } = await renderNote();
    let release!: () => void;
    client.saveNote.mockImplementationOnce(
      (date: string, name: string) =>
        new Promise((resolve) => {
          release = () => resolve({ date, name: `${name}.md`, relPath: "", updatedAt: new Date().toISOString(), author: "me" });
        }),
    );
    type("하나");
    await advance(800);
    expect(client.saveNote).toHaveBeenCalledTimes(1);
    type("하나 둘");
    type("하나 둘 셋");
    await advance(800);
    expect(client.saveNote).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await advance(0);
    expect(client.saveNote).toHaveBeenCalledTimes(2);
    expect(client.saveNote).toHaveBeenLastCalledWith(DATE, "계획", "하나 둘 셋");
    await advance(10_000);
    expect(client.saveNote).toHaveBeenCalledTimes(2);
  });

  it("flushes unsaved text on unmount", async () => {
    const { client, unmount } = await renderNote();
    type("닫기 직전");
    unmount();
    expect(client.saveNote).toHaveBeenCalledWith(DATE, "계획", "닫기 직전");
  });
});

describe("NoteView: external changes", () => {
  async function externalSave(fake: Awaited<ReturnType<typeof renderNote>>, body: string, updatedAt: string) {
    fake.state.notes[`${DATE}/계획`] = body;
    fake.state.days[DATE] = { notes: [note("계획.md", updatedAt)] };
    await act(async () => {
      fake.emit({ type: "note.saved", note: note("계획.md", updatedAt) });
    });
    await advance(200); // the store's day refetch (150ms debounce)
    await advance(0);
  }

  it("reloads the body when the note changes elsewhere and the textarea is idle", async () => {
    const fake = await renderNote();
    await externalSave(fake, "다른 편집기에서 고침", "2026-10-05T02:00:00Z");
    expect(textarea()).toHaveValue("다른 편집기에서 고침");
    expect(fake.client.saveNote).not.toHaveBeenCalled();
  });

  it("does not reload while the textarea is focused, then catches up after blur", async () => {
    const fake = await renderNote();
    fireEvent.focus(textarea());
    await externalSave(fake, "바깥 내용", "2026-10-05T02:00:00Z");
    expect(textarea()).toHaveValue("원래 내용");
    fireEvent.blur(textarea());
    await advance(0);
    expect(textarea()).toHaveValue("바깥 내용");
  });

  it("does not reload over unsaved local edits", async () => {
    const fake = await renderNote();
    const fail = new RoomsApiError(500, "disk", "write_failed");
    fake.client.saveNote.mockRejectedValue(fail);
    type("내 편집");
    await advance(800);
    await externalSave(fake, "바깥 내용", "2026-10-05T02:00:00Z");
    expect(textarea()).toHaveValue("내 편집");
  });

  it("ignores the echo of its own save", async () => {
    const fake = await renderNote();
    type("내 글");
    await advance(800);
    expect(fake.client.saveNote).toHaveBeenCalledTimes(1);
    const own = (await fake.client.saveNote.mock.results[0].value) as Note;
    fake.client.getNote.mockClear();
    await externalSave(fake, "내 글", own.updatedAt);
    expect(fake.client.getNote).not.toHaveBeenCalled();
    expect(textarea()).toHaveValue("내 글");
  });
});

describe("NoteView: other editor and read-only", () => {
  it("다른 편집기로 열기 opens the .md under the journal folder", async () => {
    await renderNote();
    fireEvent.click(screen.getByRole("button", { name: "다른 편집기로 열기" }));
    expect(openInEditor).toHaveBeenCalledWith("/h/journal/2026-10-05/계획.md");
  });

  it("is read-only in read-only mode, without editing affordances", async () => {
    const { client } = await renderNote({ readOnly: true });
    expect(textarea()).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "다른 편집기로 열기" })).not.toBeInTheDocument();
    type("못 써요");
    await advance(5000);
    expect(client.saveNote).not.toHaveBeenCalled();
  });
});
