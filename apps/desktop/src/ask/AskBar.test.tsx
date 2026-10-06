import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Artifact, AskTurn } from "@alto-rooms/protocol-ts";
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
  id: "t1", fileKey: "k1", question: "왜?", answer: "", agent: "claude-code", mode: "resume", status: "running",
  error: null, startedAt: "2026-10-06T10:00:00+09:00", endedAt: null, ...extra,
});

let store: ReturnType<typeof useAsksStore>;
function Grab() { store = useAsksStore(); return null; }

async function setup(asks: Record<string, AskTurn[]> = {}, readOnly = false) {
  return renderWithStores(<><Grab /><AskBar artifact={doc} /></>, { rooms: [room("r1", "R")], artifacts: { r1: [doc] }, asks, readOnly });
}

describe("AskBar", () => {
  afterEach(cleanup);

  it("renders nothing until toggled, then focuses the input", async () => {
    await setup();
    expect(screen.queryByPlaceholderText("이 문서에 대해 묻기…")).toBeNull();
    act(() => store.toggle());
    const input = await screen.findByPlaceholderText("이 문서에 대해 묻기…");
    expect(document.activeElement).toBe(input);
    expect(screen.getByText("claude-code")).toBeTruthy();
  });

  it("renders nothing in read-only", async () => {
    await setup({}, true);
    act(() => store.toggle());
    expect(screen.queryByPlaceholderText("이 문서에 대해 묻기…")).toBeNull();
  });

  it("sends on Enter (not Shift+Enter, not while composing), shows waiting, then the markdown answer", async () => {
    const { client, emit } = await setup();
    act(() => store.toggle());
    const input = await screen.findByPlaceholderText("이 문서에 대해 묻기…");
    fireEvent.change(input, { target: { value: "왜?" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(client.startAsk).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith({ roomId: "r1", artifactId: "a1", question: "왜?" }));
    expect(await screen.findByText("claude-code가 답을 쓰고 있어요…")).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("");
    expect((input as HTMLTextAreaElement).disabled).toBe(true);
    act(() => emit({ type: "ask.done", turn: turn({ id: "ask-왜?", status: "done", answer: "**굵게** 답", endedAt: "2026-10-06T10:00:12+09:00" }) }));
    expect((await screen.findByText("굵게")).tagName).toBe("STRONG");
    expect(screen.getByText(/12초/)).toBeTruthy();
    expect(screen.getByText("claude-code · 만든 대화에 이어서")).toBeTruthy();
  });

  it("shows a loaded thread, failed turns with retry, and cancelled turns", async () => {
    const { client } = await setup({ k1: [
      turn({ id: "t0", question: "q0", status: "failed", error: "claude-code가 오류로 끝났어요 (code 1)", endedAt: "2026-10-06T10:00:01+09:00" }),
      turn({ id: "t1", question: "q1", status: "cancelled", answer: "부분", endedAt: "2026-10-06T10:00:02+09:00" }),
    ] });
    act(() => store.toggle());
    expect(await screen.findByText("claude-code가 오류로 끝났어요 (code 1)")).toBeTruthy();
    expect(screen.getByText("멈췄어요")).toBeTruthy();
    fireEvent.click(screen.getByText("다시 묻기"));
    await waitFor(() => expect(client.startAsk).toHaveBeenCalledWith({ roomId: "r1", artifactId: "a1", question: "q0" }));
  });

  it("stop button cancels the running turn", async () => {
    const { client } = await setup({ k1: [turn({})] });
    act(() => store.toggle());
    fireEvent.click(await screen.findByText("멈추기"));
    expect(client.cancelAsk).toHaveBeenCalledWith("t1");
  });

  it("shows the API error inline and keeps the draft", async () => {
    const { client } = await setup();
    client.startAsk.mockRejectedValueOnce(new RoomsApiError(409, "답을 기다리는 중이에요", "ask_busy"));
    act(() => store.toggle());
    const input = await screen.findByPlaceholderText("이 문서에 대해 묻기…");
    fireEvent.change(input, { target: { value: "또" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("답을 기다리는 중이에요")).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("또");
  });

  it("Escape folds the sheet, focusing the input unfolds it", async () => {
    await setup({ k1: [turn({ status: "done", answer: "답", endedAt: "2026-10-06T10:00:03+09:00" })] });
    act(() => store.toggle());
    const input = await screen.findByPlaceholderText("이 문서에 대해 묻기…");
    expect(await screen.findByText("답")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByText("답")).toBeNull();
    fireEvent.focus(input);
    expect(screen.getByText("답")).toBeTruthy();
  });

  it("renders links and images as plain text", async () => {
    await setup({ k1: [turn({ status: "done", answer: "[문서](https://x.dev) ![그림](https://x.dev/a.png) **굵게**", endedAt: "2026-10-06T10:00:03+09:00" })] });
    act(() => store.toggle());
    expect(await screen.findByText("굵게")).toBeTruthy();
    const sheet = screen.getByText("굵게").closest("div")!;
    expect(sheet.querySelector("a")).toBeNull();
    expect(sheet.querySelector("img")).toBeNull();
    expect(sheet.textContent).toContain("문서 (https://x.dev)");
    expect(sheet.textContent).toContain("그림");
    expect(screen.getByText("굵게").tagName).toBe("STRONG");
  });
});
