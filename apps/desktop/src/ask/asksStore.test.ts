import { describe, expect, it, vi } from "vitest";
import type { AskTurn, RoomsEvent } from "@alto-rooms/protocol-ts";
import { AsksStore, upsert } from "./asksStore";

type EventInput = RoomsEvent extends infer T ? (T extends RoomsEvent ? Omit<T, "seq"> : never) : never;

const turn = (id: string, status: AskTurn["status"], extra: Partial<AskTurn> = {}): AskTurn => ({
  id, fileKey: "k1", question: "q", answer: "", agent: "claude-code", mode: "resume", status,
  error: null, startedAt: "2026-10-06T10:00:00+09:00", endedAt: null, ...extra,
});

function setup(thread: AskTurn[] = []) {
  let signal: (type: RoomsEvent["type"], e: RoomsEvent) => void = () => {};
  const client = {
    startAsk: vi.fn(async () => turn("t1", "running")),
    askThread: vi.fn(async () => thread),
    cancelAsk: vi.fn(async () => {}),
  };
  const store = new AsksStore(client, { onSignal: (fn) => ((signal = fn), () => {}) });
  store.start();
  const emit = (e: EventInput) => signal(e.type, { ...e, seq: 1 } as RoomsEvent);
  return { store, client, emit };
}

describe("upsert", () => {
  it("adds, replaces, and never turns a finished turn back to running", () => {
    const a = upsert([], turn("a", "running"));
    const done = upsert(a, turn("a", "done", { answer: "x" }));
    expect(done).toEqual([turn("a", "done", { answer: "x" })]);
    expect(upsert(done, turn("a", "running"))).toBe(done);
  });
});

describe("AsksStore", () => {
  it("starts closed and toggles", () => {
    const { store } = setup();
    expect(store.getState().open).toBe(false);
    store.toggle();
    expect(store.getState().open).toBe(true);
  });

  it("loads a thread and applies ask events for that file key", async () => {
    const { store, emit } = setup([turn("t0", "done", { answer: "old" })]);
    await store.load("k1");
    emit({ type: "ask.started", turn: turn("t1", "running") });
    emit({ type: "ask.done", turn: turn("t1", "done", { answer: "new" }) });
    expect(store.getState().threads.k1.turns.map((t) => [t.id, t.status, t.answer])).toEqual([
      ["t0", "done", "old"],
      ["t1", "done", "new"],
    ]);
  });

  it("ask.done before the 202 stays done", async () => {
    const { store, client, emit } = setup();
    let resolve!: (t: AskTurn) => void;
    client.startAsk.mockImplementationOnce(() => new Promise<AskTurn>((r) => (resolve = r)));
    const p = store.ask({ roomId: "r", artifactId: "a" }, "q");
    emit({ type: "ask.done", turn: turn("t1", "failed", { error: "boom" }) });
    resolve(turn("t1", "running"));
    await p;
    expect(store.getState().threads.k1.turns[0].status).toBe("failed");
    expect(client.startAsk).toHaveBeenCalledWith({ roomId: "r", artifactId: "a", question: "q" });
  });

  it("a load that races an event keeps the newer state", async () => {
    const { store, client, emit } = setup();
    let resolve!: (t: AskTurn[]) => void;
    client.askThread.mockImplementationOnce(() => new Promise<AskTurn[]>((r) => (resolve = r)));
    const p = store.load("k1");
    emit({ type: "ask.done", turn: turn("t1", "done", { answer: "a" }) });
    resolve([turn("t1", "running")]);
    await p;
    expect(store.getState().threads.k1.turns[0].status).toBe("done");
  });

  it("marks load errors and reloads loaded threads on resync", async () => {
    const { store, client, emit } = setup();
    client.askThread.mockRejectedValueOnce(new Error("x"));
    await store.load("k1");
    expect(store.getState().threads.k1.error).toBe(true);
    emit({ type: "resync", roomId: null });
    await vi.waitFor(() => expect(store.getState().threads.k1.error).toBe(false));
    expect(client.askThread).toHaveBeenCalledTimes(2);
  });

  it("ask() rethrows API errors for the bar to show", async () => {
    const { store, client } = setup();
    client.startAsk.mockRejectedValueOnce(new Error("busy"));
    await expect(store.ask({ roomId: "r", artifactId: "a" }, "q")).rejects.toThrow("busy");
  });

  it("cancel calls the client and swallows errors", () => {
    const { store, client } = setup();
    client.cancelAsk.mockRejectedValueOnce(new Error("gone"));
    store.cancel("t1");
    expect(client.cancelAsk).toHaveBeenCalledWith("t1");
  });
});
