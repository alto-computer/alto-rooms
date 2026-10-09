/*
 * Everything the ask bar shows that outlives one bar: each scope's thread (kept in step with roomsd
 * by `ask.*` events), the answer streaming in, the quotes and queued questions waiting to go out,
 * and whether the bar is open (global, starts open, not saved).
 *
 * Rooms only relays: a question goes to roomsd, which runs the agent CLI; nothing here reads or
 * shapes an answer.
 */
import type { AskImage, AskKind, AskScope, AskTarget, AskTurn, RoomsEvent, StartAsk } from "@alto-rooms/protocol-ts";
import { RoomsApiError, scopeKey } from "@alto-rooms/protocol-ts";
import { MAX_QUOTES, toQuote } from "./quotes";

/** What goes to roomsd: a question (its quotes already in `text`) or a command (`kind`). */
export type Outgoing = { text: string; model: string | null; images: string[]; kind: AskKind };
/** Waiting behind the running answer; sent by itself when that ends (Codex's queued follow-ups). */
export type Queued = Outgoing & { id: string; scope: AskScope; error: string | null };

export type Thread = { scope: AskScope; turns: AskTurn[]; loaded: boolean; error: boolean };
/** A running turn's answer so far and what the agent is doing, from `ask.progress`. */
export type Live = { answer: string; activity: string | null };
/** All by scope key (`scopeKey`). */
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
  askTarget(scope: AskScope): Promise<AskTarget>;
  askThread(scope: AskScope): Promise<AskTurn[]>;
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

/** Threads kept in memory; a dropped one reloads from roomsd when its scope is shown again. */
export const MAX_THREADS = 20;

const empty = (scope: AskScope): Thread => ({ scope, turns: [], loaded: false, error: false });

export class AsksStore {
  private state: AsksState = { open: true, threads: {}, live: {}, quotes: {}, queues: {} };
  /** Scope keys with a question on its way to roomsd: another one queues instead of racing it. */
  private sending = new Set<string>();
  private queueSeq = 0;
  private listeners = new Set<() => void>();
  /** Scope keys an ask bar is showing, with a count per bar. */
  private held = new Map<string, number>();
  private stopSignals: (() => void) | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** When each scope key last heard from roomsd (an event or a load). */
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
        for (const th of Object.values(this.state.threads)) if (th.loaded) void this.load(th.scope);
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
      const th = this.state.threads[key];
      if (th && this.running(key) && now - (this.heard.get(key) ?? 0) >= STALE_MS) void this.load(th.scope);
    }
  }

  toggle(): void {
    this.setOpen(!this.state.open);
  }

  setOpen(open: boolean): void {
    if (open !== this.state.open) this.set({ ...this.state, open });
  }

  async load(scope: AskScope): Promise<void> {
    if (!this.client) return;
    const key = scopeKey(scope);
    try {
      this.heard.set(key, Date.now());
      const loaded = await this.client.askThread(scope);
      const current = this.state.threads[key]?.turns ?? [];
      const turns = current.reduce(upsert, loaded);
      this.setThread(key, { scope, turns, loaded: true, error: false });
      // A turn that ended while we weren't hearing about it frees the queue too.
      void this.drain(key);
    } catch (e) {
      console.warn("rooms: could not load ask thread", e);
      this.setThread(key, { ...(this.state.threads[key] ?? empty(scope)), loaded: true, error: true });
    }
  }

  /** Which agent an ask in this scope goes to, and its models; null when roomsd can't say. */
  async target(scope: AskScope): Promise<AskTarget | null> {
    if (!this.client) return null;
    try {
      return await this.client.askTarget(scope);
    } catch (e) {
      console.warn("rooms: could not load the ask target", e);
      return null;
    }
  }

  /**
   * Sends `q` in `scope`, or queues it when that scope's thread is busy (an answer running, a
   * question on its way, or others already waiting). `now` stops the running answer so `q` goes
   * next. Throws roomsd's error when sending fails; a queued question keeps its error instead.
   */
  async submit(scope: AskScope, q: Outgoing, now = false): Promise<"sent" | "queued"> {
    const key = scopeKey(scope);
    if (this.busy(key)) {
      const item: Queued = { ...q, id: `q${++this.queueSeq}`, scope, error: null };
      this.setQueue(key, [...(this.state.queues[key] ?? []), item]);
      if (now) this.sendNow(key, item.id);
      else void this.drain(key); // e.g. only failed questions were waiting
      return "queued";
    }
    try {
      await this.send(scope, q);
    } finally {
      // Whatever queued behind it while it was on its way goes once it runs (or failed).
      void this.drain(key);
    }
    return "sent";
  }

  private busy(key: string): boolean {
    return this.sending.has(key) || !!this.state.queues[key]?.length || !!this.running(key);
  }

  private running(key: string): AskTurn | undefined {
    return this.state.threads[key]?.turns.find((t) => !finished(t));
  }

  private async send(scope: AskScope, q: Outgoing): Promise<void> {
    if (!this.client) return;
    const key = scopeKey(scope);
    this.sending.add(key);
    try {
      const t = await this.client.startAsk({
        scope, question: q.text, model: q.model,
        ...(q.images.length ? { images: q.images } : {}), ...(q.kind !== "question" ? { kind: q.kind } : {}),
      });
      this.apply(t);
    } finally {
      this.sending.delete(key);
    }
  }

  /** Takes a queued question out (to edit it, or drop it). */
  unqueue(key: string, id: string): Queued | undefined {
    const queue = this.state.queues[key] ?? [];
    const item = queue.find((q) => q.id === id);
    if (item) this.setQueue(key, queue.filter((q) => q.id !== id));
    return item;
  }

  /** Sends a queued question now: it moves to the front and the running answer is stopped. */
  sendNow(key: string, id: string): void {
    const queue = this.state.queues[key] ?? [];
    const item = queue.find((q) => q.id === id);
    if (!item) return;
    this.setQueue(key, [{ ...item, error: null }, ...queue.filter((q) => q.id !== id)]);
    const running = this.running(key);
    if (running) this.cancel(running.id);
    else void this.drain(key);
  }

  /** Sends the head of `key`'s queue once nothing runs or is being sent there. A failure stays on the item until the next try. */
  private async drain(key: string): Promise<void> {
    const head = this.state.queues[key]?.[0];
    if (!head || this.sending.has(key) || this.running(key)) return;
    try {
      await this.send(head.scope, head);
      this.setQueue(key, (this.state.queues[key] ?? []).filter((q) => q.id !== head.id));
    } catch (e) {
      const error = e instanceof Error && e.message ? e.message : "Couldn't send";
      this.setQueue(key, (this.state.queues[key] ?? []).map((q) => (q.id === head.id ? { ...q, error } : q)));
    }
  }

  private setQueue(key: string, queue: Queued[]) {
    this.set({ ...this.state, queues: { ...this.state.queues, [key]: queue } });
  }

  /** Adds `text` as a quote for the next question in the scope under `key`, and opens the bar. */
  addQuote(key: string, text: string): void {
    const q = toQuote(text);
    if (!q) return;
    const current = this.state.quotes[key] ?? [];
    const next = current.includes(q) ? current : [...current, q].slice(-MAX_QUOTES);
    this.set({ ...this.state, open: true, quotes: { ...this.state.quotes, [key]: next } });
  }

  removeQuote(key: string, index: number): void {
    const next = (this.state.quotes[key] ?? []).filter((_, i) => i !== index);
    this.set({ ...this.state, quotes: { ...this.state.quotes, [key]: next } });
  }

  clearQuotes(key: string, sent: string[]): void {
    const next = (this.state.quotes[key] ?? []).filter((q) => !sent.includes(q));
    this.set({ ...this.state, quotes: { ...this.state.quotes, [key]: next } });
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
    const scope = Object.values(this.state.threads).find((th) => th.turns.some((t) => t.id === askId))?.scope;
    // Read the thread as it is then, not as it was: an `ask.done` in the meantime replaces it.
    const stillRunning = () => !!scope && !!this.state.threads[scopeKey(scope)]?.turns.some((t) => t.id === askId && !finished(t));
    client.cancelAsk(askId).then(
      () => setTimeout(() => { if (stillRunning()) void this.load(scope!); }, STOP_CHECK_MS),
      (e) => {
        if (scope && e instanceof RoomsApiError && e.status === 404) void this.load(scope);
        else console.warn("rooms: could not cancel ask", e);
      },
    );
  }

  /** Keeps the thread under `key` from being pruned while an ask bar shows it; returns the release. */
  hold(key: string): () => void {
    this.held.set(key, (this.held.get(key) ?? 0) + 1);
    return () => {
      const n = (this.held.get(key) ?? 1) - 1;
      if (n > 0) this.held.set(key, n);
      else this.held.delete(key);
    };
  }

  private apply(t: AskTurn) {
    const key = scopeKey(t.scope);
    this.heard.set(key, Date.now());
    if (finished(t) && t.id in this.state.live) {
      const { [t.id]: _done, ...live } = this.state.live;
      this.state = { ...this.state, live };
    }
    const th = this.state.threads[key] ?? empty(t.scope);
    this.setThread(key, { ...th, turns: upsert(th.turns, t) });
    // An answer ended (done, failed or stopped): the next queued question goes out.
    if (finished(t)) void this.drain(key);
  }

  /** Progress for a turn already known to be finished is late and dropped. */
  private progress(e: Progress) {
    const key = scopeKey(e.scope);
    this.heard.set(key, Date.now());
    const turn = this.state.threads[key]?.turns.find((t) => t.id === e.id);
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
