/*
 * Ask threads by file key, kept in step with roomsd by `ask.started` / `ask.done`
 * events, plus whether the ask bar is open (global, starts open, not saved).
 */
import type { AskImage, AskTarget, AskTurn, RoomsEvent, StartAsk } from "@alto-rooms/protocol-ts";

export type Thread = { turns: AskTurn[]; loaded: boolean; error: boolean };
/** A running turn's answer so far and what the agent is doing, from `ask.progress`. */
export type Live = { answer: string; activity: string | null };
/** `quotes`: text picked with "Ask" in a doc or an answer, waiting to go out with the next question, by file key. */
/** A question typed while an answer runs: it goes out by itself when that answer ends (Codex's queued follow-ups). */
export type Queued = { id: string; roomId: string; artifactId: string; text: string; model: string | null; images: string[]; error: string | null };
export type AsksState = {
  open: boolean;
  threads: Record<string, Thread>;
  live: Record<string, Live>;
  quotes: Record<string, string[]>;
  /** By file key, oldest first. */
  queues: Record<string, Queued[]>;
};

export const MAX_QUOTES = 5;
/** A question is at most 8,000 characters; a few quotes plus the question must fit. */
export const MAX_QUOTE_CHARS = 1500;

/** The question as sent: each quote as a Markdown blockquote, then what was asked. */
export function withQuotes(quotes: string[], question: string): string {
  const blocks = quotes.map((q) => q.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n"));
  return [...blocks, question].join("\n\n");
}
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

/** Threads kept in memory; a dropped one reloads from roomsd when its doc is shown again. */
export const MAX_THREADS = 20;

const EMPTY: Thread = { turns: [], loaded: false, error: false };

export class AsksStore {
  private state: AsksState = { open: true, threads: {}, live: {}, quotes: {}, queues: {} };
  /** File keys whose head question is being sent, so one end-of-turn never sends two. */
  private draining = new Set<string>();
  private queueSeq = 0;
  private listeners = new Set<() => void>();
  /** File keys an ask bar is showing, with a count per bar. */
  private held = new Map<string, number>();
  private stopSignals: (() => void) | null = null;

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
  }

  stop(): void {
    this.stopSignals?.();
    this.stopSignals = null;
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
      const loaded = await this.client.askThread(fileKey);
      const current = this.state.threads[fileKey]?.turns ?? [];
      const turns = current.reduce(upsert, loaded);
      this.setThread(fileKey, { turns, loaded: true, error: false });
    } catch (e) {
      console.warn("rooms: could not load ask thread", e);
      this.setThread(fileKey, { ...(this.state.threads[fileKey] ?? EMPTY), loaded: true, error: true });
    }
  }

  /** Which agent an ask from this doc goes to, and its models; null when roomsd can't say. */
  async target(a: { roomId: string; artifactId: string }): Promise<AskTarget | null> {
    if (!this.client) return null;
    try {
      return await this.client.askTarget(a.roomId, a.artifactId);
    } catch (e) {
      console.warn("rooms: could not load the ask target", e);
      return null;
    }
  }

  /** Throws the API error (e.g. ask_busy) for the bar to show. `model` null = the agent's default. */
  async ask(a: { roomId: string; artifactId: string }, question: string, model: string | null = null, images: string[] = []): Promise<void> {
    if (!this.client) return;
    const t = await this.client.startAsk({ roomId: a.roomId, artifactId: a.artifactId, question, model, ...(images.length ? { images } : {}) });
    this.apply(t);
  }

  /** Queues a question behind the running answer for `a.fileKey`; it is sent when that answer ends. */
  enqueue(a: { roomId: string; artifactId: string; fileKey: string }, text: string, model: string | null, images: string[] = []): string {
    const item: Queued = { id: `q${++this.queueSeq}`, roomId: a.roomId, artifactId: a.artifactId, text, model, images, error: null };
    this.setQueue(a.fileKey, [...(this.state.queues[a.fileKey] ?? []), item]);
    void this.drain(a.fileKey);
    return item.id;
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
    const running = this.state.threads[fileKey]?.turns.find((t) => !finished(t));
    if (running) this.cancel(running.id);
    else void this.drain(fileKey);
  }

  /** Sends the head of `fileKey`'s queue if nothing runs there. A failure stays on the item, which waits for the next try. */
  private async drain(fileKey: string): Promise<void> {
    const head = this.state.queues[fileKey]?.[0];
    if (!head || this.draining.has(fileKey) || this.state.threads[fileKey]?.turns.some((t) => !finished(t))) return;
    this.draining.add(fileKey);
    try {
      await this.ask(head, head.text, head.model, head.images);
      this.setQueue(fileKey, (this.state.queues[fileKey] ?? []).filter((q) => q.id !== head.id));
    } catch (e) {
      const error = e instanceof Error && e.message ? e.message : "Couldn't send";
      this.setQueue(fileKey, (this.state.queues[fileKey] ?? []).map((q) => (q.id === head.id ? { ...q, error } : q)));
    } finally {
      this.draining.delete(fileKey);
    }
  }

  private setQueue(fileKey: string, queue: Queued[]) {
    this.set({ ...this.state, queues: { ...this.state.queues, [fileKey]: queue } });
  }

  /** Adds `text` as a quote for the next question about `fileKey`, and opens the bar. */
  addQuote(fileKey: string, text: string): void {
    const t = text.trim();
    if (!t) return;
    const q = t.length > MAX_QUOTE_CHARS ? `${t.slice(0, MAX_QUOTE_CHARS - 1)}…` : t;
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

  cancel(askId: string): void {
    void this.client?.cancelAsk(askId).catch((e) => console.warn("rooms: could not cancel ask", e));
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
