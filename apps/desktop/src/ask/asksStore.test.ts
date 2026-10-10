import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskScope, AskTarget, AskTurn, RoomsEvent } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { AsksStore, MAX_THREADS, STALE_MS, STOP_CHECK_MS, upsert, type Outgoing } from "./asksStore";

type EventInput = RoomsEvent extends infer T ? (T extends RoomsEvent ? Omit<T, "seq"> : never) : never;

const docScope = (fileKey: string): AskScope => ({ kind: "doc", fileKey });

const turn = (id: string, status: AskTurn["status"], extra: Partial<AskTurn> = {}): AskTurn => ({
  id, scope: docScope("k1"), question: "q", answer: "", agent: "claude-code", model: null, mode: "resume", status,
  error: null, startedAt: "2026-10-06T10:00:00+09:00", endedAt: null, images: [], kind: "question", leftOut: 0, session: null, ...extra,
});

const doc = docScope("k1");
const q = (text: string, extra: Partial<Outgoing> = {}): Outgoing => ({ text, model: null, images: [], kind: "question", ...extra });

function setup(thread: AskTurn[] = []) {
  let signal: (type: RoomsEvent["type"], e: RoomsEvent) => void = () => {};
  const client = {
    startAsk: vi.fn(async () => turn("t1", "running")),
    askThread: vi.fn(async () => thread),
    askTarget: vi.fn(async (): Promise<AskTarget> => ({ agent: "codex", mode: "new", models: ["gpt-6-sol"], scoped: false })),
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
    emit({ type: "ask.started", turn: turn("busy", "running", { scope: docScope("busy") }) });
    for (let i = 0; i < MAX_THREADS + 5; i++) emit({ type: "ask.done", turn: turn(`t${i}`, "done", { scope: docScope(`f${i}`) }) });
    const keys = Object.keys(store.getState().threads);
    expect(keys).toHaveLength(MAX_THREADS);
    expect(keys).toContain("doc:busy");
    expect(keys).toContain(`doc:f${MAX_THREADS + 4}`);
    expect(keys).not.toContain("doc:f0");
  });

  it("never drops a thread an ask bar holds, until it lets go", () => {
    const { store, emit } = setup();
    emit({ type: "ask.done", turn: turn("seen", "done", { scope: docScope("seen") }) });
    const release = store.hold(docScope("seen"));
    for (let i = 0; i < MAX_THREADS + 5; i++) emit({ type: "ask.done", turn: turn(`t${i}`, "done", { scope: docScope(`f${i}`) }) });
    expect(Object.keys(store.getState().threads)).toContain("doc:seen");
    release();
    emit({ type: "ask.done", turn: turn("last", "done", { scope: docScope("last") }) });
    expect(Object.keys(store.getState().threads)).not.toContain("doc:seen");
  });

  it("keeps a running turn's progress until it finishes, and drops late progress", () => {
    const { store, emit } = setup();
    emit({ type: "ask.started", turn: turn("t1", "running") });
    emit({ type: "ask.progress", id: "t1", scope: doc, answer: "표는", activity: null });
    emit({ type: "ask.progress", id: "t1", scope: doc, answer: "", activity: "Read · doc.html" });
    expect(store.getState().live.t1).toEqual({ answer: "", activity: "Read · doc.html" });
    emit({ type: "ask.done", turn: turn("t1", "done", { answer: "표는 이래요" }) });
    expect(store.getState().live).toEqual({});
    emit({ type: "ask.progress", id: "t1", scope: doc, answer: "late", activity: null });
    expect(store.getState().live).toEqual({});
  });

  it("queues questions behind a running answer and sends them one per finished answer", async () => {
    const { store, client, emit } = setup();
    emit({ type: "ask.started", turn: turn("t1", "running") });
    expect(await store.submit(doc, q("second"))).toBe("queued");
    expect(await store.submit(doc, q("third", { model: "opus", images: ["img.png"] }))).toBe("queued");
    expect(store.getState().queues["doc:k1"].map((q) => q.text)).toEqual(["second", "third"]);
    expect(client.startAsk).not.toHaveBeenCalled();
    client.startAsk.mockResolvedValueOnce(turn("t2", "running"));
    emit({ type: "ask.done", turn: turn("t1", "done") });
    await vi.waitFor(() => expect(client.startAsk).toHaveBeenCalledTimes(1));
    expect(client.startAsk).toHaveBeenLastCalledWith({ scope: doc, question: "second", model: null });
    await vi.waitFor(() => expect(store.getState().queues["doc:k1"].map((q) => q.text)).toEqual(["third"]));
    client.startAsk.mockResolvedValueOnce(turn("t3", "running"));
    emit({ type: "ask.done", turn: turn("t2", "cancelled") });
    await vi.waitFor(() => expect(client.startAsk).toHaveBeenLastCalledWith({ scope: doc, question: "third", model: "opus", images: ["img.png"] }));
    await vi.waitFor(() => expect(store.getState().queues["doc:k1"]).toEqual([]));
  });

  it("send now moves a question to the front and stops the running answer; a failure stays on the item", async () => {
    const { store, client, emit } = setup();
    emit({ type: "ask.started", turn: turn("t1", "running") });
    await store.submit(doc, q("one"));
    await store.submit(doc, q("two"));
    const two = store.getState().queues["doc:k1"][1];
    store.sendNow(doc, two.id);
    expect(client.cancelAsk).toHaveBeenCalledWith("t1");
    expect(store.getState().queues["doc:k1"].map((q) => q.text)).toEqual(["two", "one"]);
    client.startAsk.mockRejectedValueOnce(new Error("Waiting for an answer"));
    emit({ type: "ask.done", turn: turn("t1", "cancelled") });
    await vi.waitFor(() => expect(store.getState().queues["doc:k1"][0].error).toBe("Waiting for an answer"));
    expect(store.unqueue(doc, two.id)?.text).toBe("two");
    expect(store.getState().queues["doc:k1"].map((q) => q.text)).toEqual(["one"]);
    // Nothing running, only a failed question waiting: a new one queues behind it and both go.
    expect(await store.submit(doc, q("three"))).toBe("queued");
    await vi.waitFor(() => expect(client.startAsk).toHaveBeenLastCalledWith(expect.objectContaining({ question: "one" })));
  });

  it("a doc turn and a room turn with the same raw id land in separate threads", () => {
    const { store, emit } = setup();
    const room: AskScope = { kind: "room", roomId: "k1" };
    emit({ type: "ask.started", turn: turn("d1", "running") });
    emit({ type: "ask.started", turn: turn("r1", "running", { scope: room }) });
    emit({ type: "ask.progress", id: "r1", scope: room, answer: "room so far", activity: null });
    const { threads, live } = store.getState();
    expect(Object.keys(threads).sort()).toEqual(["doc:k1", "room:k1"]);
    expect(threads["doc:k1"].turns.map((t) => t.id)).toEqual(["d1"]);
    expect(threads["room:k1"]).toMatchObject({ scope: room, turns: [turn("r1", "running", { scope: room })] });
    expect(live.r1.answer).toBe("room so far");
    emit({ type: "ask.done", turn: turn("r1", "done", { scope: room, answer: "room" }) });
    expect(threads["doc:k1"].turns[0].status).toBe("running");
    expect(store.getState().threads["room:k1"].turns[0].answer).toBe("room");
  });

  it("a quote and a queued question for a room scope never show under the doc scope", async () => {
    const { store, client, emit } = setup();
    const room: AskScope = { kind: "room", roomId: "k1" };
    store.addQuote(room, "picked in the room");
    emit({ type: "ask.started", turn: turn("r1", "running", { scope: room }) });
    expect(await store.submit(room, q("later"))).toBe("queued");
    const { quotes, queues } = store.getState();
    expect(quotes["room:k1"]).toEqual(["picked in the room"]);
    expect(quotes["doc:k1"]).toBeUndefined();
    expect(queues["room:k1"].map((x) => x.text)).toEqual(["later"]);
    expect(queues["doc:k1"]).toBeUndefined();
    expect(await store.submit(doc, q("doc question"))).toBe("sent");
    expect(client.startAsk).toHaveBeenCalledWith({ scope: doc, question: "doc question", model: null });
  });

  it("starts open and toggles", () => {
    const { store } = setup();
    expect(store.getState().open).toBe(true);
    store.toggle();
    expect(store.getState().open).toBe(false);
  });

  it("loads a thread and applies ask events for that file key", async () => {
    const { store, emit } = setup([turn("t0", "done", { answer: "old" })]);
    await store.load(doc);
    emit({ type: "ask.started", turn: turn("t1", "running") });
    emit({ type: "ask.done", turn: turn("t1", "done", { answer: "new" }) });
    expect(store.getState().threads["doc:k1"].turns.map((t) => [t.id, t.status, t.answer])).toEqual([
      ["t0", "done", "old"],
      ["t1", "done", "new"],
    ]);
  });

  it("ask.done before the 202 stays done", async () => {
    const { store, client, emit } = setup();
    let resolve!: (t: AskTurn) => void;
    client.startAsk.mockImplementationOnce(() => new Promise<AskTurn>((r) => (resolve = r)));
    const p = store.submit(doc, q("q"));
    emit({ type: "ask.done", turn: turn("t1", "failed", { error: "boom" }) });
    resolve(turn("t1", "running"));
    await p;
    expect(store.getState().threads["doc:k1"].turns[0].status).toBe("failed");
    expect(client.startAsk).toHaveBeenCalledWith({ scope: doc, question: "q", model: null });
  });

  it("a load that races an event keeps the newer state", async () => {
    const { store, client, emit } = setup();
    let resolve!: (t: AskTurn[]) => void;
    client.askThread.mockImplementationOnce(() => new Promise<AskTurn[]>((r) => (resolve = r)));
    const p = store.load(doc);
    emit({ type: "ask.done", turn: turn("t1", "done", { answer: "a" }) });
    resolve([turn("t1", "running")]);
    await p;
    expect(store.getState().threads["doc:k1"].turns[0].status).toBe("done");
  });

  it("marks load errors and reloads loaded threads on resync", async () => {
    const { store, client, emit } = setup();
    client.askThread.mockRejectedValueOnce(new Error("x"));
    await store.load(doc);
    expect(store.getState().threads["doc:k1"].error).toBe(true);
    emit({ type: "resync", roomId: null });
    await vi.waitFor(() => expect(store.getState().threads["doc:k1"].error).toBe(false));
    expect(client.askThread).toHaveBeenCalledTimes(2);
  });

  it("submit() rethrows API errors for the bar to show", async () => {
    const { store, client } = setup();
    client.startAsk.mockRejectedValueOnce(new Error("busy"));
    await expect(store.submit(doc, q("q"))).rejects.toThrow("busy");
  });

  it("a question sent while another is on its way queues instead of racing it", async () => {
    const { store, client } = setup();
    let resolve!: (t: AskTurn) => void;
    client.startAsk.mockImplementationOnce(() => new Promise<AskTurn>((r) => (resolve = r)));
    const first = store.submit(doc, q("one"));
    expect(await store.submit(doc, q("two"))).toBe("queued");
    expect(client.startAsk).toHaveBeenCalledTimes(1);
    resolve(turn("t1", "running"));
    expect(await first).toBe("sent");
    expect(store.getState().queues["doc:k1"].map((x) => x.text)).toEqual(["two"]);
  });

  it("submit() sends the picked model and a command's kind; target() asks roomsd and swallows errors", async () => {
    const { store, client } = setup();
    expect(await store.submit(doc, q("q", { model: "gpt-6-sol" }))).toBe("sent");
    expect(client.startAsk).toHaveBeenCalledWith({ scope: doc, question: "q", model: "gpt-6-sol" });
    client.startAsk.mockResolvedValueOnce(turn("c1", "done", { kind: "clear" }));
    await store.submit(docScope("k2"), q("/new", { kind: "clear" }));
    expect(client.startAsk).toHaveBeenLastCalledWith({ scope: docScope("k2"), question: "/new", model: null, kind: "clear" });
    expect(await store.target(doc)).toEqual({ agent: "codex", mode: "new", models: ["gpt-6-sol"], scoped: false });
    expect(client.askTarget).toHaveBeenCalledWith(doc);
    client.askTarget.mockRejectedValueOnce(new Error("x"));
    expect(await store.target(doc)).toBeNull();
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
      await vi.waitFor(() => expect(store.getState().threads["doc:k1"].turns).toEqual([ended]));
    });

    it("Stop answered by ask.done before the check does not reload", async () => {
      vi.useFakeTimers();
      const { store, client, emit } = setup();
      emit({ type: "ask.started", turn: stale });
      store.cancel("t1");
      emit({ type: "ask.done", turn: turn("t1", "cancelled") });
      await vi.advanceTimersByTimeAsync(STOP_CHECK_MS);
      expect(client.askThread).not.toHaveBeenCalled();
      expect(store.getState().threads["doc:k1"].turns).toEqual([turn("t1", "cancelled")]);
    });

    it("a turn still running a while after Stop is reloaded", async () => {
      vi.useFakeTimers();
      const { store, client, emit } = setup();
      emit({ type: "ask.started", turn: stale });
      client.askThread.mockResolvedValueOnce([ended]);
      store.cancel("t1");
      await vi.advanceTimersByTimeAsync(STOP_CHECK_MS);
      expect(client.askThread).toHaveBeenCalledWith(doc);
      expect(store.getState().threads["doc:k1"].turns).toEqual([ended]);
    });

    it("a shown thread whose running turn goes quiet is reloaded; a hidden one isn't", async () => {
      vi.useFakeTimers();
      const { store, client, emit } = setup();
      emit({ type: "ask.started", turn: stale });
      emit({ type: "ask.started", turn: turn("h1", "running", { scope: docScope("hidden") }) });
      const release = store.hold(doc);
      await vi.advanceTimersByTimeAsync(STALE_MS / 2);
      expect(client.askThread).not.toHaveBeenCalled();
      // progress keeps it fresh
      emit({ type: "ask.progress", id: "t1", scope: doc, answer: "a", activity: null });
      await vi.advanceTimersByTimeAsync(STALE_MS / 2);
      expect(client.askThread).not.toHaveBeenCalled();
      client.askThread.mockResolvedValueOnce([ended]);
      await vi.advanceTimersByTimeAsync(STALE_MS);
      expect(client.askThread).toHaveBeenCalledTimes(1);
      expect(client.askThread).toHaveBeenCalledWith(doc);
      expect(store.getState().threads["doc:k1"].turns).toEqual([ended]);
      release();
      store.stop();
    });
  });
});
