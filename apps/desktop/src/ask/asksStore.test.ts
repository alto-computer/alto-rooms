import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskTarget, AskTurn, RoomsEvent } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { AsksStore, MAX_THREADS, STALE_MS, STOP_CHECK_MS, upsert } from "./asksStore";

type EventInput = RoomsEvent extends infer T ? (T extends RoomsEvent ? Omit<T, "seq"> : never) : never;

const turn = (id: string, status: AskTurn["status"], extra: Partial<AskTurn> = {}): AskTurn => ({
  id, fileKey: "k1", question: "q", answer: "", agent: "claude-code", model: null, mode: "resume", status,
  error: null, startedAt: "2026-10-06T10:00:00+09:00", endedAt: null, images: [], kind: "question", leftOut: 0, ...extra,
});

function setup(thread: AskTurn[] = []) {
  let signal: (type: RoomsEvent["type"], e: RoomsEvent) => void = () => {};
  const client = {
    startAsk: vi.fn(async () => turn("t1", "running")),
    askThread: vi.fn(async () => thread),
    askTarget: vi.fn(async (): Promise<AskTarget> => ({ agent: "codex", mode: "new", models: ["gpt-6-sol"] })),
    cancelAsk: vi.fn(async () => {}),
    uploadAskImage: vi.fn(async () => ({ id: "img.png" })),
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
  it("keeps the most recently touched threads and never drops a running one", () => {
    const { store, emit } = setup();
    emit({ type: "ask.started", turn: turn("busy", "running", { fileKey: "busy" }) });
    for (let i = 0; i < MAX_THREADS + 5; i++) emit({ type: "ask.done", turn: turn(`t${i}`, "done", { fileKey: `f${i}` }) });
    const keys = Object.keys(store.getState().threads);
    expect(keys).toHaveLength(MAX_THREADS);
    expect(keys).toContain("busy");
    expect(keys).toContain(`f${MAX_THREADS + 4}`);
    expect(keys).not.toContain("f0");
  });

  it("never drops a thread an ask bar holds, until it lets go", () => {
    const { store, emit } = setup();
    emit({ type: "ask.done", turn: turn("seen", "done", { fileKey: "seen" }) });
    const release = store.hold("seen");
    for (let i = 0; i < MAX_THREADS + 5; i++) emit({ type: "ask.done", turn: turn(`t${i}`, "done", { fileKey: `f${i}` }) });
    expect(Object.keys(store.getState().threads)).toContain("seen");
    release();
    emit({ type: "ask.done", turn: turn("last", "done", { fileKey: "last" }) });
    expect(Object.keys(store.getState().threads)).not.toContain("seen");
  });

  it("keeps a running turn's progress until it finishes, and drops late progress", () => {
    const { store, emit } = setup();
    emit({ type: "ask.started", turn: turn("t1", "running") });
    emit({ type: "ask.progress", id: "t1", fileKey: "k1", answer: "표는", activity: null });
    emit({ type: "ask.progress", id: "t1", fileKey: "k1", answer: "", activity: "Read · doc.html" });
    expect(store.getState().live.t1).toEqual({ answer: "", activity: "Read · doc.html" });
    emit({ type: "ask.done", turn: turn("t1", "done", { answer: "표는 이래요" }) });
    expect(store.getState().live).toEqual({});
    emit({ type: "ask.progress", id: "t1", fileKey: "k1", answer: "late", activity: null });
    expect(store.getState().live).toEqual({});
  });

  it("queues questions behind a running answer and sends them one per finished answer", async () => {
    const { store, client, emit } = setup();
    const a = { roomId: "r", artifactId: "a", fileKey: "k1" };
    emit({ type: "ask.started", turn: turn("t1", "running") });
    store.enqueue(a, "second", null);
    store.enqueue(a, "third", "opus", ["img.png"]);
    expect(store.getState().queues.k1.map((q) => q.text)).toEqual(["second", "third"]);
    expect(client.startAsk).not.toHaveBeenCalled();
    client.startAsk.mockResolvedValueOnce(turn("t2", "running"));
    emit({ type: "ask.done", turn: turn("t1", "done") });
    await vi.waitFor(() => expect(client.startAsk).toHaveBeenCalledTimes(1));
    expect(client.startAsk).toHaveBeenLastCalledWith({ roomId: "r", artifactId: "a", question: "second", model: null });
    await vi.waitFor(() => expect(store.getState().queues.k1.map((q) => q.text)).toEqual(["third"]));
    client.startAsk.mockResolvedValueOnce(turn("t3", "running"));
    emit({ type: "ask.done", turn: turn("t2", "cancelled") });
    await vi.waitFor(() => expect(client.startAsk).toHaveBeenLastCalledWith({ roomId: "r", artifactId: "a", question: "third", model: "opus", images: ["img.png"] }));
    await vi.waitFor(() => expect(store.getState().queues.k1).toEqual([]));
  });

  it("send now moves a question to the front and stops the running answer; a failure stays on the item", async () => {
    const { store, client, emit } = setup();
    const a = { roomId: "r", artifactId: "a", fileKey: "k1" };
    emit({ type: "ask.started", turn: turn("t1", "running") });
    store.enqueue(a, "one", null);
    store.enqueue(a, "two", null);
    const two = store.getState().queues.k1[1];
    store.sendNow("k1", two.id);
    expect(client.cancelAsk).toHaveBeenCalledWith("t1");
    expect(store.getState().queues.k1.map((q) => q.text)).toEqual(["two", "one"]);
    client.startAsk.mockRejectedValueOnce(new Error("Waiting for an answer"));
    emit({ type: "ask.done", turn: turn("t1", "cancelled") });
    await vi.waitFor(() => expect(store.getState().queues.k1[0].error).toBe("Waiting for an answer"));
    expect(store.unqueue("k1", two.id)?.text).toBe("two");
    expect(store.getState().queues.k1.map((q) => q.text)).toEqual(["one"]);
    // Nothing running: queuing sends at once.
    store.enqueue(a, "three", null);
    await vi.waitFor(() => expect(client.startAsk).toHaveBeenLastCalledWith(expect.objectContaining({ question: "one" })));
  });

  it("starts open and toggles", () => {
    const { store } = setup();
    expect(store.getState().open).toBe(true);
    store.toggle();
    expect(store.getState().open).toBe(false);
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
    expect(client.startAsk).toHaveBeenCalledWith({ roomId: "r", artifactId: "a", question: "q", model: null });
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

  it("ask() sends the picked model; target() asks roomsd and swallows errors", async () => {
    const { store, client } = setup();
    await store.ask({ roomId: "r", artifactId: "a" }, "q", "gpt-6-sol");
    expect(client.startAsk).toHaveBeenCalledWith({ roomId: "r", artifactId: "a", question: "q", model: "gpt-6-sol" });
    expect(await store.target({ roomId: "r", artifactId: "a" })).toEqual({ agent: "codex", mode: "new", models: ["gpt-6-sol"] });
    expect(client.askTarget).toHaveBeenCalledWith("r", "a");
    client.askTarget.mockRejectedValueOnce(new Error("x"));
    expect(await store.target({ roomId: "r", artifactId: "a" })).toBeNull();
  });

  it("cancel calls the client and swallows errors", () => {
    const { store, client } = setup();
    client.cancelAsk.mockRejectedValueOnce(new Error("gone"));
    store.cancel("t1");
    expect(client.cancelAsk).toHaveBeenCalledWith("t1");
  });

  describe("a turn that ended unheard", () => {
    afterEach(() => vi.useRealTimers());
    const stale = turn("t1", "running");
    const ended = turn("t1", "failed", { error: "Stopped because Rooms restarted" });

    it("Stop on a turn roomsd no longer runs reloads the thread", async () => {
      const { store, client, emit } = setup();
      emit({ type: "ask.started", turn: stale });
      client.askThread.mockResolvedValueOnce([ended]);
      client.cancelAsk.mockRejectedValueOnce(new RoomsApiError(404, "Not Found"));
      store.cancel("t1");
      await vi.waitFor(() => expect(store.getState().threads.k1.turns).toEqual([ended]));
    });

    it("a turn still running a while after Stop is reloaded", async () => {
      vi.useFakeTimers();
      const { store, client, emit } = setup();
      emit({ type: "ask.started", turn: stale });
      client.askThread.mockResolvedValueOnce([ended]);
      store.cancel("t1");
      await vi.advanceTimersByTimeAsync(STOP_CHECK_MS);
      expect(client.askThread).toHaveBeenCalledWith("k1");
      expect(store.getState().threads.k1.turns).toEqual([ended]);
    });

    it("a shown thread whose running turn goes quiet is reloaded; a hidden one isn't", async () => {
      vi.useFakeTimers();
      const { store, client, emit } = setup();
      emit({ type: "ask.started", turn: stale });
      emit({ type: "ask.started", turn: turn("h1", "running", { fileKey: "hidden" }) });
      const release = store.hold("k1");
      await vi.advanceTimersByTimeAsync(STALE_MS / 2);
      expect(client.askThread).not.toHaveBeenCalled();
      // progress keeps it fresh
      emit({ type: "ask.progress", id: "t1", fileKey: "k1", answer: "a", activity: null });
      await vi.advanceTimersByTimeAsync(STALE_MS / 2);
      expect(client.askThread).not.toHaveBeenCalled();
      client.askThread.mockResolvedValueOnce([ended]);
      await vi.advanceTimersByTimeAsync(STALE_MS);
      expect(client.askThread).toHaveBeenCalledTimes(1);
      expect(client.askThread).toHaveBeenCalledWith("k1");
      expect(store.getState().threads.k1.turns).toEqual([ended]);
      release();
      store.stop();
    });
  });
});
