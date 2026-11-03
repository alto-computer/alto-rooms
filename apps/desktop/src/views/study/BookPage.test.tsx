import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeFlowLayout } from "@/test/flow";
import { renderWithStores, studyCard } from "@/test/fakes";
import { BookPage } from "./BookPage";
import { SAVE_DELAY_MS } from "./CardCanvas";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeAll(fakeFlowLayout);

const DATE = "2026-11-02";
const book = { date: DATE, title: "정리", cards: [studyCard("a", { body: "# 오늘" })], edges: [] };

describe("a day book", () => {
  it("opens a past day's book, editable, and saves an edit to that day as the whole book", async () => {
    const { client } = await renderWithStores(<BookPage date={DATE} />, { studyBooks: { [DATE]: book } });
    expect(within(await screen.findByTestId("ink-card")).getByRole("heading", { level: 1, name: "오늘" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "← 11.02" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    const title = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "하루 정리" } });
    await waitFor(() => expect(client.saveStudyDayBook).toHaveBeenCalledTimes(1), { timeout: SAVE_DELAY_MS + 1000 });
    expect(vi.mocked(client.saveStudyDayBook).mock.calls[0]).toEqual([DATE, { title: "하루 정리", cards: [{ id: "a", kind: "ink", x: 0, y: 0, width: 280, body: "# 오늘" }], edges: [] }]);
  });

  it("starts empty on a day with no book, adds a card from the bar, and goes back to the day", async () => {
    const { client, state, viewer } = await renderWithStores(<BookPage date={DATE} />);
    fireEvent.click(await screen.findByRole("button", { name: "+ ?" }));
    expect(await screen.findAllByTestId("question-card")).toHaveLength(1);
    await waitFor(() => expect(client.saveStudyDayBook).toHaveBeenCalled(), { timeout: SAVE_DELAY_MS + 1000 });
    expect(state.studyBooks[DATE].cards).toMatchObject([{ kind: "question" }]);
    fireEvent.click(screen.getByRole("button", { name: "← 11.02" }));
    expect(viewer.getState().tabs.find((t) => t.id === viewer.getState().activeId)).toMatchObject({ kind: "study", page: "day", date: DATE });
  });

  it("asks about this book from the one ask bar", async () => {
    const { client } = await renderWithStores(<BookPage date={DATE} />, { studyBooks: { [DATE]: book } });
    const input = await screen.findByPlaceholderText("Ask about this book…");
    expect(input.closest(".st-sheet")).toBeNull();
    fireEvent.change(input, { target: { value: "오늘 뭐 했지?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith({ scope: { kind: "studyDayBook", date: DATE }, question: "오늘 뭐 했지?", model: null }));
  });
});
