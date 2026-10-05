import type { Artifact, Note } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useViewer } from "@/data/hooks";
import { ViewerStore } from "@/data/viewerStore";
import { addDays, localDate } from "@/lib/dates";
import { takeNoteBodyFocus } from "@/lib/notes";
import { memoryStorage, renderWithStores, room } from "@/test/fakes";
import { JournalView } from "./JournalView";

vi.mock("@/lib/native", () => ({
  pickFolder: vi.fn(async () => null),
  openInEditor: vi.fn(async () => {}),
  viewerInitial: vi.fn(async () => "J"),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const today = localDate();

const artifact = (id: string, roomId: string, relPath: string, title: string, createdAt: string): Artifact => ({
  id,
  roomId,
  relPath,
  title,
  createdAt,
  updatedAt: createdAt,
  author: "agent",
  source: { agent: null, session: null, cwd: null, machine: null },
});

const note = (date: string, name: string, updatedAt = "2026-10-05T01:00:00Z"): Note => ({
  date,
  name,
  relPath: `${date}/${name}`,
  updatedAt,
  author: "me",
});

/** Renders the journal tab the way AppShell does: keyed by tab id, date from the tab. */
function Host() {
  const { tabs } = useViewer();
  const tab = tabs.find((t) => t.kind === "journal");
  return tab?.kind === "journal" ? <JournalView key={tab.id} tabId={tab.id} date={tab.date} /> : null;
}

function journalViewer(date = today) {
  const viewer = new ViewerStore(memoryStorage());
  viewer.open({ kind: "journal", date });
  return viewer;
}

const agentRow = () => screen.getByRole("region", { name: "에이전트가 쓴 것" });
const meRow = () => screen.getByRole("region", { name: "내가 쓴 것" });

describe("JournalView: agent row", () => {
  it("puts the Dream card first labelled 복습, then the rest by createdAt with their room names", async () => {
    await renderWithStores(<Host />, {
      viewer: journalViewer(),
      rooms: [room("r1", "벤치마크"), room("r2", "리서치")],
      days: {
        [today]: {
          artifacts: [
            artifact("x2", "r2", "later.html", "나중 문서", `${today}T05:00:00Z`),
            artifact("x1", "r1", "early.html", "이른 문서", `${today}T01:00:00Z`),
            artifact("j1", "journal", `${today}/memo.html`, "메모", `${today}T03:00:00Z`),
            artifact("dream", "journal", `${today}/dream.html`, "어젯밤 꿈", `${today}T09:00:00Z`),
          ],
        },
      },
    });
    const cards = within(agentRow()).getAllByTestId("artifact-card");
    expect(cards.map((c) => within(c).getByTestId("card-title").textContent)).toEqual(["어젯밤 꿈", "이른 문서", "메모", "나중 문서"]);
    expect(within(cards[0]).getByText("복습")).toBeInTheDocument();
    expect(within(cards[1]).getByText("벤치마크")).toBeInTheDocument();
    expect(within(cards[2]).getByText("Journal")).toBeInTheDocument();
    expect(within(cards[3]).getByText("리서치")).toBeInTheDocument();
    expect(within(agentRow()).getByText("4")).toBeInTheDocument();
    expect(within(agentRow()).getByText("에이전트")).toBeInTheDocument();
  });

  it("shows another room's artifact with that room's name and opens it as a doc tab", async () => {
    const { viewer } = await renderWithStores(<Host />, {
      viewer: journalViewer(),
      rooms: [room("r9", "다른 방")],
      days: { [today]: { artifacts: [artifact("a1", "r9", "x.html", "보고서", `${today}T01:00:00Z`)] } },
    });
    const card = within(agentRow()).getByTestId("artifact-card");
    expect(within(card).getByText("다른 방")).toBeInTheDocument();
    const frame = card.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-popups");
    expect(frame.getAttribute("src")).toBe("http://files.test/r9/x.html");
    fireEvent.click(within(card).getByRole("button", { name: "새 탭에서 크게 보기" }));
    const active = viewer.getState().tabs.find((t) => t.id === viewer.getState().activeId);
    expect(active).toMatchObject({ kind: "doc", roomId: "r9", artifactId: "a1" });
  });

  it("labels an artifact whose room isn't listed 방", async () => {
    await renderWithStores(<Host />, {
      viewer: journalViewer(),
      days: { [today]: { artifacts: [artifact("a1", "gone-room", "x.html", "고아 문서", `${today}T01:00:00Z`)] } },
    });
    const card = within(agentRow()).getByTestId("artifact-card");
    expect(within(card).getByText("방")).toBeInTheDocument();
  });

  it("does not treat a dream.html outside the journal room as the Dream", async () => {
    await renderWithStores(<Host />, {
      viewer: journalViewer(),
      rooms: [room("r1", "벤치마크")],
      days: {
        [today]: {
          artifacts: [
            artifact("a", "r1", "first.html", "첫째", `${today}T01:00:00Z`),
            artifact("b", "r1", `${today}/dream.html`, "가짜 꿈", `${today}T02:00:00Z`),
          ],
        },
      },
    });
    const cards = within(agentRow()).getAllByTestId("artifact-card");
    expect(cards.map((c) => within(c).getByTestId("card-title").textContent)).toEqual(["첫째", "가짜 꿈"]);
    expect(screen.queryByText("복습")).not.toBeInTheDocument();
  });

  it("shows the load-failure copy when the day can't be loaded", async () => {
    await renderWithStores(<Host />, { viewer: journalViewer(), dayErrors: { [today]: new Error("boom") } });
    expect(screen.getByText("문제가 생겼어요")).toBeInTheDocument();
  });
});

describe("JournalView: header and week strip", () => {
  it("titles the day and marks today", async () => {
    await renderWithStores(<Host />, { viewer: journalViewer() });
    const [, m, d] = today.split("-").map(Number);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(new RegExp(`^${m}월 ${d}일 .요일$`));
    expect(screen.getByText("오늘")).toBeInTheDocument();
    expect(screen.getAllByText(/^[일월화수목금토]$/).map((e) => e.textContent)).toEqual(["일", "월", "화", "수", "목", "금", "토"]);
  });

  it("moves by a week with ‹ › and selects a day by clicking it, in the same tab", async () => {
    const viewer = journalViewer("2026-10-05");
    await renderWithStores(<Host />, { viewer });
    const tabId = viewer.getState().tabs.find((t) => t.kind === "journal")!.id;
    const count = viewer.getState().tabs.length;
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("10월 5일 월요일");

    fireEvent.click(screen.getByRole("button", { name: "다음 주" }));
    expect(viewer.getState().tabs.find((t) => t.id === tabId)).toMatchObject({ kind: "journal", date: "2026-10-12" });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("10월 12일 월요일");

    fireEvent.click(screen.getByRole("button", { name: "이전 주" }));
    fireEvent.click(screen.getByRole("button", { name: "이전 주" }));
    expect(viewer.getState().tabs.find((t) => t.id === tabId)).toMatchObject({ date: "2026-09-28" });

    fireEvent.click(screen.getByRole("button", { name: "10월 3일" }));
    expect(viewer.getState().tabs.find((t) => t.id === tabId)).toMatchObject({ date: "2026-10-03" });
    expect(screen.getByRole("button", { name: "10월 3일" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("10월 3일 토요일");
    expect(viewer.getState().tabs.length).toBe(count);
  });

  it("shows 오늘 only for the local today", async () => {
    await renderWithStores(<Host />, { viewer: journalViewer(addDays(today, -1)) });
    expect(screen.queryByText("오늘")).not.toBeInTheDocument();
  });
});

describe("JournalView: me row and new note", () => {
  it("lists 새 노트 first, then notes by name (shown without .md), and opens a note tab with the file name", async () => {
    const { viewer } = await renderWithStores(<Host />, {
      viewer: journalViewer(),
      days: { [today]: { notes: [note(today, "회고.md"), note(today, "계획.md")] } },
    });
    const buttons = within(meRow()).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["새 노트", "계획", "회고"]);
    expect(within(meRow()).getByText("나")).toBeInTheDocument();
    expect(within(meRow()).getByText("2")).toBeInTheDocument();
    expect(within(meRow()).getByText("회고")).toBeInTheDocument();
    fireEvent.click(within(meRow()).getByRole("button", { name: "회고" }));
    const active = viewer.getState().tabs.find((t) => t.id === viewer.getState().activeId);
    expect(active).toMatchObject({ kind: "note", date: today, name: "회고.md" });
  });

  it("shows the viewer initial", async () => {
    await renderWithStores(<Host />, { viewer: journalViewer() });
    await act(async () => {});
    expect(within(meRow()).getByText("J")).toBeInTheDocument();
  });

  it("새 노트 asks for no name: it creates New Note at once and opens it in a new tab, cursor in the body", async () => {
    const { viewer, client } = await renderWithStores(<Host />, { viewer: journalViewer() });
    const before = viewer.getState().tabs.length;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "새 노트" }));
    });
    expect(screen.queryByLabelText("노트 이름")).not.toBeInTheDocument();
    expect(client.getNote).toHaveBeenCalledWith(today, "New Note.md");
    expect(client.saveNote).toHaveBeenCalledTimes(1);
    expect(client.saveNote).toHaveBeenCalledWith(today, "New Note.md", "");
    const { tabs, activeId } = viewer.getState();
    expect(tabs).toHaveLength(before + 1);
    expect(tabs.find((t) => t.id === activeId)).toMatchObject({ kind: "note", date: today, name: "New Note.md" });
    expect(takeNoteBodyFocus(today, "New Note.md")).toBe(true);
  });

  it("the next note is New Note 2, then New Note 3 (names compared case-insensitively)", async () => {
    const { viewer, client } = await renderWithStores(<Host />, {
      viewer: journalViewer(),
      days: { [today]: { notes: [note(today, "new note.md")] } },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "새 노트" }));
    });
    expect(client.getNote).not.toHaveBeenCalledWith(today, "New Note.md");
    expect(client.saveNote).toHaveBeenCalledWith(today, "New Note 2.md", "");
    expect(viewer.getState().tabs.find((t) => t.id === viewer.getState().activeId)).toMatchObject({ name: "New Note 2.md" });
    cleanup();

    const r = await renderWithStores(<Host />, {
      viewer: journalViewer(),
      days: { [today]: { notes: [note(today, "New Note.md"), note(today, "NEW NOTE 2.md")] } },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "새 노트" }));
    });
    expect(r.client.saveNote).toHaveBeenCalledWith(today, "New Note 3.md", "");
  });

  it("never saves over a New Note that exists on disk but not in the day list: it moves on to New Note 2", async () => {
    const { viewer, client, state } = await renderWithStores(<Host />, {
      viewer: journalViewer(),
      notes: { [`${today}/New Note.md`]: "이미 쓴 글" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "새 노트" }));
    });
    expect(client.getNote).toHaveBeenCalledWith(today, "New Note.md");
    expect(client.saveNote).not.toHaveBeenCalledWith(today, "New Note.md", expect.anything());
    expect(client.saveNote).toHaveBeenCalledWith(today, "New Note 2.md", "");
    expect(state.notes[`${today}/New Note.md`]).toBe("이미 쓴 글");
    expect(viewer.getState().tabs.find((t) => t.id === viewer.getState().activeId)).toMatchObject({ name: "New Note 2.md" });
  });

  it("shows the error copy and creates nothing when the existence check fails with anything but 404", async () => {
    const { client, viewer } = await renderWithStores(<Host />, {
      viewer: journalViewer(),
      notes: { [`${today}/New Note.md`]: new RoomsApiError(500, "boom") },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "새 노트" }));
    });
    expect(client.saveNote).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("문제가 생겼어요");
    expect(viewer.getState().tabs.some((t) => t.kind === "note")).toBe(false);
  });

  it("shows the error copy and opens nothing when saving fails", async () => {
    const { client, viewer } = await renderWithStores(<Host />, { viewer: journalViewer() });
    client.saveNote.mockRejectedValueOnce(new RoomsApiError(500, "disk", "write_failed"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "새 노트" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("저장하지 못했어요. 다시 시도할게요");
    expect(viewer.getState().tabs.some((t) => t.kind === "note")).toBe(false);
  });

  it("a second click while creating does not create a second note", async () => {
    const { client } = await renderWithStores(<Host />, { viewer: journalViewer() });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "새 노트" }));
      fireEvent.click(screen.getByRole("button", { name: "새 노트" }));
    });
    expect(client.saveNote).toHaveBeenCalledTimes(1);
  });

  it("strips only one .md for display: x.md.md shows as x.md and opens as x.md.md", async () => {
    const { viewer } = await renderWithStores(<Host />, {
      viewer: journalViewer(),
      days: { [today]: { notes: [note(today, "x.md.md")] } },
    });
    fireEvent.click(within(meRow()).getByRole("button", { name: "x.md" }));
    const active = viewer.getState().tabs.find((t) => t.id === viewer.getState().activeId);
    expect(active).toMatchObject({ kind: "note", date: today, name: "x.md.md" });
  });

  it("hides 새 노트 in read-only mode", async () => {
    await renderWithStores(<Host />, { viewer: journalViewer(), readOnly: true, days: { [today]: { notes: [note(today, "계획.md")] } } });
    expect(screen.queryByRole("button", { name: "새 노트" })).not.toBeInTheDocument();
    expect(within(meRow()).getByRole("button", { name: "계획" })).toBeInTheDocument();
  });
});
