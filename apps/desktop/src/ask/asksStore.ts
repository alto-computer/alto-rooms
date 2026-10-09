/*
 * Everything the ask bar shows that outlives one bar: each doc's thread (kept in step with roomsd
 * by `ask.*` events), the answer streaming in, the quotes and queued questions waiting to go out,
 * and whether the bar is open (global, starts open, not saved).
 *
 * Rooms only relays: a question goes to roomsd, which runs the agent CLI; nothing here reads or
 * shapes an answer.
 */
import type { AskImage, AskKind, AskTarget, AskTurn, RoomsEvent, StartAsk } from "@alto-rooms/protocol-ts";
import { RoomsApiError } from "@alto-rooms/protocol-ts";
import { MAX_QUOTES, toQuote } from "./quotes";

/** The doc a question is about: where roomsd finds it, and the file key its thread is kept under. */
export type AskDoc = { roomId: string; artifactId: string; fileKey: string };
/** What goes to roomsd: a question (its quotes already in `text`) or a command (`kind`). */
export type Outgoing = { text: string; model: string | null; images: string[]; kind: AskKind };
/** Waiting behind the running answer; sent by itself when that ends (Codex's queued follow-ups). */
export type Queued = Outgoing & { id: string; doc: AskDoc; error: string | null };

export type Thread = { turns: AskTurn[]; loaded: boolean; error: boolean };
/** A running turn's answer so far and what the agent is doing, from `ask.progress`. */
export type Live = { answer: string; activity: string | null };
/** All by file key. */
export type AsksState = {
  open: boolean;
  threads: Record<string, Thread>;
  live: Record<string, Live>;
  /** Picked text waiting to go out with the next question. */
  quotes: Record<string, string[]>;
  /** Oldest first. */
  queues: Record<string, Queued[]>;
};

type Progress = Extract<RoomsEvent, { type: "ask.progress" }>;

type Client = {
  startAsk(req: StartAsk): Promise<AskTurn>;
  askTarget(roomId: string, artifactId: string): Promise<AskTarget>;
  askThread(fileKey: string): Promise<AskTurn[]>;
  cancelAsk(askId: string): Promise<void>;
  uploadAskImage(image: Blob): Promise<AskImage>;
};
type Signals = { onSignal(fn: (type: RoomsEvent["type"], e: RoomsEvent) => void): () => void };

const finished = (t: AskTurn) => t.status !== "running";

/** By id; a finished turn never goes back to running (a late 202 or stale load). */
export function upsert(turns: AskTurn[], t: AskTurn): AskTurn[] {
  const i = turns.findIndex((x) => x.id === t.id);
  if (i < 0) return [...turns, t];
  if (finished(turns[i]) && !finished(t)) return turns;
  const next = turns.slice();
  next[i] = t;
  return next;
}

/**
 * A shown thread with a running turn and no event for this long is reloaded from roomsd, so a
 * missed `ask.done` (roomsd restarted, the event stream dropped) can't leave it "Thinking" forever.
 */
export const STALE_MS = 20_000;
/** After Stop, the turn should end at once; if it still runs after this, reload it. */
export const STOP_CHECK_MS = 5_000;

/** Threads kept in memory; a dropped one reloads from roomsd when its doc is shown again. */
export const MAX_THREADS = 20;

const EMPTY: Thread = { turns: [], loaded: false, error: false };

export class AsksStore {
  private state: AsksState = { open: true, threads: {}, live: {}, quotes: {}, queues: {} };
  /** File keys with a question on its way to roomsd: another one queues instead of racing it. */
  private sending = new Set<string>();
  private queueSeq = 0;
  private listeners = new Set<() => void>();
  /** File keys an ask bar is showing, with a count per bar. */
  private held = new Map<string, number>();
  private stopSignals: (() => void) | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** When each file key last heard from roomsd (an event or a load). */
  private heard = new Map<string, number>();

  constructor(
    private readonly client: Client | undefined,
    private readonly rooms: Signals,
  ) {}

  getState = (): AsksState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };

  start(): void {
    if (this.stopSignals) return;
    this.stopSignals = this.rooms.onSignal((type, e) => {
      if (e.type === "ask.started" || e.type === "ask.done") this.apply(e.turn);
      else if (e.type === "ask.progress") this.progress(e);
      else if (type === "resync" && e.type === "resync" && e.roomId === null) {
        for (const [key, th] of Object.entries(this.state.threads)) if (th.loaded) void this.load(key);
      }
    });
    this.watchdog = setInterval(() => this.reloadStale(), STALE_MS / 2);
  }

  stop(): void {
    this.stopSignals?.();
    this.stopSignals = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /** Reloads shown threads whose running turn has gone quiet for STALE_MS. */
  private reloadStale(): void {
    const now = Date.now();
    for (const key of this.held.keys()) {
        if (this.running(key) && now - (this.heard.get(key) ?? 0) >= STALE_MS) void this.load(key);
    }
  }

  toggle(): void {
    this.setOpen(!this.state.open);
  }

  setOpen(open: boolean): void {
    if (open !== this.state.open) this.set({ ...this.state, open });
  }

  async load(fileKey: string): Promise<void> {
    if (!this.client) return;
    try {
      this.heard.set(fileKey, Date.now());
      const loaded = await this.client.askThread(fileKey);
      const current = this.state.threads[fileKey]?.turns ?? [];
      const turns = current.reduce(upsert, loaded);
      this.setThread(fileKey, { turns, loaded: true, error: false });
      // A turn that ended while we weren't hearing about it frees the queue too.
      void this.drain(fileKey);
    } catch (e) {
      console.warn("rooms: could not load ask thread", e);
      this.setThread(fileKey, { ...(this.state.threads[fileKey] ?? EMPTY), loaded: true, error: true });
    }
  }

  /** Which agent an ask from this doc goes to, and its models; null when roomsd can't say. */
  async target(doc: { roomId: string; artifactId: string }): Promise<AskTarget | null> {
    if (!this.client) return null;
    try {
      return await this.client.askTarget(doc.roomId, doc.artifactId);
    } catch (e) {
      console.warn("rooms: could not load the ask target", e);
      return null;
    }
  }

  /**
   * Sends `q` about `doc`, or queues it when that doc's thread is busy (an answer running, a
   * question on its way, or others already waiting). `now` stops the running answer so `q` goes
   * next. Throws roomsd's error when sending fails; a queued question keeps its error instead.
   */
  async submit(doc: AskDoc, q: Outgoing, now = false): Promise<"sent" | "queued"> {
    if (this.busy(doc.fileKey)) {
      const item: Queued = { ...q, id: `q${++this.queueSeq}`, doc, error: null };
      this.setQueue(doc.fileKey, [...(this.state.queues[doc.fileKey] ?? []), item]);
      if (now) this.sendNow(doc.fileKey, item.id);
      else void this.drain(doc.fileKey); // e.g. only failed questions were waiting
      return "queued";
    }
    try {
      await this.send(doc, q);
    } finally {
      // Whatever queued behind it while it was on its way goes once it runs (or failed).
      void this.drain(doc.fileKey);
    }
    return "sent";
  }

  private busy(fileKey: string): boolean {
    return this.sending.has(fileKey) || !!this.state.queues[fileKey]?.length || !!this.running(fileKey);
  }

  private running(fileKey: string): AskTurn | undefined {
    return this.state.threads[fileKey]?.turns.find((t) => !finished(t));
  }

  private async send(doc: AskDoc, q: Outgoing): Promise<void> {
    if (!this.client) return;
    this.sending.add(doc.fileKey);
    try {
      const t = await this.client.startAsk({
        roomId: doc.roomId, artifactId: doc.artifactId, question: q.text, model: q.model,
        ...(q.images.length ? { images: q.images } : {}), ...(q.kind !== "question" ? { kind: q.kind } : {}),
      });
      this.apply(t);
    } finally {
      this.sending.delete(doc.fileKey);
    }
  }

  /** Takes a queued question out (to edit it, or drop it). */
  unqueue(fileKey: string, id: string): Queued | undefined {
    const queue = this.state.queues[fileKey] ?? [];
    const item = queue.find((q) => q.id === id);
    if (item) this.setQueue(fileKey, queue.filter((q) => q.id !== id));
    return item;
  }

  /** Sends a queued question now: it moves to the front and the running answer is stopped. */
  sendNow(fileKey: string, id: string): void {
    const queue = this.state.queues[fileKey] ?? [];
    const item = queue.find((q) => q.id === id);
    if (!item) return;
    this.setQueue(fileKey, [{ ...item, error: null }, ...queue.filter((q) => q.id !== id)]);
    const running = this.running(fileKey);
    if (running) this.cancel(running.id);
    else void this.drain(fileKey);
  }

  /** Sends the head of `fileKey`'s queue once nothing runs or is being sent there. A failure stays on the item until the next try. */
  private async drain(fileKey: string): Promise<void> {
    const head = this.state.queues[fileKey]?.[0];
    if (!head || this.sending.has(fileKey) || this.running(fileKey)) return;
    try {
      await this.send(head.doc, head);
      this.setQueue(fileKey, (this.state.queues[fileKey] ?? []).filter((q) => q.id !== head.id));
    } catch (e) {
      const error = e instanceof Error && e.message ? e.message : "Couldn't send";
      this.setQueue(fileKey, (this.state.queues[fileKey] ?? []).map((q) => (q.id === head.id ? { ...q, error } : q)));
    }
  }

  private setQueue(fileKey: string, queue: Queued[]) {
    this.set({ ...this.state, queues: { ...this.state.queues, [fileKey]: queue } });
  }

  /** Adds `text` as a quote for the next question about `fileKey`, and opens the bar. */
  addQuote(fileKey: string, text: string): void {
    const q = toQuote(text);
    if (!q) return;
    const current = this.state.quotes[fileKey] ?? [];
    const next = current.includes(q) ? current : [...current, q].slice(-MAX_QUOTES);
    this.set({ ...this.state, open: true, quotes: { ...this.state.quotes, [fileKey]: next } });
  }

  removeQuote(fileKey: string, index: number): void {
    const next = (this.state.quotes[fileKey] ?? []).filter((_, i) => i !== index);
    this.set({ ...this.state, quotes: { ...this.state.quotes, [fileKey]: next } });
  }

  clearQuotes(fileKey: string, sent: string[]): void {
    const next = (this.state.quotes[fileKey] ?? []).filter((q) => !sent.includes(q));
    this.set({ ...this.state, quotes: { ...this.state.quotes, [fileKey]: next } });
  }

  /** Stores an image for a question; resolves to its id. Throws the API error for the bar to show. */
  async uploadImage(image: Blob): Promise<string> {
    if (!this.client) throw new Error("no roomsd");
    return (await this.client.uploadAskImage(image)).id;
  }

  /**
   * Stops a running turn. roomsd answers 404 when it isn't running there (it ended unheard, or
   * roomsd restarted): the thread reloads and shows how it really ended. So does a turn still
   * running STOP_CHECK_MS after Stop.
   */
  cancel(askId: string): void {
    const client = this.client;
    if (!client) return;
    const fileKey = Object.entries(this.state.threads).find(([, th]) => th.turns.some((t) => t.id === askId))?.[0];
    const stillRunning = () => !!fileKey && !!this.state.threads[fileKey]?.turns.some((t) => t.id === askId && !finished(t));
    client.cancelAsk(askId).then(
      () => setTimeout(() => { if (stillRunning()) void this.load(fileKey!); }, STOP_CHECK_MS),
      (e) => {
        if (fileKey && e instanceof RoomsApiError && e.status === 404) void this.load(fileKey);
        else console.warn("rooms: could not cancel ask", e);
      },
    );
  }

  /** Keeps `fileKey`'s thread from being pruned while an ask bar shows it; returns the release. */
  hold(fileKey: string): () => void {
    this.held.set(fileKey, (this.held.get(fileKey) ?? 0) + 1);
    return () => {
      const n = (this.held.get(fileKey) ?? 1) - 1;
      if (n > 0) this.held.set(fileKey, n);
      else this.held.delete(fileKey);
    };
  }

  private apply(t: AskTurn) {
    this.heard.set(t.fileKey, Date.now());
    if (finished(t) && t.id in this.state.live) {
      const { [t.id]: _done, ...live } = this.state.live;
      this.state = { ...this.state, live };
    }
    const th = this.state.threads[t.fileKey] ?? EMPTY;
    this.setThread(t.fileKey, { ...th, turns: upsert(th.turns, t) });
    // An answer ended (done, failed or stopped): the next queued question goes out.
    if (finished(t)) void this.drain(t.fileKey);
  }

  /** Progress for a turn already known to be finished is late and dropped. */
  private progress(e: Progress) {
    this.heard.set(e.fileKey, Date.now());
    const turn = this.state.threads[e.fileKey]?.turns.find((t) => t.id === e.id);
    if (turn && finished(turn)) return;
    this.set({ ...this.state, live: { ...this.state.live, [e.id]: { answer: e.answer, activity: e.activity } } });
  }

  /** Moves `key` to the end (most recently touched) and drops the oldest idle threads past the cap. */
  private setThread(key: string, th: Thread) {
    const { [key]: _old, ...rest } = this.state.threads;
    const threads: Record<string, Thread> = { ...rest, [key]: th };
    let extra = Object.keys(threads).length - MAX_THREADS;
    for (const [k, t] of Object.entries(threads)) {
      if (extra <= 0) break;
      if (k === key || this.held.has(k) || t.turns.some((x) => !finished(x))) continue;
      delete threads[k];
      extra--;
    }
    this.set({ ...this.state, threads });
  }

  private set(next: AsksState) {
    this.state = next;
    for (const l of [...this.listeners]) l();
  }
}
