import type { Artifact, Note } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useViewer } from "@/data/hooks";
import { ViewerStore } from "@/data/viewerStore";
import { addDays, clockTime, isoWeek, localDate } from "@/lib/dates";
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
  source: { agent: null, session: null, cwd: null, machine: null }, fileKey: "0000000000000000",
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

const daybook = () => screen.getByRole("list", { name: "Your day" });
const titles = () => within(daybook()).getAllByRole("listitem").map((li) => within(li).getByRole("button").getAttribute("aria-label"));

describe("JournalView: the daybook", () => {
  it("puts notes and every room's artifacts in time order, the time in the margin and the room beside each artifact", async () => {
    await renderWithStores(<Host />, {
      viewer: journalViewer(),
      rooms: [room("r1", "벤치마크"), room("r2", "리서치")],
      days: {
        [today]: {
          artifacts: [
            artifact("x2", "r2", "later.html", "나중 문서", `${today}T05:00:00Z`),
            artifact("x1", "r1", "early.html", "이른 문서", `${today}T01:00:00Z`),
            artifact("j1", "journal", `${today}/memo.html`, "메모", `${today}T03:00:00Z`),
            artifact("dream", "journal", `${today}/dream.html`, "어젯밤 꿈", `${today}T00:30:00Z`),
          ],
          notes: [note(today, "계획.md", `${today}T02:00:00Z`)],
        },
      },
    });
    expect(titles()).toEqual(["어젯밤 꿈", "이른 문서", "계획", "메모", "나중 문서"]);
    const items = within(daybook()).getAllByRole("listitem");
    expect(within(items[0]).getByText(/^Review/)).toBeInTheDocument();
    expect(within(items[1]).getByText(/^벤치마크/)).toBeInTheDocument();
    expect(within(items[3]).getByText(/^Journal/)).toBeInTheDocument();
    expect(within(items[4]).getByText(/^리서치/)).toBeInTheDocument();
    expect(within(items[1]).getByText(clockTime(`${today}T01:00:00Z`))).toBeInTheDocument();
    expect(screen.queryByText("1 note and 4 artifacts")).not.toBeInTheDocument();
  });

  it("shows a note's own words in the day and opens the note on click", async () => {
    const { viewer } = await renderWithStores(<Host />, {
      viewer: journalViewer(),
      days: { [today]: { notes: [note(today, "계획.md")] } },
      notes: { [`${today}/계획.md`]: "점심 전에 끝내기\n- 첫째 할 일\n- 둘째 할 일" },
    });
    expect(await within(daybook()).findByText("점심 전에 끝내기")).toBeInTheDocument();
    expect(within(daybook()).getAllByRole("listitem")[0].querySelectorAll("li")).toHaveLength(2);
    fireEvent.click(within(daybook()).getByRole("button", { name: "계획" }));
    expect(viewer.getState().tabs.find((t) => t.id === viewer.getState().activeId)).toMatchObject({ kind: "note", date: today, name: "계획.md" });
  });

  it("opens another room's artifact as a doc tab, from a sandboxed preview of it", async () => {
    const { viewer } = await renderWithStores(<Host />, {
      viewer: journalViewer(),
      rooms: [room("r9", "다른 방")],
      days: { [today]: { artifacts: [artifact("a1", "r9", "x.html", "보고서", `${today}T01:00:00Z`)] } },
    });
    const row = within(daybook()).getByTestId("day-artifact");
    expect(within(row).getByText("다른 방")).toBeInTheDocument();
    const frame = row.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-popups");
    expect(frame.getAttribute("src")).toBe("http://files.test/r9/x.html");
    fireEvent.click(row);
    const active = viewer.getState().tabs.find((t) => t.id === viewer.getState().activeId);
    expect(active).toMatchObject({ kind: "doc", roomId: "r9", artifactId: "a1" });
  });

  it("labels an artifact whose room isn't listed Room, and a dream.html outside the Journal is no Review", async () => {
    await renderWithStores(<Host />, {
      viewer: journalViewer(),
      days: {
        [today]: {
          artifacts: [
            artifact("a1", "gone-room", "x.html", "고아 문서", `${today}T01:00:00Z`),
            artifact("b", "gone-room", `${today}/dream.html`, "가짜 꿈", `${today}T02:00:00Z`),
          ],
        },
      },
    });
    expect(within(daybook()).getAllByText(/^Room/)).toHaveLength(2);
    expect(screen.queryByText(/^Review/)).not.toBeInTheDocument();
  });

  it("shows the load-failure copy when the day can't be loaded", async () => {
    await renderWithStores(<Host />, { viewer: journalViewer(), dayErrors: { [today]: new Error("boom") } });
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });
});

describe("JournalView: an empty day", () => {
  it("lets Clew sleep, offers a note and today, and points at the nearest days with something in them", async () => {
    const day = addDays(today, -3);
    const viewer = journalViewer(day);
    await renderWithStores(<Host />, {
      viewer,
      rooms: [room("r1", "벤치마크")],
      days: { [addDays(day, -2)]: { artifacts: [artifact("a", "r1", "a.html", "보고서", `${addDays(day, -2)}T03:00:00Z`)] }, [addDays(day, 1)]: { notes: [note(addDays(day, 1), "메모.md")] } },
    });
    expect(screen.getByRole("img", { name: "Clew the otter, asleep" })).toBeInTheDocument();
    expect(screen.getByText(/^A quiet [A-Z][a-z]+day\.$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Write a note" })).toBeInTheDocument();
    const nearest = await screen.findByRole("region", { name: "Nearest days" });
    const [before, after] = within(nearest).getAllByRole("button");
    expect(before).toHaveTextContent("1 artifact");
    expect(before).toHaveTextContent("벤치마크");
    expect(after).toHaveTextContent("1 note");
    fireEvent.click(after);
    expect(viewer.getState().tabs.find((t) => t.kind === "journal")).toMatchObject({ date: addDays(day, 1) });
  });

  it("goes to today from another quiet day", async () => {
    const viewer = journalViewer(addDays(today, -3));
    await renderWithStores(<Host />, { viewer });
    fireEvent.click(screen.getByRole("button", { name: "Go to today" }));
    expect(viewer.getState().tabs.find((t) => t.kind === "journal")).toMatchObject({ date: today });
  });

  it("never shows Clew on a load error", async () => {
    await renderWithStores(<Host />, { viewer: journalViewer(), dayErrors: { [today]: new Error("boom") } });
    expect(screen.queryByRole("img", { name: /Clew/ })).toBeNull();
  });
});

describe("JournalView: the day's tally", () => {
  const busyDay = () => ({
    viewer: journalViewer(),
    rooms: [room("r1", "벤치마크"), room("r2", "리서치")],
    days: {
      [today]: {
        artifacts: [
          artifact("a1", "r1", "a1.html", "아침 보고서", `${today}T00:10:00Z`),
          artifact("a3", "r2", "a3.html", "저녁 메모", `${today}T09:00:00Z`),
          artifact("a2", "r1", "a2.html", "점심 분석", `${today}T04:00:00Z`),
        ],
        notes: [note(today, "계획.md", `${today}T01:00:00Z`)],
      },
    },
  });
  const tally = () => screen.getByRole("region", { name: "Today" });

  it("counts the day's conversations, its artifacts across rooms and its notes, and has nothing else beside the day", async () => {
    await renderWithStores(<Host />, busyDay());
    expect(within(tally()).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["0 conversations", "3 artifacts", "1 note"]);
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Your day", "Today"]);
  });

  it("opens a list of the artifacts on hover, newest first, and an item opens on click", async () => {
    const { viewer } = await renderWithStores(<Host />, busyDay());
    fireEvent.pointerEnter(within(tally()).getByRole("button", { name: "3 artifacts" }), { pointerType: "mouse" });
    const list = await screen.findByRole("dialog", { name: "3 artifacts" });
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual([
      `${clockTime(`${today}T09:00:00Z`)}저녁 메모리서치`,
      `${clockTime(`${today}T04:00:00Z`)}점심 분석벤치마크`,
      `${clockTime(`${today}T00:10:00Z`)}아침 보고서벤치마크`,
    ]);
    fireEvent.click(rows[1]);
    expect(viewer.getState().tabs.find((t) => t.id === viewer.getState().activeId)).toMatchObject({ kind: "doc", roomId: "r1", artifactId: "a2" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on keyboard focus without taking the caret, Enter moves into it, and the notes list opens a note", async () => {
    const { viewer } = await renderWithStores(<Host />, busyDay());
    const cell = within(tally()).getByRole("button", { name: "1 note" });
    act(() => cell.focus());
    const list = await screen.findByRole("dialog", { name: "1 note" });
    expect(cell).toHaveFocus();
    fireEvent.click(cell);
    expect(within(list).getByRole("button", { name: /계획/ })).toHaveFocus();
    fireEvent.click(within(list).getByRole("button", { name: /계획/ }));
    expect(viewer.getState().tabs.find((t) => t.id === viewer.getState().activeId)).toMatchObject({ kind: "note", date: today, name: "계획.md" });
  });

  it("names the day it counts when it isn't today", async () => {
    await renderWithStores(<Host />, { viewer: journalViewer("2026-10-05") });
    expect(screen.getByRole("region", { name: "Oct 5" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Today" })).toBeNull();
  });
});

describe("JournalView: header and week strip", () => {
  it("titles the day and marks today", async () => {
    await renderWithStores(<Host />, { viewer: journalViewer() });
    const [, m, d] = today.split("-").map(Number);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(new RegExp(`^[A-Z][a-z]+day, ${d} ${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]}$`));
    expect(screen.getByText(`Journal · Week ${isoWeek(today)}`)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Today" })).toBeInTheDocument();
    expect(screen.getAllByText(/^[SMTWF]$/).map((e) => e.textContent)).toEqual(["S", "M", "T", "W", "T", "F", "S"]);
  });

  it("moves by a week with ‹ › and selects a day by clicking it, in the same tab", async () => {
    const viewer = journalViewer("2026-10-05");
    await renderWithStores(<Host />, { viewer });
    const tabId = viewer.getState().tabs.find((t) => t.kind === "journal")!.id;
    const count = viewer.getState().tabs.length;
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Monday, 5 October");

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(viewer.getState().tabs.find((t) => t.id === tabId)).toMatchObject({ kind: "journal", date: "2026-10-12" });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Monday, 12 October");

    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(viewer.getState().tabs.find((t) => t.id === tabId)).toMatchObject({ date: "2026-09-28" });

    fireEvent.click(screen.getByRole("button", { name: "Oct 3" }));
    expect(viewer.getState().tabs.find((t) => t.id === tabId)).toMatchObject({ date: "2026-10-03" });
    expect(screen.getByRole("button", { name: "Oct 3" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Saturday, 3 October");
    expect(viewer.getState().tabs.length).toBe(count);
  });

});

describe("JournalView: write a note", () => {
  it("Write a note asks for no name: it creates New Note at once and opens it in a new tab, cursor in the body", async () => {
    const { viewer, client } = await renderWithStores(<Host />, { viewer: journalViewer() });
    const before = viewer.getState().tabs.length;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Write a note" }));
    });
    expect(screen.queryByLabelText("Note name")).not.toBeInTheDocument();
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
      fireEvent.click(screen.getByRole("button", { name: "Write a note" }));
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
      fireEvent.click(screen.getByRole("button", { name: "Write a note" }));
    });
    expect(r.client.saveNote).toHaveBeenCalledWith(today, "New Note 3.md", "");
  });

  it("never saves over a New Note that exists on disk but not in the day list: it moves on to New Note 2", async () => {
    const { viewer, client, state } = await renderWithStores(<Host />, {
      viewer: journalViewer(),
      notes: { [`${today}/New Note.md`]: "이미 쓴 글" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Write a note" }));
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
      fireEvent.click(screen.getByRole("button", { name: "Write a note" }));
    });
    expect(client.saveNote).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    expect(viewer.getState().tabs.some((t) => t.kind === "note")).toBe(false);
  });

  it("shows the error copy and opens nothing when saving fails", async () => {
    const { client, viewer } = await renderWithStores(<Host />, { viewer: journalViewer() });
    client.saveNote.mockRejectedValueOnce(new RoomsApiError(500, "disk", "write_failed"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Write a note" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't save. Trying again");
    expect(viewer.getState().tabs.some((t) => t.kind === "note")).toBe(false);
  });

  it("a second click while creating does not create a second note", async () => {
    const { client } = await renderWithStores(<Host />, { viewer: journalViewer() });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Write a note" }));
      fireEvent.click(screen.getByRole("button", { name: "Write a note" }));
    });
    expect(client.saveNote).toHaveBeenCalledTimes(1);
  });

  it("strips only one .md for display: x.md.md shows as x.md and opens as x.md.md", async () => {
    const { viewer } = await renderWithStores(<Host />, {
      viewer: journalViewer(),
      days: { [today]: { notes: [note(today, "x.md.md")] } },
    });
    fireEvent.click(within(daybook()).getByRole("button", { name: "x.md" }));
    const active = viewer.getState().tabs.find((t) => t.id === viewer.getState().activeId);
    expect(active).toMatchObject({ kind: "note", date: today, name: "x.md.md" });
  });

  it("hides Write a note in read-only mode", async () => {
    await renderWithStores(<Host />, { viewer: journalViewer(), readOnly: true, days: { [today]: { notes: [note(today, "계획.md")] } } });
    expect(screen.queryByRole("button", { name: "Write a note" })).not.toBeInTheDocument();
    expect(within(daybook()).getByRole("button", { name: "계획" })).toBeInTheDocument();
  });
});
