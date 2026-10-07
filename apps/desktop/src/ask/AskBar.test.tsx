import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Artifact, AskTarget, AskTurn } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { useAsksStore } from "@/data/hooks";
import { renderWithStores, room } from "@/test/fakes";
import { AskBar } from "./AskBar";

const doc: Artifact = {
  id: "a1", roomId: "r1", relPath: "doc.html", title: "Doc", createdAt: "2026-10-06T09:00:00+09:00",
  updatedAt: "2026-10-06T09:00:00+09:00", author: "agent", fileKey: "k1",
  source: { agent: "claude-code", session: "S1", cwd: null, machine: null },
};
const turn = (extra: Partial<AskTurn>): AskTurn => ({
  id: "t1", fileKey: "k1", question: "왜?", answer: "", agent: "claude-code", model: null, mode: "resume", status: "running",
  error: null, startedAt: "2026-10-06T10:00:00+09:00", endedAt: null, ...extra,
});

let store: ReturnType<typeof useAsksStore>;
function Grab() { store = useAsksStore(); return null; }

async function setup(asks: Record<string, AskTurn[]> = {}, readOnly = false, target?: AskTarget) {
  const askTargets = target ? { a1: target } : undefined;
  return renderWithStores(<><Grab /><AskBar artifact={doc} /></>, { rooms: [room("r1", "R")], artifacts: { r1: [doc] }, asks, readOnly, askTargets });
}

const claude: AskTarget = { agent: "claude-code", mode: "resume", models: ["opus", "sonnet", "haiku", "claude-x-1"] };

describe("AskBar", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("is open on mount without taking focus; toggling off hides it, toggling on focuses it", async () => {
    await setup();
    const first = await screen.findByPlaceholderText("Ask about this doc…");
    expect(document.activeElement).not.toBe(first);
    expect(await screen.findByText("claude-code")).toBeTruthy();
    act(() => store.toggle());
    expect(screen.queryByPlaceholderText("Ask about this doc…")).toBeNull();
    act(() => store.toggle());
    const input = await screen.findByPlaceholderText("Ask about this doc…");
    expect(document.activeElement).toBe(input);
  });

  it("renders nothing in read-only", async () => {
    await setup({}, true);
    expect(screen.queryByPlaceholderText("Ask about this doc…")).toBeNull();
  });

  it("sends on Enter (not Shift+Enter, not while composing), shows waiting, then the markdown answer", async () => {
    const { client, emit } = await setup();
    const input = await screen.findByPlaceholderText("Ask about this doc…");
    fireEvent.change(input, { target: { value: "왜?" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(client.startAsk).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith({ roomId: "r1", artifactId: "a1", question: "왜?", model: null }));
    expect(await screen.findByText("Thinking")).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("");
    // readOnly, not disabled: Esc still folds the sheet and focus stays in the bar
    expect((input as HTMLTextAreaElement).disabled).toBe(false);
    expect((input as HTMLTextAreaElement).readOnly).toBe(true);
    input.blur();
    act(() => emit({ type: "ask.done", turn: turn({ id: "ask-왜?", status: "done", answer: "**굵게** 답", endedAt: "2026-10-06T10:00:12+09:00" }) }));
    expect((await screen.findByText("굵게")).tagName).toBe("STRONG");
    expect((input as HTMLTextAreaElement).readOnly).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(screen.getByText(/12s/)).toBeTruthy();
    expect(screen.getByText("claude-code · continuing the thread that made it")).toBeTruthy();
  });

  it("says so when a new conversation was started because the thread couldn't be found", async () => {
    await setup({ k1: [turn({ mode: "new", status: "done", answer: "a", endedAt: "2026-10-06T10:00:01+09:00" })] });
    expect(await screen.findByText("claude-code · new conversation — couldn't find the thread that made this doc")).toBeTruthy();
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
    const input = await screen.findByPlaceholderText("Ask about this doc…");
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

  it("a fast double Enter sends once", async () => {
    const { client } = await setup();
    const input = await screen.findByPlaceholderText("Ask about this doc…");
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
    expect(client.askThread).toHaveBeenCalledWith("k1");
  });

  it("shows a loaded thread, failed turns with retry, and cancelled turns", async () => {
    const { client } = await setup({ k1: [
      turn({ id: "t0", question: "q0", status: "failed", error: "claude-code exited with an error (code 1)", endedAt: "2026-10-06T10:00:01+09:00" }),
      turn({ id: "t1", question: "q1", status: "cancelled", answer: "부분", endedAt: "2026-10-06T10:00:02+09:00" }),
    ] });
    expect(await screen.findByText("claude-code exited with an error (code 1)")).toBeTruthy();
    expect(screen.getByText("Stopped")).toBeTruthy();
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith({ roomId: "r1", artifactId: "a1", question: "q0", model: null }));
  });

  it("while running the send button is a Stop button that cancels; there is no Stop text link", async () => {
    const { client } = await setup({ k1: [turn({})] });
    expect(await screen.findByText(/esc to interrupt/)).toBeTruthy();
    expect(screen.queryByText("Stop")).toBeNull();
    expect(screen.queryByLabelText("Send")).toBeNull();
    const stop = screen.getByLabelText("Stop") as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    fireEvent.click(stop);
    expect(client.cancelAsk).toHaveBeenCalledWith("t1");
  });

  it("Escape while running cancels the turn and does not fold the sheet", async () => {
    const { client } = await setup({ k1: [turn({ answer: "" })] });
    const input = await screen.findByPlaceholderText("Ask about this doc…");
    expect(await screen.findByText("왜?")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(client.cancelAsk).toHaveBeenCalledWith("t1");
    expect(screen.getByText("왜?")).toBeTruthy();
  });

  it("shows the API error inline and keeps the draft", async () => {
    const { client } = await setup();
    client.startAsk.mockRejectedValueOnce(new RoomsApiError(409, "Waiting for an answer", "ask_busy"));
    const input = await screen.findByPlaceholderText("Ask about this doc…");
    fireEvent.change(input, { target: { value: "또" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Waiting for an answer")).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("또");
  });

  it("Escape folds the sheet, focusing the input unfolds it", async () => {
    await setup({ k1: [turn({ status: "done", answer: "답", endedAt: "2026-10-06T10:00:03+09:00" })] });
    const input = await screen.findByPlaceholderText("Ask about this doc…");
    expect(await screen.findByText("답")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByText("답")).toBeNull();
    fireEvent.focus(input);
    expect(screen.getByText("답")).toBeTruthy();
  });

  it("an outside pointerdown or a click into the doc iframe folds the sheet; inside does not", async () => {
    await setup({ k1: [turn({ status: "done", answer: "답", endedAt: "2026-10-06T10:00:03+09:00" })] });
    const input = await screen.findByPlaceholderText("Ask about this doc…");
    fireEvent.pointerDown(await screen.findByText("답"));
    expect(screen.getByText("답")).toBeTruthy();
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
    const { client } = await setup({}, false, { agent: "codex", mode: "new", models: [] });
    expect(await screen.findByText("codex")).toBeTruthy();
    expect(client.askTarget).toHaveBeenCalledWith("r1", "a1");
    expect(screen.queryByLabelText("Model")).toBeNull();
  });

  it("a model menu lists Default and the models, checks the current one, and sends the pick", async () => {
    const { client } = await setup({}, false, claude);
    const trigger = await screen.findByLabelText("Model");
    expect(trigger.textContent).toBe("claude-code · Default");
    fireEvent.keyDown(trigger, { key: "Enter" });
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Default", "Opus", "Sonnet", "Haiku", "claude-x-1"]);
    expect(items[0].querySelector("[aria-label=Current]")).toBeTruthy();
    expect(items[2].querySelector("[aria-label=Current]")).toBeNull();
    fireEvent.click(items[2]);
    await waitFor(() => expect(screen.getByLabelText("Model").textContent).toBe("claude-code · Sonnet"));
    const input = screen.getByPlaceholderText("Ask about this doc…");
    fireEvent.change(input, { target: { value: "왜?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith({ roomId: "r1", artifactId: "a1", question: "왜?", model: "sonnet" }));
  });

  it("remembers the pick per agent and ignores a remembered model that is no longer offered", async () => {
    localStorage.setItem("alto-rooms.askModel.claude-code", "haiku");
    localStorage.setItem("alto-rooms.askModel.codex", "gpt-6-sol");
    await setup({}, false, claude);
    const trigger = await screen.findByLabelText("Model");
    expect(trigger.textContent).toBe("claude-code · Haiku");
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click((await screen.findAllByRole("menuitem"))[1]);
    expect(localStorage.getItem("alto-rooms.askModel.claude-code")).toBe("opus");
    expect(localStorage.getItem("alto-rooms.askModel.codex")).toBe("gpt-6-sol");
    cleanup();
    localStorage.setItem("alto-rooms.askModel.claude-code", "retired-model");
    await setup({}, false, claude);
    expect((await screen.findByLabelText("Model")).textContent).toBe("claude-code · Default");
  });

  it("shows the turn's model in the sheet header", async () => {
    await setup({ k1: [turn({ model: "sonnet", status: "done", answer: "a", endedAt: "2026-10-06T10:00:01+09:00" })] });
    expect(await screen.findByText("claude-code · Sonnet · continuing the thread that made it")).toBeTruthy();
  });
});
