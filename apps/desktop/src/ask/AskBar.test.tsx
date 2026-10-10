import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Artifact, AskScope, AskTarget, AskTurn, Conversation } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { useAsksStore } from "@/data/hooks";
import { renderWithStores, room } from "@/test/fakes";
import { AskBar } from "./AskBar";

const scope: AskScope = { kind: "doc", fileKey: "k1" };
const doc: Artifact = {
  id: "a1", roomId: "r1", relPath: "doc.html", title: "Doc", createdAt: "2026-10-06T09:00:00+09:00",
  updatedAt: "2026-10-06T09:00:00+09:00", author: "agent", fileKey: "k1",
  source: { agent: "claude-code", session: "S1", cwd: null, machine: null },
};
const turn = (extra: Partial<AskTurn>): AskTurn => ({
  id: "t1", scope: { kind: "doc", fileKey: "k1" }, question: "왜?", answer: "", agent: "claude-code", model: null, mode: "resume", status: "running",
  error: null, startedAt: "2026-10-06T10:00:00+09:00", endedAt: null, images: [], kind: "question", leftOut: 0, session: null, ...extra,
});

let store: ReturnType<typeof useAsksStore>;
function Grab() { store = useAsksStore(); return null; }

async function setup(asks: Record<string, AskTurn[]> = {}, readOnly = false, target?: AskTarget) {
  const askTargets = target ? { k1: target } : undefined;
  return renderWithStores(<><Grab /><AskBar subject={{ kind: "doc", artifact: doc }} /></>, { rooms: [room("r1", "R")], artifacts: { r1: [doc] }, asks, readOnly, askTargets });
}

const claude: AskTarget = { agent: "claude-code", mode: "resume", models: ["opus", "sonnet", "haiku", "claude-x-1"], scoped: false };

describe("AskBar", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("is open on mount without taking focus; toggling off hides it, toggling on focuses it", async () => {
    await setup();
    const first = await screen.findByPlaceholderText("Ask about this artifact…");
    expect(document.activeElement).not.toBe(first);
    expect(await screen.findByText("claude-code")).toBeTruthy();
    act(() => store.toggle());
    expect(screen.queryByPlaceholderText("Ask about this artifact…")).toBeNull();
    act(() => store.toggle());
    const input = await screen.findByPlaceholderText("Ask about this artifact…");
    expect(document.activeElement).toBe(input);
  });

  it("renders nothing in read-only", async () => {
    await setup({}, true);
    expect(screen.queryByPlaceholderText("Ask about this artifact…")).toBeNull();
  });

  it("sends on Enter (not Shift+Enter, not while composing), shows waiting, then the markdown answer", async () => {
    const { client, emit } = await setup();
    const input = await screen.findByPlaceholderText("Ask about this artifact…");
    fireEvent.change(input, { target: { value: "왜?" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(client.startAsk).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith({ scope, question: "왜?", model: null }));
    expect(await screen.findByText("Thinking")).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("");
    // Writable while it runs: typing ahead is fine, sending waits.
    expect((input as HTMLTextAreaElement).disabled).toBe(false);
    expect((input as HTMLTextAreaElement).readOnly).toBe(false);
    input.blur();
    act(() => emit({ type: "ask.done", turn: turn({ id: "ask-왜?", status: "done", answer: "**굵게** 답", endedAt: "2026-10-06T10:00:12+09:00" }) }));
    expect((await screen.findByText("굵게")).tagName).toBe("STRONG");
    expect(document.activeElement).toBe(input);
    // No timers in the ask UI.
    expect(screen.queryByText(/\d+s$/)).toBeNull();
    expect(screen.getByText("claude-code · continuing the thread that made it")).toBeTruthy();
  });

  it("says so when a new conversation was started because the thread couldn't be found", async () => {
    await setup({ k1: [turn({ mode: "new", status: "done", answer: "a", endedAt: "2026-10-06T10:00:01+09:00" })] });
    const head = await screen.findByText("claude-code · New conversation");
    expect(head.getAttribute("title")).toBe("Couldn't find the thread that made this artifact");
  });

  it("says when a question went on in the conversation the thread started", async () => {
    await setup({ k1: [turn({ mode: "continue", session: "S1", status: "done", answer: "a", endedAt: "2026-10-06T10:00:01+09:00" })] });
    const head = await screen.findByText("claude-code · continuing this conversation");
    expect(head.getAttribute("title")).toBeNull();
  });

  it("puts a copy button under each finished answer", async () => {
    await setup({ k1: [turn({ status: "done", answer: "the answer", endedAt: "2026-10-06T10:00:05+09:00" })] });
    expect(await screen.findByRole("button", { name: "Copy answer" })).toBeTruthy();
  });

  it("scrolls the sheet to the latest turn when it opens and when a turn arrives", async () => {
    const scrollTo = vi.fn();
    vi.spyOn(Element.prototype, "scrollTo").mockImplementation(scrollTo);
    try {
      const { emit } = await setup({ k1: [turn({ status: "done", answer: "a", endedAt: "2026-10-06T10:00:01+09:00" })] });
      await screen.findByText("a");
      await waitFor(() => expect(scrollTo).toHaveBeenCalled());
      scrollTo.mockClear();
      act(() => emit({ type: "ask.started", turn: turn({ id: "t2", question: "q2" }) }));
      await screen.findByText("Thinking");
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("when a turn ends, refocuses the input only if focus was on the body", async () => {
    const { emit } = await setup({ k1: [turn({})] });
    const input = await screen.findByPlaceholderText("Ask about this artifact…");
    input.blur();
    expect(document.activeElement).toBe(document.body);
    act(() => emit({ type: "ask.done", turn: turn({ status: "done", answer: "a", endedAt: "2026-10-06T10:00:01+09:00" }) }));
    await waitFor(() => expect(document.activeElement).toBe(input));

    act(() => emit({ type: "ask.started", turn: turn({ id: "t2", question: "q2" }) }));
    await screen.findByText("Thinking");
    const other = document.createElement("input");
    document.body.appendChild(other);
    try {
      other.focus();
      expect(document.activeElement).toBe(other);
      act(() => emit({ type: "ask.done", turn: turn({ id: "t2", question: "q2", status: "done", answer: "b", endedAt: "2026-10-06T10:00:02+09:00" }) }));
      await screen.findByText("b");
      expect(document.activeElement).toBe(other);
    } finally {
      other.remove();
    }
  });

  it("puts a finished turn's question at the top of the sheet instead of the end of its answer", async () => {
    const scrollTo = vi.fn();
    const scrollIntoView = vi.fn();
    vi.spyOn(Element.prototype, "scrollTo").mockImplementation(scrollTo);
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(scrollIntoView);
    try {
      const { emit } = await setup({ k1: [turn({ status: "done", answer: "a", endedAt: "2026-10-06T10:00:01+09:00" })] });
      await screen.findByText("a");
      act(() => emit({ type: "ask.started", turn: turn({ id: "t2", question: "q2" }) }));
      await screen.findByText("Thinking");
      // Thinking still sticks to the bottom.
      expect(scrollTo).toHaveBeenCalled();
      expect(scrollIntoView).not.toHaveBeenCalled();
      scrollTo.mockClear();
      act(() => emit({ type: "ask.done", turn: turn({ id: "t2", question: "q2", status: "done", answer: "long answer", endedAt: "2026-10-06T10:00:02+09:00" }) }));
      await screen.findByText("long answer");
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: "start" }));
      expect(scrollIntoView.mock.contexts[0]).toBe(document.querySelector('[data-turn-id="t2"]'));
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("streams the answer so far with what the agent is doing, then follows to the end instead of jumping back", async () => {
    const scrollTo = vi.fn();
    const scrollIntoView = vi.fn();
    vi.spyOn(Element.prototype, "scrollTo").mockImplementation(scrollTo);
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(scrollIntoView);
    try {
      const { emit } = await setup({ k1: [turn({})] });
      await screen.findByText("Thinking");
      act(() => emit({ type: "ask.progress", id: "t1", scope, answer: "", activity: "Read · doc.html" }));
      expect(await screen.findByText("Read · doc.html")).toBeInTheDocument();
      expect(screen.queryByText("Thinking")).toBeNull();
      scrollTo.mockClear();
      act(() => emit({ type: "ask.progress", id: "t1", scope, answer: "| a | b |\n|---|---|\n| **1** | 2 |", activity: null }));
      expect((await screen.findByText("1")).tagName).toBe("STRONG");
      expect(screen.getByText("Thinking")).toBeInTheDocument();
      expect(scrollTo).toHaveBeenCalled();
      act(() => emit({ type: "ask.done", turn: turn({ status: "done", answer: "| a | b |\n|---|---|\n| **1** | 2 |", endedAt: "2026-10-06T10:00:02+09:00" }) }));
      await waitFor(() => expect(screen.queryByText("Thinking")).toBeNull());
      expect(screen.getByRole("button", { name: "Copy answer" })).toBeInTheDocument();
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("the input grows with its text up to about five lines, rounds less when taller, and shrinks after send", async () => {
    let height = 20;
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
    try {
      await setup();
      const input = (await screen.findByPlaceholderText("Ask about this artifact…")) as HTMLTextAreaElement;
      // The textarea's row sits in the bordered bar, under the attached images when there are any.
      const pill = input.parentElement!.parentElement!;
      expect(input.style.height).toBe("20px");
      expect(pill).toHaveClass("rounded-full");
      // Focus is ink, not the thread red the send button uses.
      expect(pill).toHaveClass("focus-within:border-ink/60");
      expect(pill.className).not.toMatch(/focus-within:[\w-]+-primary/);
      height = 60;
      fireEvent.change(input, { target: { value: "one\ntwo\nthree" } });
      expect(input.style.height).toBe("60px");
      expect(pill).toHaveClass("rounded-[20px]");
      expect(pill).not.toHaveClass("rounded-full");
      height = 400;
      fireEvent.change(input, { target: { value: "lots\n".repeat(20) } });
      expect(input.style.height).toBe("128px");
      height = 20;
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(input.value).toBe(""));
      expect(input.style.height).toBe("20px");
      expect(pill).toHaveClass("rounded-full");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("pasted, dropped or picked images upload at once, go out with the question, and show on it", async () => {
    const createObjectURL = vi.fn(() => "blob:preview");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const { client } = await setup();
    const input = await screen.findByPlaceholderText("Ask about this artifact…");
    const shot = new File(["png"], "shot.png", { type: "image/png" });
    fireEvent.paste(input, { clipboardData: { files: [shot] } });
    await waitFor(() => expect(client.uploadAskImage).toHaveBeenCalledWith(shot));
    expect(await screen.findByRole("img", { name: "shot.png" })).toHaveAttribute("src", "blob:preview");
    const drop = new File(["gif"], "drop.gif", { type: "image/gif" });
    const svg = new File(["<svg/>"], "x.svg", { type: "image/svg+xml" });
    fireEvent.drop(input, { dataTransfer: { files: [drop, svg], types: ["Files"] } });
    await screen.findByRole("img", { name: "drop.gif" });
    expect(screen.queryByRole("img", { name: "x.svg" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove drop.gif" }));
    expect(screen.queryByRole("img", { name: "drop.gif" })).toBeNull();
    fireEvent.change(input, { target: { value: "이 화면 뭐야?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith(expect.objectContaining({ question: "이 화면 뭐야?", images: ["img-shot.png"] })));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Attached images" })).toBeNull());
    expect(await screen.findByRole("button", { name: "Open image" })).toBeInTheDocument();
    expect(document.querySelector('img[src$="/_asks/images/img-shot.png"]')).not.toBeNull();
  });

  it("a failed upload shows on its thumbnail and holds the question until it's removed", async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:p"), revokeObjectURL: vi.fn() });
    const { client } = await setup();
    client.uploadAskImage.mockRejectedValueOnce(new RoomsApiError(400, "Only PNG, JPEG, GIF and WebP images can be attached", "bad_request"));
    const input = await screen.findByPlaceholderText("Ask about this artifact…");
    fireEvent.paste(input, { clipboardData: { files: [new File(["x"], "bad.png", { type: "image/png" })] } });
    expect(await screen.findByLabelText("Only PNG, JPEG, GIF and WebP images can be attached")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "q" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Remove the images that couldn't be attached")).toBeInTheDocument();
    expect(client.startAsk).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove bad.png" }));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith(expect.not.objectContaining({ images: expect.anything() })));
  });

  it("shows quotes waiting above the input and on the asked question", async () => {
    const { emit } = await setup();
    act(() => store.addQuote({ kind: "doc", fileKey: "k1" }, "첫 인용\n둘째 줄"));
    act(() => store.addQuote({ kind: "doc", fileKey: "k1" }, "  다른 인용  "));
    act(() => store.addQuote({ kind: "doc", fileKey: "k1" }, "다른 인용"));
    const chips = await screen.findByRole("list", { name: "Quoted text" });
    expect(chips.querySelectorAll("li")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove quote" })[1]);
    expect(chips.querySelectorAll("li")).toHaveLength(1);
    act(() => emit({ type: "ask.started", turn: turn({ question: "> 첫 인용\n> 둘째 줄\n\n뭐야?" }) }));
    const bubbleQuote = await screen.findByText(/첫 인용/, { selector: "div.line-clamp-3" });
    expect(bubbleQuote.textContent).toBe("첫 인용\n둘째 줄");
    expect(screen.getByText("뭐야?")).toBeInTheDocument();
  });

  it("while an answer runs, Enter queues the question and it goes out when the answer ends", async () => {
    const { client, emit } = await setup({ k1: [turn({})] });
    const input = (await screen.findByPlaceholderText("Ask about this artifact…")) as HTMLTextAreaElement;
    await screen.findByText("Thinking");
    expect(input.readOnly).toBe(false);
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "다음 질문" } });
    expect(screen.getByRole("button", { name: "Queue" })).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("");
    const queued = screen.getByRole("list", { name: "Queued questions" });
    expect(queued.textContent).toContain("다음 질문");
    fireEvent.change(input, { target: { value: "그 다음" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.getByRole("list", { name: "Queued questions" }).querySelectorAll("li")).toHaveLength(2);
    expect(client.startAsk).not.toHaveBeenCalled();
    act(() => emit({ type: "ask.done", turn: turn({ status: "done", answer: "끝", endedAt: "2026-10-06T10:00:05+09:00" }) }));
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledTimes(1));
    expect(client.startAsk).toHaveBeenCalledWith(expect.objectContaining({ question: "다음 질문" }));
    // the second waits for the first's answer
    expect(screen.getByRole("list", { name: "Queued questions" }).textContent).toContain("그 다음");
  });

  it("⌘Enter stops the running answer and sends this question next", async () => {
    const { client, emit } = await setup({ k1: [turn({})] });
    const input = await screen.findByPlaceholderText("Ask about this artifact…");
    await screen.findByText("Thinking");
    fireEvent.change(input, { target: { value: "지금 바로" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    await waitFor(() => expect(client.cancelAsk).toHaveBeenCalledWith("t1"));
    act(() => emit({ type: "ask.done", turn: turn({ status: "cancelled", endedAt: "2026-10-06T10:00:05+09:00" }) }));
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith(expect.objectContaining({ question: "지금 바로" })));
  });

  it("↑ in an empty input takes the last queued question back to edit; the row buttons send now or drop", async () => {
    const { client } = await setup({ k1: [turn({})] });
    const input = (await screen.findByPlaceholderText("Ask about this artifact…")) as HTMLTextAreaElement;
    await screen.findByText("Thinking");
    for (const q of ["첫째", "둘째"]) {
      fireEvent.change(input, { target: { value: q } });
      fireEvent.keyDown(input, { key: "Enter" });
    }
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("둘째");
    expect(screen.getByRole("list", { name: "Queued questions" }).querySelectorAll("li")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove queued question" }));
    expect(screen.queryByRole("list", { name: "Queued questions" })).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(client.cancelAsk).toHaveBeenCalledWith("t1"));
  });

  it("↑ in an empty input with nothing queued brings back the last question", async () => {
    await setup({ k1: [turn({ status: "done", question: "> 인용\n\n지난 질문", answer: "a", endedAt: "2026-10-06T10:00:01+09:00" })] });
    const input = (await screen.findByPlaceholderText("Ask about this artifact…")) as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("지난 질문");
  });

  it("a fast double Enter sends once", async () => {
    const { client } = await setup();
    const input = await screen.findByPlaceholderText("Ask about this artifact…");
    fireEvent.change(input, { target: { value: "한 번만" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("Thinking");
    expect(client.startAsk).toHaveBeenCalledTimes(1);
  });

  it("loads older turns even when another client's ask event created the thread first", async () => {
    const { client, emit } = await setup({ k1: [turn({ id: "old", question: "예전 질문", status: "done", answer: "예전 답", endedAt: "2026-10-06T09:30:00+09:00" })] });
    act(() => emit({ type: "ask.started", turn: turn({ id: "new", question: "다른 창 질문" }) }));
    expect(await screen.findByText("예전 답")).toBeTruthy();
    expect(screen.getByText("다른 창 질문")).toBeTruthy();
    expect(client.askThread).toHaveBeenCalledWith(scope);
  });

  it("shows a loaded thread, failed turns with retry, and cancelled turns", async () => {
    const { client } = await setup({ k1: [
      turn({ id: "t0", question: "q0", status: "failed", error: "claude-code exited with an error (code 1)", endedAt: "2026-10-06T10:00:01+09:00" }),
      turn({ id: "t1", question: "q1", status: "cancelled", answer: "부분", endedAt: "2026-10-06T10:00:02+09:00" }),
    ] });
    const error = await screen.findByText("claude-code exited with an error (code 1)");
    expect(error.closest("p")).toHaveClass("text-error");
    expect(error.closest("p")!.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("Stopped")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toHaveClass("min-h-7", "focus-visible:outline-ink");
    fireEvent.click(retry);
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith({ scope, question: "q0", model: null }));
  });

  it("while running the send button is a Stop button that cancels; there is no Stop text link", async () => {
    const { client } = await setup({ k1: [turn({})] });
    expect(await screen.findByText("Thinking")).toBeTruthy();
    expect(screen.queryByText("Stop")).toBeNull();
    expect(screen.queryByLabelText("Send")).toBeNull();
    const stop = screen.getByLabelText("Stop") as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    expect(stop).toHaveClass("focus-visible:outline-2", "focus-visible:outline-ink");
    fireEvent.focus(stop);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Stop (Esc)");
    fireEvent.click(stop);
    expect(client.cancelAsk).toHaveBeenCalledWith("t1");
  });

  it("Escape while running cancels the turn and does not fold the sheet", async () => {
    const { client } = await setup({ k1: [turn({ answer: "" })] });
    const input = await screen.findByPlaceholderText("Ask about this artifact…");
    expect(await screen.findByText("왜?")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(client.cancelAsk).toHaveBeenCalledWith("t1");
    expect(screen.getByText("왜?")).toBeTruthy();
  });

  it("shows the API error inline and keeps the draft", async () => {
    const { client } = await setup();
    client.startAsk.mockRejectedValueOnce(new RoomsApiError(409, "Waiting for an answer", "ask_busy"));
    const input = await screen.findByPlaceholderText("Ask about this artifact…");
    fireEvent.change(input, { target: { value: "또" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Waiting for an answer")).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("또");
  });

  it("Escape folds the sheet, focusing the input unfolds it", async () => {
    await setup({ k1: [turn({ status: "done", answer: "답", endedAt: "2026-10-06T10:00:03+09:00" })] });
    const input = await screen.findByPlaceholderText("Ask about this artifact…");
    expect(await screen.findByText("답")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByText("답")).toBeNull();
    fireEvent.focus(input);
    expect(screen.getByText("답")).toBeTruthy();
  });

  it("floats over the page: an outside pointerdown or a click into the doc iframe folds the sheet; inside does not", async () => {
    const { container } = await setup({ k1: [turn({ status: "done", answer: "답", endedAt: "2026-10-06T10:00:03+09:00" })] });
    const input = await screen.findByPlaceholderText("Ask about this artifact…");
    fireEvent.pointerDown(await screen.findByText("답"));
    expect(screen.getByText("답")).toBeTruthy();
    expect(container.querySelector(".absolute")).toContainElement(screen.getByText("답"));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByText("답")).toBeNull();
    expect(input.isConnected).toBe(true);
    fireEvent.focus(input);
    expect(screen.getByText("답")).toBeTruthy();
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    try {
      frame.focus();
      expect(document.activeElement).toBe(frame);
      act(() => void window.dispatchEvent(new Event("blur")));
      expect(screen.queryByText("답")).toBeNull();
    } finally {
      frame.remove();
    }
  });

  it("with no models shows just the agent the ask goes to, from roomsd, with no menu", async () => {
    const { client } = await setup({}, false, { agent: "codex", mode: "new", models: [], scoped: false });
    expect(await screen.findByText("codex")).toBeTruthy();
    expect(client.askTarget).toHaveBeenCalledWith(scope);
    expect(screen.queryByLabelText(/^Model/)).toBeNull();
  });

  it("falls back to the doc's agent when roomsd can't say where the ask goes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const noAgent = { ...doc, source: { ...doc.source, agent: null } };
      await renderWithStores(<AskBar subject={{ kind: "doc", artifact: noAgent }} />, { rooms: [room("r1", "R")], artifacts: { r1: [noAgent] }, askTargets: { k1: new Error("down") } });
      expect(await screen.findByText("Default agent")).toBeTruthy();
      await waitFor(() => expect(warn).toHaveBeenCalled());
      expect(screen.getByText("Default agent")).toBeTruthy();
    } finally {
      warn.mockRestore();
    }
  });

  it("a model menu lists Default and the models as radio items, checks the current one, and sends the pick", async () => {
    const { client } = await setup({}, false, claude);
    const trigger = await screen.findByLabelText("Model: claude-code · Default");
    expect(trigger.textContent).toBe("claude-code · Default");
    expect(trigger).toHaveClass("min-h-7", "focus-visible:outline-ink");
    fireEvent.keyDown(trigger, { key: "Enter" });
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["Default", "Opus", "Sonnet", "Haiku", "claude-x-1"]);
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false", "false"]);
    fireEvent.click(items[2]);
    expect(await screen.findByLabelText("Model: claude-code · Sonnet")).toBeTruthy();
    const input = screen.getByPlaceholderText("Ask about this artifact…");
    fireEvent.change(input, { target: { value: "왜?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith({ scope, question: "왜?", model: "sonnet" }));
  });

  it("a pointerdown in the model menu keeps the sheet open", async () => {
    await setup({ k1: [turn({ status: "done", answer: "답", endedAt: "2026-10-06T10:00:03+09:00" })] }, false, claude);
    expect(await screen.findByText("답")).toBeTruthy();
    fireEvent.keyDown(await screen.findByLabelText(/^Model:/), { key: "Enter" });
    fireEvent.pointerDown((await screen.findAllByRole("menuitemradio"))[1]);
    expect(screen.getByText("답")).toBeTruthy();
  });

  it("remembers the pick per agent and ignores a remembered model that is no longer offered", async () => {
    localStorage.setItem("alto-rooms.askModel.claude-code", "haiku");
    localStorage.setItem("alto-rooms.askModel.codex", "gpt-6-sol");
    await setup({}, false, claude);
    const trigger = await screen.findByLabelText("Model: claude-code · Haiku");
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click((await screen.findAllByRole("menuitemradio"))[1]);
    expect(localStorage.getItem("alto-rooms.askModel.claude-code")).toBe("opus");
    expect(localStorage.getItem("alto-rooms.askModel.codex")).toBe("gpt-6-sol");
    cleanup();
    localStorage.setItem("alto-rooms.askModel.claude-code", "retired-model");
    await setup({}, false, claude);
    expect(await screen.findByLabelText("Model: claude-code · Default")).toBeTruthy();
  });

  it("retry keeps the turn's model while it is offered, else uses the picker's", async () => {
    localStorage.setItem("alto-rooms.askModel.claude-code", "haiku");
    const failed = (id: string, model: string) =>
      turn({ id, question: id, model, status: "failed", error: `err ${id}`, endedAt: "2026-10-06T10:00:01+09:00" });
    const { client, emit } = await setup({ k1: [failed("q-opus", "opus"), failed("q-gone", "retired")] }, false, claude);
    await screen.findByLabelText("Model: claude-code · Haiku");
    fireEvent.click((await screen.findAllByText("Retry"))[0]);
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith({ scope, question: "q-opus", model: "opus" }));
    act(() => emit({ type: "ask.done", turn: turn({ id: "ask-q-opus", question: "q-opus", status: "done", answer: "ok", endedAt: "2026-10-06T10:00:02+09:00" }) }));
    await screen.findByText("ok");
    fireEvent.click(screen.getAllByText("Retry")[1]);
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith({ scope, question: "q-gone", model: "haiku" }));
  });

  it("shows the turn's model in the sheet header", async () => {
    await setup({ k1: [turn({ model: "sonnet", status: "done", answer: "a", endedAt: "2026-10-06T10:00:01+09:00" })] });
    expect(await screen.findByText("claude-code · Sonnet · continuing the thread that made it")).toBeTruthy();
  });

  describe("commands", () => {
    it("typing / lists the commands; arrows pick one, Enter runs it", async () => {
      const { client } = await setup({ k1: [turn({ status: "done", answer: "a", endedAt: "2026-10-06T10:00:01+09:00" })] });
      const input = await screen.findByPlaceholderText("Ask about this artifact…");
      fireEvent.change(input, { target: { value: "/" } });
      const menu = screen.getByRole("listbox", { name: "Commands" });
      expect(Array.from(menu.querySelectorAll("[role=option]")).map((o) => o.textContent)).toEqual([
        "/newStart a new conversation", "/clearStart a new conversation", "/compactSummarize the conversation so far, and send that instead",
      ]);
      fireEvent.change(input, { target: { value: "/c" } });
      expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-selected"))).toEqual(["true", "false"]);
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith(expect.objectContaining({ kind: "compact" })));
      expect(await screen.findByText("Summarizing the conversation")).toBeTruthy();
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("/new sent as text starts over with a divider; Escape closes the menu", async () => {
      const { client } = await setup({ k1: [turn({ status: "done", answer: "a", endedAt: "2026-10-06T10:00:01+09:00" })] });
      const input = (await screen.findByPlaceholderText("Ask about this artifact…")) as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "/ne" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(input.value).toBe("");
      fireEvent.change(input, { target: { value: "/new " } });
      expect(screen.queryByRole("listbox")).toBeNull();
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith(expect.objectContaining({ kind: "clear" })));
      expect(await screen.findByRole("separator", { name: "New conversation" })).toBeTruthy();
      expect(input.value).toBe("");
      // ↑ recalls the last question, not the command
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(input.value).toBe("왜?");
    });

    it("a finished summary is a divider with the summary behind a toggle", async () => {
      await setup({ k1: [
        turn({ id: "a", status: "done", answer: "a", endedAt: "2026-10-06T10:00:01+09:00" }),
        turn({ id: "c", kind: "compact", question: "/compact", status: "done", answer: "**요약** 내용", endedAt: "2026-10-06T10:00:02+09:00" }),
      ] });
      expect(await screen.findByRole("separator", { name: "Conversation summarized" })).toBeTruthy();
      expect(screen.queryByText("요약")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Show summary" }));
      expect((await screen.findByText("요약")).tagName).toBe("STRONG");
      expect(screen.queryByText("/compact")).toBeNull();
    });

    it("says when earlier answers were left out, and offers to summarize", async () => {
      const { client } = await setup({ k1: [turn({ status: "done", answer: "a", leftOut: 3, endedAt: "2026-10-06T10:00:01+09:00" })] });
      expect(await screen.findByText(/3 earlier answers weren't sent along/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Summarize it" }));
      await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith(expect.objectContaining({ kind: "compact" })));
    });

    it("a command typed while an answer runs waits in the queue", async () => {
      const { client } = await setup({ k1: [turn({})] });
      const input = await screen.findByPlaceholderText("Ask about this artifact…");
      await screen.findByText("Thinking");
      fireEvent.change(input, { target: { value: "/new" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByRole("list", { name: "Queued questions" }).textContent).toContain("/new");
      expect(client.startAsk).not.toHaveBeenCalled();
    });

    it("shows roomsd's refusal", async () => {
      const { client } = await setup();
      client.startAsk.mockRejectedValueOnce(new RoomsApiError(400, "Nothing to clear yet", "bad_request"));
      const input = await screen.findByPlaceholderText("Ask about this artifact…");
      fireEvent.change(input, { target: { value: "/clear" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(await screen.findByText("Nothing to clear yet")).toBeTruthy();
    });
  });

  it("keeps an unsent draft per doc, across a remount", async () => {
    const first = await setup();
    const input = (await screen.findByPlaceholderText("Ask about this artifact…")) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "쓰다 만 질문" } });
    first.unmount();
    await setup();
    expect(((await screen.findByPlaceholderText("Ask about this artifact…")) as HTMLTextAreaElement).value).toBe("쓰다 만 질문");
    expect(localStorage.getItem("alto-rooms.askDraft.k1")).toBe("쓰다 만 질문");
    fireEvent.keyDown(screen.getByPlaceholderText("Ask about this artifact…"), { key: "Enter" });
    await waitFor(() => expect(localStorage.getItem("alto-rooms.askDraft.k1")).toBeNull());
  });

  it("shows the question at once, and puts it back in the input if roomsd refuses it", async () => {
    const { client } = await setup();
    let refuse: (e: Error) => void = () => {};
    client.startAsk.mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)));
    const input = (await screen.findByPlaceholderText("Ask about this artifact…")) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "바로 보여?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("바로 보여?")).toBeTruthy();
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(input.value).toBe("");
    await act(async () => refuse(new RoomsApiError(409, "Waiting for an answer", "ask_busy")));
    expect(await screen.findByText("Waiting for an answer")).toBeTruthy();
    expect(screen.queryByText("Thinking")).toBeNull();
    expect(input.value).toBe("바로 보여?");
  });
});

describe("AskBar for a room", () => {
  const roomScope: AskScope = { kind: "room", roomId: "r1" };
  const roomTurn = (extra: Partial<AskTurn>) => turn({ id: "rt1", scope: roomScope, mode: "new", ...extra });
  const setupRoom = (opts: { asks?: Record<string, AskTurn[]>; readOnly?: boolean; target?: AskTarget } = {}) =>
    renderWithStores(<AskBar subject={{ kind: "room", roomId: "r1" }} />, {
      rooms: [room("r1", "R")], artifacts: { r1: [doc] }, asks: opts.asks, readOnly: opts.readOnly,
      askTargets: opts.target ? { "room:r1": opts.target } : undefined,
    });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("asks about the room, and heads its answer with the agent and model only", async () => {
    const { client, emit } = await setupRoom();
    const input = await screen.findByPlaceholderText("Ask about this room…");
    fireEvent.change(input, { target: { value: "뭐가 있어?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith({ scope: roomScope, question: "뭐가 있어?", model: null }));
    act(() => emit({ type: "ask.done", turn: roomTurn({ id: "ask-뭐가 있어?", question: "뭐가 있어?", model: "haiku", status: "done", answer: "세 개", endedAt: "2026-10-06T10:00:09+09:00" }) }));
    expect(await screen.findByText("세 개")).toBeTruthy();
    const head = screen.getByText("claude-code · Haiku", { exact: true });
    expect(head.getAttribute("title")).toBeNull();
  });

  it("shows only the room's thread, never the doc's", async () => {
    await setupRoom({
      asks: {
        k1: [turn({ question: "doc question", status: "done", answer: "doc answer", endedAt: "2026-10-06T10:00:01+09:00" })],
        "room:r1": [roomTurn({ question: "room question", status: "done", answer: "room answer", endedAt: "2026-10-06T10:00:02+09:00" })],
      },
    });
    expect(await screen.findByText("room answer")).toBeTruthy();
    expect(screen.queryByText("doc answer")).toBeNull();
  });

  it("says the agent reads only the room's docs when roomsd scopes its reads, and nothing when it doesn't", async () => {
    const first = await setupRoom({ target: { agent: "claude-code", mode: "new", models: ["haiku"], scoped: true } });
    const hint = await screen.findByRole("button", { name: "Reads only this room's artifacts" });
    expect(hint.tabIndex).toBe(0);
    act(() => hint.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe("Reads only this room's artifacts");
    first.unmount();
    await setupRoom({ target: { agent: "codex", mode: "new", models: [], scoped: false } });
    expect(await screen.findByText("codex")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reads only this room's artifacts" })).toBeNull();
  });

  it("a room's answer keeps running while another room is shown, and is there on coming back", async () => {
    let show: (roomId: string) => void = () => {};
    function Switch() {
      const [roomId, setRoomId] = useState("r1");
      show = setRoomId;
      return <AskBar key={roomId} subject={{ kind: "room", roomId }} />;
    }
    const { client, emit } = await renderWithStores(<Switch />, { rooms: [room("r1", "A"), room("r2", "B")], artifacts: { r1: [doc], r2: [] } });
    const input = await screen.findByPlaceholderText("Ask about this room…");
    fireEvent.change(input, { target: { value: "길게?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith({ scope: roomScope, question: "길게?", model: null }));
    act(() => show("r2"));
    expect(screen.queryByText("길게?")).toBeNull();
    act(() => emit({ type: "ask.progress", id: "ask-길게?", scope: roomScope, answer: "절반", activity: null }));
    act(() => emit({ type: "ask.done", turn: roomTurn({ id: "ask-길게?", question: "길게?", status: "done", answer: "끝까지 답함", endedAt: "2026-10-06T10:00:09+09:00" }) }));
    act(() => show("r1"));
    expect(await screen.findByText("끝까지 답함")).toBeTruthy();
    expect(client.cancelAsk).not.toHaveBeenCalled();
  });

  it("renders nothing in read-only", async () => {
    await setupRoom({ readOnly: true });
    expect(screen.queryByPlaceholderText("Ask about this room…")).toBeNull();
  });
});

describe("AskBar for a day", () => {
  const monday: AskScope = { kind: "day", date: "2026-10-05" };
  const dayTurn = (extra: Partial<AskTurn>) => turn({ id: "dt1", scope: monday, mode: "new", ...extra });
  let show: (date: string) => void = () => {};
  /** The Journal tab keeps one bar mounted and hands it the viewed date. */
  function Journal() {
    const [date, setDate] = useState("2026-10-05");
    show = setDate;
    return <AskBar subject={{ kind: "day", date }} />;
  }
  const setupDays = (asks: Record<string, AskTurn[]> = {}) =>
    renderWithStores(<Journal />, { rooms: [room("r1", "R")], artifacts: { r1: [doc] }, asks });
  const input = () => screen.getByPlaceholderText("Ask about this day…") as HTMLTextAreaElement;

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("follows the viewed date to that day's own thread and draft", async () => {
    await setupDays({
      "day:2026-10-06": [turn({ id: "dt2", scope: { kind: "day", date: "2026-10-06" }, question: "화요일?", status: "done", answer: "화요일 답", endedAt: "2026-10-06T10:00:01+09:00" })],
    });
    fireEvent.change(await screen.findByPlaceholderText("Ask about this day…"), { target: { value: "월요일 초안" } });
    act(() => show("2026-10-06"));
    expect(await screen.findByText("화요일 답")).toBeTruthy();
    expect(input().value).toBe("");
    fireEvent.change(input(), { target: { value: "화요일 초안" } });
    act(() => show("2026-10-05"));
    expect(input().value).toBe("월요일 초안");
    expect(screen.queryByText("화요일 답")).toBeNull();
    expect(localStorage.getItem("alto-rooms.askDraft.day:2026-10-05")).toBe("월요일 초안");
    expect(localStorage.getItem("alto-rooms.askDraft.day:2026-10-06")).toBe("화요일 초안");
  });

  it("a question on its way stays with its day, and its answer keeps running while another day is shown", async () => {
    const { client, emit } = await setupDays();
    let accept: () => void = () => {};
    client.startAsk.mockImplementationOnce(() => new Promise((resolve) => (accept = () => resolve(dayTurn({ id: "ask-월요일?", question: "월요일?" })))));
    fireEvent.change(await screen.findByPlaceholderText("Ask about this day…"), { target: { value: "월요일?" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(await screen.findByText("Thinking")).toBeTruthy();
    act(() => show("2026-10-06"));
    expect(screen.queryByText("월요일?")).toBeNull();
    expect(screen.queryByText("Thinking")).toBeNull();
    await act(async () => accept());
    act(() => emit({ type: "ask.progress", id: "ask-월요일?", scope: monday, answer: "절반", activity: null }));
    expect(screen.queryByText("절반")).toBeNull();
    act(() => emit({ type: "ask.done", turn: dayTurn({ id: "ask-월요일?", question: "월요일?", status: "done", answer: "월요일 답", endedAt: "2026-10-06T10:00:09+09:00" }) }));
    act(() => show("2026-10-05"));
    expect(await screen.findByText("월요일 답")).toBeTruthy();
    expect(client.startAsk).toHaveBeenCalledWith({ scope: monday, question: "월요일?", model: null });
    expect(client.cancelAsk).not.toHaveBeenCalled();
  });

  it("a question roomsd refuses after the day changed comes back in its own day's input", async () => {
    const { client } = await setupDays();
    let refuse: (e: Error) => void = () => {};
    client.startAsk.mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)));
    fireEvent.change(await screen.findByPlaceholderText("Ask about this day…"), { target: { value: "월요일?" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input().value).toBe("");
    act(() => show("2026-10-06"));
    await act(async () => refuse(new RoomsApiError(409, "Waiting for an answer", "ask_busy")));
    expect(input().value).toBe("");
    act(() => show("2026-10-05"));
    expect(input().value).toBe("월요일?");
  });
});

describe("AskBar for a session", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  const session = (agent: "aside" | "codex"): Conversation => ({
    id: { agent, session: "S1" }, title: "t", cwd: null, startedAt: "", endedAt: "", messages: 2, lastReply: null, artifactsWritten: [], roomId: null,
  });

  it("says under the bar that an Aside session's asks continue it; a Codex session says nothing", async () => {
    const target: AskTarget = { agent: "aside", mode: "resume", models: [], scoped: false };
    const first = await renderWithStores(<AskBar subject={{ kind: "conversation", conversation: session("aside") }} />, {
      rooms: [room("r1", "R")], askTargets: { "conversation:aside:S1": target },
    });
    expect(await screen.findByText("Asks continue this Aside session; it can use the browser.")).toBeTruthy();
    first.unmount();
    await renderWithStores(<AskBar subject={{ kind: "conversation", conversation: session("codex") }} />, { rooms: [room("r1", "R")] });
    await screen.findByPlaceholderText("Ask about this session…");
    expect(screen.queryByText(/continue this Aside session/)).toBeNull();
  });
});
