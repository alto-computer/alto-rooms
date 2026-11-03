import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeFlowLayout } from "@/test/flow";
import { renderWithStores, studyCard, studyVolume, type FakeStudyRoom } from "@/test/fakes";
import { SAVE_DELAY_MS, VolumePage } from "./VolumePage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeAll(fakeFlowLayout);

const room = (published: boolean): FakeStudyRoom => ({
  id: "s000000101",
  name: "어텐션",
  createdAt: "2026-10-01T00:00:00Z",
  links: [],
  volumes: [
    studyVolume(1, {
      title: "병목",
      ...(published ? { publishedAt: "2026-10-12T00:00:00Z" } : {}),
      cards: [studyCard("a", { body: "# 제목\n\n본문" }), studyCard("q", { kind: "question", x: 400, body: "왜 하나일까" })],
      edges: [{ id: "e1", source: "a", target: "q" }],
    }),
    ...(published ? [studyVolume(2)] : []),
  ],
});

const lastSave = (client: { saveStudyVolume: unknown }) => vi.mocked(client.saveStudyVolume as (...a: unknown[]) => unknown).mock.calls.at(-1);

describe("a draft volume", () => {
  it("renders an ink card's markdown and saves an edit as the whole volume", async () => {
    const { client } = await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [room(false)] });
    const ink = await screen.findByTestId("ink-card");
    expect(within(ink).getByRole("heading", { level: 1, name: "제목" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Question" }), { target: { value: "왜 둘이 아닐까" } });
    expect(client.saveStudyVolume).not.toHaveBeenCalled();
    await waitFor(() => expect(client.saveStudyVolume).toHaveBeenCalledTimes(1), { timeout: SAVE_DELAY_MS + 1000 });
    expect(lastSave(client)).toEqual([
      "s000000101",
      1,
      {
        title: "병목",
        cards: [
          { id: "a", kind: "ink", x: 0, y: 0, width: 280, body: "# 제목\n\n본문" },
          { id: "q", kind: "question", x: 400, y: 0, width: 280, body: "왜 둘이 아닐까" },
        ],
        edges: [{ id: "e1", source: "a", target: "q" }],
      },
    ]);
  });

  it("keeps a card when Backspace or Delete is typed inside it; on the selected card itself they delete it and its lines in one save", async () => {
    const { client } = await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [room(false)] });
    const ink = await screen.findByTestId("ink-card");
    fireEvent.click(ink);
    await waitFor(() => expect(ink.closest(".react-flow__node")).toHaveClass("selected"));
    const editor = within(ink).getByRole("textbox", { name: "Card" });
    fireEvent.keyDown(editor, { key: "Backspace" });
    fireEvent.keyDown(editor, { key: "Delete" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Question" }), { key: "Backspace" });
    await new Promise((r) => setTimeout(r, SAVE_DELAY_MS + 100));
    expect(screen.getByTestId("ink-card")).toBeInTheDocument();
    expect(client.saveStudyVolume).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "Backspace" });
    await waitFor(() => expect(screen.queryByTestId("ink-card")).toBeNull());
    await waitFor(() => expect(client.saveStudyVolume).toHaveBeenCalled(), { timeout: SAVE_DELAY_MS + 1000 });
    expect(lastSave(client)?.[2]).toMatchObject({ cards: [{ id: "q" }], edges: [] });
  });

  it("stops edits while a publish is under way, so none lands on the frozen volume", async () => {
    const r = await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [room(false)] });
    const real = r.client.publishStudyRoom.getMockImplementation()!;
    let release = () => {};
    r.client.publishStudyRoom.mockImplementationOnce((id: string) => new Promise((res) => (release = () => res(real(id)))));
    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(r.client.publishStudyRoom).toHaveBeenCalled());
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveAttribute("readonly");
    expect(within(screen.getByTestId("ink-card")).getByRole("textbox", { name: "Card" })).toHaveAttribute("contenteditable", "false");
    release();
  });

  it("adds a card from the bar and publishes after an inline confirm", async () => {
    const r = await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [room(false)] });
    fireEvent.click(await screen.findByRole("button", { name: "+ ?" }));
    expect(await screen.findAllByTestId("question-card")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(r.client.publishStudyRoom).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(r.client.publishStudyRoom).toHaveBeenCalledWith("s000000101"));
    // The pending edit landed before the publish froze the volume.
    expect(r.state.studyRooms[0].volumes[0]).toMatchObject({ status: "published" });
    expect(r.state.studyRooms[0].volumes[0].cards).toHaveLength(3);
    await waitFor(() => expect(r.viewer.getState().tabs.find((t) => t.id === r.viewer.getState().activeId)).toMatchObject({ kind: "study", page: "volume", number: 2 }));
  });
});

describe("the volume's ask bar", () => {
  it("asks about this volume, outside the canvas: typing in it adds no card and deletes none", async () => {
    const { client } = await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [room(true)] });
    const input = await screen.findByPlaceholderText("Ask about this volume…");
    expect(input.closest(".st-sheet")).toBeNull();
    fireEvent.doubleClick(input);
    fireEvent.change(input, { target: { value: "왜 하나일까?" } });
    fireEvent.keyDown(input, { key: "Backspace" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith({ scope: { kind: "studyVolume", roomId: "s000000101", number: 1 }, question: "왜 하나일까?", model: null }));
    expect(screen.getAllByTestId("ink-card")).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Question" })).toBeInTheDocument();
  });

  it("is not there in a read-only window", async () => {
    await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [room(false)], readOnly: true });
    await screen.findByTestId("ink-card");
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryByPlaceholderText("Ask about this volume…")).toBeNull();
  });
});

describe("a draft another writer changes", () => {
  it("keeps an untouched card's markdown byte for byte when another card is saved", async () => {
    const r = room(false);
    r.volumes[0].cards[0].body = "* 하나\n* 둘\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    const { client } = await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [r] });
    fireEvent.change(await screen.findByRole("textbox", { name: "Question" }), { target: { value: "다른 질문" } });
    await waitFor(() => expect(client.saveStudyVolume).toHaveBeenCalled(), { timeout: SAVE_DELAY_MS + 1000 });
    expect((lastSave(client)?.[2] as { cards: { body: string }[] }).cards[0].body).toBe("* 하나\n* 둘\n\n| a | b |\n|---|---|\n| 1 | 2 |");
  });

  it("shows what roomsd now holds after study.changed, when no edit of ours is pending", async () => {
    const { state, emit, client } = await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [room(false)] });
    await screen.findByTestId("ink-card");
    state.studyRooms[0].volumes[0] = { ...state.studyRooms[0].volumes[0], cards: [studyCard("a", { body: "# 바뀐 제목" }), studyCard("q", { kind: "question", body: "새 질문" })] };
    await act(async () => emit({ type: "study.changed", roomId: "s000000101" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("새 질문"));
    await waitFor(() => expect(within(screen.getByTestId("ink-card")).getByRole("heading", { level: 1, name: "바뀐 제목" })).toBeInTheDocument());
    await new Promise((res) => setTimeout(res, SAVE_DELAY_MS + 100));
    expect(client.saveStudyVolume).not.toHaveBeenCalled();
  });
});

describe("a published volume", () => {
  it("only reads: no editing, adding, deleting or publishing, and nothing is saved", async () => {
    const { client, container } = await renderWithStores(<VolumePage roomId="s000000101" number={1} />, { studyRooms: [room(true)] });
    const ink = await screen.findByTestId("ink-card");
    await waitFor(() => expect(within(ink).getByRole("textbox", { name: "Card" })).toHaveAttribute("contenteditable", "false"));
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveAttribute("readonly");
    expect(screen.getByRole("textbox", { name: "Subtitle" })).toHaveAttribute("readonly");
    for (const name of ["+ Card", "+ ?", "Publish"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(ink.closest(".react-flow__node")).not.toHaveClass("draggable");

    fireEvent.click(ink);
    fireEvent.keyDown(document.body, { key: "Backspace" });
    fireEvent.doubleClick(container.querySelector(".react-flow__pane")!);
    await new Promise((r) => setTimeout(r, SAVE_DELAY_MS + 100));
    expect(screen.getAllByTestId("ink-card")).toHaveLength(1);
    expect(client.saveStudyVolume).not.toHaveBeenCalled();
  });
});
