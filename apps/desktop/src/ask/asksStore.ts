/*
 * Ask threads by file key, kept in step with roomsd by `ask.started` / `ask.done`
 * events, plus whether the ask bar is open (global, starts open, not saved).
 */
import type { AskImage, AskTarget, AskTurn, RoomsEvent, StartAsk } from "@alto-rooms/protocol-ts";

export type Thread = { turns: AskTurn[]; loaded: boolean; error: boolean };
/** A running turn's answer so far and what the agent is doing, from `ask.progress`. */
export type Live = { answer: string; activity: string | null };
export type AsksState = { open: boolean; threads: Record<string, Thread>; live: Record<string, Live> };
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
  private state: AsksState = { open: true, threads: {}, live: {} };
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
