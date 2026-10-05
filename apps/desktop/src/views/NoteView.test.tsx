import type { Note } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openInEditor } from "@/lib/native";
import { textHash } from "@/lib/drafts";
import { noteSaverKeys, resetNoteSavers } from "@/lib/noteSaver";
import { StoresProvider } from "@/data/hooks";
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
  resetNoteSavers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const note = (name: string, updatedAt: string): Note => ({ date: DATE, name, relPath: `${DATE}/${name}`, updatedAt, author: "me" });

async function renderNote(opts: Parameters<typeof renderWithStores>[1] = {}) {
  const r = await renderWithStores(<NoteView date={DATE} name="계획.md" />, {
    notes: { [`${DATE}/계획.md`]: "원래 내용" },
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
    expect(client.getNote).toHaveBeenCalledWith(DATE, "계획.md");
    expect(textarea()).toHaveValue("원래 내용");
    expect(textarea()).not.toBeDisabled();
  });

  it("treats a 404 as an empty, editable note", async () => {
    await renderNote({ notes: { [`${DATE}/계획.md`]: new RoomsApiError(404, "nope", "not_found") } });
    expect(textarea()).toHaveValue("");
    expect(textarea()).not.toBeDisabled();
    expect(screen.queryByText("문제가 생겼어요")).not.toBeInTheDocument();
  });

  it("on any other error, shows the copy, keeps the textarea disabled, and retries on request", async () => {
    const { client, state } = await renderNote({ notes: { [`${DATE}/계획.md`]: new RoomsApiError(500, "boom") } });
    expect(screen.getByText("문제가 생겼어요")).toBeInTheDocument();
    expect(textarea()).toBeDisabled();
    type("이건 저장되면 안 돼요");
    await advance(5000);
    expect(client.saveNote).not.toHaveBeenCalled();

    state.notes[`${DATE}/계획.md`] = "서버 내용";
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
    expect(client.saveNote).toHaveBeenCalledWith(DATE, "계획.md", "원래 내용!!");
    await advance(10_000);
    expect(client.saveNote).toHaveBeenCalledTimes(1);
  });

  it("saves on blur", async () => {
    const { client } = await renderNote();
    fireEvent.focus(textarea());
    type("바로 저장");
    fireEvent.blur(textarea());
    await advance(0);
    expect(client.saveNote).toHaveBeenCalledWith(DATE, "계획.md", "바로 저장");
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
    expect(client.saveNote).toHaveBeenLastCalledWith(DATE, "계획.md", "잃으면 안 되는 글");
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
    expect(client.saveNote).toHaveBeenLastCalledWith(DATE, "계획.md", "하나 둘 셋");
    await advance(10_000);
    expect(client.saveNote).toHaveBeenCalledTimes(2);
  });

  it("keeps saving unsaved text after unmount (debounce still applies)", async () => {
    const { client, unmount } = await renderNote();
    type("닫기 직전");
    unmount();
    await advance(800);
    expect(client.saveNote).toHaveBeenCalledWith(DATE, "계획.md", "닫기 직전");
  });

  it("flushes every dirty note immediately on pagehide / beforeunload", async () => {
    const { client, state } = await renderNote();
    type("종료 직전");
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(client.saveNote).toHaveBeenCalledTimes(1);
    expect(client.saveNote).toHaveBeenCalledWith(DATE, "계획.md", "종료 직전");
    await advance(0);
    expect(state.notes[`${DATE}/계획.md`]).toBe("종료 직전");
    type("종료 직전!");
    act(() => {
      window.dispatchEvent(new Event("beforeunload"));
    });
    expect(client.saveNote).toHaveBeenCalledTimes(2);
    expect(client.saveNote).toHaveBeenLastCalledWith(DATE, "계획.md", "종료 직전!");
  });
});

describe("NoteView: saver registry (reopen and unmount)", () => {
  type Fake = Awaited<ReturnType<typeof renderNote>>;
  const show = (fake: Fake, on: boolean) =>
    act(async () => {
      fake.rerender(
        <StoresProvider rooms={fake.rooms} viewer={fake.viewer} client={fake.client}>
          {on ? <NoteView date={DATE} name="계획.md" /> : null}
        </StoresProvider>,
      );
    });

  it("reopening during an in-flight save attaches to the live saver: no getNote, local text shown, disk ends with it", async () => {
    const fake = await renderNote({ notes: { [`${DATE}/계획.md`]: "" } });
    let release!: () => void;
    const real = fake.client.saveNote.getMockImplementation()!;
    fake.client.saveNote.mockImplementationOnce(
      (date: string, name: string, body?: string) =>
        new Promise((resolve) => {
          release = () => resolve(real(date, name, body));
        }),
    );
    type("ab");
    await advance(800);
    expect(fake.client.saveNote).toHaveBeenCalledTimes(1);
    type("abc");
    await show(fake, false);
    fake.client.getNote.mockClear();
    await show(fake, true);
    await advance(0);
    expect(fake.client.getNote).not.toHaveBeenCalled();
    expect(textarea()).toHaveValue("abc");
    expect(textarea()).not.toBeDisabled();

    await act(async () => release());
    await advance(800);
    expect(fake.client.saveNote).toHaveBeenCalledTimes(2);
    expect(fake.state.notes[`${DATE}/계획.md`]).toBe("abc");
    expect(textarea()).toHaveValue("abc");
  });

  it("an unmounted note in the error state keeps retrying until its text lands", async () => {
    const fake = await renderNote();
    const real = fake.client.saveNote.getMockImplementation()!;
    let failing = true;
    fake.client.saveNote.mockImplementation(async (date: string, name: string, body?: string) => {
      if (failing) throw new RoomsApiError(500, "disk", "write_failed");
      return real(date, name, body);
    });
    type("살아남아야 하는 글");
    await advance(800 + 1000 + 2000);
    expect(screen.getByText(ERROR_COPY)).toBeInTheDocument();
    await show(fake, false);
    await advance(4000 + 10_000);
    expect(fake.client.saveNote).toHaveBeenCalledTimes(5);
    expect(noteSaverKeys()).toEqual([`${DATE}/계획.md`]);
    failing = false;
    await advance(10_000);
    expect(fake.state.notes[`${DATE}/계획.md`]).toBe("살아남아야 하는 글");
    expect(noteSaverKeys()).toEqual([]); // clean, idle and detached: released
    await advance(60_000);
    expect(fake.client.saveNote).toHaveBeenCalledTimes(6);
  });

  it("releases a clean saver on unmount, so reopening loads from disk again", async () => {
    const fake = await renderNote();
    expect(noteSaverKeys()).toEqual([`${DATE}/계획.md`]);
    await show(fake, false);
    expect(noteSaverKeys()).toEqual([]);
    fake.state.notes[`${DATE}/계획.md`] = "디스크의 새 내용";
    fake.client.getNote.mockClear();
    await show(fake, true);
    await advance(0);
    expect(fake.client.getNote).toHaveBeenCalledWith(DATE, "계획.md");
    expect(textarea()).toHaveValue("디스크의 새 내용");
  });
});

describe("NoteView: file names", () => {
  it("uses the on-disk name for load and save, and strips one .md only for display (x.md.md round-trips)", async () => {
    const fake = await renderWithStores(<NoteView date={DATE} name="x.md.md" />, { notes: { [`${DATE}/x.md.md`]: "본문" } });
    await advance(0);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("x.md");
    expect(fake.client.getNote).toHaveBeenCalledWith(DATE, "x.md.md");
    expect(textarea()).toHaveValue("본문");
    type("본문!");
    await advance(800);
    expect(fake.client.saveNote).toHaveBeenCalledWith(DATE, "x.md.md", "본문!");
    expect(fake.state.notes[`${DATE}/x.md.md`]).toBe("본문!");
    expect(fake.state.notes[`${DATE}/x.md`]).toBeUndefined();
  });
});

describe("NoteView: external changes", () => {
  async function externalSave(fake: Awaited<ReturnType<typeof renderNote>>, body: string, updatedAt: string) {
    fake.state.notes[`${DATE}/계획.md`] = body;
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

  it("says 문제가 생겼어요 briefly when the other editor can't be opened", async () => {
    await renderNote();
    vi.mocked(openInEditor).mockRejectedValueOnce(new Error("no app"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "다른 편집기로 열기" }));
    });
    const msg = screen.getByText("문제가 생겼어요");
    expect(msg.closest("[role=status]")).toHaveClass("text-[#c13515]");
    expect(msg.closest("[role=status]")!.querySelector("svg")).not.toBeNull();
    await advance(3000);
    expect(screen.queryByText("문제가 생겼어요")).toBeNull();
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

describe("NoteView: drafts kept at quit", () => {
  const DRAFT = `alto-rooms.note-draft.v1:${DATE}/계획.md`;
  const keep = (text: string, base: string) => localStorage.setItem(DRAFT, JSON.stringify({ v: 1, text, baseHash: textHash(base) }));
  afterEach(() => localStorage.clear());

  it("disk unchanged since the draft: restores it as unsaved text, saves it, then deletes the draft", async () => {
    keep("종료 전에 못 저장한 글", "원래 내용");
    const fake = await renderNote();
    await advance(0);
    expect(textarea()).toHaveValue("종료 전에 못 저장한 글");
    expect(screen.queryByText("저장되지 않았던 글이 있어요")).toBeNull();
    expect(localStorage.getItem(DRAFT)).not.toBeNull(); // kept until it lands
    await advance(800);
    expect(fake.client.saveNote).toHaveBeenCalledWith(DATE, "계획.md", "종료 전에 못 저장한 글");
    expect(fake.state.notes[`${DATE}/계획.md`]).toBe("종료 전에 못 저장한 글");
    await advance(0);
    expect(localStorage.getItem(DRAFT)).toBeNull();
  });

  it("disk changed since the draft: keeps the disk text and offers 되살리기 / 버리기", async () => {
    keep("옛 초안", "그때의 디스크 본문");
    const fake = await renderNote();
    await advance(0);
    expect(textarea()).toHaveValue("원래 내용");
    expect(screen.getByText("저장되지 않았던 글이 있어요")).toBeInTheDocument();
    await advance(5000);
    expect(fake.client.saveNote).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "되살리기" }));
    expect(textarea()).toHaveValue("옛 초안");
    expect(screen.queryByText("저장되지 않았던 글이 있어요")).toBeNull();
    await advance(800);
    expect(fake.state.notes[`${DATE}/계획.md`]).toBe("옛 초안");
    await advance(0);
    expect(localStorage.getItem(DRAFT)).toBeNull();
  });

  it("버리기 deletes the draft and leaves the text alone", async () => {
    keep("옛 초안", "그때의 디스크 본문");
    const fake = await renderNote();
    await advance(0);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "버리기" }));
    });
    expect(screen.queryByText("저장되지 않았던 글이 있어요")).toBeNull();
    expect(textarea()).toHaveValue("원래 내용");
    expect(localStorage.getItem(DRAFT)).toBeNull();
    await advance(5000);
    expect(fake.client.saveNote).not.toHaveBeenCalled();
  });

  it("drops a draft that matches the disk without saving", async () => {
    keep("원래 내용", "아무거나");
    const fake = await renderNote();
    await advance(0);
    expect(textarea()).toHaveValue("원래 내용");
    await advance(5000);
    expect(fake.client.saveNote).not.toHaveBeenCalled();
    expect(localStorage.getItem(DRAFT)).toBeNull();
  });

  it("keeps a failing restored draft until a save lands", async () => {
    keep("초안", "원래 내용");
    const fake = await renderNote();
    await advance(0);
    fake.client.saveNote.mockRejectedValueOnce(new RoomsApiError(500, "disk", "write_failed"));
    await advance(800);
    expect(localStorage.getItem(DRAFT)).not.toBeNull();
    await advance(1000);
    expect(fake.state.notes[`${DATE}/계획.md`]).toBe("초안");
    await advance(0);
    expect(localStorage.getItem(DRAFT)).toBeNull();
  });
});
