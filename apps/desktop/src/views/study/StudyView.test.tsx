import type { Artifact, StudyDay } from "@alto-rooms/protocol-ts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useViewer, useViewerStore } from "@/data/hooks";
import type { StudyPage } from "@/data/viewerStore";
import { localDate } from "@/lib/dates";
import { ViewerStore } from "@/data/viewerStore";
import { AppShell } from "@/shell/AppShell";
import { memoryStorage, renderWithStores, room, studyVolume, type FakeStudyRoom } from "@/test/fakes";
import { StudyView } from "./StudyView";

vi.mock("@/lib/native", () => ({
  pickFolder: vi.fn(async () => null),
  openInEditor: vi.fn(async () => {}),
  viewerInitial: vi.fn(async () => "J"),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Renders the active tab the way AppShell does, so navigating in the Study shows the next page. */
function Host() {
  const { tabs, activeId } = useViewer();
  const viewer = useViewerStore();
  const tab = tabs.find((t) => t.id === activeId);
  return tab?.kind === "study" ? <StudyView key={viewer.navKey(tab.id)} tab={tab} /> : <p>not the Study</p>;
}

async function renderStudy(page: StudyPage, opts: Parameters<typeof renderWithStores>[1] = {}) {
  const r = await renderWithStores(<Host />, opts);
  act(() => void r.viewer.navigate({ kind: "study", ...page }));
  return r;
}

const attention = (): FakeStudyRoom => ({
  id: "s000000101",
  name: "어텐션",
  createdAt: "2026-10-01T00:00:00Z",
  links: [],
  volumes: [
    studyVolume(1, { title: "처음 만남", publishedAt: "2026-10-12T00:00:00Z" }),
    studyVolume(2, { title: "점수로 섞는다", publishedAt: "2026-10-20T00:00:00Z" }),
    studyVolume(3),
  ],
});

describe("the library", () => {
  it("shows each room as a board: published volumes as books, the draft as a proof, and the room count", async () => {
    await renderStudy({ page: "library" }, { studyRooms: [attention()] });
    const v1 = await screen.findByRole("button", { name: "어텐션 v0.1" });
    expect(v1).toHaveClass("st-bk");
    expect(v1).not.toHaveClass("st-proof");
    expect(v1).toHaveTextContent("처음 만남");
    expect(screen.getByRole("button", { name: "어텐션 v0.2" })).not.toHaveClass("st-proof");
    expect(screen.getByRole("button", { name: "어텐션 v0.3" })).toHaveClass("st-proof");
    expect(screen.getByText("01")).toBeInTheDocument();
  });

  it("names a room's newest published volume and its title while the board is hovered", async () => {
    await renderStudy({ page: "library" }, { studyRooms: [attention()] });
    const label = await screen.findByRole("button", { name: "어텐션" });
    fireEvent.mouseEnter(label.closest("[role=listitem]")!);
    const lede = document.querySelector(".st-lede")!;
    expect(lede).toHaveTextContent("v0.2");
    expect(lede).toHaveTextContent("점수로 섞는다");
  });

  it("makes a room from the empty board's name field, and only on an Enter that ends no composition", async () => {
    const { client } = await renderStudy({ page: "library" });
    fireEvent.click(await screen.findByRole("button", { name: "New room" }));
    const input = screen.getByRole("textbox", { name: "New room name" });
    fireEvent.change(input, { target: { value: "제1원리" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(client.createStudyRoom).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.createStudyRoom).toHaveBeenCalledWith("제1원리"));
    expect(await screen.findByRole("button", { name: "제1원리 v0.1" })).toHaveClass("st-proof");
    expect(screen.queryByRole("textbox", { name: "New room name" })).toBeNull();
  });

  it("opens the volume a book is, and the room a board is", async () => {
    const r = await renderStudy({ page: "library" }, { studyRooms: [attention()] });
    fireEvent.click(await screen.findByRole("button", { name: "어텐션 v0.2" }));
    expect(r.viewer.getState().tabs.find((t) => t.id === r.viewer.getState().activeId)).toMatchObject({ kind: "study", page: "volume", roomId: "s000000101", number: 2 });
    act(() => r.viewer.back());
    fireEvent.click(await screen.findByRole("button", { name: "어텐션" }));
    expect(r.viewer.getState().tabs.find((t) => t.id === r.viewer.getState().activeId)).toMatchObject({ kind: "study", page: "room", roomId: "s000000101" });
  });

  it("refetches when roomsd says the Study changed", async () => {
    const r = await renderStudy({ page: "library" }, { studyRooms: [] });
    await screen.findByText("00");
    r.state.studyRooms.push(attention());
    await act(async () => r.emit({ type: "study.changed", roomId: null }));
    expect(await screen.findByRole("button", { name: "어텐션 v0.3" })).toBeInTheDocument();
  });
});

describe("the room page", () => {
  it("links a Rooms room picked from the list, and unlinks it", async () => {
    const r = await renderStudy({ page: "room", roomId: "s000000101" }, { studyRooms: [attention()], rooms: [room("r1", "리서치")] });
    expect(await screen.findByRole("button", { name: "Read →" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    fireEvent.click(await screen.findByRole("option", { name: "리서치" }));
    await waitFor(() => expect(r.client.updateStudyRoom).toHaveBeenCalledWith("s000000101", { name: "어텐션", links: [{ kind: "room", roomId: "r1" }] }));
    const links = await screen.findByRole("list", { name: "Linked rooms and artifacts" });
    fireEvent.click(within(links).getByRole("button", { name: "Unlink 리서치" }));
    await waitFor(() => expect(r.client.updateStudyRoom).toHaveBeenLastCalledWith("s000000101", { name: "어텐션", links: [] }));
  });

  it("asks about the Study room from the one ask bar, and the library has none", async () => {
    const r = await renderStudy({ page: "room", roomId: "s000000101" }, { studyRooms: [attention()] });
    const input = await screen.findByPlaceholderText("Ask about this Study room…");
    expect(screen.getAllByRole("textbox").filter((t) => t.tagName === "TEXTAREA")).toHaveLength(1);
    fireEvent.change(input, { target: { value: "v0.2에서 뭐가 바뀌었지?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(r.client.startAsk).toHaveBeenCalledWith({ scope: { kind: "studyRoom", roomId: "s000000101" }, question: "v0.2에서 뭐가 바뀌었지?", model: null }));
    // The arrow keys that turn the covers leave the question being typed alone.
    const current = () => screen.getByRole("button", { current: true }).getAttribute("aria-label");
    const before = current();
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(current()).toBe(before);
    act(() => void r.viewer.navigate({ kind: "study", page: "library" }));
    expect(await screen.findByRole("button", { name: "New room" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/^Ask about/)).toBeNull();
  });

  it("shows no ask bar in a read-only window", async () => {
    await renderStudy({ page: "room", roomId: "s000000101" }, { studyRooms: [attention()], readOnly: true });
    expect(await screen.findByRole("button", { name: "Read →" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryByPlaceholderText("Ask about this Study room…")).toBeNull();
  });
});

describe("⌘J in the Study", () => {
  const cmdJ = () => fireEvent.keyDown(window, { key: "j", code: "KeyJ", metaKey: true });

  it("toggles the ask bar on a Study room's page, the same bar as everywhere else", async () => {
    const viewer = new ViewerStore(memoryStorage());
    viewer.replace(viewer.getState().activeId!, { kind: "study", page: "room", roomId: "s000000101" });
    await renderWithStores(<AppShell />, { viewer, studyRooms: [attention()] });
    await screen.findByPlaceholderText("Ask about this Study room…");
    act(cmdJ);
    expect(screen.queryByPlaceholderText("Ask about this Study room…")).toBeNull();
    act(cmdJ);
    expect(await screen.findByPlaceholderText("Ask about this Study room…")).toHaveFocus();
  });
});

const artifact = (id: string, title: string, createdAt: string): Artifact => ({
  id,
  roomId: "r1",
  relPath: `${id}.html`,
  title,
  createdAt,
  updatedAt: createdAt,
  author: "agent",
  source: { agent: null, session: null, cwd: null, machine: null },
  fileKey: `k${id}`.padEnd(16, "0"),
});

describe("the calendar's day", () => {
  const date = localDate();
  const saved = (memos: string[], todos: [string, boolean][]): StudyDay => ({
    date,
    memos: memos.map((text, i) => ({ id: `m${i}`, text, at: "2026-11-03T09:00:00Z" })),
    todos: todos.map(([text, done], i) => ({ id: `t${i}`, text, done, at: "2026-11-03T09:00:00Z" })),
  });

  it("adds a memo on Enter, but not on the Enter that commits a Korean syllable", async () => {
    const { client } = await renderStudy({ page: "day", date });
    const input = await screen.findByRole("textbox", { name: "Memo" });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "라우터가 하나면 병목 아닌가" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(client.saveStudyDay).not.toHaveBeenCalled();
    expect(input).toHaveValue("라우터가 하나면 병목 아닌가");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.saveStudyDay).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.saveStudyDay).mock.calls[0][1].memos.map((m) => m.text)).toEqual(["라우터가 하나면 병목 아닌가"]);
    expect(input).toHaveValue("");
    expect(within(screen.getByRole("region", { name: "Memo" })).getByText("라우터가 하나면 병목 아닌가")).toBeInTheDocument();
  });

  it("toggles a todo and deletes a memo, each saved whole", async () => {
    const { client, state } = await renderStudy({ page: "day", date }, { studyDays: { [date]: saved(["하나", "둘"], [["리뷰 준비", false]]) } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "리뷰 준비" }));
    await waitFor(() => expect(state.studyDays[date].todos[0].done).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Delete 하나" }));
    await waitFor(() => expect(state.studyDays[date].memos.map((m) => m.text)).toEqual(["둘"]));
    expect(state.studyDays[date].todos[0].done).toBe(true);
    expect(client.saveStudyDay).toHaveBeenCalledTimes(2);
  });

  it("lists the day's artifacts and opens one in a tab", async () => {
    const r = await renderStudy(
      { page: "day", date },
      { rooms: [room("r1", "리서치")], days: { [date]: { artifacts: [artifact("a2", "둘째", "2026-11-03T10:00:00Z"), artifact("a1", "첫째", "2026-11-03T09:00:00Z")] } } },
    );
    const list = await screen.findByRole("region", { name: "Artifacts" });
    await waitFor(() => expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual(["첫째", "둘째"]));
    fireEvent.click(within(list).getByRole("button", { name: "둘째" }));
    expect(r.viewer.getState().tabs.some((t) => t.kind === "artifact" && t.artifactId === "a2")).toBe(true);
  });

  it("goes to the day picked in the month", async () => {
    const r = await renderStudy({ page: "day", date: "2026-11-03" });
    fireEvent.click(await screen.findByRole("button", { name: "2026-11-17" }));
    expect(r.viewer.getState().tabs.find((t) => t.id === r.viewer.getState().activeId)).toMatchObject({ kind: "study", page: "day", date: "2026-11-17" });
    expect(await screen.findByRole("heading", { level: 1, name: "11.17" })).toBeInTheDocument();
  });
});
